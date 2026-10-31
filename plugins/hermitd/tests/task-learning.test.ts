import { test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { mutateTask, readTasks, decodeTask, encodeTask, startupTasks } from '../scripts/lib/tasks';
import { collectToolUseIds, transcriptDirFor } from '../scripts/lib/cc-compat';
import { freshDirFactory } from './helpers/workdir';
const { freshDir, cleanup } = freshDirFactory('task-learning-');
afterAll(cleanup);

test('collects unique main-chain tool attempts within the window and limit', () => {
  const file = path.join(freshDir(), 'session.jsonl');
  const since = '2026-01-01T00:00:00.000Z';
  const use = (id: string, timestamp = since, isSidechain = false) => JSON.stringify({
    type: 'assistant', timestamp, isSidechain,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] },
  });
  fs.writeFileSync(file, [
    use('old', '2025-12-31T23:59:59.999Z'),
    use('sidechain', since, true),
    use('failed'),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'failed', is_error: true }] } }),
    use('failed'),
    use('denied'),
    JSON.stringify({ type: 'user', toolDenialKind: 'permission-rule', message: { content: [{ type: 'tool_result', tool_use_id: 'denied', is_error: true }] } }),
    '{"type":"assistant","tool_use":',
    use('third'),
    '{"type":"assistant","tool_use":',
  ].join('\n'));
  const ids = new Set<string>();
  collectToolUseIds(file, since, 2, ids);
  expect([...ids]).toEqual(['failed', 'denied']);
  collectToolUseIds(file, since, 5, ids);
  expect([...ids]).toEqual(['failed', 'denied', 'third']);
  collectToolUseIds(path.join(file, 'missing'), since, 5, ids);
  collectToolUseIds(path.dirname(file), since, 5, ids);
  expect([...ids]).toEqual(['failed', 'denied', 'third']);
});

