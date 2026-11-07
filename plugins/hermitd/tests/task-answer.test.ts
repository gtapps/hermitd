import { test, expect } from 'bun:test';
import { decodeTask, mutateTask, isRunnable, type TaskFlags } from '../scripts/lib/tasks';
import { pendingDecisions } from '../scripts/lib/decisions';
import { taskFixture } from './helpers/tasks';

const chat = 'discord:home';
const consent = { purpose: 'consent', authority: 'admin', generation: 1 };
function fixture() {
  const f = taskFixture();
  f.put('config.json', { channels: { discord: { operators: ['admin'], allowed_users: ['admin', 'member', 'requester'], default_chat_id: 'home' } } });
  const read = (id: string) => decodeTask(f.text(id));
  const open = (decision: Record<string, unknown> = consent, extra = {}) => mutateTask(f.dir, 'open', undefined, {
    requester: 'agent', title: 'Agent proposal', done: 'Verified', kind: 'proposal', conversation: chat,
    'waiting-on': 'admin', decision: JSON.stringify(decision), ...extra,
  }, '') as { id: string };
  const answer = (id: string | undefined, reply = 'yes', user = 'admin', extra = {}) => mutateTask(f.dir, 'answer', id, { chat, user, reply, ...extra }, '') as any;
  return { ...f, read, openRecord: open, answer };
}

test('admin consent refuses members, isolates chats, records consent and one metrics row', () => {
  const f = fixture(); try {
    const { id } = f.openRecord();
    const before = f.text(id);
    expect(f.answer(id, 'yes', 'member')).toEqual({ status: 'refused', reason: 'not_decider' });
    expect(f.answer(id, 'yes', 'admin', { chat: 'discord:other' })).toEqual({ status: 'none', reason: 'no_pending' });
    expect(f.answer(id, 'unrelated')).toEqual({ status: 'none', reason: 'no_match' });
    expect(f.answer(id, 'yes', 'admin', { generation: '0' })).toEqual({ status: 'stale' });
    expect(f.text(id)).toBe(before);
    expect(f.answer(id)).toMatchObject({ status: 'match', id, answer: 'yes' });
    expect(f.read(id)).toMatchObject({ approved_rev: '0', approved_by: 'admin', approver: null, waiting_on: null });
    expect(isRunnable(f.read(id))).toBe(true);
    expect(f.answer(id)).toEqual({ status: 'none', reason: 'no_pending' });
  } finally { f.cleanup(); }
});

for (const authority of ['requester', 'chat', 'admin']) test(`${authority} input obeys its authority and no is an answer`, () => {
  const f = fixture(); try {
    const { id } = f.openRecord({ purpose: 'input', authority, generation: 1 }, { kind: false, requester: 'discord:requester' });
    const user = authority === 'requester' ? 'requester' : authority === 'chat' ? 'member' : 'admin';
    expect(f.answer(id, 'no', user)).toMatchObject({ status: 'match', answer: 'no' });
    expect(f.read(id)).toMatchObject({ status: 'open', waiting_on: null });
    expect(f.read(id).body).toContain(': no');
  } finally { f.cleanup(); }
});

for (const authority of ['requester', 'chat', 'admin']) test(`admin answers ${authority} input`, () => {
  const f = fixture(); try {
    const { id } = f.openRecord({ purpose: 'input', authority, generation: 1 }, { kind: false, requester: 'discord:requester' });
    expect(f.answer(id)).toMatchObject({ status: 'match' });
  } finally { f.cleanup(); }
});

test('consent no cancels with a reason and an unscoped admin decision is admin-only', () => {
  const f = fixture(); try {
    const { id } = f.openRecord(consent, { conversation: undefined });
    expect(f.answer(id, 'no', 'member')).toEqual({ status: 'none', reason: 'no_pending' });
    expect(f.answer(id, 'no')).toMatchObject({ status: 'match' });
    expect(f.read(id)).toMatchObject({ status: 'closed', closed_by: 'cancelled', closed_reason: 'Consent declined: no' });
  } finally { f.cleanup(); }
});

