import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-operator-action-');
afterAll(cleanup);

function fixture(inflight: Array<{ command: string; arg: string | null }> | null) {
  const dir = freshDir();
  const state = path.join(dir, '.hermit', 'state');
  fs.mkdirSync(state, { recursive: true });
  if (inflight) {
    fs.mkdirSync(path.join(state, 'harness-inflight'), { recursive: true });
    fs.writeFileSync(path.join(state, 'harness-inflight', '2026-10-22T00:00:00.000Z-a.json'),
      JSON.stringify({ id: 'a', source: 'watchdog', commands: inflight, requested_at: '2026-10-22T00:00:00.000Z' }));
  }
  return dir;
}

async function counted(dir: string, prompt: string): Promise<boolean> {
  const r = await runScript('record-operator-action.ts', { stdin: JSON.stringify({ prompt }), cwd: dir });
  expect(r.exitCode).toBe(0);
  return fs.existsSync(path.join(dir, '.hermit', 'state', 'last-operator-action.json'));
}

const focus = 'focus on unfinished work, pending operator items, and in-flight decisions';
for (const [label, inflight, prompt] of [
  ['a queued compaction with its focus', [{ command: '/compact', arg: focus }], `/compact ${focus}`],
  ['a queued model switch', [{ command: '/model', arg: 'sonnet' }], '/model sonnet'],
  ['a queued clear', [{ command: '/clear', arg: null }], '/clear'],
  ['the second leg of an update batch', [{ command: '/reload-plugins', arg: null }, { command: '/hermitd:hermit-evolve', arg: 'unattended' }], '/hermitd:hermit-evolve unattended'],
  ['a queued monitor re-arm', [{ command: '/hermitd:heartbeat', arg: 'start' }], '/hermitd:heartbeat start'],
] as const) {
  test(`${label} is not operator activity`, async () => {
    expect(await counted(fixture([...inflight]), prompt)).toBe(false);
  });
}

for (const [label, inflight, prompt] of [
  ['a typed clear with nothing in flight', null, '/clear'],
  ['a typed compaction with nothing in flight', null, '/compact'],
  ['a typed model switch to another model', [{ command: '/model', arg: 'sonnet' }], '/model opus'],
  ['a typed heartbeat run with nothing in flight', null, '/hermitd:heartbeat run'],
] as const) {
  test(`${label} counts as operator activity`, async () => {
    expect(await counted(fixture(inflight ? [...inflight] : null), prompt)).toBe(true);
  });
}

test('the boot skill is never operator activity', async () => {
  expect(await counted(fixture(null), '/hermitd:resident-start')).toBe(false);
});

test('multi-skill bootstrap is never operator activity', async () => {
  expect(await counted(fixture(null), 'Always-on bootstrap. Invoke these skills in order: (1) /hermitd:hermit-routines load, (2) /hermitd:resident-start.')).toBe(false);
});
