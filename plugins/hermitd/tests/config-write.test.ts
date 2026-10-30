import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { persistConfig } from '../scripts/lib/config-write';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-config-write-');
afterAll(cleanup);

function fixture() {
  const hermitDir = freshDir();
  const before = JSON.parse(fs.readFileSync(path.join(import.meta.dir, '../state-templates/config.json.template'), 'utf8'));
  const file = path.join(hermitDir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(before));
  return { hermitDir, before, file };
}

test('new errors refuse persistence and preserve bytes', () => {
  const { hermitDir, before, file } = fixture();
  const bytes = fs.readFileSync(file);
  const result = persistConfig({ hermitDir, before, after: { ...before, remote: 'invalid' }, actor: 'test' });
  expect(result.newErrors.length).toBeGreaterThan(0);
  expect(fs.readFileSync(file)).toEqual(bytes);
  expect(fs.existsSync(path.join(hermitDir, 'state/settings-audit.jsonl'))).toBe(false);
});

test('kept errors pass and new warnings surface', () => {
  const { hermitDir, before, file } = fixture();
  before.remote = 'invalid';
  const after = { ...before, settings_permissions: {} };
  const result = persistConfig({ hermitDir, before, after, actor: 'test' });
  expect(result.newErrors).toEqual([]);
  expect(result.keptErrors.length).toBeGreaterThan(0);
  expect(result.newWarnings.length).toBeGreaterThan(0);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(after);
});

test('explicit priorErrors revalidates an existing error', () => {
  const { hermitDir, before, file } = fixture();
  before.remote = 'invalid';
  const bytes = fs.readFileSync(file);
  const result = persistConfig({ hermitDir, before, after: before, actor: 'test', priorErrors: [] });
  expect(result.newErrors).toContain('remote: expected boolean, got string');
  expect(result.keptErrors).toEqual([]);
  expect(fs.readFileSync(file)).toEqual(bytes);
});

test('undefined before records one creation row and does not forgive missing keys', () => {
  const { hermitDir, before } = fixture();
  expect(persistConfig({ hermitDir, before: undefined, after: {}, actor: 'test' }).newErrors.length).toBeGreaterThan(0);
  const result = persistConfig({ hermitDir, before: undefined, after: before, actor: 'test' });
  expect(result.newErrors).toEqual([]);
  const rows = fs.readFileSync(path.join(hermitDir, 'state/settings-audit.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ actor: 'test', path: '*', new: 'config created' });
});

test('changed timezones canonicalize and invalid zones preserve config', () => {
  const { hermitDir, before, file } = fixture();
  const after = { ...before, timezone: 'europe/lisbon' };
  expect(persistConfig({ hermitDir, before, after, actor: 'test' }).newErrors).toEqual([]);
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).timezone).toBe('Europe/Lisbon');
  for (const timezone of ['+01:00', 'nowhere/invalid', '']) {
    const bytes = fs.readFileSync(file);
    expect(persistConfig({ hermitDir, before, after: { ...before, timezone }, actor: 'test' }).newErrors).toContain('timezone: expected an IANA timezone name');
    expect(fs.readFileSync(file)).toEqual(bytes);
  }
});

test('unchanged legacy timezone still saves', () => {
  const { hermitDir, before } = fixture();
  before.timezone = '+01:00';
  expect(persistConfig({ hermitDir, before, after: { ...before, agent_name: 'Agent' }, actor: 'test' }).newErrors).toEqual([]);
});
