// bun test suite for scripts/evolve-finalize.ts — the deterministic
// _hermit_versions writer that replaces the LLM hand-edit in evolve step 9.
// These are the regression tests for issue #426 (silent dropped version bump).
//
// Usage: bun test tests/evolve-finalize.test.ts   (from the plugin root)

import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { finalize, writeSnapshot } from '../scripts/evolve-finalize';
import { auditConfigChange } from '../scripts/lib/config-audit';
import { runScript, runPinnedScript } from './helpers/run';

// Fake plugin root with plugin.json version "1.2.6" (shared, read-only across tests).
let PR: string;

beforeAll(() => {
  PR = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-finalize-pr-'));
  fs.mkdirSync(path.join(PR, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(PR, '.claude-plugin', 'plugin.json'), '{"version":"1.2.6"}\n');
});

afterAll(() => {
  try { fs.rmSync(PR, { recursive: true, force: true }); } catch {}
});

/** Run a test body against a throwaway hermit dir, always cleaning up. */
function withProj(fn: (hermitDir: string) => Promise<void> | void) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-finalize-'));
    try { await fn(dir); } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  };
}

const writeConfig = (dir: string, content: string) =>
  fs.writeFileSync(path.join(dir, 'config.json'), content);

const readConfig = (dir: string) =>
  JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));

// -------------------------------------------------------
// 1. #426 regression — core bump actually lands on disk
// -------------------------------------------------------

test('#426 regression: core bump lands and confirmed', withProj(async (dir) => {
  writeConfig(dir, '{"_hermit_versions":{"hermitd":"1.2.5"}}');
  const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });

  expect(result.ok).toBe(true);
  expect(result.core.requested).toBe('1.2.6');
  expect(result.core.confirmed).toBe('1.2.6');
  expect(result.core.matched).toBe(true);
  expect(result.errors).toEqual([]);

  // Independently verify the on-disk file actually changed
  const onDisk = readConfig(dir);
  expect(onDisk._hermit_versions['hermitd']).toBe('1.2.6');
}));

// -------------------------------------------------------
// 2. Step-9 keys preserved — only _hermit_versions.hermit changes
// -------------------------------------------------------

test('step-9 keys preserved: other keys untouched after bump', withProj(async (dir) => {
  writeConfig(dir, JSON.stringify({
    _hermit_versions: { 'hermitd': '1.2.5' },
    model: 'sonnet',
    reflection: { graduation_min_sessions: 1 },
    routines: [{ id: 'brief' }],
  }, null, 2));

  finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });

  const onDisk = readConfig(dir);
  expect(onDisk._hermit_versions['hermitd']).toBe('1.2.6');
  expect(onDisk.model).toBe('sonnet');
  expect(onDisk.reflection).toEqual({ graduation_min_sessions: 1 });
  expect(onDisk.routines).toEqual([{ id: 'brief' }]);
}));

// -------------------------------------------------------
// 3. Sibling present → applied; sibling NOT a key → skipped, not added
// -------------------------------------------------------

test('sibling present: bumped and confirmed', withProj(async (dir) => {
  writeConfig(dir, JSON.stringify({
    _hermit_versions: {
      'hermitd': '1.2.5',
      'hermitd-dev': '0.3.0',
    },
  }));
  const result = finalize({
    hermitDir: dir,
    core: '1.2.6',
    pluginRoot: PR,
    siblings: [{ name: 'hermitd-dev', version: '0.4.0' }],
  });

  expect(result.ok).toBe(true);
  expect(result.siblings_confirmed['hermitd-dev']).toBe('0.4.0');
  expect(result.siblings_skipped).toEqual([]);

  const onDisk = readConfig(dir);
  expect(onDisk._hermit_versions['hermitd-dev']).toBe('0.4.0');
}));