test('matching preserves all ambiguity reasons and supports numbers and labels', () => {
  const f = fixture(); try {
    const decision = { purpose: 'input', authority: 'chat', generation: 1, options: ['Alpha', 'Alpine', 'Beta'] };
    const { id } = f.openRecord(decision, { kind: false });
    for (const [reply, reason] of [['yes', 'options_require_choice'], ['10', 'number_out_of_range'], ['al', 'multiple_labels']]) expect(f.answer(id, reply)).toMatchObject({ status: 'ambiguous', reason });
    expect(f.answer(id, '2')).toMatchObject({ status: 'match', answer: 'Alpine' });
    const second = f.openRecord(decision, { kind: false });
    expect(f.answer(second.id, 'bet')).toMatchObject({ status: 'match', answer: 'Beta' });
    const labelled = f.openRecord({ ...decision, options: ['Yes', 'Later', 'Later today'] }, { kind: false });
    expect(f.answer(labelled.id, 'yes')).toMatchObject({ status: 'match', answer: 'Yes' });
    const prefixed = f.openRecord({ ...decision, options: ['Yes', 'Later', 'Later today'] }, { kind: false });
    expect(f.answer(prefixed.id, 'later')).toMatchObject({ status: 'match', answer: 'Later' });
    f.openRecord(); f.openRecord();
    expect(f.answer(undefined)).toMatchObject({ status: 'ambiguous', reason: 'multiple_pending' });
  } finally { f.cleanup(); }
});

test('pending consent cannot be bypassed through clear-wait, check, close, cancel, or a result block', () => {
  const f = fixture(); try {
    const { id } = f.openRecord(consent, { check: 'true' });
    const before = f.text(id);
    for (const [verb, flags] of [
      ['note', { 'clear-waiting': true, chat, user: 'admin' }],
      ['check-result', { 'result-rev': '0', exit: '0', 'output-stdin': true }],
      ['close', { by: 'confirmed', actor: 'admin', 'reason-stdin': true, chat, user: 'admin' }],
      ['cancel', { actor: 'admin', 'reason-stdin': true, chat, user: 'admin' }],
      ['block', { 'result-stdin': true }],
    ] as const) expect(() => mutateTask(f.dir, verb, id, flags, 'Bypass')).toThrow('not_decider');
    expect(f.text(id)).toBe(before);
  } finally { f.cleanup(); }
});

test('a changed definition resets consent, and a passing executable check closes an approved proposal', () => {
  const f = fixture(); try {
    const { id } = f.openRecord(consent, { check: 'true' });
    f.answer(id);
    mutateTask(f.dir, 'note', id, { done: 'New outcome', actor: 'admin' }, '');
    expect(f.read(id)).toMatchObject({ approved_rev: null, waiting_on: 'admin' });
    expect(JSON.parse(f.read(id).decision!)).toMatchObject({ purpose: 'consent', generation: 2 });
    f.answer(id);
    mutateTask(f.dir, 'note', id, { check: 'true' }, '');
    expect(f.read(id).waiting_on).toBeNull();
    mutateTask(f.dir, 'check-result', id, { 'result-rev': String(f.read(id).result_rev), exit: '0', 'output-stdin': true }, 'Verified');
    expect(f.read(id)).toMatchObject({ status: 'closed', closed_by: 'check' });
  } finally { f.cleanup(); }
});

