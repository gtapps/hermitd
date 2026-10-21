import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { freshDirFactory } from './helpers/workdir';
import { logMessage, roleReviewHistory } from '../scripts/lib/channel-log';
import { memoryDirFor } from '../scripts/lib/cc-compat';
import { chatInstructions } from '../scripts/lib/channel-auth';
import { ROW_TEXT_CAP, SNAPSHOT_TEXT_BUDGET } from '../scripts/lib/role-review';

const { freshDir, cleanup } = freshDirFactory('role-review-');
afterAll(cleanup);
const script = path.resolve(import.meta.dir, '../scripts/role-review.ts');
function fixture(source = 'fakechat') {
  const root = freshDir();
  const dir = path.join(root, '.hermit');
  const configDir = path.join(root, 'config');
  const memory = memoryDirFor(root, configDir);
  fs.mkdirSync(memory, { recursive: true });
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  const config: any = { channels: { [source]: { allowed_users: ['u1'] } }, routines: [{ id: 'weekly', chat: `${source}:100` }] };
  const writeConfig = () => fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  writeConfig();
  const role = 'feedback_role_test.md';
  fs.writeFileSync(path.join(memory, 'MEMORY.md'), `- [Standing role: test](${role}): [role ${source}:100] Old rule\n`);
  fs.writeFileSync(path.join(memory, role), 'Old rule');
  const add = (text = 'correction', extra: any = {}) => {
    expect(logMessage(dir, { source, chat_id: '100', direction: 'in', sender_id: 'u1', text, ...extra }).ok).toBe(true);
  };
  const call = async (args: string[], input = '', env: Record<string, string> = {}) => {
    const proc = Bun.spawn([process.execPath, script, dir, ...args], {
      cwd: root, env: { ...process.env, AGENT_DIR: dir, CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_PROJECT_DIR_NAME: '', ...env },
      stdin: Buffer.from(input), stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(stderr).toBe('');
    return { code, value: JSON.parse(stdout) };
  };
  const snap = async () => { const r = await call(['snapshot', '--routine', 'weekly']); expect(r.code).toBe(0); return r.value; };
  const commit = async (upper: number, proposals: any[]) => {
    const r = await call(['commit', '--routine', 'weekly', '--upper', String(upper)], JSON.stringify(proposals));
    expect(r.code).toBe(0); return r.value;
  };
  const get = async () => (await call(['get', '--chat', `${source}:100`])).value.proposals;
  const proposal = (evidence_ids: number[], extra: any = {}) => ({ kind: 'memory', target: role, proposed_text: 'New rule', evidence_ids, ...extra });
  return { root, dir, configDir, memory, config, role, add, call, snap, commit, get, proposal, writeConfig };
}

test('owner resolution includes no owner and ambiguous routine ids', async () => {
  const f = fixture();
  delete f.config.routines[0].chat; f.writeConfig();
  expect(await f.snap()).toEqual({ status: 'no_owning_chat' });
  f.config.routines.push({ id: 'weekly', chat: 'fakechat:100' }); f.writeConfig();
  expect(await f.snap()).toEqual({ status: 'ambiguous_routine' });
});

test('bootstrap excludes old rows, dedupes deliveries, admits inbound and keeps outbound', async () => {
  const f = fixture();
  f.add('old', { ts: new Date(Date.now() - 8 * 86_400_000).toISOString() });
  f.add('first', { message_id: 'm1' });
  f.add('redelivery', { message_id: 'm1' });
  f.add('excluded', { sender_id: 'outsider' });
  f.add('outbound', { direction: 'out', sender_id: 'bot' });
  const s = await f.snap();
  expect(s.status).toBe('ready');
  expect(s.rows.map((r: any) => r.text)).toEqual(['first', 'outbound']);
  expect(s.roles).toEqual([{ kind: 'memory', target: f.role, text: 'Old rule' }]);
  f.add('after snapshot');
  expect((await f.commit(s.upper_id, [])).saved).toEqual([]);
  expect((await f.snap()).rows.map((r: any) => r.text)).toEqual(['after snapshot']);
});

test('row excerpts and total budget truncate, and the next run continues', async () => {
  const f = fixture();
  for (let i = 0; i < 16; i++) f.add(String(i).padEnd(4000, 'x'));
  const s = await f.snap();
  expect(s.truncated).toBe(true);
  expect(s.rows.every((r: any) => r.text.length === ROW_TEXT_CAP)).toBe(true);
  expect(s.rows.reduce((n: number, r: any) => n + r.text.length, 0)).toBeLessThanOrEqual(SNAPSHOT_TEXT_BUDGET);
  await f.commit(s.upper_id, []);
  const next = await f.snap();
  expect(next.rows[0].id).toBe(s.upper_id + 1);
  expect(next.rows.length + s.rows.length).toBe(16);
});

test('an uncached Discord thread is resolved with a bounded fail-soft lookup', async () => {
  const f = fixture('discord');
  const tokens = path.join(f.root, 'discord');
  fs.mkdirSync(tokens);
  fs.writeFileSync(path.join(tokens, '.env'), 'DISCORD_BOT_TOKEN=test-token\n');
  f.config.channels.discord.state_dir = tokens; f.writeConfig();
  f.add('thread correction', { chat_id: '101' });
  f.add('unrelated', { chat_id: '102' });
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch(req) {
    requests++;
    return new URL(req.url).pathname === '/channels/101'
      ? Response.json({ type: 11, parent_id: '100' }) : new Response('', { status: 503 });
  } });
  try {
    const env = { HERMIT_DISCORD_API_URL: server.url.toString().replace(/\/$/, '') };
    const s = (await f.call(['snapshot', '--routine', 'weekly'], '', env)).value;
    expect(s.rows.map((r: any) => r.text)).toEqual(['thread correction']);
    await f.call(['snapshot', '--routine', 'weekly'], '', env);
    expect(requests).toBe(2);
  } finally { server.stop(true); }
});