function fixture(learning = true) {
  const root = freshDir();
  const dir = path.join(root, '.hermit'); fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ skills: { learning } }));
  fs.writeFileSync(path.join(dir, 'state/runtime.json'), JSON.stringify({ config_dir: path.join(root, 'cc-config'), cc_session_id: 'current' }));
  return dir;
}
function open(dir: string, flags: any = {}) { return (mutateTask(dir, 'open', undefined, { title: 'Example', requester: 'operator', done: 'Done', ...flags }, '') as any).id as string; }
function close(dir: string, id: string) { return mutateTask(dir, 'close', id, { by: 'confirmed', actor: 'operator', 'reason-stdin': true }, 'Confirmed') as any; }
function openedAt(dir: string, id: string) { return readTasks(dir).find(row => row.id === id)!.opened_at; }
function transcript(dir: string, session: string, count: number, at: string, opts: { sidechain?: boolean; prefix?: string } = {}) {
  const configDir = path.join(path.dirname(dir), 'cc-config');
  const folder = transcriptDirFor(path.dirname(dir), configDir);
  fs.mkdirSync(folder, { recursive: true });
  const lines = Array.from({ length: count }, (_, i) => JSON.stringify({
    type: 'assistant', timestamp: at, isSidechain: opts.sidechain ?? false,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: `${opts.prefix ?? session}-${i}`, name: 'Bash', input: {} }] },
  }));
  fs.writeFileSync(path.join(folder, `${session}.jsonl`), lines.join('\n') + '\n');
}
function costRows(dir: string, rows: object[]) {
  fs.writeFileSync(path.join(path.dirname(dir), '.claude/cost-log.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}
function execution(dir: string, session: string) {
  fs.writeFileSync(path.join(dir, 'state/execution.json'), JSON.stringify({ state: 'idle', at: new Date().toISOString(), cc_session_id: session }));
}
test('threshold flags only the digest; old review fields are ignored and dropped', () => {
  const dir = fixture(); const first = open(dir); transcript(dir, 'current', 9, openedAt(dir, first));
  expect(close(dir, first)).not.toHaveProperty('next');
  const id = open(dir); transcript(dir, 'current', 10, openedAt(dir, id));
  expect(close(dir, id).next).toEndWith('skills/task/learn.md');
  const record = readTasks(dir).find(row => row.id === id)!;
  expect(record).not.toHaveProperty('skill_review');
  const old = encodeTask(record).replace(/^delegated:.*\n/m, '').replace('---\n', '---\nskill_review: "pending"\n');
  const decoded = decodeTask(old);
  expect(decoded.delegated).toBe(false);
  expect(decoded).not.toHaveProperty('skill_review');
  expect(encodeTask(decoded)).not.toContain('skill_review');
});
test('reviews run only in modes where learning can write', () => {
  for (const permission_mode of ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions']) {
    const dir = fixture();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ permission_mode }));
    const digest = close(dir, open(dir, { owner: 'helper:review' }));
    expect(!!digest.next).toBe(['auto', 'bypassPermissions'].includes(permission_mode));
  }
});
test('worker and helper ownership persist delegation; both close paths schedule learning', () => {
  for (const owner of ['worker:abcdef123456', 'helper:research']) {
    const dir = fixture(); const id = open(dir, { check: 'true' });
    mutateTask(dir, 'note', id, { owner }, ''); mutateTask(dir, 'note', id, { owner: 'resident' }, '');
    expect(readTasks(dir)[0].delegated).toBe(true);
    const digest = mutateTask(dir, 'check-result', id, { 'result-rev': '0', exit: '0', 'output-stdin': true }, 'passed') as any;
    expect(digest.next).toEndWith('skills/task/learn.md');
  }
});
test('a qualifying close names the review guide by absolute path; other closes stay silent', () => {
  const dir = fixture();
  const quiet = close(dir, open(dir));
  expect(quiet).not.toHaveProperty('next');
  const { next } = close(dir, open(dir, { 'dedupe-key': 'helper:PROP-001' }));
  const guide = next.slice(next.indexOf('/'));
  expect(path.isAbsolute(guide)).toBe(true);
  expect(fs.readFileSync(guide, 'utf8')).toContain('# Close-time skill learning');
});
test('startup context carries no review recovery line', () => {
  const dir = fixture();
  close(dir, open(dir, { owner: 'helper:review' }));
  expect(startupTasks(dir, 0)).toEqual(['Open tasks: 0']);
});
test('helper dedupe keys mark new resident records delegated but preserve reused records', () => {
  const dir = fixture();
  const id = open(dir, { 'dedupe-key': 'helper:PROP-001' });
  const record = readTasks(dir)[0];
  expect(record).toMatchObject({ owner: 'resident', delegated: true });
  expect(close(dir, id).next).toEndWith('skills/task/learn.md');

  const legacy = fixture();
  const legacyId = open(legacy, { 'dedupe-key': 'helper:PROP-001' });
  const existing = readTasks(legacy)[0];
  existing.delegated = false;
  fs.writeFileSync(path.join(legacy, 'tasks', `${legacyId}.md`), encodeTask(existing));
  const reused = mutateTask(legacy, 'open', undefined, { requester: 'operator', 'dedupe-key': 'helper:PROP-001' }, '') as any;
  expect(reused).toMatchObject({ id: legacyId, created: false });
  expect(readTasks(legacy)[0]).toMatchObject({ owner: 'resident', delegated: false });
  expect(close(legacy, legacyId).next).toBeUndefined();
});
test('cancel and learning off never schedule a review', () => {
  for (const cancelled of [true, false]) {
    const dir = fixture(cancelled); const id = open(dir);
    transcript(dir, 'current', 10, openedAt(dir, id));
    if (cancelled) mutateTask(dir, 'cancel', id, { actor: 'operator', 'reason-stdin': true }, 'Cancelled');
    else close(dir, id);
    expect(readTasks(dir)[0]).not.toHaveProperty('skill_review');
  }
});

test('only calls in the open window qualify; missing transcripts are harmless', () => {
  const dir = fixture(); const id = open(dir);
  transcript(dir, 'current', 10, new Date(Date.parse(openedAt(dir, id)) - 1).toISOString());
  expect(close(dir, id).next).toBeUndefined();
  const missing = fixture(); const missingId = open(missing);
  expect(close(missing, missingId).closed_by).toBe('confirmed');
  expect(readTasks(missing)[0]).not.toHaveProperty('skill_review');
});

