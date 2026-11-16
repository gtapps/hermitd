import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../scripts/lib/prompt-stages/first-chat';
import { parseChannelEnvelope } from '../scripts/lib/channel-envelope';
import type { StageContext } from '../scripts/lib/prompt-stages/types';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('first-chat-');
afterAll(cleanup);

function fixture(prompt = 'Hello') {
  const dir = freshDir();
  fs.mkdirSync(path.join(dir, 'state'));
  const marker = path.join(dir, 'state/first-chat-pending.json');
  fs.writeFileSync(marker, JSON.stringify({ private_chats: [{ channel: 'telegram', chat_id: '1', sender_id: '2' }] }));
  const ctx: StageContext = { dir, prompt, sessionId: 'resident', envelope: parseChannelEnvelope(prompt), transcriptPath: null,
    config: () => ({}), runtime: () => ({ cc_session_id: 'resident' }) };
  return { ctx, marker };
}

function withPromptFile(fn: () => void) {
  const previous = process.env.CLAUDE_PLUGIN_ROOT;
  const root = freshDir();
  fs.mkdirSync(path.join(root, 'prompts'));
  fs.writeFileSync(path.join(root, 'prompts/first-chat.md'), 'First-chat fixture text');
  process.env.CLAUDE_PLUGIN_ROOT = root;
  try { fn(); } finally {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = previous;
  }
}

test('one claim injects file text verbatim; a repeat emits nothing', () => withPromptFile(() => {
  const { ctx, marker } = fixture();
  expect(run(ctx)).toEqual({ context: 'First-chat fixture text' });
  expect(fs.existsSync(marker)).toBe(false);
  expect(run(ctx)).toBeUndefined();
}));

test('competing callers emit exactly once', () => {
  withPromptFile(() => {
    const { ctx } = fixture();
    expect([run(ctx), run(ctx)].filter(Boolean)).toHaveLength(1);
  });
});

for (const prompt of ['', '  ', '/status', ' !pause',
  '<channel source="telegram" chat_id="1" user="2">/status</channel>',
  '<channel source="telegram" chat_id="1" user="2">!pause</channel>',
  '<channel source="telegram" chat_id="group" user="2">Hello</channel>',
  '<channel source="telegram" chat_id="1" user="stranger">Hello</channel>']) {
  test(`ineligible effective text or private chat: ${prompt}`, () => withPromptFile(() => {
    const { ctx, marker } = fixture(prompt);
    expect(run(ctx)).toBeUndefined();
    expect(fs.existsSync(marker)).toBe(true);
  }));
}

test('recorded private chat is eligible', () => withPromptFile(() => {
  expect(run(fixture('<channel source="telegram" chat_id="1" user="2">Hello</channel>').ctx)).toEqual({ context: 'First-chat fixture text' });
}));

test('plugin-qualified channel source matches the recorded channel key', () => withPromptFile(() => {
  expect(run(fixture('<channel source="plugin:telegram:telegram" chat_id="1" user="2">Hello</channel>').ctx))
    .toEqual({ context: 'First-chat fixture text' });
}));

for (const [label, sessionId, runtime] of [['setup session', 'hatch', { cc_session_id: 'resident' }], ['no resident', 'resident', null],
  ['unknown session', null, { cc_session_id: 'resident' }]] as const) {
  test(`non-resident session leaves the marker: ${label}`, () => withPromptFile(() => {
    const { ctx, marker } = fixture();
    expect(run({ ...ctx, sessionId, runtime: () => runtime })).toBeUndefined();
    expect(fs.existsSync(marker)).toBe(true);
  }));
}

test('missing prompt preserves the marker', () => withPromptFile(() => {
  const { ctx, marker } = fixture();
  fs.unlinkSync(path.join(process.env.CLAUDE_PLUGIN_ROOT!, 'prompts/first-chat.md'));
  expect(run(ctx)).toBeUndefined();
  expect(fs.existsSync(marker)).toBe(true);
}));
