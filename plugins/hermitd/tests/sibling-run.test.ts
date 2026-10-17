import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN_ROOT } from './helpers/run';

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function plugin(dir: string, name: string): string {
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude-plugin/plugin.json'), JSON.stringify({ name, version: '1.0.0' }));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts/probe.ts'), 'console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() })); process.stderr.write("child stderr\\n"); process.exit(Number(process.argv[2]) || 0);');
  return dir;
}

function fixture(versioned = false) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-run-')));
  dirs.push(dir);
  const core = plugin(path.join(dir, 'plugins/core', ...(versioned ? ['1.0.0'] : [])), 'core');
  fs.mkdirSync(path.join(core, 'scripts/lib'), { recursive: true });
  for (const file of ['hermitd-exec.sh', 'sibling-run.ts', 'lib/cli.ts', 'lib/plugin-siblings.ts']) {
    fs.copyFileSync(path.join(PLUGIN_ROOT, 'scripts', file), path.join(core, 'scripts', file));
  }
  const sibling = plugin(path.join(dir, 'plugins/folder-name', ...(versioned ? ['2.0.0'] : [])), 'domain');
  const cwd = path.join(dir, 'project');
  fs.mkdirSync(cwd);
  return { dir, core, sibling, cwd };
}

async function run(f: ReturnType<typeof fixture>, args: string[], stdin = '') {
  const child = Bun.spawn(['bash', path.join(f.core, 'scripts/hermitd-exec.sh'), 'sibling-run', ...args], {
    cwd: f.cwd,
    stdin: Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

describe('sibling-run through bare-name dispatch', () => {
  for (const versioned of [false, true]) {
    test(`${versioned ? 'versioned cache' : 'flat'} matches manifest name and preserves args, cwd, and child exit`, async () => {
      const f = fixture(versioned);
      if (versioned) plugin(path.join(f.dir, 'plugins/folder-name/1.0.0'), 'old-domain');
      const args = ['7', 'two words', '--flag', 'literal $value'];
      const result = await run(f, ['domain', 'scripts/probe.ts', ...args]);
      expect(result.code).toBe(7);
      expect(JSON.parse(result.stdout)).toEqual({ args, cwd: f.cwd });
      expect(result.stderr).toBe('child stderr\n');
    });
  }

  test('inherits stdin', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.sibling, 'scripts/probe.ts'), 'console.log(await Bun.stdin.text());');
    const result = await run(f, ['domain', 'scripts/probe.ts'], 'input');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('input\n');
  });

  test('no manifest-name match is no_sibling at exit 1', async () => {
    const f = fixture();
    const result = await run(f, ['folder-name', 'scripts/probe.ts']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ error: 'no_sibling:folder-name' });
  });

  test('multiple matches are ambiguous_sibling at exit 1', async () => {
    const f = fixture();
    plugin(path.join(f.dir, 'plugins/another-folder'), 'domain');
    const result = await run(f, ['domain', 'scripts/probe.ts']);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ error: 'ambiguous_sibling:domain' });
  });

  test('an invalid script is invalid_script and a missing one missing_script, at exit 1', async () => {
    const f = fixture();
    for (const script of ['/absolute.ts', '../probe.ts', 'scripts/a..b.ts', 'scripts/probe.js']) {
      const result = await run(f, ['domain', script]);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({ error: 'invalid_script' });
    }
    const none = await run(f, ['domain']);
    expect(none.code).toBe(1);
    expect(JSON.parse(none.stdout)).toEqual({ error: 'invalid_script' });
    const missing = await run(f, ['domain', 'scripts/missing.ts']);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout)).toEqual({ error: 'missing_script' });
  });
});
