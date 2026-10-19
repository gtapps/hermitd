import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { withDir } from './helpers/workdir';
import { clearGuest, markGuest } from '../scripts/lib/guest-marker';

const id = 'guest-state-test';
const state = (dir: string, name: string) => path.join(dir, '.hermit', 'state', name);

describe('guest prompt ownership', () => {
  for (const script of ['user-prompt-pipeline.ts', 'record-operator-action.ts']) {
    for (const idKey of ['session_id', 'sessionId']) {
      test(`${script} preserves resident activity with ${idKey}`, withDir(async (dir) => {
        markGuest(state(dir, ''), id);
        for (const name of ['last-operator-action.json', 'operator-turn-open.json']) {
          fs.writeFileSync(state(dir, name), '{"at":"2000-01-01T00:00:00Z"}');
        }
        const result = await runScript(script, {
          cwd: dir, stdin: JSON.stringify({ [idKey]: id, prompt: '/example:skill' }),
        });
        expect(result.exitCode).toBe(0);
        for (const name of ['last-operator-action.json', 'operator-turn-open.json']) {
          expect(fs.readFileSync(state(dir, name), 'utf-8')).toBe('{"at":"2000-01-01T00:00:00Z"}');
        }
      }));
    }
  }

  test('guest cannot pause the resident through a channel prompt', withDir(async (dir) => {
    markGuest(state(dir, ''), id);
    fs.writeFileSync(path.join(dir, '.hermit', 'config.json'), JSON.stringify({
      channels: { telegram: { enabled: true, default_chat_id: '1', allowed_users: ['u1'] } },
    }));
    const input = JSON.stringify({
      session_id: id, prompt: '<channel source="telegram" chat_id="1" user="u1">!pause</channel>',
    });
    await runScript('user-prompt-pipeline.ts', { cwd: dir, stdin: input });
    expect(fs.existsSync(state(dir, 'operator-pause.json'))).toBe(false);
    clearGuest(state(dir, ''), id);
    await runScript('user-prompt-pipeline.ts', { cwd: dir, stdin: input });
    expect(fs.existsSync(state(dir, 'operator-pause.json'))).toBe(true);
  }));
});
