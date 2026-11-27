import { test, expect, describe } from 'bun:test';
import { validate } from '../scripts/validate-config';
import { TABLE, specAt, type Spec } from '../scripts/lib/config-read';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT } from './helpers/run';

test('standalone clear settings are validated and the retired flag is ignored', () => {
  const valid = { context_hygiene: { clear: { enabled: true, quiet: '1h', max_age: '24h', min_tokens: 20000 } }, tasks: { queue_nudge_minutes: 60 } };
  expect(validate(valid).errors.filter(e => /context_hygiene|tasks/.test(e))).toEqual([]);
  expect(validate({ post_close_clear: 'retired' }).errors.some(e => e.includes('post_close_clear'))).toBe(false);
  for (const [key, value] of [['enabled', 'yes'], ['quiet', 1], ['max_age', 'later'], ['min_tokens', -1]]) {
    expect(validate({ context_hygiene: { clear: { [key]: value } } }).errors.some(e => e.includes(`context_hygiene.clear.${key}`))).toBe(true);
  }
  expect(validate({ tasks: { queue_nudge_minutes: -1 } }).errors.some(e => e.includes('queue_nudge_minutes'))).toBe(true);
});

test('remote environment names and IDs validate', () => {
  const errors = (environments: unknown) =>
    validate({ remote_environments: environments }).errors.filter(error => error.startsWith('remote_environments'));
  expect(errors({ 'Laptop.local_1-2': 'env_Ab12' })).toEqual([]);
  expect(errors({ 'bad name': 'env_Ab12' })).toEqual(['remote_environments: invalid name "bad name"']);
  expect(errors({ laptop: 'session_Ab12' })).toEqual(['remote_environments.laptop: must be an env_ ID']);
});

function configAt(dotted: string, value: unknown): Record<string, unknown> {
  return dotted.split('.').reverse().reduce<Record<string, unknown> | unknown>(
    (nested, key) => ({ [key]: nested }), value,
  ) as Record<string, unknown>;
}

function constrainedLeaves(rows: Record<string, Spec>, prefix = ''): Array<[string, unknown]> {
  return Object.entries(rows).flatMap(([key, spec]): Array<[string, unknown]> => {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (spec.kind === 'shape') return constrainedLeaves(spec.sub, dotted);
    if (spec.kind === 'string') {
      if (spec.enum) return [[dotted, 'zz']];
      if (spec.pattern) return [[dotted, spec.pattern === 'duration' ? 123 : '8am']];
    }
    if (spec.kind === 'number' && spec.range) return [[dotted, spec.range[0] - 1]];
    return [];
  });
}

test('heartbeat.every declares its duration constraint', () => {
  const spec = specAt('heartbeat.every');
  expect(spec?.kind === 'string' && spec.pattern).toBe('duration');
});

for (const [dotted, invalid] of constrainedLeaves(TABLE)) {
  test(`table constraint rejects invalid ${dotted}`, () => {
    expect(validate(configAt(dotted, invalid)).errors.some(error => error.includes(dotted))).toBe(true);
  });
}

test('invalid storage_drift.ignore names the key', () => {
  expect(validate(configAt('storage_drift.ignore', 'notarray')).errors.some(error => error.includes('storage_drift.ignore'))).toBe(true);
});


test('optional channel plugin, send script and attribute mappings validate', () => {
  const errors = (ch: unknown) => validate({ channels: { custom: ch } }).errors.filter(e => e.startsWith('channels.custom'));
  expect(errors({})).toEqual([]);
  expect(errors({ plugin: 'custom-plugin', send_script: 'scripts/send.sh', attributes: {
    chat_id: 'channel_id', message_id: 'ts', user_id: 'user', user: 'user_name', thread_id: 'thread_ts', mentioned: 'event=mention',
  } })).toEqual([]);
  for (const plugin of [null, 1, '', 'a@b', 'a b']) expect(errors({ plugin }).some(e => e.includes('.plugin'))).toBe(true);
  for (const send_script of [null, 1, '', '/tmp/send', '../send', 'reflect', 'doctor', 'later', 'dream']) {
    expect(errors({ send_script }).some(e => e.includes('.send_script'))).toBe(true);
  }
  for (const attributes of [null, [], 'chat_id']) expect(errors({ attributes }).some(e => e.includes('.attributes'))).toBe(true);
  for (const key of ['chat_id', 'message_id', 'user_id', 'user', 'thread_id', 'unknown']) {
    expect(errors({ attributes: { [key]: 'bad-name' } }).some(e => e.includes(`.attributes.${key}`))).toBe(true);
    expect(errors({ attributes: { [key]: 1 } }).some(e => e.includes(`.attributes.${key}`))).toBe(true);
  }
  for (const mentioned of ['event=', 'event=a=b', 'event=bad value', 'bad-name']) {
    expect(errors({ attributes: { mentioned } }).some(e => e.includes('.attributes.mentioned'))).toBe(true);
  }
  expect(errors({ attributes: { mentioned: 'mentioned' } })).toEqual([]);
  for (const attributes of [{ user_id: 'user' }, { user: 'user_id' }, { user_id: 'id', user: 'id' }]) {
    expect(errors({ attributes }).some(e => e.includes('.attributes.user_id'))).toBe(true);
  }
});

