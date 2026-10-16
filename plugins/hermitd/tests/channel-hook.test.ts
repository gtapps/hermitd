import fs from 'node:fs';
import { Database } from 'bun:sqlite';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, afterEach } from 'bun:test';
import { persistDmChannelId, isEligibleInboundReply } from '../scripts/channel-hook';
import { validate } from '../scripts/validate-config';
import { withDir } from './helpers/workdir';
import { runScript } from './helpers/run';

// The sender allow-list gate (channel-reply-reminder.ts isAllowedSender) and
// validate-config both require channel IDs to be strings. If a channel plugin
// delivers chat_id as a JSON number, persistDmChannelId must coerce it so a
// number never lands in config.json.
//
// All of these pass isInboundReply: true — they're exercising the coercion
// and maintainer-exclusion logic, which only runs once the new turn-eligibility
// gate (see the 'inbound-turn eligibility' describe block below) has already
// passed.
describe('persistDmChannelId — dm_channel_id string coercion', () => {
  test('coerces a numeric chat_id to its string form', () => {
    const config: any = { channels: { discord: { dm_channel_id: null } } };
    const changed = persistDmChannelId(config, 'discord', 555, true);
    expect(changed).toBe(true);
    expect(config.channels.discord.dm_channel_id).toBe('555');
    expect(typeof config.channels.discord.dm_channel_id).toBe('string');
  });

  test('a numeric chat_id equal to the stored string id is a no-op', () => {
    const config: any = { channels: { discord: { dm_channel_id: '555' } } };
    expect(persistDmChannelId(config, 'discord', 555, true)).toBe(false);
    expect(persistDmChannelId(config, 'discord', '555', true)).toBe(false);
    expect(config.channels.discord.dm_channel_id).toBe('555');
  });

  test('a falsy chatId returns false and leaves the existing id untouched', () => {
    const config: any = { channels: { discord: { dm_channel_id: 'D1' } } };
    expect(persistDmChannelId(config, 'discord', null, true)).toBe(false);
    expect(config.channels.discord.dm_channel_id).toBe('D1');
  });
});

// The maintainer chat must never be re-learned as dm_channel_id — dm_channel_id
// binds operator *control* authority in lib/channel-auth.ts isTrustedController,
// and maintainer_channel_id is outbound routing for technical alerts. The two
// chats stay separate on purpose.
describe('persistDmChannelId — maintainer chat exclusion', () => {
  test('a chatId equal to maintainer_channel_id is refused, dm_channel_id untouched', () => {
    const config: any = {
      channels: { discord: { dm_channel_id: 'D1', maintainer_channel_id: 'M1' } },
    };
    expect(persistDmChannelId(config, 'discord', 'M1', true)).toBe(false);
    expect(config.channels.discord.dm_channel_id).toBe('D1');
  });

  test('a chatId equal to maintainer_channel_id is refused even when dm_channel_id is null', () => {
    const config: any = {
      channels: { discord: { dm_channel_id: null, maintainer_channel_id: 'M1' } },
    };
    expect(persistDmChannelId(config, 'discord', 'M1', true)).toBe(false);
    expect(config.channels.discord.dm_channel_id).toBe(null);
  });

  test('a numeric chatId matching a string maintainer_channel_id is still refused', () => {
    const config: any = {
      channels: { discord: { dm_channel_id: 'D1', maintainer_channel_id: '555' } },
    };
    expect(persistDmChannelId(config, 'discord', 555, true)).toBe(false);
    expect(config.channels.discord.dm_channel_id).toBe('D1');
  });

  test('a chatId different from maintainer_channel_id is still learned normally', () => {
    const config: any = {
      channels: { discord: { dm_channel_id: 'D1', maintainer_channel_id: 'M1' } },
    };
    expect(persistDmChannelId(config, 'discord', 'D2', true)).toBe(true);
    expect(config.channels.discord.dm_channel_id).toBe('D2');
  });

  // The maintainer exemption must still hold even when the reply DID open on
  // a matching inbound turn — it's defense in depth below the new eligibility
  // gate, not replaced by it.
  test('maintainer exclusion holds even when isInboundReply is true', () => {
    const config: any = {
      channels: { discord: { dm_channel_id: 'D1', maintainer_channel_id: 'M1' } },
    };
    expect(persistDmChannelId(config, 'discord', 'M1', true)).toBe(false);
    expect(config.channels.discord.dm_channel_id).toBe('D1');
  });

  // An already-clobbered install (or one configured to the same chat) can't be
  // repaired by the hook — it must be reported so doctor/the operator sees it.
  test('validate-config warns when dm_channel_id already equals maintainer_channel_id', () => {
    const { warnings } = validate({
      channels: { discord: { enabled: true, dm_channel_id: 'M1', maintainer_channel_id: 'M1' } },
    });
    expect(warnings.some(w => w.includes('discord.dm_channel_id equals maintainer_channel_id'))).toBe(true);
  });

  test('validate-config stays quiet when default_chat_id differs from dm_channel_id', () => {
    const { warnings } = validate({
      operator_profile: 'technical',
      channels: { discord: { enabled: true, default_chat_id: 'H1', dm_channel_id: 'D1' } },
    });
    expect(warnings.some(w => w.includes('looks like a shared chat'))).toBe(false);
  });

  test('validate-config warns when default_chat_id equals maintainer_channel_id', () => {
    const { warnings } = validate({
      channels: { discord: { enabled: true, default_chat_id: 'M1', maintainer_channel_id: 'M1' } },
    });
    expect(warnings.some(w => w.includes('default_chat_id equals maintainer_channel_id'))).toBe(true);
  });

  test('validate-config stays quiet when the two ids differ', () => {
    const { warnings } = validate({
      channels: { discord: { enabled: true, dm_channel_id: 'D1', maintainer_channel_id: 'M1' } },
    });
    expect(warnings.some(w => w.includes('equals maintainer_channel_id'))).toBe(false);
  });
});

