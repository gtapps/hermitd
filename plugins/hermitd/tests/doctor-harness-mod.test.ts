import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { checkHarnessMod, resolvePaths } from '../scripts/doctor-check';
import { QUEUE_PROTOCOL } from '../scripts/lib/harness-mod';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-harness-mod-');
afterAll(cleanup);

for (const [label, booted, session, status, queue] of [
  ['current session', true, 'resident', 'ok', QUEUE_PROTOCOL],
  ['pre-queue mod', true, 'resident', 'warn', undefined],
  ['absent record', true, null, 'warn', QUEUE_PROTOCOL],
  ['other session', true, 'other', 'warn', QUEUE_PROTOCOL],
  ['never-started install', false, null, 'ok', QUEUE_PROTOCOL],
] as const) {
  test(label, () => {
    const root = path.join(freshDir(), '.hermit');
    const state = path.join(root, 'state');
    fs.mkdirSync(state, { recursive: true });
    if (booted) fs.writeFileSync(path.join(state, 'runtime.json'), JSON.stringify({ cc_session_id: 'resident' }));
    if (session) fs.writeFileSync(path.join(state, 'harness-mod-loaded.json'), JSON.stringify({ session_id: session, queue }));
    const result = checkHarnessMod(resolvePaths(root, path.resolve(import.meta.dir, '..')));
    expect(result.status).toBe(status);
    if (status === 'warn') expect(result.detail).toContain('chat harness commands unavailable');
    if (status === 'ok' && booted) expect(result.detail).toContain('watchdog compaction and clear, shutdown and update');
  });
}
