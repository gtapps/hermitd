// Unit tests for scripts/lib/channel-auth.ts and its normalizeChannelSource
// dependency (scripts/lib/channel-envelope.ts) — the shared config-lookup gate
// behind pause-keyword.ts, channel-reply-reminder.ts, and
// channel-status-responder.ts. Pure exported helpers, tested in-process (not
// via runScript) per the repo convention (see tests/pause-lib.test.ts).
//
// Usage: bun test tests/channel-auth.test.ts   (from the plugin root)

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setupWorkdir } from './helpers/workdir';
import { normalizeChannelSource, parseChannelEnvelope } from '../scripts/lib/channel-envelope';
import {
  isAllowedSender, isTrustedController, recallScope, audienceVisible,
} from '../scripts/lib/channel-auth';

const scopeWorkdir = setupWorkdir();
const scopeDir = path.join(scopeWorkdir.dir, '.hermit');
afterAll(() => scopeWorkdir.cleanup());

describe('normalizeChannelSource', () => {
  test('plugin-qualified source — returns the server name', () => {
    expect(normalizeChannelSource('plugin:discord:discord')).toBe('discord');
    expect(normalizeChannelSource('plugin:voice:voice')).toBe('voice');
  });

  test('bare source — passes through unchanged', () => {
    expect(normalizeChannelSource('discord')).toBe('discord');
  });

  test('non-plugin colon string — passes through unchanged', () => {
    expect(normalizeChannelSource('foo:bar')).toBe('foo:bar');
  });

  test('more than two segments after plugin: — NOT normalized (unrecognized shape)', () => {
    expect(normalizeChannelSource('plugin:a:b:c')).toBe('plugin:a:b:c');
  });

  test('empty string — passes through unchanged', () => {
    expect(normalizeChannelSource('')).toBe('');
  });
});

describe('isAllowedSender with plugin-qualified sources', () => {
  test('qualified source resolves to bare-keyed config allowlist', () => {
    const config = { channels: { discord: { allowed_users: ['U1'] } } };
    expect(isAllowedSender(config, 'plugin:discord:discord', 'U1')).toBe(true);
    expect(isAllowedSender(config, 'plugin:discord:discord', 'STRANGER')).toBe(false);
  });

  test('no allowlist configured, qualified source — accept-all fallback still applies', () => {
    const config = { channels: { discord: {} } };
    expect(isAllowedSender(config, 'plugin:discord:discord', 'ANYONE')).toBe(true);
  });

  test('qualified source, no matching config entry at all — accept-all fallback (absent allowlist)', () => {
    const config = { channels: {} };
    expect(isAllowedSender(config, 'plugin:discord:discord', 'ANYONE')).toBe(true);
  });
});

describe('isTrustedController with plugin-qualified sources', () => {
  test('DM-binding match on a qualified source, no allowlist configured', () => {
    const config = { channels: { discord: { default_chat_id: '1' } } };
    expect(isTrustedController(config, 'plugin:discord:discord', 'U1', '1')).toBe(true);
    expect(isTrustedController(config, 'plugin:discord:discord', 'U1', '99')).toBe(false);
  });

  test('explicit allowlist on a qualified source wins over DM binding', () => {
    const config = { channels: { discord: { allowed_users: ['ALLOWED'], default_chat_id: '1' } } };
    expect(isTrustedController(config, 'plugin:discord:discord', 'ALLOWED', '99')).toBe(true);
    expect(isTrustedController(config, 'plugin:discord:discord', 'STRANGER', '1')).toBe(false);
  });

  test('allowed_users=[] lockdown on a qualified source — nobody trusted', () => {
    const config = { channels: { discord: { allowed_users: [] } } };
    expect(isTrustedController(config, 'plugin:discord:discord', 'ANYONE', '1')).toBe(false);
  });

  test('normalized bare key is authoritative — the send path uses the same key, so auth must too', () => {
    // A config keyed ONLY by the qualified form is off-convention and does not
    // resolve: the send path always looks up the normalized bare name, so if the
    // auth gate honored the qualified key it would pass a sender the send path
    // can't route/token (the #634 auth/send split). The bare key is the one truth.
    const qualifiedOnly = { channels: { 'plugin:discord:discord': { default_chat_id: '1' } } };
    expect(isTrustedController(qualifiedOnly, 'plugin:discord:discord', 'U1', '1')).toBe(false);

    // When both forms are present, the normalized (bare) key wins.
    const both = {
      channels: {
        'plugin:discord:discord': { default_chat_id: '1' },
        discord: { default_chat_id: '99' },
      },
    };
    expect(isTrustedController(both, 'plugin:discord:discord', 'U1', '99')).toBe(true);
    expect(isTrustedController(both, 'plugin:discord:discord', 'U1', '1')).toBe(false);
  });

  test('genericity: an unrecognized custom channel plugin normalizes the same way', () => {
    const config = { channels: { crm: { default_chat_id: '1' } } };
    expect(isTrustedController(config, 'plugin:acme-crm:crm', 'U1', '1')).toBe(true);
  });

  test('no config entry matches, qualified or normalized — untrusted (fails closed)', () => {
    const config = { channels: {} };
    expect(isTrustedController(config, 'plugin:discord:discord', 'U1', '1')).toBe(false);
  });
});