test('config watches ignore retired persistent and timeout_ms fields', () => {
  const result = validate({ monitors: [{
    id: 'sample', description: 'Sample watch', command: 'tail -f events.log',
    enabled: true, persistent: 'retired', timeout_ms: -1,
  }] });
  expect(result.errors.filter(e => e.includes('monitors'))).toEqual([]);
  expect(result.warnings.filter(e => e.includes('monitors'))).toEqual([]);
});

test('channel format accepts only declared converters or passthrough', () => {
  const errors = (format: unknown) => validate({ channels: { custom: { format } } }).errors.filter(e => e.includes('channels.custom.format'));
  for (const format of ['discord', 'telegram', 'signal', 'matrix', 'mattermost', 'sms', 'bluebubbles', 'line', 'irc', 'email', 'ntfy', 'slack', 'google_chat', 'whatsapp', 'passthrough']) expect(errors(format)).toEqual([]);
  for (const format of [null, 1, '', {}, 'MarkdownV2']) expect(errors(format).length).toBe(1);
});


test('channel recovery max_age requires a duration', () => {
  expect(validate({ channel_recovery: { enabled: true, max_age: '6h' } }).errors.filter(error => error.includes('channel_recovery'))).toEqual([]);
  expect(validate({ channel_recovery: { max_age: 'tomorrow' } }).errors.some(error => error.includes('channel_recovery.max_age'))).toBe(true);
});

test('retry_after_crash is optional boolean and does not change the registered prompt hash', () => {
  const routine = { id: 'r', skill: 'test:run', schedule: '0 9 * * *', enabled: true };
  for (const value of [true, false, undefined]) {
    expect(validate({ routines: [{ ...routine, retry_after_crash: value }] }).errors.filter(e => e.includes('retry_after_crash'))).toEqual([]);
  }
  for (const value of [null, 'false', 0]) {
    expect(validate({ routines: [{ ...routine, retry_after_crash: value }] }).errors.some(e => e.includes('retry_after_crash'))).toBe(true);
  }
  const { promptHash } = require('../scripts/lib/routines/registry');
  expect(promptHash(routine, routine.schedule, '/plugin')).toBe(promptHash({ ...routine, retry_after_crash: false }, routine.schedule, '/plugin'));
});

 test('approvals accepts only the two modes', () => {
  for (const approvals of ['personal', 'team']) expect(validate({ approvals }).errors.filter(e => e.startsWith('approvals:'))).toEqual([]);
  for (const approvals of ['', null, 1, 'custom']) expect(validate({ approvals }).errors.some(e => e.startsWith('approvals:'))).toBe(true);
});

test('timezone validation names unusable values and accepts null', () => {
  for (const timezone of ['WEST', 'CEST', '+01:00', 'Lisbon', '']) {
    expect(validate({ timezone }).errors).toContain(`timezone: "${timezone}" is not a time zone the scheduler can use`);
  }
  for (const timezone of [null, 'UTC', 'Europe/Lisbon', 'WET', 'EST']) {
    expect(validate({ timezone }).errors.filter(e => e.startsWith('timezone:'))).toEqual([]);
  }
});

describe('session-check config validation', () => {
  test('rejects legacy cadence fields and preserves custom session fields', async () => {
    const { validate } = await import('../scripts/validate-config');
    const config = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'state-templates/config.json.template'), 'utf-8'));
    const check = { id: 'custom-check', skill: 'custom:check', trigger: 'session', enabled: true, custom_key: 'preserved' };
    const errorsFor = (entry: object) => validate({ ...config, scheduled_checks: [entry] }).errors.filter((e: string) => e.startsWith('scheduled_checks'));
    expect(errorsFor(check)).toEqual([]);
    for (const entry of [{ ...check, trigger: 'interval' }, { ...check, interval_days: 7 }, { ...check, interval_days: null }]) {
      expect(errorsFor(entry)).toHaveLength(1);
      expect(errorsFor(entry)[0]).toContain('routines');
    }
  });
});

test('chat commands validate names, entries, duplicates, and sessions', () => {
  const errors = (chat_commands: unknown) => validate({ chat_commands }).errors.filter(e => e.startsWith('chat_commands'));
  expect(errors(['issues', { name: 'other', session: 'helper' }, { name: 'local', session: 'resident' }])).toEqual([]);
  for (const value of ['wrong', [42], [{}], ['UPPER'], ['x'.repeat(65)], ['a', { name: 'a' }], ['pause'], [{ name: 'x', session: 'worker' }], [{ name: 'x', extra: true }]]) {
    expect(errors(value).length).toBeGreaterThan(0);
  }
});