test('overlapping closes each count their own window, including after a delegated close', () => {
  const dir = fixture(); const first = open(dir); const second = open(dir);
  transcript(dir, 'current', 10, openedAt(dir, second));
  expect(close(dir, first).next).toEndWith('skills/task/learn.md');
  expect(close(dir, second).next).toEndWith('skills/task/learn.md');

  const other = fixture(); const delegated = open(other, { owner: 'helper:review' }); const ordinary = open(other);
  transcript(other, 'current', 10, openedAt(other, ordinary));
  expect(close(other, delegated).next).toEndWith('skills/task/learn.md');
  expect(close(other, ordinary).next).toEndWith('skills/task/learn.md');
});

test('resident session sources include old cost rows, runtime and execution', () => {
  const dir = fixture(); const id = open(dir); const at = openedAt(dir, id);
  transcript(dir, 'old', 10, at);
  costRows(dir, [{ cc_session_id: 'old', timestamp: at }]);
  expect(close(dir, id).next).toEndWith('skills/task/learn.md');

  const runtime = fixture(); const runtimeId = open(runtime);
  transcript(runtime, 'current', 10, openedAt(runtime, runtimeId));
  expect(close(runtime, runtimeId).next).toEndWith('skills/task/learn.md');

  const exec = fixture(); const execId = open(exec);
  execution(exec, 'execution-only');
  transcript(exec, 'execution-only', 10, openedAt(exec, execId));
  expect(close(exec, execId).next).toEndWith('skills/task/learn.md');
});

test('guest and subagent rows, sidechain entries, and old observations do not qualify', () => {
  const dir = fixture(); const id = open(dir); const at = openedAt(dir, id);
  for (const session of ['guest', 'agent', 'old']) transcript(dir, session, 10, at);
  transcript(dir, 'current', 10, at, { sidechain: true });
  costRows(dir, [
    { cc_session_id: 'guest', guest: true, observed_at: at },
    { cc_session_id: 'agent', subagent: true, observed_at: at },
    { cc_session_id: 'old', timestamp: at, observed_at: new Date(Date.parse(at) - 1).toISOString() },
  ]);
  expect(close(dir, id).next).toBeUndefined();
  expect(readTasks(dir)[0]).not.toHaveProperty('skill_review');
});

test('successful checks schedule, failed and approver-blocked checks do not', () => {
  for (const scenario of ['passed', 'failed', 'approver'] as const) {
    const dir = fixture(); const id = open(dir, { check: 'true', ...(scenario === 'approver' ? { approver: 'discord:u2' } : {}) });
    transcript(dir, 'current', 10, openedAt(dir, id));
    const digest = mutateTask(dir, 'check-result', id, { 'result-rev': '0', exit: scenario === 'failed' ? '1' : '0', 'output-stdin': true }, 'proof') as any;
    expect(!!digest.next).toBe(scenario === 'passed');
    const record = readTasks(dir)[0];
    expect(record.status).toBe(scenario === 'passed' ? 'closed' : 'open');
    expect(record).not.toHaveProperty('skill_review');
  }
});
test('missing config settles learning on for delegated tasks', () => {
  const dir = fixture(); fs.unlinkSync(path.join(dir, 'config.json'));
  const id = open(dir); mutateTask(dir, 'note', id, { owner: 'helper:review' }, '');
  expect(close(dir, id).next).toEndWith('skills/task/learn.md');
});

test('muting a closed delegated task preserves closure without review state', () => {
  const dir = fixture(); const id = open(dir, { owner: 'helper:review' });
  close(dir, id);
  mutateTask(dir, 'note', id, { muted: 'true' }, '');
  expect(readTasks(dir)[0]).toMatchObject({ status: 'closed', muted: true });
  expect(readTasks(dir)[0]).not.toHaveProperty('skill_review');
});
