import { test, expect } from 'bun:test';
import { validate } from '../scripts/validate-config';
import { TABLE, specAt, type Spec } from '../scripts/lib/config-read';

test('standalone clear settings are validated and the retired flag is ignored', () => {
  const valid = { context_hygiene: { clear: { enabled: true, quiet: '1h', max_age: '24h', min_tokens: 20000 } }, tasks: { queue_nudge_minutes: 60 } };
  expect(validate(valid).errors.filter(e => /context_hygiene|tasks/.test(e))).toEqual([]);
  expect(validate({ post_close_clear: 'retired' }).errors.some(e => e.includes('post_close_clear'))).toBe(false);
  for (const [key, value] of [['enabled', 'yes'], ['quiet', 1], ['max_age', 'later'], ['min_tokens', -1]]) {
    expect(validate({ context_hygiene: { clear: { [key]: value } } }).errors.some(e => e.includes(`context_hygiene.clear.${key}`))).toBe(true);
  }
  expect(validate({ tasks: { queue_nudge_minutes: -1 } }).errors.some(e => e.includes('queue_nudge_minutes'))).toBe(true);
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

for (const [dotted, invalid] of [
  ['heartbeat.every', 123],
  ['heartbeat.stale_threshold', 'bogus'],
  ['heartbeat.waiting_timeout', -1],
  ['heartbeat.clean_recheck_cooldown', {}],
  ['routine_wake_lint.max_windows', 'x'],
  ['storage_drift.ignore', 'notarray'],
] as const) {
  test(`invalid ${dotted} names the key`, () => {
    expect(validate(configAt(dotted, invalid)).errors.some(error => error.includes(dotted))).toBe(true);
  });
}


test('optional channel plugin, send script and attribute mappings validate', () => {
  const errors = (ch: unknown) => validate({ channels: { custom: ch } }).errors.filter(e => e.startsWith('channels.custom'));
  expect(errors({})).toEqual([]);
  expect(errors({ plugin: 'custom-plugin', send_script: 'scripts/send.sh', attributes: {
    chat_id: 'channel_id', message_id: 'ts', user_id: 'user', user: 'user_name', thread_id: 'thread_ts', mentioned: 'event=mention',
  } })).toEqual([]);
  for (const plugin of [null, 1, '', 'a@b', 'a b']) expect(errors({ plugin }).some(e => e.includes('.plugin'))).toBe(true);
  for (const send_script of [null, 1, '', '/tmp/send', '../send', 'reflect', 'doctor', 'later']) {
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
