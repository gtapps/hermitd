import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import { armFirstChat, clearFirstChat, readFirstChat, deliveredFirstChat } from '../scripts/lib/first-chat';
import { freshDirFactory } from './helpers/workdir';
import { runScript } from './helpers/run';
const { freshDir, cleanup } = freshDirFactory('first-chat-');
afterAll(cleanup);
test('clear absent marker is a no-op; arm and cap deliveries', async () => {
  const dir = freshDir();
  clearFirstChat(dir); expect(readFirstChat(dir)).toBeNull();
  for (const verb of ['clear', 'arm']) {
    const r = await runScript('first-chat.ts', { args: [verb], env: { AGENT_DIR: dir } });
    expect(r.exitCode).toBe(0); expect(r.stdout.trim()).toBe('OK');
  }
  expect(readFirstChat(dir)).toMatchObject({ attempts: 0, armed_at: expect.any(String) });
  deliveredFirstChat(dir); expect(readFirstChat(dir)?.attempts).toBe(1);
  deliveredFirstChat(dir); deliveredFirstChat(dir); expect(readFirstChat(dir)).toBeNull();
  armFirstChat(dir); expect(fs.readdirSync(dir)).toContain('state');
});