test('sibling NOT a key: skipped, not added to config', withProj(async (dir) => {
  writeConfig(dir, JSON.stringify({
    _hermit_versions: { 'hermitd': '1.2.5' },
  }));
  const result = finalize({
    hermitDir: dir,
    core: '1.2.6',
    pluginRoot: PR,
    siblings: [{ name: 'foo-hermit', version: '1.0.0' }],
  });

  expect(result.ok).toBe(true);
  expect(result.siblings_skipped).toContain('foo-hermit');
  expect('foo-hermit' in result.siblings_confirmed).toBe(false);

  const onDisk = readConfig(dir);
  expect('foo-hermit' in onDisk._hermit_versions).toBe(false); // key must NOT be added
}));

// -------------------------------------------------------
// 4. --core ≠ plugin.json.version → refuse, file unchanged
// -------------------------------------------------------

test('core_version_mismatch: --core differs from plugin.json → error, file unchanged', withProj(async (dir) => {
  const original = '{"_hermit_versions":{"hermitd":"1.2.5"}}';
  writeConfig(dir, original);

  const result = finalize({ hermitDir: dir, core: '1.2.9', pluginRoot: PR, siblings: [] });

  expect(result.ok).toBe(false);
  expect(result.errors.map(e => e.code)).toContain('core_version_mismatch');
  expect(result.core.confirmed).toBeNull(); // no write attempted

  // File must be unchanged
  expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(original);
}));

// -------------------------------------------------------
// 4b. Monotonicity — the stamp records APPLIED migrations, so it never moves back
// -------------------------------------------------------

// The incident shape: the session loaded a STALE plugin copy (1.2.6) while this hermit
// had already applied 1.2.8. --core matches that copy's plugin.json, so the cross-check
// above passes; only the monotonicity guard stops the downgrade.
test('core_version_regression: --core older than applied stamp → refuse, file byte-identical', withProj(async (dir) => {
  const original = '{"_hermit_versions":{"hermitd":"1.2.8","hermitd-dev":"0.3.0"}}';
  writeConfig(dir, original);

  const result = finalize({
    hermitDir: dir,
    core: '1.2.6',
    pluginRoot: PR,
    siblings: [{ name: 'hermitd-dev', version: '0.4.0' }],
  });

  expect(result.ok).toBe(false);
  expect(result.errors.map(e => e.code)).toContain('core_version_regression');
  expect(result.core.confirmed).toBeNull();
  expect(result.siblings_confirmed).toEqual({}); // sibling writes never reached
  expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(original);
}));

// Equal must pass: the documented sibling-only run re-stamps the same version, and so
// does a re-run after a crash mid-evolve. Blocking it would break both.
test('equal core: idempotent re-stamp still succeeds', withProj(async (dir) => {
  writeConfig(dir, '{"_hermit_versions":{"hermitd":"1.2.6"}}');
  const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });

  expect(result.ok).toBe(true);
  expect(result.core.confirmed).toBe('1.2.6');
  expect(readConfig(dir)._hermit_versions['hermitd']).toBe('1.2.6');
}));

test('absent stamp: bootstrap write is not treated as a regression', withProj(async (dir) => {
  writeConfig(dir, '{}');
  const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });

  expect(result.ok).toBe(true);
  expect(readConfig(dir)._hermit_versions['hermitd']).toBe('1.2.6');
}));

// cmpSemver reads garbage as equal, so the sole writer can REPAIR a hand-mangled stamp.
// A hard reject here would wedge evolve with no in-band recovery path.
test('unparseable stamp: repaired by the valid --core', withProj(async (dir) => {
  writeConfig(dir, '{"_hermit_versions":{"hermitd":"not-a-version"}}');
  const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });

  expect(result.ok).toBe(true);
  expect(readConfig(dir)._hermit_versions['hermitd']).toBe('1.2.6');
}));

