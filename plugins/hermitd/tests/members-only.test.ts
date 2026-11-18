// `channels.<key>.members_only: true` makes every sender on that channel a plain
// member: no control, operator, sign-in or unscoped-recall authority, no home
// pin, never the outbound channel. Admission still follows `allowed_users`.
//
// Usage: bun test tests/members-only.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import {
  isAllowedSender, isTrustedController, isPrimaryOperator, canCompleteAuthentication, recallScope,
} from '../scripts/lib/channel-auth';
import { seedDefaultChatId } from '../scripts/channel-hook';
import { eligible, resolve } from '../scripts/resolve-outbound-channel';
import { validate } from '../scripts/validate-config';

const HOME = 'c-1';

function config(entry: Record<string, unknown>, profile = 'technical'): any {
  return { operator_profile: profile, channels: { connector: { enabled: true, ...entry } } };
}

describe('members_only authority', () => {
  const shapes: [string, Record<string, unknown>][] = [
    ['home chat, no lists', { default_chat_id: HOME }],
    ['sender listed in allowed_users', { default_chat_id: HOME, allowed_users: ['u1'] }],
    ['sender listed in operators', { default_chat_id: HOME, operators: ['u1'] }],
    ['maintainer chat', { maintainer_channel_id: HOME }],
  ];
  for (const [name, entry] of shapes) {
    test(`${name}: no control, operator or sign-in authority`, () => {
      const on = config({ ...entry, members_only: true });
      expect(isTrustedController(on, 'plugin:hermitd-connector:connector', 'u1', HOME)).toBe(false);
      expect(isPrimaryOperator(on, 'connector', 'u1', HOME)).toBe(false);
      expect(canCompleteAuthentication(on, 'connector', 'u1', HOME)).toBe(false);
    });
  }

  test('without the key the same shapes keep their authority', () => {
    expect(isTrustedController(config({ default_chat_id: HOME }), 'connector', 'u1', HOME)).toBe(true);
    expect(isPrimaryOperator(config({ allowed_users: ['u1'] }), 'connector', 'u1', HOME)).toBe(true);
    expect(canCompleteAuthentication(config({ default_chat_id: HOME }), 'connector', 'u1', HOME)).toBe(true);
    expect(recallScope(config({ default_chat_id: HOME }), 'connector', HOME, '/nonexistent')).toBeNull();
  });

  test('admission still follows allowed_users', () => {
    const on = config({ members_only: true, allowed_users: ['u1'] });
    expect(isAllowedSender(on, 'connector', 'u1')).toBe(true);
    expect(isAllowedSender(on, 'connector', 'u2')).toBe(false);
    expect(isAllowedSender(config({ members_only: true }), 'connector', 'anyone')).toBe(true);
  });

  for (const field of ['default_chat_id', 'maintainer_channel_id']) {
    test(`recall stays scoped for the ${field} chat`, () => {
      const scope = recallScope(config({ members_only: true, [field]: HOME }), 'connector', HOME, '/nonexistent');
      expect(scope).not.toBeNull();
      expect(scope.own).toEqual({ source: 'connector', chat_id: HOME });
    });
  }

  test('a non-boolean value grants nothing extra and removes nothing', () => {
    expect(isTrustedController(config({ default_chat_id: HOME, members_only: 'yes' }), 'connector', 'u1', HOME)).toBe(true);
  });
});

describe('members_only routing', () => {
  test('a reply never pins a home', () => {
    const on: any = config({ members_only: true, default_chat_id: null });
    expect(seedDefaultChatId(on, 'connector', HOME, true)).toBe(false);
    expect(on.channels.connector.default_chat_id).toBeNull();
  });

  test('never eligible as the outbound channel, even as primary or the only channel', () => {
    const entry = { enabled: true, members_only: true, default_chat_id: HOME };
    expect(eligible(entry)).toBe(false);
    expect(resolve({ connector: entry })).toBeNull();
    expect(resolve({ primary: 'connector', connector: entry })).toBeNull();
    expect(resolve({ connector: entry, discord: { enabled: true, default_chat_id: 'D1' } })).toEqual({ id: 'discord', chat_id: 'D1' });
  });
});

describe('members_only validation', () => {
  test('a non-boolean value fails validation; a boolean passes', () => {
    const errors = (value: unknown) => validate({ channels: { connector: { members_only: value } } }).errors
      .filter((e: string) => e.includes('members_only'));
    expect(errors('yes')).toEqual(['channels.connector.members_only: must be a boolean']);
    expect(errors(true)).toEqual([]);
  });
});
