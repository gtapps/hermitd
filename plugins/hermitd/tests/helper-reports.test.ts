import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { storeHelperReport } from '../scripts/lib/helper-reports';
import { decodeTask, mutateTask } from '../scripts/lib/tasks';
import { taskFixture } from './helpers/tasks';
import { runScript } from './helpers/run';

const author = 'helper:review';
const args = (id: string, kind = 'result') => [id, '--as', author, '--kind', kind];
const files = (dir: string) => fs.existsSync(path.join(dir, 'helper-reports')) ? fs.readdirSync(path.join(dir, 'helper-reports')) : [];

test('author report preserves exact text, binding and result; guest leaves task turn untouched', async () => {
  const f = taskFixture(); try {
    const { id } = await f.open(['--owner', author]);
    f.put('state/execution.json', { state: 'in_flight', cc_session_id: 'resident', at: new Date().toISOString() });
    f.put('state/task-turn.json', { frozen: true });
    const before = fs.readFileSync(path.join(f.dir, 'state/task-turn.json'), 'utf8');
    const body = '  Verdict.\n\n1. Decision.\n```ts\nconst café = "世界";  \n```\n';
    const receipt = await f.ok('report', args(id), body);
    expect(receipt).toMatchObject({ task: id, recorded: true, result_rev: 1, delivery: 'no_channel' });
    expect(receipt.report).toMatch(/^[a-z0-9]{10}$/);
    expect(fs.readFileSync(path.join(f.dir, 'helper-reports', receipt.report + '.md'), 'utf8')).toBe(body);
    expect(JSON.parse(fs.readFileSync(path.join(f.dir, 'helper-reports', receipt.report + '.json'), 'utf8'))).toEqual({ task: id, author });
    expect(decodeTask(f.text(id)).result).toBe(body);
    expect(fs.readFileSync(path.join(f.dir, 'state/task-turn.json'), 'utf8')).toBe(before);
  } finally { f.cleanup(); }
});

test('immutable storage never overwrites a report and refuses symlinked files', () => {
  const f = taskFixture(); try {
    const binding = { task: null, author };
    storeHelperReport(f.dir, 'first', binding, () => 'aaaaaaaaaa');
    expect(() => storeHelperReport(f.dir, 'second', binding, () => 'aaaaaaaaaa')).toThrow('report_id_exhausted');
    expect(fs.readFileSync(path.join(f.dir, 'helper-reports/aaaaaaaaaa.md'), 'utf8')).toBe('first');
    fs.symlinkSync(path.join(f.dir, 'config.json'), path.join(f.dir, 'helper-reports/bbbbbbbbbb.md'));
    expect(() => storeHelperReport(f.dir, 'second', binding, () => 'bbbbbbbbbb')).toThrow('report_outside_state');
  } finally { f.cleanup(); }
});

test('empty, oversized and symlinked directory submissions change nothing', async () => {
  const f = taskFixture(); try {
    const { id } = await f.open(['--owner', author]);
    const before = f.text(id);
    for (const [text, reason] of [[' \n', 'empty'], ['é'.repeat(32769), 'report_too_long']]) {
      expect(await f.ok('report', args(id), text)).toEqual({ status: 'refused', reason });
      expect(files(f.dir)).toEqual([]);
      expect(f.text(id)).toBe(before);
    }
    const elsewhere = path.join(f.dir, 'elsewhere'); fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(f.dir, 'helper-reports'));
    expect(await f.ok('report', args(id), 'Body')).toEqual({ status: 'refused', reason: 'report_outside_state' });
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(f.text(id)).toBe(before);
  } finally { f.cleanup(); }
});

test('stale helper, wrong worker class and closed task are refused before storage or delivery', async () => {
  const f = taskFixture(); try {
    const { id } = await f.open(['--owner', author]);
    const before = f.text(id);
    for (const as of ['helper:stale', 'worker']) {
      expect(await f.ok('report', [id, '--as', as, '--kind', 'result'], 'Body')).toEqual({ status: 'refused', reason: 'not_owner' });
      expect(f.text(id)).toBe(before);
      expect(files(f.dir)).toEqual([]);
    }
    await f.ok('cancel', [id, '--actor', 'operator', '--reason-stdin'], 'Cancelled');
    expect(await f.ok('report', args(id), 'Body')).toEqual({ status: 'refused', reason: 'closed' });
    expect(files(f.dir)).toEqual([]);
    const worker = await f.open(['--owner', 'worker:a123456789']);
    expect(await f.ok('report', [worker.id, '--as', 'worker', '--kind', 'result'], 'Worker result')).toMatchObject({ recorded: true, result_rev: 1 });
  } finally { f.cleanup(); }
});

test('consent-protected results reuse block protection with no stored report', async () => {
  const f = taskFixture(); try {
    const opened = mutateTask(f.dir, 'open', undefined, { title: 'Proposal', done: 'Verified', requester: 'agent', kind: 'proposal', owner: author, decision: JSON.stringify({ purpose: 'consent', authority: 'admin', generation: 1 }), 'waiting-on': 'admin' }, '') as { id: string };
    const before = f.text(opened.id);
    expect(await f.ok('report', args(opened.id), 'Result')).toEqual({ status: 'refused', reason: 'consent_required' });
    expect(f.text(opened.id)).toBe(before);
    expect(files(f.dir)).toEqual([]);
  } finally { f.cleanup(); }
});