// Sibling versions come from a runner-assembled command line with no cross-check, so
// they get the same no-downgrade rule — as a skip, never a failure of the core bump.
test('sibling regression: skipped with marker, core bump still lands', withProj(async (dir) => {
  writeConfig(dir, '{"_hermit_versions":{"hermitd":"1.2.5","hermitd-dev":"0.4.0"}}');
  const result = finalize({
    hermitDir: dir,
    core: '1.2.6',
    pluginRoot: PR,
    siblings: [{ name: 'hermitd-dev', version: '0.3.0' }],
  });

  expect(result.ok).toBe(true);
  expect(result.siblings_skipped).toContain('[regression:hermitd-dev]');
  expect('hermitd-dev' in result.siblings_confirmed).toBe(false);

  const onDisk = readConfig(dir);
  expect(onDisk._hermit_versions['hermitd']).toBe('1.2.6'); // core still bumped
  expect(onDisk._hermit_versions['hermitd-dev']).toBe('0.4.0'); // sibling untouched
}));

// -------------------------------------------------------
// 5. Missing config → no_config; malformed config → config_json_invalid
// -------------------------------------------------------

test('no_config: missing config.json → error, exit behavior', withProj(async (dir) => {
  const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });

  expect(result.ok).toBe(false);
  expect(result.errors.map(e => e.code)).toContain('no_config');
}));

test('config_json_invalid: malformed JSON → error, bytes unchanged', withProj(async (dir) => {
  const bad = '{"_hermit_versions":';
  writeConfig(dir, bad);

  const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });

  expect(result.ok).toBe(false);
  expect(result.errors.map(e => e.code)).toContain('config_json_invalid');

  // Original bytes must be unchanged
  expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(bad);
}));

// -------------------------------------------------------
// 6. Missing --core → no_core_target, no write
// -------------------------------------------------------

test('no_core_target: --core absent → error, no file touched', withProj(async (dir) => {
  const original = '{"_hermit_versions":{"hermitd":"1.2.5"}}';
  writeConfig(dir, original);

  const result = finalize({ hermitDir: dir, core: null, pluginRoot: PR, siblings: [] });

  expect(result.ok).toBe(false);
  expect(result.errors.map(e => e.code)).toContain('no_core_target');
  expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(original);
}));

test('no_core_target: empty --core string → error', withProj(async (dir) => {
  writeConfig(dir, '{"_hermit_versions":{"hermitd":"1.2.5"}}');
  const result = finalize({ hermitDir: dir, core: '', pluginRoot: null, siblings: [] });
  expect(result.errors.map(e => e.code)).toContain('no_core_target');
}));

// -------------------------------------------------------
// 7. _hermit_versions absent entirely → created, core key set
// -------------------------------------------------------

test('_hermit_versions absent: created and core key set', withProj(async (dir) => {
  writeConfig(dir, '{"model":"sonnet"}');

  const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });

  expect(result.ok).toBe(true);
  expect(result.core.confirmed).toBe('1.2.6');

  const onDisk = readConfig(dir);
  expect(onDisk._hermit_versions['hermitd']).toBe('1.2.6');
  expect(onDisk.model).toBe('sonnet'); // other keys preserved
}));

// -------------------------------------------------------
// 8. Idempotency — running twice produces identical file
// -------------------------------------------------------

test('idempotency: second run is a no-op, both ok:true', withProj(async (dir) => {
  writeConfig(dir, '{"_hermit_versions":{"hermitd":"1.2.5"}}');

  const r1 = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });
  expect(r1.ok).toBe(true);
  const afterFirst = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');

  const r2 = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });
  expect(r2.ok).toBe(true);
  const afterSecond = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');

  expect(afterSecond).toBe(afterFirst);
}));

// -------------------------------------------------------
// 9. Sibling version contains dots + = in rest of version string
// -------------------------------------------------------

