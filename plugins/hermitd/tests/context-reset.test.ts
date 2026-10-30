// lib/context-reset.ts — the bookkeeping every /clear and /compact path shares.
//
// Both tests here are regressions for state-file hazards, not feature coverage:
// applyContextReset used to resolve runtime.json two different ways in one call, and
// every runtime.json writer used to share one temp filename.

import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { freshDirFactory } from './helpers/workdir';
import { runtimeTmpPath } from '../scripts/lib/runtime';

const { freshDir, cleanup } = freshDirFactory('hermit-context-reset-');
afterAll(cleanup);

const CONTEXT_RESET_LIB = path.resolve(import.meta.dir, '../scripts/lib/context-reset.ts');

// applyContextReset writes runtime.json through writeRuntimeJson, which resolves
// `.hermit/state` RELATIVE TO THE CWD — so the only way to prove it is
// anchored to the hermitRoot argument is to run it from somewhere else entirely.
// process.chdir() would leak across `bun test --concurrent`, hence the subprocess.
async function applyResetFromCwd(hermitRoot: string, cwd: string, runtime: Record<string, unknown>) {
  const code = `
    const { applyContextReset } = await import(${JSON.stringify(CONTEXT_RESET_LIB)});
    applyContextReset(${JSON.stringify(hermitRoot)}, ${JSON.stringify(runtime)}, {
      kind: 'cleared', trigger: 'test', hhmm: '12:00',
    });
  `;
  const proc = Bun.spawn({
    cmd: [process.execPath, '-e', code],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
}

test('applyContextReset anchors its write to hermitRoot, not the cwd', async () => {
  const hermitRoot = path.join(freshDir(), '.hermit');
  fs.mkdirSync(path.join(hermitRoot, 'state'), { recursive: true });
  fs.mkdirSync(path.join(hermitRoot, 'sessions'), { recursive: true });
  const shellPath = path.join(hermitRoot, 'sessions', 'SHELL.md');
  fs.writeFileSync(shellPath, '## Progress Log\n');
  const runtimeJson = path.join(hermitRoot, 'state', 'runtime.json');
  fs.writeFileSync(runtimeJson, JSON.stringify({ cc_session_id: 'resident', tmux_session: 'hermit' }));

  const foreignCwd = freshDir();
  await applyResetFromCwd(hermitRoot, foreignCwd, { cc_session_id: 'resident', tmux_session: 'hermit' });

  const written = JSON.parse(fs.readFileSync(runtimeJson, 'utf-8'));
  expect(typeof written.last_context_reset_at).toBe('string');
  expect(written.cc_session_id).toBe('resident');
  expect(typeof written.updated_at).toBe('string');

  // writeRuntimeJson mkdirs its target, so a cwd-relative resolve would have silently
  // created a decoy state dir here and written into it.
  expect(fs.existsSync(path.join(foreignCwd, '.hermit'))).toBe(false);
  expect(fs.readFileSync(shellPath, 'utf-8')).toBe('## Progress Log\n');

  // The atomic write renames its temp away; nothing is left behind.
  const leftovers = fs.readdirSync(path.join(hermitRoot, 'state')).filter((f) => f.endsWith('.tmp'));
  expect(leftovers).toEqual([]);
});

test('runtimeTmpPath is per-process, so concurrent writers cannot share a temp file', () => {
  const stateDir = path.join(freshDir(), 'state');
  const tmp = runtimeTmpPath(stateDir);

  expect(path.dirname(tmp)).toBe(stateDir);
  expect(path.basename(tmp)).toContain(String(process.pid));
  // The shared name two processes could open with O_TRUNC at once — one renaming a
  // zero-length temp over runtime.json while the other was still writing it.
  expect(path.basename(tmp)).not.toBe('.runtime.json.tmp');
});