test('needs-input stalls on requester without setting a result; notes carry provenance', async () => {
  const f = taskFixture(); try {
    const { id } = await f.open(['--owner', author]);
    expect(await f.ok('report', args(id, 'needs-input'), 'Which option?\n1. A\n2. B')).toMatchObject({ recorded: true, result_rev: 0 });
    expect(decodeTask(f.text(id))).toMatchObject({ result: null, waiting_on: 'discord:u1', stall_status: 'Which option?' });
    await f.ok('report', args(id, 'note'), 'Progress\ncontinued');
    expect(f.text(id)).toContain('[guest:review] Progress continued');
  } finally { f.cleanup(); }
});

for (const scenario of ['sent', 'partial', 'failed', 'timeout', 'disabled', 'relay', 'no_channel', 'thread', 'shared', 'cap', 'no-task'] as const) {
  test.serial(`report delivery: ${scenario}`, async () => {
    const f = taskFixture();
    const platform = scenario === 'thread' ? 'telegram' : 'discord';
    const requests: { route: string; body: any }[] = [];
    const server = Bun.serve({ port: 0, async fetch(req) {
      const route = new URL(req.url).pathname;
      if (req.method === 'GET') return Response.json({ type: 1 });
      requests.push({ route, body: await req.json() });
      if (scenario === 'timeout') return new Promise<Response>(() => {});
      if (scenario === 'failed' || scenario === 'partial' && requests.length > 1) return Response.json({ message: 'failed' }, { status: 500 });
      return Response.json({ ok: true, id: 'sent' });
    } });
    const state = path.join(f.dir, 'channel'); fs.mkdirSync(state);
    fs.writeFileSync(path.join(state, '.env'), `${platform.toUpperCase()}_BOT_TOKEN=test\n`);
    const env = { [platform === 'discord' ? 'HERMIT_DISCORD_API_URL' : 'HERMIT_TELEGRAM_API_URL']: server.url.toString().replace(/\/$/, '') };
    try {
      const key = scenario === 'relay' ? 'custom' : platform;
      f.put('config.json', { channels: { [key]: { enabled: scenario !== 'disabled', state_dir: state, default_chat_id: 'CHAT' } } });
      const conversation = scenario === 'no_channel' ? [] : ['--conversation', `${key}:CHAT${scenario === 'thread' ? '~42' : ''}`];
      const { id } = await f.open(['--owner', author, ...conversation]);
      if (scenario === 'shared') await f.open(['--conversation', 'discord:CHAT']);
      const body = scenario === 'cap' ? 'x '.repeat(15000) : scenario === 'partial' ? 'x '.repeat(2000) : 'Verdict.\n1. Decision.';
      const call = scenario === 'no-task' ? ['--no-task', '--as', author] : args(id);
      const result = await runScript('task.ts', { cwd: path.dirname(f.dir), env: { AGENT_DIR: f.dir, ...env }, args: ['report', f.dir, ...call], stdin: body });
      expect(result.exitCode).toBe(0);
      const receipt = JSON.parse(result.stdout);
      const expected = scenario === 'disabled' || scenario === 'timeout' ? 'failed' : ['thread', 'shared', 'cap', 'no-task'].includes(scenario) ? 'sent' : scenario;
      expect(receipt.delivery).toBe(expected);
      if (scenario === 'thread') expect(requests[0].body.message_thread_id).toBe('42');
      if (scenario === 'shared') {
        const task = decodeTask(f.text(id));
        expect(requests[0].body.content).toBe(`${task.handle} · ${task.title}: ${body}`);
      }
      if (scenario === 'cap') {
        expect(requests.length).toBe(8);
        expect(requests[7].body.content).toContain('The rest of this report is on the task.');
      }
      if (scenario === 'no-task') expect(receipt).toMatchObject({ task: null, recorded: false, result_rev: null });
    } finally { server.stop(true); f.cleanup(); }
  }, 20000);
}

test('CLI refuses a foreign root and accepts nested and worktree-shaped callers through the pinned root', async () => {
  const f = taskFixture(); const foreign = taskFixture(); try {
    const { id } = await f.open(['--owner', author]);
    const run = (cwd: string, dir: string) => runScript('task.ts', { cwd, env: { AGENT_DIR: f.dir }, args: ['report', dir, ...args(id)], stdin: 'Report' });
    const refused = await run(path.dirname(f.dir), foreign.dir);
    expect(refused.exitCode).toBe(1);
    expect(refused.stdout).toContain('foreign_state_dir:');
    expect(files(foreign.dir)).toEqual([]);
    for (const name of ['nested/repo', '.claude/worktrees/helper']) {
      const cwd = path.join(path.dirname(f.dir), name); fs.mkdirSync(cwd, { recursive: true });
      expect((await run(cwd, f.dir)).exitCode).toBe(0);
    }
  } finally { f.cleanup(); foreign.cleanup(); }
});