test('sibling first-= split: name and version parsed correctly', withProj(async (dir) => {
  writeConfig(dir, JSON.stringify({
    _hermit_versions: { 'hermitd': '1.2.5', 'x-hermit': '0.1.0' },
  }));
  const result = finalize({
    hermitDir: dir,
    core: '1.2.6',
    pluginRoot: PR,
    siblings: [{ name: 'x-hermit', version: '1.2.3.4' }],
  });

  expect(result.ok).toBe(true);
  expect(result.siblings_confirmed['x-hermit']).toBe('1.2.3.4');
  const onDisk = readConfig(dir);
  expect(onDisk._hermit_versions['x-hermit']).toBe('1.2.3.4');
}));

// -------------------------------------------------------
// 10. Exit code via subprocess (the actual binary contract)
// -------------------------------------------------------

test('process exit 0 on success', withProj(async (dir) => {
  writeConfig(dir, '{"_hermit_versions":{"hermitd":"1.2.5"}}');
  const r = await runPinnedScript('evolve-finalize.ts', dir, [dir, `--core=1.2.6`, `--plugin-root=${PR}`]);
  expect(r.exitCode).toBe(0);
  const out = JSON.parse(r.stdout);
  expect(out.ok).toBe(true);
  expect(out.core.confirmed).toBe('1.2.6');
}));

test('process exit 1 on error (no_config)', withProj(async (dir) => {
  // No config.json
  const r = await runPinnedScript('evolve-finalize.ts', dir, [dir, `--core=1.2.6`, `--plugin-root=${PR}`]);
  expect(r.exitCode).toBe(1);
  const out = JSON.parse(r.stdout);
  expect(out.ok).toBe(false);
  expect(out.errors.map((e: any) => e.code)).toContain('no_config');
}));

test('process exit 1 on mismatch (core_version_mismatch)', withProj(async (dir) => {
  writeConfig(dir, '{"_hermit_versions":{"hermitd":"1.2.5"}}');
  const r = await runPinnedScript('evolve-finalize.ts', dir, [dir, `--core=9.9.9`, `--plugin-root=${PR}`]);
  expect(r.exitCode).toBe(1);
  const out = JSON.parse(r.stdout);
  expect(out.ok).toBe(false);
  expect(out.errors.map((e: any) => e.code)).toContain('core_version_mismatch');
}));

// -------------------------------------------------------
// 11. malformed --sibling: goes to siblings_skipped, does not affect ok
// -------------------------------------------------------

test('malformed sibling: goes to siblings_skipped, core still bumps, ok:true', withProj(async (dir) => {
  writeConfig(dir, '{"_hermit_versions":{"hermitd":"1.2.5"}}');
  const result = finalize({
    hermitDir: dir,
    core: '1.2.6',
    pluginRoot: PR,
    siblings: [{ name: 'bad-hermit', version: '' }], // malformed (no version)
  });

  expect(result.siblings_skipped.some(s => s.includes('bad-hermit'))).toBe(true);
  expect(result.errors).toEqual([]);
  expect(result.core.confirmed).toBe('1.2.6');
  expect(result.ok).toBe(true);
}));

// -------------------------------------------------------
// 12. Audit attribution (issue #753) — the step-1 snapshot
// -------------------------------------------------------

const snapFile = (dir: string) => path.join(dir, 'state', 'evolve-config-snapshot.json');