for (const purpose of ['result', 'input', 'consent']) test(`a ${purpose} block chooses the right consent and wait`, () => {
  const f = fixture(); try {
    const { id } = f.openRecord(); f.answer(id);
    const flags: TaskFlags = purpose === 'result' ? { 'result-stdin': true } : { 'waiting-on': 'agent', 'status-line': 'Question', next: 'Reply', decision: JSON.stringify({ purpose, authority: 'admin', generation: 2 }) };
    mutateTask(f.dir, 'block', id, flags, 'Ready');
    expect(f.read(id).waiting_on).toBe('admin');
    expect(f.read(id).approved_rev).toBe(purpose === 'consent' ? null : '0');
    expect(JSON.parse(f.read(id).decision!).purpose).toBe(purpose);
    if (purpose === 'result') {
      expect(f.answer(id, 'yes', 'admin', { 'result-rev': '0' })).toEqual({ status: 'stale' });
      expect(f.answer(id)).toMatchObject({ status: 'match' });
      expect(f.read(id).status).toBe('closed');
    }
  } finally { f.cleanup(); }
});

test('a fresh CLI process answers the durable question after runtime state is cleared', async () => {
  const f = fixture(); try {
    const { id } = f.openRecord();
    f.put('state/runtime.json', {});
    const result = await f.ok('answer', [id, '--chat', chat, '--user', 'admin', '--reply', 'yes']);
    expect(result).toMatchObject({ status: 'match', id });
    expect(f.read(id)).toMatchObject({ waiting_on: null, approved_by: 'admin' });
    expect(await f.ok('answer', [id, '--chat', chat, '--user', 'admin', '--reply', 'yes'])).toMatchObject({ status: 'none', reason: 'no_pending' });
  } finally { f.cleanup(); }
});

test('first executable check preserves consent; replacing or clearing a check resets it', () => {
  const f = fixture(); try {
    const first = f.openRecord(); f.answer(first.id);
    const approved = f.read(first.id).approved_rev;
    mutateTask(f.dir, 'note', first.id, { check: 'true' }, '');
    expect(f.read(first.id)).toMatchObject({ approved_rev: approved, approved_by: 'admin', waiting_on: null });
    expect(JSON.parse(f.read(first.id).decision!).generation).toBe(1);
    mutateTask(f.dir, 'check-result', first.id, { 'result-rev': String(f.read(first.id).result_rev), exit: '0', 'output-stdin': true }, 'Verified');
    expect(f.read(first.id).closed_by).toBe('check');
    for (const replacement of ['false', 'clear']) {
      const { id } = f.openRecord(); f.answer(id);
      mutateTask(f.dir, 'note', id, { check: 'true' }, '');
      mutateTask(f.dir, 'note', id, { check: replacement }, '');
      expect(f.read(id)).toMatchObject({ approved_rev: null, waiting_on: 'admin' });
      expect(JSON.parse(f.read(id).decision!).generation).toBe(2);
    }
  } finally { f.cleanup(); }
});

test('new decisions advance beyond answered generations and get a fresh delivery budget', () => {
  const f = fixture(); try {
    const { id } = f.openRecord();
    f.put('state/decision-deliveries.json', { [`${id}:1`]: 2 });
    f.answer(id);
    mutateTask(f.dir, 'block', id, { 'result-stdin': true }, 'Authored result');
    expect(JSON.parse(f.read(id).decision!).generation).toBe(2);
    const pending = pendingDecisions(f.dir);
    expect(pending.ok && pending.records.find(row => row.task.id === id)?.delivered).toBe(0);
    f.answer(id, 'no');
    const block = (purpose: string) => mutateTask(f.dir, 'block', id, { 'waiting-on': 'admin', 'status-line': 'Question', next: 'Reply',
      decision: JSON.stringify({ purpose, authority: 'admin', generation: 1 }) }, '');
    block('input');
    expect(JSON.parse(f.read(id).decision!).generation).toBe(3);
    f.answer(id);
    block('consent');
    expect(JSON.parse(f.read(id).decision!).generation).toBe(4);
    expect(f.read(id).approved_rev).toBeNull();
    expect(f.answer(id, 'yes', 'admin', { generation: '1' })).toEqual({ status: 'stale' });
  } finally { f.cleanup(); }
});
