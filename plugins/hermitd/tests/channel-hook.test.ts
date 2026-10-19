import fs from 'node:fs';
import { Database } from 'bun:sqlite';
import os from 'node:os';
import path from 'node:path';
import { describe, test, expect, afterEach } from 'bun:test';
import { seedDefaultChatId, isEligibleInboundReply } from '../scripts/channel-hook';
import { validate } from '../scripts/validate-config';
import { withDir } from './helpers/workdir';
import { runScript } from './helpers/run';

describe('seedDefaultChatId', () => {
  for (const home of [undefined, null, '']) {
    test(`seeds an empty home (${home}) and coerces numeric IDs`, () => {
      const config: any = { channels: { discord: { default_chat_id: home } } };
      expect(seedDefaultChatId(config, 'discord', 555, true)).toBe(true);
      expect(config.channels.discord.default_chat_id).toBe('555');
    });
  }

  test('never moves a seeded home', () => {
    const config: any = { channels: { discord: { default_chat_id: 'HOME' } } };
    expect(seedDefaultChatId(config, 'discord', 'OTHER', true)).toBe(false);
    expect(config.channels.discord.default_chat_id).toBe('HOME');
  });

  for (const [chat, inbound] of [['M1', true], [555, true], ['OTHER', false], [null, true]] as const) {
    test(`refuses ${chat} with inbound=${inbound}`, () => {
      const config: any = { channels: { discord: { default_chat_id: '', maintainer_channel_id: chat === 555 ? '555' : 'M1' } } };
      expect(seedDefaultChatId(config, 'discord', chat, inbound)).toBe(false);
      expect(config.channels.discord.default_chat_id).toBe('');
    });
  }

  test('validator warns when home equals maintainer', () => {
    const { warnings } = validate({ channels: { discord: { default_chat_id: 'M1', maintainer_channel_id: 'M1' } } });
    expect(warnings.some(w => w.includes('default_chat_id equals maintainer_channel_id'))).toBe(true);
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
  expect(JSON.parse(fs.readFileSync(hermit(dir, 'config.json'), 'utf8')).channels.custom.default_chat_id).toBe('C1');
  const db = new Database(hermit(dir, 'state', 'channel-log.sqlite'), { readonly: true });
  try {
    expect(db.query("SELECT direction FROM messages WHERE source = 'custom' AND chat_id = 'C1'").all()).toEqual([{ direction: 'out' }]);
  } finally { db.close(); }
}));

for (const home of ['', 'HOME']) test(`hook home=${home} eligibility and audit`, withDir(async (dir) => {
  const configPath = hermit(dir, 'config.json');
  const config = JSON.stringify({ channels: { discord: { default_chat_id: home } } });
  fs.writeFileSync(configPath, config);
  const transcript = path.join(dir, 'transcript.jsonl');
  // A seeded pin must skip this unreadable transcript entirely. Reading a
  // directory produces the eligibility warning, making the skip observable.
  if (!home) fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: '<channel source="discord" chat_id="NEW">hi</channel>' } }) + '\n');
  const result = await runScript('channel-hook.ts', {
    cwd: dir, env: { AGENT_DIR: hermit(dir) }, stdin: JSON.stringify({
      tool_name: 'mcp__discord__reply', tool_input: { chat_id: 'NEW' }, transcript_path: home ? dir : transcript,
    }),
  });
  expect(result.exitCode).toBe(0);
  if (home) {
    expect(result.stderr).toBe('');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(config);
    expect(fs.existsSync(hermit(dir, 'state/settings-audit.jsonl'))).toBe(false);
  } else {
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).channels.discord.default_chat_id).toBe('NEW');
    expect(fs.readFileSync(hermit(dir, 'state/settings-audit.jsonl'), 'utf8')).toContain('channel-hook');
  }
}));