// PROP-012: a proactive/scheduled reply (routine wake, heartbeat, a brief
// firing on a timer) must not be mistaken for the operator having relocated
// their primary DM. persistDmChannelId's isInboundReply gate handles the
// "did we even check" half; isEligibleInboundReply below handles "was this
// reply actually opened by a matching inbound message."
describe('persistDmChannelId — inbound-turn eligibility gate', () => {
  test('(regression) isInboundReply: true still learns dm_channel_id as before', () => {
    const config: any = { channels: { discord: { dm_channel_id: 'D1' } } };
    expect(persistDmChannelId(config, 'discord', 'D2', true)).toBe(true);
    expect(config.channels.discord.dm_channel_id).toBe('D2');
  });

  test('isInboundReply: false refuses the write and leaves dm_channel_id untouched', () => {
    const config: any = { channels: { discord: { dm_channel_id: 'D1' } } };
    expect(persistDmChannelId(config, 'discord', 'D2', false)).toBe(false);
    expect(config.channels.discord.dm_channel_id).toBe('D1');
  });
});

// default_chat_id is the pinned destination for unattended proactive sends and
// the no-allowlist trust anchor. dm_channel_id still follows the operator's last
// inbound chat; the pin is seeded once and then only moves from the terminal, so
// a message from a second chat can neither relocate briefings nor hand that chat
// operator authority.
describe('persistDmChannelId — default_chat_id pin', () => {
  test('first pairing seeds the pin from the chat that paired', () => {
    const config: any = { channels: { discord: { dm_channel_id: null, default_chat_id: null } } };
    expect(persistDmChannelId(config, 'discord', 'D1', true)).toBe(true);
    expect(config.channels.discord.dm_channel_id).toBe('D1');
    expect(config.channels.discord.default_chat_id).toBe('D1');
  });

  test('a later chat moves dm_channel_id but never the pin', () => {
    const config: any = { channels: { discord: { dm_channel_id: 'D1', default_chat_id: 'D1' } } };
    expect(persistDmChannelId(config, 'discord', 'D2', true)).toBe(true);
    expect(config.channels.discord.dm_channel_id).toBe('D2');
    expect(config.channels.discord.default_chat_id).toBe('D1');
  });

  // Pre-pin installs upgrade through here when the migration hasn't run: the
  // incumbent chat is the home, never the message that diverted the DM.
  test('unpinned install: the incumbent dm_channel_id becomes the pin, not the new chat', () => {
    const config: any = { channels: { discord: { dm_channel_id: 'HOME' } } };
    expect(persistDmChannelId(config, 'discord', 'OTHER', true)).toBe(true);
    expect(config.channels.discord.dm_channel_id).toBe('OTHER');
    expect(config.channels.discord.default_chat_id).toBe('HOME');
  });

  test('a dm_channel_id already clobbered to the maintainer chat is not pinned', () => {
    const config: any = {
      channels: { discord: { dm_channel_id: 'M1', maintainer_channel_id: 'M1' } },
    };
    expect(persistDmChannelId(config, 'discord', 'D2', true)).toBe(true);
    expect(config.channels.discord.default_chat_id).toBe('D2');
  });

  test('numeric coercion applies to the pin too', () => {
    const config: any = { channels: { discord: { dm_channel_id: null } } };
    expect(persistDmChannelId(config, 'discord', 555, true)).toBe(true);
    expect(config.channels.discord.default_chat_id).toBe('555');
    expect(typeof config.channels.discord.default_chat_id).toBe('string');
  });

  test('a refused write seeds nothing (proactive send, maintainer chat)', () => {
    const proactive: any = { channels: { discord: { dm_channel_id: 'D1' } } };
    expect(persistDmChannelId(proactive, 'discord', 'D2', false)).toBe(false);
    expect(proactive.channels.discord.default_chat_id).toBeUndefined();

    const maintainer: any = {
      channels: { discord: { dm_channel_id: 'D1', maintainer_channel_id: 'M1' } },
    };
    expect(persistDmChannelId(maintainer, 'discord', 'M1', true)).toBe(false);
    expect(maintainer.channels.discord.default_chat_id).toBeUndefined();
  });
});

