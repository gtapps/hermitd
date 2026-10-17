// Contract test for scripts/manifest-seed.ts.
// Exercises the process boundary (stdin in, exit code/file out, fail-loud).

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript, runPinnedScript, PLUGIN_ROOT } from './helpers/run';
import { withDir } from './helpers/workdir';
import { sha256 } from '../scripts/lib/hash';

function manifestPath(dir: string): string {
  return path.join(dir, '.hermit', 'state', 'template-manifest.json');
}
function stateArg(dir: string): string {
  return path.join(dir, '.hermit');
}
function readManifest(dir: string): any {
  return JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8'));
}

describe('manifest-seed: hashing + shape', () => {
  test('hashes a file correctly and stamps plugin_version', withDir(async (dir) => {
    const f = path.join(dir, 'sample.txt');
    fs.writeFileSync(f, 'hello world\n');

    const r = await runPinnedScript('manifest-seed.ts', stateArg(dir), [stateArg(dir)], {
      stdin: JSON.stringify({ plugin_version: '1.2.9', entries: [{ key: 'templates/a', file: f }] }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('{"seeded":1,"preserved":0}\n');

    const m = readManifest(dir);
    expect(m.version).toBe(1);
    expect(m.files['templates/a'].sha256).toBe(sha256(fs.readFileSync(f)));
    expect(m.files['templates/a'].plugin_version).toBe('1.2.9');
  }));

  test('every written sha256 is 64-hex (shape evolve-plan validates)', withDir(async (dir) => {
    const f = path.join(dir, 'sample.txt');
    fs.writeFileSync(f, 'data');
    await runPinnedScript('manifest-seed.ts', stateArg(dir), [stateArg(dir)], {
      stdin: JSON.stringify({ plugin_version: '1.0.0', entries: [{ key: 'bin/x', file: f }] }),
    });
    const m = readManifest(dir);
    for (const v of Object.values(m.files) as any[]) {
      expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  }));
});

describe('manifest-seed: pristine baseline copies', () => {
  test('copies the seeded bytes to state/pristine/<key>, nested key included',
    withDir(async (dir) => {
      const f = path.join(dir, 'entrypoint.sh');
      fs.writeFileSync(f, '#!/usr/bin/env bash\necho boot\n');

      const r = await runPinnedScript('manifest-seed.ts', stateArg(dir), [stateArg(dir)], {
        stdin: JSON.stringify({
          plugin_version: '1.2.52',
          entries: [{ key: 'docker/docker-entrypoint.hermit.sh', file: f }],
        }),
      });
      expect(r.exitCode).toBe(0);

      const copy = path.join(
        stateArg(dir), 'state', 'pristine', 'docker', 'docker-entrypoint.hermit.sh');
      expect(fs.readFileSync(copy)).toEqual(fs.readFileSync(f));
    }));

  test('key_prefix entries get one pristine copy each', withDir(async (dir) => {
    const src = path.join(dir, 'src-bin');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'hermitd-run'), 'run\n');
    fs.writeFileSync(path.join(src, 'hermitd-start'), 'start\n');

    await runPinnedScript('manifest-seed.ts', stateArg(dir), [stateArg(dir)], {
      stdin: JSON.stringify({
        plugin_version: '1.2.52',
        entries: [{ key_prefix: 'bin', dir: src }],
      }),
    });

    const root = path.join(stateArg(dir), 'state', 'pristine', 'bin');
    expect(fs.readFileSync(path.join(root, 'hermitd-run'), 'utf8')).toBe('run\n');
    expect(fs.readFileSync(path.join(root, 'hermitd-start'), 'utf8')).toBe('start\n');
  }));

  test('re-seeding a key refreshes its pristine copy', withDir(async (dir) => {
    const f = path.join(dir, 'a.txt');
    const copy = path.join(stateArg(dir), 'state', 'pristine', 'templates', 'a');

    fs.writeFileSync(f, 'v1\n');
    await runPinnedScript('manifest-seed.ts', stateArg(dir), [stateArg(dir)], {
      stdin: JSON.stringify({ plugin_version: '1.0.0', entries: [{ key: 'templates/a', file: f }] }),
    });
    expect(fs.readFileSync(copy, 'utf8')).toBe('v1\n');

    fs.writeFileSync(f, 'v2\n');
    await runPinnedScript('manifest-seed.ts', stateArg(dir), [stateArg(dir)], {
      stdin: JSON.stringify({ plugin_version: '1.0.1', entries: [{ key: 'templates/a', file: f }] }),
    });
    expect(fs.readFileSync(copy, 'utf8')).toBe('v2\n');
  }));
});

describe('manifest-seed: foreign-key preservation', () => {
  test('preserves untouched keys, overwrites re-seeded ones', withDir(async (dir) => {
    fs.writeFileSync(
      manifestPath(dir),
      JSON.stringify({
        version: 1,
        files: {
          'templates/some-addon': { sha256: 'a'.repeat(64), plugin_version: '0.9.0' },
          'sibling-hermit/CLAUDE-APPEND.md': { sha256: 'b'.repeat(64), plugin_version: '0.9.0' },
          'templates/a': { sha256: 'c'.repeat(64), plugin_version: '0.9.0' },
        },
      }) + '\n',
    );
    const f = path.join(dir, 'a.txt');
    fs.writeFileSync(f, 'new content');

    const r = await runPinnedScript('manifest-seed.ts', stateArg(dir), [stateArg(dir)], {
      stdin: JSON.stringify({ plugin_version: '1.2.9', entries: [{ key: 'templates/a', file: f }] }),
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ preserved: 2 });

    const m = readManifest(dir);
    // Foreign keys survive untouched.
    expect(m.files['templates/some-addon'].sha256).toBe('a'.repeat(64));
    expect(m.files['sibling-hermit/CLAUDE-APPEND.md'].sha256).toBe('b'.repeat(64));
    // Re-seeded key overwritten with the real hash + new version.
    expect(m.files['templates/a'].sha256).toBe(sha256(fs.readFileSync(f)));
    expect(m.files['templates/a'].plugin_version).toBe('1.2.9');
  }));
});

describe('manifest-seed: key_prefix/dir enumeration', () => {
  test('enumerates the source dir, one entry per file', withDir(async (dir) => {
    const binSrc = path.join(dir, 'src-bin');
    fs.mkdirSync(binSrc);
    fs.writeFileSync(path.join(binSrc, 'hermitd-start'), '#!/usr/bin/env bun\n');
    fs.writeFileSync(path.join(binSrc, 'hermitd-stop'), '#!/usr/bin/env bun\n');
    fs.mkdirSync(path.join(binSrc, 'subdir')); // must be ignored (non-recursive, files only)

    const r = await runPinnedScript('manifest-seed.ts', stateArg(dir), [stateArg(dir)], {
      stdin: JSON.stringify({ plugin_version: '1.0.0', entries: [{ key_prefix: 'bin', dir: binSrc }] }),
    });
    expect(r.exitCode).toBe(0);

    const m = readManifest(dir);
    expect(Object.keys(m.files).sort()).toEqual(['bin/hermitd-start', 'bin/hermitd-stop']);
  }));
});

describe('manifest-seed: invalid existing manifest is fatal', () => {
  const cases: { name: string; content: string }[] = [
    { name: 'unparseable JSON', content: '{ not json' },
    { name: 'files not an object', content: JSON.stringify({ version: 1, files: [] }) },
    {
      name: 'existing entry with non-64-hex sha256',
      content: JSON.stringify({ version: 1, files: { 'templates/a': { sha256: 'short', plugin_version: '1' } } }),
    },
  ];
  for (const c of cases) {
    test(`${c.name} -> exit 1, file unchanged`, withDir(async (dir) => {
      fs.writeFileSync(manifestPath(dir), c.content);
      const before = fs.readFileSync(manifestPath(dir), 'utf8');
      const f = path.join(dir, 'a.txt');
      fs.writeFileSync(f, 'x');

      const r = await runPinnedScript('manifest-seed.ts', stateArg(dir), [stateArg(dir)], {
        stdin: JSON.stringify({ plugin_version: '1.2.9', entries: [{ key: 'templates/a', file: f }] }),
      });
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.stdout).error).toStartWith('corrupt_manifest:');
      // File left byte-for-byte unchanged.
      expect(fs.readFileSync(manifestPath(dir), 'utf8')).toBe(before);
    }));
  }
});