// Without an allowlist, only a seeded home grants control authority.
describe('isTrustedController — pinned-home anchor', () => {
  test('the pin is the anchor', () => {
    const config = { channels: { discord: { default_chat_id: 'HOME' } } };
    expect(isTrustedController(config, 'discord', 'U1', 'HOME')).toBe(true);
    expect(isTrustedController(config, 'discord', 'U1', 'OTHER')).toBe(false);
  });

  test('an unseeded home grants no control authority', () => {
    const config = { channels: { discord: {} } };
    expect(isTrustedController(config, 'discord', 'U1', 'D1')).toBe(false);
  });

  test('an explicit allowlist still wins over the pin', () => {
    const config = {
      channels: { discord: { allowed_users: ['ALLOWED'], default_chat_id: 'HOME' } },
    };
    expect(isTrustedController(config, 'discord', 'ALLOWED', 'ANY')).toBe(true);
    expect(isTrustedController(config, 'discord', 'STRANGER', 'HOME')).toBe(false);
  });

  test('allowed_users=[] lockdown is not reopened by a matching pin', () => {
    const config = { channels: { discord: { allowed_users: [], default_chat_id: 'HOME' } } };
    expect(isTrustedController(config, 'discord', 'ANYONE', 'HOME')).toBe(false);
  });
});

// Both predicate variants must agree once the reply stage has warmed the cache.
import { isPassiveChat, isPassiveChatSync, isSelfMentioned, isSelfMentionedSync } from '../scripts/lib/channel-auth';

test('passive predicates use listed ids and cached parents, with exact self-mentions', async () => {
  const wd = setupWorkdir();
  const dir = path.join(wd.dir, '.hermit');
  const config = { channels: {
    discord: { passive_chats: ['parent'], bot_user_id: '123' },
    telegram: { passive_chats: ['group'], bot_user_id: '123', bot_username: 'hermitbot' },
  } };
  try {
    expect(isPassiveChatSync(dir, config, 'discord', 'parent')).toBe(true);
    expect(isPassiveChatSync(dir, config, 'discord', 'thread')).toBe(false);
    fs.writeFileSync(path.join(dir, 'state', 'channel-chats.json'), JSON.stringify({ discord: {
      chats: { thread: { parent_id: 'parent', guild_id: 'guild', type: 11, fetched_at: new Date().toISOString() },
        failed: { error: 403, fetched_at: new Date().toISOString() } },
      guilds: { guild: { role_ids: ['456'], fetched_at: new Date().toISOString() } },
    } }));
    for (const predicate of [isPassiveChatSync, isPassiveChat]) {
      expect(await predicate(dir, config, 'discord', 'parent')).toBe(true);
      expect(await predicate(dir, config, 'discord', 'thread')).toBe(true);
      expect(await predicate(dir, config, 'discord', 'failed')).toBe(false);
      expect(await predicate(dir, config, 'telegram', 'thread')).toBe(false);
      expect(await predicate(dir, { channels: { discord: { passive_chats: [] } } }, 'discord', 'thread')).toBe(false);
    }
    for (const predicate of [isSelfMentionedSync, isSelfMentioned]) {
      for (const body of ['hello <@123>', 'hello <@!123>', 'hello <@&456>']) {
        expect(await predicate(dir, config, 'discord', 'thread', body)).toBe(true);
      }
      for (const body of ['number 123 here', '<@1234>', '<@&789>', '@hermitbot']) {
        expect(await predicate(dir, config, 'discord', 'thread', body)).toBe(false);
      }
      for (const body of ['hello @HermitBot!', '@hermitbot', 'id 123.']) {
        expect(await predicate(dir, config, 'telegram', 'group', body)).toBe(true);
      }
      for (const body of ['@hermitbot_extra', '@hermitbotx', 'mail@hermitbot', 'id 1234']) {
        expect(await predicate(dir, config, 'telegram', 'group', body)).toBe(false);
      }
    }
  } finally { wd.cleanup(); }
});