test('logging off and no DB are distinguished without creating a DB', async () => {
  const f = fixture();
  expect(await f.snap()).toEqual({ status: 'empty', reason: 'no_db' });
  f.config.knowledge = { channel_log_enabled: false }; f.writeConfig();
  expect(await f.snap()).toEqual({ status: 'empty', reason: 'logging_off' });
  expect(fs.existsSync(path.join(f.dir, 'state', 'channel-log.sqlite'))).toBe(false);
});

test('commit rejects invalid evidence, single messages and unauthorized targets', async () => {
  const f = fixture();
  f.add('first', { message_id: 'same' });
  f.add('duplicate', { message_id: 'same' });
  f.add('second', { message_id: 'other' });
  f.add('out', { direction: 'out' });
  f.add('excluded', { sender_id: 'stranger' });
  const s = await f.snap();
  f.add('future');
  const result = await f.commit(s.upper_id, [[1, 6], [1, 4], [1, 5], [1], [1, 2]].map(ids => f.proposal(ids)).concat([
    f.proposal([1, 3], { target: 'other-chat.md' }),
  ]));
  expect(result.saved).toEqual([]);
  expect(result.rejected.map((r: any) => r.reason)).toEqual(['invalid_evidence', 'invalid_evidence', 'invalid_evidence', 'insufficient_evidence', 'invalid_evidence', 'invalid_target']);
  expect((await f.commit(s.upper_id, [])).status).toBe('stale_snapshot');
});

test('quiet commit advances, and accepted proposals supersede and become stale', async () => {
  const f = fixture(); f.add(); f.add();
  let s = await f.snap();
  const first = await f.commit(s.upper_id, [f.proposal([1, 2])]);
  expect(first.saved.length).toBe(1);
  expect((await f.get())[0].stale).toBe(false);
  f.add(); f.add(); s = await f.snap();
  const second = await f.commit(s.upper_id, [f.proposal([3, 4], { proposed_text: 'Newer' })]);
  expect((await f.get()).map((p: any) => p.id)).toEqual([second.saved[0].id]);
  fs.writeFileSync(path.join(f.memory, f.role), 'Edited');
  expect((await f.get())[0].stale).toBe(true);
  fs.unlinkSync(path.join(f.memory, f.role));
  expect((await f.get())[0].stale).toBe(true);
});