describe('manifest-seed: malformed stdin is fatal', () => {
  const bad: { name: string; stdin: string }[] = [
    { name: 'invalid JSON', stdin: 'not json' },
    { name: 'empty entries', stdin: JSON.stringify({ plugin_version: '1', entries: [] }) },
    { name: 'missing plugin_version', stdin: JSON.stringify({ entries: [{ key: 'a', file: '/x' }] }) },
    { name: 'empty stdin', stdin: '' },
  ];
  for (const b of bad) {
    test(`${b.name} -> exit 1, no manifest written`, withDir(async (dir) => {
      const r = await runPinnedScript('manifest-seed.ts', stateArg(dir), [stateArg(dir)], { stdin: b.stdin });
      expect(r.exitCode).toBe(1);
      expect(fs.existsSync(manifestPath(dir))).toBe(false);
    }));
  }
});

// manifest-seed.ts is reachable through a pre-approved
// `Bash(bun */scripts/manifest-seed.ts*)` grant that covers every argument, so
// an unvalidated root let one such call seed a manifest into another
// project's hermit state (see docs/security.md § Script Argument Trust).
describe('manifest-seed: state-dir pin', () => {
  test('refuses a state dir belonging to another project', withDir(async (mine) => {
    await withDir(async (victim) => {
      fs.writeFileSync(
        manifestPath(victim),
        JSON.stringify({ version: 1, files: { 'templates/victim': { sha256: 'a'.repeat(64), plugin_version: '1.0.0' } } }) + '\n',
      );
      const before = fs.readFileSync(manifestPath(victim), 'utf8');
      const f = path.join(victim, 'a.txt');
      fs.writeFileSync(f, 'attacker content');

      // AGENT_DIR pins hermitDir() to `mine`; argv still names `victim`.
      const r = await runScript('manifest-seed.ts', {
        args: [stateArg(victim)],
        env: { AGENT_DIR: stateArg(mine) },
        stdin: JSON.stringify({ plugin_version: '9.9.9', entries: [{ key: 'templates/victim', file: f }] }),
      });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toStartWith('{"error":"foreign_state_dir:');
      expect(fs.readFileSync(manifestPath(victim), 'utf8')).toBe(before);
    })();
  }));
});