describe('recallScope', () => {
  const own = { source: 'discord', chat_id: 'C1' };
  test('maintainer and technical home are unscoped, non-technical home is scoped', () => {
    for (const operator_profile of ['technical', 'non-technical']) {
      const config = { operator_profile, channels: { discord: { default_chat_id: 'C1', maintainer_channel_id: 'MAINT' } } };
      expect(recallScope(config, 'discord', 'MAINT', scopeDir)).toBeNull();
      expect(recallScope(config, 'discord', 'C1', scopeDir)).toEqual(operator_profile === 'technical' ? null : { own, shared: [] });
    }
    expect(recallScope({ channels: { discord: { default_chat_id: 'C1' } } }, 'discord', 'C1', scopeDir)).toBeNull();
  });
  test('missing config or unknown key stays own-only despite shared chats elsewhere', () => {
    for (const config of [null, {}, { channels: { telegram: { shared_chats: ['T1'] } } }]) {
      expect(recallScope(config, 'discord', 'C1', scopeDir)).toEqual({ own, shared: [] });
    }
  });
  test('channel widening and shared pairs across channels', () => {
    const config = { channels: { discord: { isolate_chats: false, shared_chats: ['C2'] }, telegram: { shared_chats: ['T1'] } } };
    expect(recallScope(config, 'discord', 'C1', scopeDir)).toEqual({ own, channel: 'discord', shared: [
      { source: 'discord', chat_id: 'C2' }, { source: 'telegram', chat_id: 'T1' },
    ] });
  });
});

describe('audienceVisible', () => {
  test('unscoped reader and shared/absent audience are always visible', () => {
    expect(audienceVisible(null, 'discord:C2')).toBe(true);
    expect(audienceVisible(undefined, 'discord:C2')).toBe(true);
    const scoped = recallScope({ channels: { discord: {} } }, 'discord', 'C1', scopeDir);
    expect(audienceVisible(scoped, undefined)).toBe(true);
    expect(audienceVisible(scoped, null)).toBe(true);
    expect(audienceVisible(scoped, 'shared')).toBe(true);
  });

  test("C2's own scope cannot see discord:HOME", () => {
    const scope = recallScope({ channels: { discord: { default_chat_id: 'HOME' } } }, 'discord', 'C2', scopeDir);
    expect(audienceVisible(scope, 'discord:HOME')).toBe(false);
    expect(audienceVisible(scope, 'discord:C2')).toBe(true);
  });

  test('shared_chats grants the pair to another channel and removing it revokes', () => {
    const granted = recallScope(
      { channels: { discord: { shared_chats: ['C2'] }, acme: {} } },
      'acme', 'X', scopeDir,
    );
    expect(audienceVisible(granted, 'discord:C2')).toBe(true);
    const revoked = recallScope(
      { channels: { discord: { shared_chats: [] }, acme: {} } },
      'acme', 'X', scopeDir,
    );
    expect(audienceVisible(revoked, 'discord:C2')).toBe(false);
  });

  test('isolate_chats: false widens same-channel ids, not other channels', () => {
    const scope = recallScope(
      { channels: { discord: { isolate_chats: false } } },
      'discord', 'C1', scopeDir,
    );
    expect(audienceVisible(scope, 'discord:C2')).toBe(true);
    expect(audienceVisible(scope, 'telegram:C2')).toBe(false);
  });

  test('malformed audience strings are hidden', () => {
    const scope = recallScope({ channels: { discord: {} } }, 'discord', 'C1', scopeDir);
    expect(audienceVisible(scope, 'discord')).toBe(false);
    expect(audienceVisible(scope, ':C2')).toBe(false);
  });

  test('chat id with a colon round-trips through the first-colon split', () => {
    const scope = recallScope({ channels: { discord: {} } }, 'discord', 'C:1', scopeDir);
    expect(audienceVisible(scope, 'discord:C:1')).toBe(true);
  });
});