const ledgerRows = (dir: string): any[] => {
  const file = path.join(dir, 'state', 'settings-audit.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

const rowFor = (dir: string, dotted: string) => ledgerRows(dir).find((r) => r.path === dotted);

/** Plant a snapshot directly, so `ts` and `to` can be aged or mismatched per test. */
const plantSnapshot = (dir: string, snap: unknown) => {
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(snapFile(dir), JSON.stringify(snap));
};

test('snapshot mode writes {ts,to,config} at 0600', withProj(async (dir) => {
  writeConfig(dir, '{"heartbeat":{"every":"2h"},"_hermit_versions":{"hermitd":"1.2.5"}}');

  expect(writeSnapshot(dir, '1.2.6')).toEqual({ path: snapFile(dir) });

  const snap = JSON.parse(fs.readFileSync(snapFile(dir), 'utf8'));
  expect(snap.to).toBe('1.2.6');
  expect(snap.config.heartbeat.every).toBe('2h');
  expect(Number.isNaN(new Date(snap.ts).getTime())).toBe(false);
  // Config carries channel tokens and an env block — the snapshot copies them verbatim.
  expect(fs.statSync(snapFile(dir)).mode & 0o777).toBe(0o600);
}));

test('snapshot mode is fail-open: no config, no snapshot, no throw', withProj(async (dir) => {
  expect(writeSnapshot(dir, '1.2.6')).toMatchObject({ status: 'skip', reason: 'snapshot_failed' });
  expect(writeSnapshot(dir, null)).toEqual({ status: 'skip', reason: 'core_required' });
  expect(fs.existsSync(snapFile(dir))).toBe(false);
}));

test('snapshot mode exits 0 through the CLI and leaves config.json untouched', withProj(async (dir) => {
  writeConfig(dir, '{"heartbeat":{"every":"2h"},"_hermit_versions":{"hermitd":"1.2.5"}}');
  const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');

  const r = await runPinnedScript('evolve-finalize.ts', dir, [dir, 'snapshot', '--core=1.2.6']);

  expect(r.exitCode).toBe(0);
  expect(JSON.parse(r.stdout).path).toBe(snapFile(dir));
  expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(before);
  expect(JSON.parse(fs.readFileSync(snapFile(dir), 'utf8')).to).toBe('1.2.6');
}));

test('step-time writes during a live snapshot are upgrade-prefixed; finalize stays hermit-evolve', withProj(async (dir) => {
  writeConfig(dir, '{"heartbeat":{"every":"2h"},"_hermit_versions":{"hermitd":"1.2.5"}}');
  writeSnapshot(dir, '1.2.6');
  // Stand in for a settings-edit write that lands while the snapshot is live.
  writeConfig(dir, '{"heartbeat":{"every":"30m"},"_hermit_versions":{"hermitd":"1.2.5"}}');
  auditConfigChange(dir, { heartbeat: { every: '2h' } }, { heartbeat: { every: '30m' } }, 'settings-edit');

  const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });

  expect(result.ok).toBe(true);
  expect(result.audit_scope).toBe('whole-run');
  expect(ledgerRows(dir).some((r) => r.actor === 'upgrade:settings-edit' && r.path === 'heartbeat.every')).toBe(true);
  expect(ledgerRows(dir).some((r) => r.actor === 'hermit-evolve' && r.path === 'heartbeat.every')).toBe(true);
  expect(rowFor(dir, '_hermit_versions.hermitd').actor).toBe('hermit-evolve');
}));

test('whole-run: a step-2b migration write is attributed to hermit-evolve', withProj(async (dir) => {
  writeConfig(dir, '{"heartbeat":{"every":"2h"},"_hermit_versions":{"hermitd":"1.2.5"}}');
  writeSnapshot(dir, '1.2.6');
  // Stand in for step 2b + step 9: the upgrade rewrites config.json by hand.
  writeConfig(dir, '{"heartbeat":{"every":"30m"},"_hermit_versions":{"hermitd":"1.2.5"}}');

  const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });

  expect(result.ok).toBe(true);
  expect(result.audit_scope).toBe('whole-run');

  const migrated = rowFor(dir, 'heartbeat.every');
  expect(migrated.old).toBe('2h');
  expect(migrated.new).toBe('30m');
  expect(migrated.actor).toBe('hermit-evolve');
  expect(rowFor(dir, '_hermit_versions.hermitd').new).toBe('1.2.6');
  // Single-use: a snapshot left behind is what the staleness window exists to contain.
  expect(fs.existsSync(snapFile(dir))).toBe(false);
}));