// isEligibleInboundReply reads a tail window of the transcript file named by
// event.transcript_path, finds the boundary prompt that opened the current
// turn, and checks it's a <channel> envelope from the SAME chat as the reply.
describe('isEligibleInboundReply — transcript-derived eligibility', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  function writeTranscript(lines: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-hook-test-'));
    tmpDirs.push(dir);
    const tmpFile = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(tmpFile, lines.map(l => JSON.stringify({ type: 'user', message: { content: l } })).join('\n') + '\n');
    return tmpFile;
  }

  // (a) regression: a reply during a genuine inbound-triggered turn from the
  // same chat is eligible.
  test('a matching inbound <channel> envelope from the same chat is eligible', () => {
    const t = writeTranscript(['<channel source="plugin:telegram:telegram" chat_id="123">hi there</channel>']);
    expect(isEligibleInboundReply({ transcript_path: t }, 'telegram', '123')).toBe(true);
  });

  // (b) a routine/heartbeat-triggered turn opens on a prompt that isn't a
  // channel envelope at all — not eligible.
  test('a routine/heartbeat-triggered turn (no channel envelope) is not eligible', () => {
    const t = writeTranscript(['[hermit-routine:morning-brief] wake']);
    expect(isEligibleInboundReply({ transcript_path: t }, 'telegram', '123')).toBe(false);
  });

  // (c) an inbound turn from chat A, replying into chat B — chat mismatch —
  // is not eligible.
  test('a reply going to a different chat than the one that opened the turn is not eligible', () => {
    const t = writeTranscript(['<channel source="plugin:telegram:telegram" chat_id="AAA">hi</channel>']);
    expect(isEligibleInboundReply({ transcript_path: t }, 'telegram', 'BBB')).toBe(false);
  });

  test('no transcript_path on the event is not eligible', () => {
    expect(isEligibleInboundReply({}, 'telegram', '123')).toBe(false);
  });

  test('a nonexistent transcript_path fails closed (not eligible)', () => {
    expect(isEligibleInboundReply({ transcript_path: '/nonexistent/path/transcript.jsonl' }, 'telegram', '123')).toBe(false);
  });
});

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.hermit', ...p);