test('plugin mention markers match only an unambiguous attribute value', async () => {
  for (const [marker, attrs, expected] of [
    ['mentioned', 'mentioned="true"', true],
    ['event=mention', 'event="mention"', true],
    ['event=mention', 'event="message"', false],
    ['event=mention', 'event="mention" event="mention"', false],
    ['mentioned', 'mentioned="false"', false],
    ['mentioned', '', false],
  ] as const) {
    const config = { channels: { custom: { attributes: { mentioned: marker } } } };
    const envelope = parseChannelEnvelope(`<channel source="custom" chat_id="C1" ${attrs}>hello</channel>`)!;
    expect(isSelfMentionedSync('/unused', config, 'custom', 'C1', envelope.body, envelope)).toBe(expected);
    expect(await isSelfMentioned('/unused', config, 'custom', 'C1', envelope.body, envelope)).toBe(expected);
  }
});

for (const type of [10, 11, 12]) test(`thread type ${type} inherits parent recall`, () => {
  const wd = setupWorkdir();
  const dir = path.join(wd.dir, '.hermit');
  fs.writeFileSync(path.join(dir, 'state/channel-chats.json'), JSON.stringify({ discord: { chats: {
    THREAD: { type, parent_id: 'PARENT', guild_id: 'guild', fetched_at: new Date().toISOString() },
    PARENT: { type: 0, parent_id: 'CATEGORY', guild_id: 'guild', fetched_at: new Date().toISOString() },
  } } }));
  try {
    for (const operator_profile of ['technical', 'non-technical']) {
      const config = { operator_profile, channels: { discord: { default_chat_id: 'PARENT' } } };
      const scope = recallScope(config, 'discord', 'THREAD', dir);
      if (operator_profile === 'technical') expect(scope).toBeNull();
      else expect(scope).toMatchObject({ own: { source: 'discord', chat_id: 'THREAD' }, shared: [{ source: 'discord', chat_id: 'PARENT' }] });
    }
    expect(recallScope({ channels: { discord: { maintainer_channel_id: 'PARENT' } } }, 'discord', 'THREAD', dir)).toBeNull();
    const config = { channels: { discord: {} } };
    const scope = recallScope(config, 'discord', 'THREAD', dir);
    expect(audienceVisible(scope, 'discord:PARENT')).toBe(true);
    expect(audienceVisible(scope, 'discord:SIBLING')).toBe(false);
    const parentScope = recallScope(config, 'discord', 'PARENT', dir);
    expect(audienceVisible(parentScope, 'discord:THREAD')).toBe(false);
    expect(audienceVisible(parentScope, 'discord:CATEGORY')).toBe(false);
    expect(recallScope(config, 'discord', 'UNCACHED', dir)).toMatchObject({ shared: [] });
    expect(recallScope({ channels: { telegram: {} } }, 'telegram', 'THREAD', dir)).toMatchObject({ shared: [] });
  } finally { wd.cleanup(); }
});