test('version-only: no snapshot degrades to the pre-#753 behavior', withProj(async (dir) => {
  writeConfig(dir, '{"heartbeat":{"every":"30m"},"_hermit_versions":{"hermitd":"1.2.5"}}');

  const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });

  expect(result.audit_scope).toBe('version-only');
  expect(rowFor(dir, 'heartbeat.every')).toBeUndefined();
  expect(rowFor(dir, '_hermit_versions.hermitd').actor).toBe('evolve-finalize');
}));

test('version-only: snapshot taken for a different --core is not trusted', withProj(async (dir) => {
  writeConfig(dir, '{"heartbeat":{"every":"2h"},"_hermit_versions":{"hermitd":"1.2.5"}}');
  plantSnapshot(dir, { ts: new Date().toISOString(), to: '9.9.9', config: { heartbeat: { every: '2h' } } });
  writeConfig(dir, '{"heartbeat":{"every":"30m"},"_hermit_versions":{"hermitd":"1.2.5"}}');

  const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });

  expect(result.audit_scope).toBe('version-only');
  expect(rowFor(dir, 'heartbeat.every')).toBeUndefined();
  expect(fs.existsSync(snapFile(dir))).toBe(false);
}));

test('version-only: a snapshot older than 24h is not trusted', withProj(async (dir) => {
  writeConfig(dir, '{"heartbeat":{"every":"30m"},"_hermit_versions":{"hermitd":"1.2.5"}}');
  // The window this closes: an aborted run's snapshot plus operator edits since.
  const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  plantSnapshot(dir, { ts: stale, to: '1.2.6', config: { heartbeat: { every: '2h' } } });

  const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });

  expect(result.audit_scope).toBe('version-only');
  expect(rowFor(dir, 'heartbeat.every')).toBeUndefined();
}));

test('version-only: an unparseable snapshot is discarded, not fatal', withProj(async (dir) => {
  writeConfig(dir, '{"heartbeat":{"every":"30m"},"_hermit_versions":{"hermitd":"1.2.5"}}');
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(snapFile(dir), '{ not json');

  const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });

  expect(result.ok).toBe(true);
  expect(result.audit_scope).toBe('version-only');
  expect(fs.existsSync(snapFile(dir))).toBe(false);
}));

test('a stamp that does not move records no _hermit_versions row, migration rows still land', withProj(async (dir) => {
  // The structural property that lets the audit call run ungated by coreMatched:
  // the diff is against the post-write re-read, so a stamp that is not on disk
  // cannot produce a row, however the bump went.
  writeConfig(dir, '{"heartbeat":{"every":"2h"},"_hermit_versions":{"hermitd":"1.2.6"}}');
  writeSnapshot(dir, '1.2.6');
  writeConfig(dir, '{"heartbeat":{"every":"30m"},"_hermit_versions":{"hermitd":"1.2.6"}}');

  const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });

  expect(result.ok).toBe(true);
  expect(rowFor(dir, 'heartbeat.every').actor).toBe('hermit-evolve');
  expect(rowFor(dir, '_hermit_versions.hermitd')).toBeUndefined();
}));

test('a write that never lands records nothing at all', withProj(async (dir) => {
  writeConfig(dir, '{"heartbeat":{"every":"2h"},"_hermit_versions":{"hermitd":"1.2.5"}}');
  writeSnapshot(dir, '1.2.6');
  writeConfig(dir, '{"heartbeat":{"every":"30m"},"_hermit_versions":{"hermitd":"1.2.5"}}');
  // Block the atomic write: config.json.tmp already exists as a directory.
  fs.mkdirSync(path.join(dir, 'config.json.tmp'));

  const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });

  expect(result.ok).toBe(false);
  expect(result.errors.map((e: any) => e.code)).toContain('write_failed');
  expect(result.audit_scope).toBe('version-only');
  expect(ledgerRows(dir)).toEqual([]);
  // The migration write is on disk with nothing to explain it — keep the snapshot
  // so the retry below can still attribute it.
  expect(fs.existsSync(snapFile(dir))).toBe(true);
}));

