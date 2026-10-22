import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { withDir, writeConfig } from './helpers/workdir';
import { markGuest } from '../scripts/lib/guest-marker';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');
const PIPE_ENV = { AGENT_HOOK_PROFILE: 'standard', CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT };
const SESSION_ID = 'test-session-001';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.hermit', ...p);

function envelope(opts: { chatId?: string; userId?: string; body?: string } = {}): object {
  const chatId = opts.chatId ?? '123';
  const userId = opts.userId ?? 'u1';
  const body = opts.body ?? 'hello';
  return {
    type: 'user',
    isMeta: true,
    message: { content: `<channel source="plugin:discord:discord" chat_id="${chatId}" user_id="${userId}">${body}</channel>` },
  };
}

function assistantText(text = 'answered in the terminal'): object {
  return { type: 'assistant', message: { content: text } };
}

function assistantTool(name: string, input: Record<string, unknown> = {}): object {
  return { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name, input }] } };
}

function writeTranscript(dir: string, entries: object[]): string {
  const file = path.join(dir, '.claude', 'transcript.jsonl');
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

function writeTurn(dir: string, at = '2020-01-01T00:00:00.000Z'): void {
  fs.writeFileSync(hermit(dir, 'state', 'operator-turn-open.json'), JSON.stringify({ at }) + '\n');
}

function stopHookInput(dir: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: SESSION_ID,
    transcript_path: path.join(dir, '.claude', 'transcript.jsonl'),
    cwd: '/tmp/test-project',
    permission_mode: 'default',
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'Done.',
    ...extra,
  });
}

async function runStop(dir: string, stdin?: string) {
  return runScript('stop-pipeline.ts', {
    stdin: stdin ?? stopHookInput(dir),
    cwd: dir,
    env: { ...PIPE_ENV, AGENT_DIR: hermit(dir) },
  });
}

function turnExists(dir: string): boolean {
  return fs.existsSync(hermit(dir, 'state', 'operator-turn-open.json'));
}