// Contract: the three skills that call manifest-seed must hand it the intended
// SOURCE paths. Guards against a future edit pointing bin enumeration at the
// destination, or docker hashing rendered output.
describe('manifest-seed: skill-call source-path contract', () => {
  const read = (rel: string) => fs.readFileSync(path.join(PLUGIN_ROOT, rel), 'utf8');

  test('hatch enumerates the source state-templates/bin dir', () => {
    const hatch = read('skills/hatch/SKILL.md');
    expect(hatch).toContain('manifest-seed.ts');
    expect(hatch).toContain('state-templates/bin');
  });

  test('docker-setup delegates rendering + pipes the emitted manifest_seed', () => {
    // The upstream-.template-vs-on-disk-entrypoint source-path contract now lives
    // in render-docker-templates.ts, which emits the manifest_seed payload; it is
    // asserted behaviorally in tests/render-docker-templates.test.ts. Here we only
    // check the skill still routes rendering + manifest seeding through the scripts.
    const docker = read('skills/docker-setup/SKILL.md');
    expect(docker).toContain('render-docker-templates.ts');
    expect(docker).toContain('manifest-seed.ts');
  });

  test('render-docker-templates emits upstream .template files for the two substituted keys', () => {
    const script = read('scripts/render-docker-templates.ts');
    // Keys ending in .template map to plugin-root upstream templates (never rendered output).
    expect(script).toContain("'docker/docker-compose.hermit.yml.template'");
    expect(script).toContain("'docker/Dockerfile.hermit.template'");
    // The entrypoint key hashes the ON-DISK rendered copy at the project root.
    expect(script).toContain("'docker/docker-entrypoint.hermit.sh'");
    expect(script).toContain('entrypointPath');
  });

  test('hermit-evolve routes its manifest write through the script', () => {
    // Step 5b (manifest-seed invocation) lives in reference.md, read by the
    // evolve-runner subagent — SKILL.md is a thin routing stub that no longer
    // carries steps 0-9.
    const evolve = read('skills/hermit-evolve/reference.md');
    expect(evolve).toContain('manifest-seed.ts');
  });
});