test('instructions require exact provenance, enforce one proposal and become stale', async () => {
  const f = fixture();
  f.config.channels.fakechat.instructions = [{ chat_id: '100', text: 'Current instructions' }]; f.writeConfig();
  expect(await chatInstructions(f.dir, f.config, 'fakechat', '100')).toEqual({ chat_id: '100', text: 'Current instructions' });
  f.add(); f.add();
  const s = await f.snap();
  expect(s.instructions).toEqual({ text: 'Current instructions', inherited: false });
  const p = f.proposal([1, 2], { kind: 'instructions', target: 'fakechat:100' });
  const result = await f.commit(s.upper_id, [{ ...p, proposed_text: 'x'.repeat(2001) }, p, p]);
  expect(result.saved.length).toBe(1);
  expect(result.rejected.map((r: any) => r.reason)).toEqual(['instructions_limit', 'instructions_limit']);
  f.config.channels.fakechat.instructions[0].text = 'Changed'; f.writeConfig();
  expect((await f.get())[0].stale).toBe(true);
});

test('inherited Discord instructions are visible but cannot be proposed as a target', async () => {
  const f = fixture('discord');
  f.config.channels.discord.instructions = [{ chat_id: '99', text: 'Parent policy' }]; f.writeConfig();
  fs.writeFileSync(path.join(f.dir, 'state', 'channel-chats.json'), JSON.stringify({ discord: { chats: { '100': { parent_id: '99', type: 11 } } } }));
  expect(await chatInstructions(f.dir, f.config, 'discord', '100')).toEqual({ text: 'Parent policy', chat_id: '99' });
  expect(await chatInstructions(f.dir, f.config, 'fakechat', '100')).toBeNull();
  f.add(); f.add(); const s = await f.snap();
  expect(s.instructions).toEqual({ text: 'Parent policy', inherited: true });
  const result = await f.commit(s.upper_id, [f.proposal([1, 2], { kind: 'instructions', target: 'discord:100' })]);
  expect(result.rejected[0].reason).toBe('invalid_target');
});

test('resolve and commit prune resolved and 30-day-old pending proposals', async () => {
  const f = fixture(); f.add(); f.add(); const s = await f.snap();
  const saved = (await f.commit(s.upper_id, [f.proposal([1, 2])])).saved[0];
  expect((await f.call(['resolve', saved.id, 'applied'])).value.status).toBe('resolved');
  expect(await f.get()).toEqual([]);
  const file = path.join(f.dir, 'state', 'role-review.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.proposals.push({ ...saved, id: 'old', state: 'pending', created_at: new Date(Date.now() - 31 * 86_400_000).toISOString() });
  fs.writeFileSync(file, JSON.stringify(state));
  f.add(); const next = await f.snap(); await f.commit(next.upper_id, []);
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).proposals).toEqual([]);
});

test('foreign state dirs and unresolved memory derivations are refused', async () => {
  const f = fixture(); const other = fixture();
  const foreign = await f.call(['snapshot', '--routine', 'weekly'], '', { AGENT_DIR: other.dir });
  expect(foreign.code).toBe(1);
  expect(foreign.value.error).toStartWith('foreign_state_dir:');
  expect((await f.call(['snapshot', '--routine', 'weekly'], '', { CLAUDE_CODE_PROJECT_DIR_NAME: 'custom' })).value.status).toBe('memory_dir_unresolved');
  fs.mkdirSync(path.join(f.root, '.claude'));
  fs.writeFileSync(path.join(f.root, '.claude', 'settings.json'), JSON.stringify({ autoMemoryDirectory: '/custom' }));
  expect((await f.snap()).status).toBe('memory_dir_unresolved');
  fs.unlinkSync(path.join(f.root, '.claude', 'settings.json'));
  fs.writeFileSync(path.join(f.root, '.git'), 'gitdir: /some/worktree');
  expect((await f.snap()).status).toBe('memory_dir_unresolved');
});

test('range query orders ids, bounds the upper id and distinguishes broken DB', () => {
  const f = fixture();
  f.add('later timestamp', { ts: '2026-01-02T00:00:00Z' }); f.add('earlier timestamp', { ts: '2026-01-01T00:00:00Z' });
  const r = roleReviewHistory(f.dir, 'fakechat', { cursor: 0, upper: 1, chatIds: ['100'], senderIds: ['u1'] });
  expect(r.status).toBe('ok');
  if (r.status === 'ok') expect(r.rows.map(row => row.id)).toEqual([1]);
  const broken = fixture();
  fs.writeFileSync(path.join(broken.dir, 'state', 'channel-log.sqlite'), 'broken');
  expect(roleReviewHistory(broken.dir, 'fakechat', { cursor: 0 }).status).toBe('error');
});
