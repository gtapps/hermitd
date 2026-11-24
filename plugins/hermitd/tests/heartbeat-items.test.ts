import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeItemKey } from '../scripts/lib/heartbeat-items';
import { runPinnedScript } from './helpers/run';
import { withDir } from './helpers/workdir';

test('heartbeat item verbs normalize, dedupe, remove one line and audit changes', withDir(async dir => {
  const state = path.join(dir, '.hermit');
  const heartbeat = path.join(state, 'HEARTBEAT.md');
  const original = '# Heartbeat Checklist\r\n\r\n- Check for announcements.\r\n';
  const item = '- [ ] Keep checking until the supplier price drops. [act]';
  const key = normalizeItemKey('- Keep checking until the supplier price drops.');
  expect(key).toMatch(/^checklist:/);
  fs.writeFileSync(heartbeat, original);

  const run = async (args: string[], stdin?: string) => {
    const result = await runPinnedScript('heartbeat.ts', state, args, { cwd: dir, stdin });
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout);
  };
  expect(await run(['item-key'], item + '\n')).toEqual({ key });
  expect(await run(['item-key'], '- [act]\n')).toEqual({ status: 'none', reason: 'no_key' });
  expect(await run(['add-item', '.hermit'], item + '\n')).toEqual({ status: 'added', key });
  expect(await run(['add-item', '.hermit'], '- Keep checking until the supplier price drops.\n')).toEqual({ status: 'none', reason: 'exists', key });
  expect(fs.readFileSync(heartbeat, 'utf8')).toBe(original + item + '\r\n');

  expect(await run(['remove-item', '.hermit', String(key)])).toEqual({ status: 'removed' });
  expect(await run(['remove-item', '.hermit', String(key)])).toEqual({ status: 'none', reason: 'not_found' });
  expect(fs.readFileSync(heartbeat, 'utf8')).toBe(original);
  const history = await runPinnedScript('settings-edit.ts', state, ['.hermit/config.json', 'history', 'HEARTBEAT.md'], { cwd: dir });
  expect(history.exitCode).toBe(0);
  const { rows } = JSON.parse(history.stdout);
  expect(rows).toHaveLength(2);
  expect(rows.map((row: { new: string }) => row.new.split(' ').slice(1).join(' ')).sort()).toEqual(['(3 lines)', '(4 lines)']);
}));