describe('channel-hook intake ack (PostToolUse)', () => {
  const envFor = (dir: string) => ({ AGENT_DIR: hermit(dir) });

  test('ack written with the payload session id', withDir(async (dir) => {
    const r = await runScript('channel-hook.ts', {
      stdin: JSON.stringify({
        tool_name: 'mcp__discord__reply',
        tool_input: { chat_id: '123', text: 'On it: the label.' },
        session_id: 'sess-from-payload',
      }),
      cwd: dir,
      env: envFor(dir),
    });
    expect(r.exitCode).toBe(0);
    const ack = JSON.parse(fs.readFileSync(hermit(dir, 'state', 'intake-acks.jsonl'), 'utf8'));
    expect(ack.session_id).toBe('sess-from-payload');
    expect(ack.channel).toBe('discord');
    expect(ack.chat_id).toBe('123');
  }));

  test('ack written with null when the payload has none', withDir(async (dir) => {
    const r = await runScript('channel-hook.ts', {
      stdin: JSON.stringify({
        tool_name: 'mcp__telegram__reply',
        tool_input: { chat_id: '456', text: 'On it' },
      }),
      cwd: dir,
      env: envFor(dir),
    });
    expect(r.exitCode).toBe(0);
    const ack = JSON.parse(fs.readFileSync(hermit(dir, 'state', 'intake-acks.jsonl'), 'utf8'));
    expect(ack.session_id).toBeNull();
  }));

  test('plain reply is not written', withDir(async (dir) => {
    const r = await runScript('channel-hook.ts', {
      stdin: JSON.stringify({
        tool_name: 'mcp__discord__reply',
        tool_input: { chat_id: '123', text: 'All done.' },
        session_id: 'sess-from-payload',
      }),
      cwd: dir,
      env: envFor(dir),
    });
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(hermit(dir, 'state', 'intake-acks.jsonl'))).toBe(false);
  }));
});


test('recall captures a full 8192-character helper report with multi-byte unicode', withDir(async (dir) => {
  const text = '界'.repeat(8192);
  const stdin = JSON.stringify({
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__discord__reply',
    tool_input: { chat_id: '123', text },
  });
  expect(text.length).toBe(8192);
  const result = await runScript('channel-hook.ts', {
    stdin, cwd: dir, env: { AGENT_DIR: hermit(dir) },
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe('');
  const db = new Database(hermit(dir, 'state', 'channel-log.sqlite'), { readonly: true });
  try {
    const rows = db.query("SELECT text FROM messages WHERE source = 'discord' AND chat_id = '123' AND direction = 'out'").all() as { text: string }[];
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0].text)).toEqual(Buffer.from(text));
  } finally {
    db.close();
  }
}));


test('configured mapped reply learns the inbound chat and logs outbound text', withDir(async (dir) => {
  fs.writeFileSync(hermit(dir, 'config.json'), JSON.stringify({ channels: { custom: { attributes: { chat_id: 'channel_id' } } } }));
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: '<channel source="plugin:custom:custom" channel_id="C1">hello</channel>' } }) + '\n');
  const result = await runScript('channel-hook.ts', { cwd: dir, env: { AGENT_DIR: hermit(dir) }, stdin: JSON.stringify({
    tool_name: 'mcp__plugin_custom_custom__reply', tool_input: { channel_id: 'C1', text: 'hello back' }, transcript_path: transcript,
  }) });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(fs.readFileSync(hermit(dir, 'config.json'), 'utf8')).channels.custom.dm_channel_id).toBe('C1');
  const db = new Database(hermit(dir, 'state', 'channel-log.sqlite'), { readonly: true });
  try {
    expect(db.query("SELECT direction FROM messages WHERE source = 'custom' AND chat_id = 'C1'").all()).toEqual([{ direction: 'out' }]);
  } finally { db.close(); }
}));