describe('stop-pipeline — channel reply checkpoint', () => {
  test('envelope boundary, assistant text only: block JSON names chat id, turn marker kept', withDir(async (dir) => {
    writeTurn(dir);
    writeTranscript(dir, [envelope(), assistantText()]);
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.decision).toBe('block');
    expect(body.reason).toContain('123');
    expect(turnExists(dir)).toBe(true);
  }));

  test('envelope boundary, discord reply tool with a different chat_id: stdout empty', withDir(async (dir) => {
    writeTranscript(dir, [
      envelope(),
      assistantTool('mcp__plugin_discord_discord__reply', { chat_id: '999', text: 'elsewhere' }),
    ]);
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  }));

  test('envelope boundary, discord react tool: stdout empty', withDir(async (dir) => {
    writeTranscript(dir, [
      envelope(),
      assistantTool('mcp__plugin_discord_discord__react', { chat_id: '123', emoji: '👍' }),
    ]);
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  }));

  test('envelope boundary, only discord download_attachment: block JSON', withDir(async (dir) => {
    writeTranscript(dir, [
      envelope(),
      assistantTool('mcp__plugin_discord_discord__download_attachment', { chat_id: '123', message_id: 'm1' }),
      assistantText(),
    ]);
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).decision).toBe('block');
  }));

  test('reply stamped after the envelope but missing from the transcript: stdout empty', withDir(async (dir) => {
    writeTranscript(dir, [{ ...envelope(), timestamp: '2026-10-19T12:45:05.363Z' }, assistantText()]);
    fs.writeFileSync(hermit(dir, 'state', 'channel-activity.json'), JSON.stringify({ discord: { last_reply_at: '2026-10-19T12:45:10.341Z' } }));
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  }));

  test('reply stamp older than the envelope: block JSON', withDir(async (dir) => {
    writeTranscript(dir, [{ ...envelope(), timestamp: '2026-10-19T12:45:05.363Z' }, assistantText()]);
    fs.writeFileSync(hermit(dir, 'state', 'channel-activity.json'), JSON.stringify({ discord: { last_reply_at: '2026-10-19T12:40:00.000Z' } }));
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).decision).toBe('block');
  }));

  test('non-channel boundary prompt, text only: stdout empty', withDir(async (dir) => {
    writeTranscript(dir, [
      { type: 'user', message: { content: 'typed in the terminal' } },
      assistantText(),
    ]);
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  }));

  test('envelope from a user_id outside allowed_users: stdout empty', withDir(async (dir) => {
    writeConfig(dir, { channels: { discord: { allowed_users: ['allowed-user'] } } });
    writeTranscript(dir, [envelope({ userId: 'stranger' }), assistantText()]);
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  }));

  test('envelope whose sourceKey:chatId owns an open task thread: stdout empty', withDir(async (dir) => {
    writeTranscript(dir, [envelope(), assistantText()]);
    const opened = await runScript('task.ts', {
      args: ['open', hermit(dir), '--owner', 'worker:a1b2c3d4e5f6a7b8c', '--requester', 'discord:u1', '--conversation', 'discord:123', '--title', 'Thread work', '--done', 'Verified'],
      cwd: dir,
      env: { AGENT_DIR: hermit(dir) },
    });
    expect(opened.exitCode).toBe(0);
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  }));

  test('envelope whose chat holds only a resident-owned record: reply still owed', withDir(async (dir) => {
    writeTranscript(dir, [envelope(), assistantText()]);
    const opened = await runScript('task.ts', {
      args: ['open', hermit(dir), '--owner', 'resident', '--requester', 'discord:u1', '--conversation', 'discord:123', '--title', 'Thread work', '--done', 'Verified'],
      cwd: dir,
      env: { AGENT_DIR: hermit(dir) },
    });
    expect(opened.exitCode).toBe(0);
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('channel-responder reply is still owed');
  }));

  test('text-only channel turn with stop_hook_active true: stdout empty', withDir(async (dir) => {
    writeTranscript(dir, [envelope(), assistantText()]);
    const r = await runStop(dir, stopHookInput(dir, { stop_hook_active: true }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  }));

  test('text-only channel turn in a guest session: stdout empty', withDir(async (dir) => {
    writeTranscript(dir, [envelope(), assistantText()]);
    markGuest(hermit(dir, 'state'), SESSION_ID);
    const r = await runStop(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  }));

  test('missing or nonexistent transcript_path: stdout empty, exit 0', withDir(async (dir) => {
    const missing = await runStop(dir, JSON.stringify({
      session_id: SESSION_ID,
      cwd: '/tmp/test-project',
      permission_mode: 'default',
      hook_event_name: 'Stop',
      stop_hook_active: false,
      last_assistant_message: 'Done.',
    }));
    expect(missing.exitCode).toBe(0);
    expect(missing.stdout.trim()).toBe('');

    const gone = await runStop(dir, stopHookInput(dir, { transcript_path: '/nonexistent/path/transcript.jsonl' }));
    expect(gone.exitCode).toBe(0);
    expect(gone.stdout.trim()).toBe('');
  }));
});


test('threaded worker handoff clears the reply checkpoint for its conversation key', withDir(async (dir) => {
  const { mutateTask } = await import('../scripts/lib/tasks');
  const { replyBlockReason } = await import('../scripts/lib/reply-checkpoint');
  writeConfig(dir, { channels: { custom: { attributes: { thread_id: 'thread_ts' } } } });
  mutateTask(hermit(dir), 'open', undefined, { owner: 'worker:a1b2c3d4', requester: 'custom:U1', conversation: 'custom:C1~T1', title: 'Thread task', done: 'Complete' }, '');
  const transcript = writeTranscript(dir, [{ type: 'user', message: { content: '<channel source="custom" chat_id="C1" thread_ts="T1">hello</channel>' } }, assistantText()]);
  expect(replyBlockReason(hermit(dir), { transcript_path: transcript })).toBeNull();
}));