test('a failed run keeps the snapshot, so the retry still attributes the migration', withProj(async (dir) => {
  writeConfig(dir, '{"heartbeat":{"every":"2h"},"_hermit_versions":{"hermitd":"1.2.5"}}');
  writeSnapshot(dir, '1.2.6');
  writeConfig(dir, '{"heartbeat":{"every":"30m"},"_hermit_versions":{"hermitd":"1.2.5"}}');
  fs.mkdirSync(path.join(dir, 'config.json.tmp'));

  expect(finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] }).ok).toBe(false);

  fs.rmdirSync(path.join(dir, 'config.json.tmp'));
  const retry = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });

  expect(retry.ok).toBe(true);
  expect(retry.audit_scope).toBe('whole-run');
  expect(rowFor(dir, 'heartbeat.every').old).toBe('2h');
  expect(rowFor(dir, 'heartbeat.every').actor).toBe('hermit-evolve');
  expect(fs.existsSync(snapFile(dir))).toBe(false);
}));

test('snapshot mode skips a foreign state dir instead of exiting non-zero', withProj(async (dir) => {
  writeConfig(dir, '{"_hermit_versions":{"hermitd":"1.2.5"}}');
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-foreign-'));
  try {
    // Readable config, so the only reason to skip is the pin.
    writeConfig(foreign, '{"_hermit_versions":{"hermitd":"9.9.9"}}');
    const r = await runPinnedScript('evolve-finalize.ts', dir, [foreign, 'snapshot', '--core=1.2.6']);

    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'skip', reason: 'foreign_state_dir' });
    expect(fs.existsSync(snapFile(foreign))).toBe(false);
  } finally {
    try { fs.rmSync(foreign, { recursive: true, force: true }); } catch {}
  }
}));

// -------------------------------------------------------
// Template-default merge (issue #760) — the finalizer applies missing keys
// itself, inside the same atomic write as the version stamp, instead of the
// runner hand-merging them before calling this script.
// -------------------------------------------------------

/** A plugin root carrying both plugin.json and a config template. */
function withTmplRoot(tmpl: unknown, fn: (pr: string) => Promise<void> | void) {
  return async () => {
    const pr = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-finalize-tpr-'));
    fs.mkdirSync(path.join(pr, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(pr, '.claude-plugin', 'plugin.json'), '{"version":"1.2.6"}\n');
    fs.mkdirSync(path.join(pr, 'state-templates'), { recursive: true });
    fs.writeFileSync(
      path.join(pr, 'state-templates', 'config.json.template'),
      JSON.stringify(tmpl, null, 2),
    );
    try { await fn(pr); } finally {
      try { fs.rmSync(pr, { recursive: true, force: true }); } catch {}
    }
  };
}

const TMPL = {
  language: 'en',
  heartbeat: { every: '30m', active_hours: '08:00-22:00' },
  artifacts: { dashboard: true },
};

test('#760: missing nested leaf and absent parent both land in one write', withTmplRoot(TMPL, async (pr) => {
  await withProj(async (dir) => {
    // `heartbeat.every` present (operator value), `heartbeat.active_hours` missing,
    // `artifacts` absent entirely, `language` missing.
    writeConfig(dir, '{"heartbeat":{"every":"2h"},"_hermit_versions":{"hermitd":"1.2.5"}}');
    const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: pr, siblings: [] });

    expect(result.ok).toBe(true);
    expect(result.settings_added.sort()).toEqual(['artifacts', 'heartbeat.active_hours', 'language']);

    const onDisk = readConfig(dir);
    expect(onDisk.language).toBe('en');
    expect(onDisk.heartbeat.active_hours).toBe('08:00-22:00');
    expect(onDisk.artifacts).toEqual({ dashboard: true });
    // Operator value survives, and the stamp rode the same write.
    expect(onDisk.heartbeat.every).toBe('2h');
    expect(onDisk._hermit_versions['hermitd']).toBe('1.2.6');
  })();
}));

test('#760: re-run adds nothing and reports an empty settings_added', withTmplRoot(TMPL, async (pr) => {
  await withProj(async (dir) => {
    writeConfig(dir, '{"_hermit_versions":{"hermitd":"1.2.5"}}');
    finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: pr, siblings: [] });
    const first = readConfig(dir);

    const again = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: pr, siblings: [] });
    expect(again.ok).toBe(true);
    expect(again.settings_added).toEqual([]);
    expect(readConfig(dir)).toEqual(first);
  })();
}));

test('scheduler_enabled is adopted while an operator enabled: false survives', withTmplRoot({
  watchdog: { enabled: false, scheduler_enabled: true, stale_factor: 2 },
}, async (pr) => {
  await withProj(async (dir) => {
    writeConfig(dir, JSON.stringify({
      watchdog: { enabled: false, stale_factor: 2 },
      _hermit_versions: { 'hermitd': '1.2.5' },
    }));
    const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: pr, siblings: [] });
    expect(result.ok).toBe(true);
    expect(result.settings_added).toContain('watchdog.scheduler_enabled');
    const onDisk = readConfig(dir);
    expect(onDisk.watchdog.scheduler_enabled).toBe(true);
    expect(onDisk.watchdog.enabled).toBe(false);
  })();
}));

test('#760: a value written earlier in the run is never overwritten', withTmplRoot(TMPL, async (pr) => {
  await withProj(async (dir) => {
    // What the runner's language/timezone auto-detect (or a migration) leaves behind.
    writeConfig(dir, '{"language":"pt","_hermit_versions":{"hermitd":"1.2.5"}}');
    const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: pr, siblings: [] });

    expect(result.settings_added).not.toContain('language');
    expect(readConfig(dir).language).toBe('pt');
  })();
}));

test('#760: a rejected run merges nothing — config stays byte-identical', withTmplRoot(TMPL, async (pr) => {
  await withProj(async (dir) => {
    // Regression guard rejects before any mutation; the merge must not have run.
    writeConfig(dir, '{"_hermit_versions":{"hermitd":"9.9.9"}}');
    const before = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');

    const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: pr, siblings: [] });

    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('core_version_regression');
    expect(result.settings_added).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).toBe(before);
  })();
}));

test('#760: no template under the plugin root is not an error', withProj(async (dir) => {
  // PR has plugin.json but no state-templates/ — the version bump still lands.
  writeConfig(dir, '{"_hermit_versions":{"hermitd":"1.2.5"}}');
  const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });

  expect(result.ok).toBe(true);
  expect(result.settings_added).toEqual([]);
  expect(readConfig(dir)._hermit_versions['hermitd']).toBe('1.2.6');
}));

test('#760: merged defaults are attributed in the audit ledger', withTmplRoot(TMPL, async (pr) => {
  await withProj(async (dir) => {
    writeConfig(dir, '{"_hermit_versions":{"hermitd":"1.2.5"}}');
    writeSnapshot(dir, '1.2.6');

    const result = finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: pr, siblings: [] });

    expect(result.audit_scope).toBe('whole-run');
    expect(rowFor(dir, 'language').new).toBe('en');
  })();
}));

test('secrets stay redacted through a whole-run diff', withProj(async (dir) => {
  writeConfig(dir, '{"env":{"SOME_KEY":"old-value"},"_hermit_versions":{"hermitd":"1.2.5"}}');
  writeSnapshot(dir, '1.2.6');
  writeConfig(dir, '{"env":{"SOME_KEY":"new-value"},"_hermit_versions":{"hermitd":"1.2.5"}}');

  finalize({ hermitDir: dir, core: '1.2.6', pluginRoot: PR, siblings: [] });

  const row = rowFor(dir, 'env.SOME_KEY');
  expect(row.old).toBe('[set]');
  expect(row.new).toBe('[set]');
  expect(JSON.stringify(ledgerRows(dir))).not.toContain('new-value');
}));
