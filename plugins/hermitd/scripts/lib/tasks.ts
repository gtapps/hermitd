import { lastRoutineFire, lastRoutineEvent } from './routines/history';
import { readAlertState } from './alert-state';
import { readConfigRaw } from './config-read';
import { readJson } from './cli';
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, globDirRecursive } from './frontmatter';
import { serializeValue, writeFileAtomic } from './md-write';
import { acquireLockWithWait, releaseLock } from './lockfile';
import { checkKey } from './conversation-key';
import { findResident } from './session-registry';
import { compactibleTokens, isOwnTurn } from './context-signal';
import { readContextSurface } from './context-surface';
import { allocateTaskShares, BY_TASK_RETENTION_DAYS, computeIndex, readCostIndex, costIndexPath } from './cost-log';
import { todayYMD } from './time';
import { costLogPath } from './cc-compat';

export const TASK_ID = /^T-\d{8}-\d{6}(-[a-z0-9])?$/;
const SLUG = /^[\w.:~+@;=-]+$/;
const HOUR = 3600000;
const requiredStrings = ['id', 'type', 'title', 'created', 'summary', 'audience', 'status', 'opened_at', 'requester', 'handle', 'owner'] as const;
const nullableStrings = ['closed_at', 'closed_by', 'closed_actor', 'closed_reason', 'requester_name', 'origin_message_id', 'approver', 'due', 'conversation', 'card_chat_id', 'card_message_id', 'waiting_on', 'waiting_since', 'result', 'result_at', 'stall_at', 'stall_status', 'stall_next', 'dedupe_key', 'check'] as const;
const booleans = ['muted'] as const;
export type Task = Record<typeof requiredStrings[number], string> & Record<typeof nullableStrings[number], string | null> & Record<typeof booleans[number], boolean> & { tags: string[]; claims: string[]; result_rev: number; body: string };
// A worker owner is `worker:<agentId>`; the id is the harness's, not a conversation key.
// An agent id is lowercase hex (probed shape: `a5670124e38fb50cb`); the charset keeps
// the `worker:*` list wildcard, or any other non-id string, from being stored as an owner.
const WORKER_OWNER = /^worker:[0-9a-f]{8,}$/;
const HELPER_OWNER = /^helper:[A-Za-z0-9._-]{1,64}$/;
const validOwner = (value: string) => value === 'resident' || WORKER_OWNER.test(value) || HELPER_OWNER.test(value);
// The records that own a chat thread: one open record per conversation key, held by
// the resident, a worker, or a spawned helper session. The three hook paths that resolve a
// thread from a chat id all read it from here.
export const threadRecords = (dir: string): Task[] =>
  readTasks(dir).filter(record => record.status === 'open' && record.conversation !== null && validOwner(record.owner));
const clean = (value: string) => value.replace(/[\r\n]+/g, ' ');
const iso = (value: string) => /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));

export function validateTask(record: Task): void {
  const fail = () => { throw new Error('invalid-record'); };
  for (const key of requiredStrings) if (typeof record[key] !== 'string' || !record[key]) fail();
  for (const key of nullableStrings) if (record[key] !== null && typeof record[key] !== 'string') fail();
  if (!TASK_ID.test(record.id) || record.type !== 'task' || !['open', 'closed'].includes(record.status)) fail();
  if (![null, 'check', 'confirmed', 'cancelled'].includes(record.closed_by)) fail();
  if (!Number.isInteger(record.result_rev) || record.result_rev < 0) fail();
  for (const key of booleans) if (typeof record[key] !== 'boolean') fail();
  for (const key of ['tags', 'claims'] as const) if (!Array.isArray(record[key]) || record[key].some(x => typeof x !== 'string' || !SLUG.test(x))) fail();
  for (const key of ['created', 'opened_at', 'closed_at', 'due', 'waiting_since', 'result_at', 'stall_at'] as const) if (record[key] !== null && !iso(record[key]!)) fail();
  if (record.created !== record.opened_at || (record.status === 'closed') !== (record.closed_by !== null && record.closed_at !== null)) fail();
  if (!validRequester(record.requester) || !SLUG.test(record.handle)) fail();
  try { if (record.conversation !== null) checkKey(record.conversation); if (record.audience !== 'operator') checkKey(record.audience); } catch { fail(); }
  if (!validOwner(record.owner)) fail();
}

export function decodeTask(text: string): Task {
  try {
    const fm = parseFrontmatter(text);
    if (!fm) throw new Error();
    const end = text.indexOf('\n---', 3);
    // The generic parser intentionally leaves JSON escapes alone. Decode only the
    // raw quoted scalar here, keeping all existing readers' behavior unchanged.
    for (const line of text.slice(4, end).split('\n')) {
      const match = line.match(/^(\w+):\s*(".*")\s*$/);
      if (match) fm[match[1]] = JSON.parse(match[2]);
    }
    if (!/^\d+$/.test(String(fm.result_rev))) throw new Error();
    fm.result_rev = Number(fm.result_rev);
    for (const key of booleans) {
      if (fm[key] !== undefined && fm[key] !== 'true' && fm[key] !== 'false') throw new Error();
      fm[key] = fm[key] === 'true';
    }
    const record = { ...fm, body: text.slice(end + 4).replace(/^\n/, '') } as Task;
    for (const key of nullableStrings) if (!(key in record)) record[key] = null;
    validateTask(record);
    return record;
  } catch { throw new Error('invalid-record'); }
}

export function encodeTask(record: Task): string {
  validateTask(record);
  const keys = [...requiredStrings, ...nullableStrings, ...booleans, 'tags', 'claims', 'result_rev'] as const;
  // A bare `null` reads back as the null literal, so the string "null" must stay quoted.
  const encode = (value: unknown) => typeof value === 'string' ? (clean(value) === 'null' ? '"null"' : serializeValue(clean(value))) : serializeValue(value);
  return '---\n' + keys.map(key => `${key}: ${encode(record[key])}`).join('\n') + '\n---\n' + record.body;
}

export function readTasks(dir: string): Task[] {
  return globDirRecursive(path.join(dir, 'tasks')).map(file => {
    const record = decodeTask(fs.readFileSync(file, 'utf8'));
    if (path.basename(file) !== `${record.id}.md`) throw new Error('invalid-record');
    return record;
  }).sort((a, b) => a.opened_at.localeCompare(b.opened_at) || a.id.localeCompare(b.id));
}

export function allocateTaskId(ids: string[], now: string): string {
  const base = 'T-' + now.slice(0, 10).replaceAll('-', '') + '-' + now.slice(11, 19).replaceAll(':', '');
  for (const suffix of ['', ...'0123456789abcdefghijklmnopqrstuvwxyz'].map(x => x ? `-${x}` : '')) if (!ids.includes(base + suffix)) return base + suffix;
  throw new Error('id-collision');
}

function validRequester(value: string): boolean {
  if (value === 'operator') return true;
  try { checkKey(value); return true; } catch { return false; }
}

function append(record: Task, section: string, actor: string, text: string, now: string): void {
  const heading = `## ${section}\n`;
  if (!record.body.includes(heading)) record.body = record.body.trimEnd() + '\n\n' + heading;
  const start = record.body.indexOf(heading);
  const next = record.body.indexOf('\n## ', start + heading.length);
  const at = next === -1 ? record.body.length : next;
  record.body = record.body.slice(0, at).trimEnd() + `\n- ${now} ${clean(actor)}: ${clean(text)}\n` + record.body.slice(at);
}

export type TaskFlags = Record<string, string | boolean | string[]>;
const flag = (flags: TaskFlags, name: string): string | undefined => typeof flags[name] === 'string' ? flags[name] as string : undefined;
function required(flags: TaskFlags, name: string): string {
  const value = flag(flags, name)?.trim();
  if (!value) throw new Error(`missing-${name}`);
  return clean(value);
}
function dateFlag(flags: TaskFlags, name: string): string | null {
  const value = flag(flags, name);
  if (!value) return null;
  if (!iso(value)) throw new Error(`invalid-${name}`);
  return new Date(value).toISOString();
}
function ownerFlag(flags: TaskFlags): string {
  // Re-stating the owner a record already has is a no-op.
  const value = flag(flags, 'owner') ?? '';
  if (!validOwner(value)) throw new Error('invalid-owner');
  return value;
}
function checkOwnerAvailable(records: Task[], owner: string, id?: string): void {
  if (owner !== 'resident' && records.some(record => record.status === 'open' && record.owner === owner && record.id !== id)) throw new Error('owner-busy');
}
function mutedFlag(flags: TaskFlags): boolean {
  const value = flag(flags, 'muted');
  if (value !== 'true' && value !== 'false') throw new Error('invalid-muted');
  return value === 'true';
}
function card(record: Task, value: string | undefined): void {
  if (value === undefined) return;
  if (record.owner !== 'resident') throw new Error('card-on-worker-task');
  let input;
  try { input = JSON.parse(value); } catch { throw new Error('invalid-card'); }
  if (!input || typeof input.chat_id !== 'string' || !input.chat_id || typeof input.message_id !== 'string' || !input.message_id || Object.keys(input).some(key => !['chat_id', 'message_id'].includes(key))) throw new Error('invalid-card');
  record.card_chat_id = input.chat_id;
  record.card_message_id = input.message_id;
}

// This is the only transition that assigns closed_by or closes a record.
function finish(record: Task, by: 'check' | 'confirmed' | 'cancelled', actor: string, reason: string, now: string): void {
  record.status = 'closed';
  record.closed_by = by;
  record.closed_at = now;
  record.closed_actor = actor;
  record.closed_reason = reason;
  record.waiting_on = null;
  record.waiting_since = null;
  append(record, 'Outcome', actor, reason, now);
}

// Reads later.ts's ledger directly: `later.ts list` keeps only the last 10 settled
// rows, which would hide an older held claim.
function heldClaim(dir: string, id: string): boolean {
  let text: string;
  try { text = fs.readFileSync(path.join(dir, 'state', 'hypotheses.jsonl'), 'utf8'); } catch { return false; }
  return text.split('\n').some(line => {
    try { const row = JSON.parse(line); return row.id === id && row.state === 'held'; } catch { return false; }
  });
}

export function mutateTask(dir: string, verb: string, id: string | undefined, flags: TaskFlags, input: string): unknown {
  if (id !== undefined && !TASK_ID.test(id)) throw new Error('invalid-id');
  const lock = path.join(dir, 'state', 'tasks.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  if (!acquireLockWithWait(lock, 2000)) throw new Error('lock-unavailable');
  try {
    const records = readTasks(dir);
    const now = new Date().toISOString();
    let record: Task;
    let digest: unknown;
    let progress = true;
    if (verb === 'open') {
      const requester = required(flags, 'requester');
      if (!validRequester(requester)) throw new Error('invalid-requester');
      const conversation = flag(flags, 'conversation') ?? null;
      try { if (conversation !== null) checkKey(conversation); } catch { throw new Error('invalid-conversation'); }
      const owner = 'owner' in flags ? ownerFlag(flags) : 'resident';
      const dedupe = flag(flags, 'dedupe-key') ?? null;
      const existing = dedupe && records.find(r => r.status === 'open' && r.dedupe_key === dedupe);
      if (existing) return openDigest(existing, records, false);
      checkOwnerAvailable(records, owner);
      const title = required(flags, 'title');
      const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'task';
      let handle = base;
      for (let n = 2; records.some(r => r.status === 'open' && r.handle === handle); n++) handle = `${base}-${n}`;
      record = {
        ...Object.fromEntries(nullableStrings.map(key => [key, null])),
        id: allocateTaskId(records.map(r => r.id), now), type: 'task', title, created: now, summary: flag(flags, 'done') ?? (flags['note-stdin'] ? title : required(flags, 'done')),
        tags: ['task', requester], audience: conversation ?? 'operator', status: 'open', opened_at: now,
        requester, requester_name: flag(flags, 'requester-name') ?? null, origin_message_id: flag(flags, 'origin-message-id') ?? null,
        approver: flag(flags, 'approver') ?? null, due: dateFlag(flags, 'due'), conversation, handle, owner,
        dedupe_key: dedupe, claims: (flags.claim as string[] | undefined) ?? [], result_rev: 0,
        muted: 'muted' in flags ? mutedFlag(flags) : false,
        body: '## Progress\n\n## Decisions\n\n## Approvals\n\n## Lessons\n\n## Outcome\n',
      } as Task;
      record.check = checkFlag(flags);
      card(record, flag(flags, 'card'));
      append(record, 'Progress', requester, 'Opened: ' + record.summary, now);
      if (flags['note-stdin'] && input.trim()) append(record, 'Progress', requester, input.trim(), now);
      records.push(record);
      digest = openDigest(record, records, true);
    } else {
      const found = records.find(r => r.id === id);
      if (!found) throw new Error('not-found');
      record = found;
      if (verb === 'check-snapshot') return { check: record.check, result_rev: record.result_rev, status: record.status };
      if (verb === 'check-result' && (record.status !== 'open' || !record.check || !/^\d+$/.test(flag(flags, 'result-rev') ?? '') || Number(flags['result-rev']) !== record.result_rev)) throw new Error('stale-check');
      if (record.status !== 'open') throw new Error('not-open');
      const actor = flag(flags, 'actor') ?? 'hermit';
      const line = clean(input.trim());
      if (verb === 'note') {
        const metadata = ['due', 'card', 'check', 'decision', 'approval', 'done', 'clear-waiting', 'owner', 'muted'].some(key => key in flags);
        if (!line && !metadata) throw new Error('empty');
        progress = !!line || 'owner' in flags;
        if (line) append(record, flags.decision ? 'Decisions' : 'Progress', actor, line, now);
        if ('check' in flags && record.check !== checkFlag(flags)) { record.check = checkFlag(flags); record.result_rev++; }
        if ('due' in flags) record.due = dateFlag(flags, 'due');
        card(record, flag(flags, 'card'));
        if ('owner' in flags) {
          const owner = ownerFlag(flags);
          checkOwnerAvailable(records, owner, record.id);
          record.owner = owner;
        }
        if ('muted' in flags) record.muted = mutedFlag(flags);
        if (flags['clear-waiting']) { record.waiting_on = null; record.waiting_since = null; }
        if ('done' in flags) {
          record.summary = required(flags, 'done');
          record.result_rev++;
          record.result = null;
          record.result_at = null;
          if (!('check' in flags)) record.check = null;
          append(record, 'Decisions', required(flags, 'actor'), 'Definition of done: ' + record.summary, now);
        }
        if ('approval' in flags) {
          const approval = required(flags, 'approval');
          const match = approval.match(/^(.+):\s+(.+)$/);
          if (!match) throw new Error('invalid-approval');
          append(record, 'Approvals', match[1], match[2], now);
        }
        digest = { id, result_rev: record.result_rev };
      } else if (verb === 'lesson') {
        if (!line) throw new Error('empty');
        for (const lesson of input.trim().split(/\r?\n/).filter(line => line.trim())) append(record, 'Lessons', actor, lesson, now);
        digest = { id };
      } else if (verb === 'check-result') {
        const exit = flag(flags, 'exit');
        if (!flags['output-stdin'] || !/^-?\d+$/.test(exit ?? '')) throw new Error('invalid-check-result');
        if (Number(exit) === 0) {
          // Clearing the passed check is what ends the daily run: the record stays open with its
          // result, and a still-set check would re-execute the command on every later wake forever.
          if (record.approver) { record.check = null; append(record, 'Progress', 'hermit', `check passed; approver confirmation still required${line ? ' ' + line : ''}`, now); }
          else {
            finish(record, 'check', 'hermit', 'check:exit-0', now);
            if (line) append(record, 'Outcome', 'hermit', line, now);
          }
        } else append(record, 'Progress', 'hermit', `check:exit-${exit} ${line}`, now);
        digest = { id, closed_by: record.closed_by, result_rev: record.result_rev };
      } else if (verb === 'block') {
        if (flags['result-stdin']) {
          if (!line) throw new Error('empty');
          record.result = line; record.result_rev++; record.result_at = now;
          record.waiting_on = flag(flags, 'waiting-on') ?? record.approver ?? record.requester;
          append(record, 'Outcome', actor, line, now);
          digest = { id, listing: 'unconfirmed', result_rev: record.result_rev, waiting_on: record.waiting_on };
        } else {
          if (!flag(flags, 'status-line') || !flag(flags, 'next')) throw new Error('stall-needs-status-and-next');
          record.waiting_on = required(flags, 'waiting-on');
          record.stall_at = now; record.stall_status = required(flags, 'status-line'); record.stall_next = required(flags, 'next');
          append(record, 'Progress', actor, `${record.stall_status}; next: ${record.stall_next}`, now);
          digest = { id, post_to: { conversation: record.conversation, requester: record.requester }, status_line: record.stall_status, next_step: record.stall_next };
        }
        record.waiting_since = now;
      } else if (verb === 'close') {
        const by = flag(flags, 'by');
        if (by !== 'check' && by !== 'confirmed') throw new Error('invalid-closed-by');
        const closer = required(flags, 'actor');
        let reason = line;
        if (by === 'confirmed') {
          if (record.approver && closer !== record.approver) throw new Error('approver-required');
          if (!record.result || !/^\d+$/.test(flag(flags, 'result-rev') ?? '') || Number(flags['result-rev']) !== record.result_rev) throw new Error('stale-result');
          if (!flags['reason-stdin'] || !reason) throw new Error('empty-reason');
        } else {
          if (record.approver) throw new Error('approver-required');
          const claim = (flags.claim as string[] | undefined)?.[0];
          if (closer.startsWith('duty:') && record.dedupe_key?.startsWith(closer + ':')) reason = closer;
          else if (closer === 'hermit' && claim && record.claims.includes(claim) && heldClaim(dir, claim)) reason = `later:${claim}:held`;
          else throw new Error('check-needs-evidence');
        }
        finish(record, by, closer, reason, now);
        digest = { id, closed_by: by, result_rev: record.result_rev, next_queued: nextQueued(records) };
      } else if (verb === 'cancel') {
        const closer = required(flags, 'actor');
        if (!flags['reason-stdin'] || !line) throw new Error('empty-reason');
        finish(record, 'cancelled', closer, line, now);
        digest = { id, closed_by: 'cancelled', next_queued: nextQueued(records) };
      } else throw new Error('invalid-verb');
    }
    const encoded = encodeTask(record);
    fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
    writeFileAtomic(path.join(dir, 'tasks', record.id + '.md'), encoded);
    if (progress) bindTaskTurn(dir, record.id);
    return digest;
  } finally { releaseLock(lock); }
}

function openDigest(record: Task, records: Task[], created: boolean) {
  return { id: record.id, handle: record.handle, created, open_count: records.filter(r => r.status === 'open').length, queued: taskListing(record, records).includes('queued') };
}
export function taskListing(record: Task, records: Task[], shared = false): string[] {
  const labels: string[] = [];
  if (record.status === 'closed') return ['closed'];
  if (record.due && Date.parse(record.due) < Date.now()) labels.push('late');
  if (record.result) labels.push('unconfirmed');
  else if (record.waiting_on) labels.push(`waiting on ${record.waiting_on}`);
  if (isRunnable(record) && records.some(r => isRunnable(r) && (r.opened_at < record.opened_at || r.opened_at === record.opened_at && r.id < record.id))) labels.push('queued');
  if (shared) labels.push('shared');
  return labels.length ? labels : ['open'];
}

export function isRunnable(record: Task): boolean {
  return record.status === 'open' && record.owner === 'resident' && !record.result && !record.waiting_on;
}
function nextQueued(records: Task[]) {
  const next = records.find(isRunnable);
  return next ? { id: next.id, handle: next.handle, title: next.title } : null;
}
function checkFlag(flags: TaskFlags): string | null {
  const value = flag(flags, 'check');
  return !value || ['null', 'none', 'clear'].includes(value) ? null : value;
}

export function listTasks(dir: string, flags: TaskFlags = {}) {
  const records = readTasks(dir);
  const owner = flag(flags, 'owner');
  if (owner && owner !== 'worker:*' && !validOwner(owner)) throw new Error('invalid-owner');
  const limit = flags.limit === undefined ? 20 : Number(flags.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('invalid-limit');
  const selected = records.filter(r => (!flags.all || flags.open ? r.status === 'open' : true)
    && (!owner || (owner === 'worker:*' ? r.owner.startsWith('worker:') : r.owner === owner))
    && (!flags['with-check'] || !!r.check)
    && ['conversation', 'requester', 'handle', 'id', 'dedupe-key'].every(key => !flag(flags, key) || r[key === 'dedupe-key' ? 'dedupe_key' : key as 'id'] === flag(flags, key)));
  const rows = selected.slice(0, limit).map(r => ({ id: r.id, handle: r.handle, listing: taskListing(r, records), requester: r.requester, title: r.title, due: r.due, result_rev: r.result_rev, owner: r.owner, result: r.result, waiting_on: r.waiting_on, closed_by: r.closed_by, check: r.check, card_chat_id: r.card_chat_id, card_message_id: r.card_message_id }));
  return { rows, total: selected.length, omitted: selected.length - rows.length, execution: readExecution(dir, { registryFallback: true }) };
}

export interface Execution { state: 'in_flight' | 'idle' | 'unknown'; turn_id: string | null; at: string | null; source: string | null; cc_session_id: string | null; reason: string | null; registry?: string | null; waitingFor?: string | null; display?: string }
export function readExecution(dir: string, options: { registryFallback?: true } = {}): Execution {
  const raw = readJson(path.join(dir, 'state/execution.json'));
  const empty: Execution = { state: 'unknown', turn_id: null, at: null, source: null, cc_session_id: null, reason: null };
  const result: Execution = !raw || !['in_flight', 'idle', 'unknown'].includes(raw.state) || !iso(raw.at ?? '') ? empty
    : { ...empty, ...raw, state: raw.state === 'in_flight' && Date.now() - Date.parse(raw.at) > HOUR ? 'unknown' : raw.state };
  if (options.registryFallback && result.state === 'unknown') {
    const runtime = readJson(path.join(dir, 'state/runtime.json'));
    const resident = findResident(runtime, runtime?.config_dir) as (ReturnType<typeof findResident> & { waitingFor?: string });
    result.registry = resident?.status ?? null;
    result.waitingFor = typeof resident?.waitingFor === 'string' ? resident.waitingFor : null;
    if (resident) result.display = `execution: unknown (registry: ${resident.status}${result.waitingFor ? ', ' + result.waitingFor : ''}, live process)`;
  }
  return result;
}
export function passesExecutionBoundary(dir: string, options: { minTokens?: number } = {}): { ok: true } | { ok: false; reason: string } {
  const execution = readExecution(dir);
  if (execution.state !== 'idle') return { ok: false, reason: 'execution-not-idle' };
  const runtime = readJson(path.join(dir, 'state/runtime.json'));
  if (!execution.cc_session_id || execution.cc_session_id !== runtime?.cc_session_id) return { ok: false, reason: 'stale-identity' };
  if (!execution.at || Date.now() - Date.parse(execution.at) < 60000) return { ok: false, reason: 'idle-too-fresh' };
  // The resident takes a record back (`note --owner resident`) before it posts a
  // result or parks it, so ownership alone says whether a worker still holds it.
  if (readTasks(dir).some(r => r.status === 'open' && r.owner.startsWith('worker:'))) return { ok: false, reason: 'worker-running' };
  const resident = findResident(runtime, runtime?.config_dir);
  if (resident && !['idle', 'shell'].includes(resident.status)) return { ok: false, reason: 'registry-busy' };
  if (options.minTokens !== undefined) {
    const entry = readTaskCostRows(dir).findLast(row => isOwnTurn(row, execution.cc_session_id!));
    if (!entry || compactibleTokens(entry, readContextSurface(dir)?.surface_upper_bound_tokens ?? null) < options.minTokens) return { ok: false, reason: 'under-token-floor' };
  }
  return { ok: true };
}
export function observeExecution(dir: string, state: Execution['state'], session: string | null, source: string | null, reason: string | null): void {
  try {
    const previous = readExecution(dir);
    writeFileAtomic(path.join(dir, 'state/execution.json'), JSON.stringify({ state, turn_id: state === 'in_flight' ? crypto.randomUUID() : previous.turn_id, at: new Date().toISOString(), source: source ?? previous.source, cc_session_id: session, reason }) + '\n');
  } catch { /* advisory, never gates the hook */ }
}
interface Binding { cc_session_id: string; task_ids: string[]; at: string; turn_id: string | null }
function readBinding(dir: string): Binding | null {
  const raw = readJson(path.join(dir, 'state/task-turn.json'));
  return raw && typeof raw.cc_session_id === 'string' && iso(raw.at ?? '') && Array.isArray(raw.task_ids) && raw.task_ids.length && raw.task_ids.every((id: unknown) => typeof id === 'string' && TASK_ID.test(id)) ? raw : null;
}
export function bindTaskTurn(dir: string, id: string): void {
  const execution = readExecution(dir);
  if (!execution.cc_session_id) return;
  const previous = readBinding(dir);
  const rows = readTaskCostRows(dir);
  const last = rows.filter(r => !r.subagent && r.cc_session_id === execution.cc_session_id).at(-1);
  const keep = previous && previous.cc_session_id === execution.cc_session_id && Date.now() - Date.parse(previous.at) <= HOUR && (!last?.observed_at || previous.at > last.observed_at);
  const taskIds = keep ? [...previous.task_ids] : [];
  if (!taskIds.includes(id)) taskIds.push(id);
  writeFileAtomic(path.join(dir, 'state/task-turn.json'), JSON.stringify({ cc_session_id: execution.cc_session_id, task_ids: taskIds, at: keep ? previous.at : new Date().toISOString(), turn_id: execution.turn_id }) + '\n');
}
export type Bucket = 'tasks' | 'conversation' | 'duties';
export interface TaskAttribution { task_id: string | null; task_ids?: string[]; bucket: Bucket; attribution: 'binding' | 'dispatch' | 'source'; binding_at?: string }
export const costBucket = (row: { bucket?: Bucket }): Bucket => row.bucket ?? 'conversation';
export function resolveTaskAttribution(dir: string, session: string, source: string, lastObserved: string | null): TaskAttribution {
  const binding = readBinding(dir);
  if (binding && Date.now() - Date.parse(binding.at) > HOUR) {
    try { fs.unlinkSync(path.join(dir, 'state/task-turn.json')); } catch {}
  } else if (binding && binding.cc_session_id === session && (!lastObserved || binding.at > lastObserved)) {
    return { task_id: binding.task_ids[0], ...(binding.task_ids.length > 1 ? { task_ids: binding.task_ids } : {}), bucket: 'tasks', attribution: 'binding', binding_at: binding.at };
  }
  return { task_id: null, bucket: source === 'heartbeat' || source.startsWith('routine:') ? 'duties' : 'conversation', attribution: 'source' };
}
export function consumeTaskBinding(dir: string, attribution: TaskAttribution): void {
  if (attribution.attribution !== 'binding') return;
  const lock = path.join(dir, 'state/tasks.lock');
  if (!acquireLockWithWait(lock, 2000)) return;
  try {
    const binding = readBinding(dir);
    if (binding?.at === attribution.binding_at) fs.unlinkSync(path.join(dir, 'state/task-turn.json'));
  } catch { /* already consumed */ } finally { releaseLock(lock); }
}
export function readTaskCostRows(dir: string): any[] {
  try { return fs.readFileSync(costLogPath(dir), 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch { return []; }
}
export function dispatchTaskAttribution(dir: string, rows: any[], session: string, boundary: string): TaskAttribution {
  const row = rows.filter(r => !r.subagent && r.cc_session_id === session && r.observed_at >= boundary).sort((a, b) => a.observed_at.localeCompare(b.observed_at))[0];
  if (row) return { task_id: row.task_id ?? null, ...(row.task_ids ? { task_ids: row.task_ids } : {}), bucket: costBucket(row), attribution: 'dispatch' };
  const binding = readBinding(dir);
  if (binding && binding.cc_session_id === session && binding.at >= boundary && Date.now() - Date.parse(binding.at) <= HOUR) return { task_id: binding.task_ids[0], ...(binding.task_ids.length > 1 ? { task_ids: binding.task_ids } : {}), bucket: 'tasks', attribution: 'dispatch' };
  return { task_id: null, bucket: 'conversation', attribution: 'dispatch' };
}
export interface PersonTasks { identity: string; name: string | null; promised: TaskSummary[]; late: TaskSummary[]; waiting: TaskSummary[] }
interface TaskSummary { id: string; handle: string; title: string; due: string | null; cost_usd: number; listing: string[] }
export function taskStandup(dir: string, days = 7) {
  const records = readTasks(dir);
  const timezone = readConfigRaw(dir)?.timezone ?? 'UTC';
  const from = todayYMD(timezone, new Date(Date.now() - days * 86400000));
  const to = todayYMD(timezone);
  const totals: Record<string, number> = {};
  let preUpgrade = false;
  if (days <= BY_TASK_RETENTION_DAYS) {
    const index = readCostIndex(costIndexPath(dir)) ?? computeIndex(costLogPath(dir), timezone);
    for (const [id, buckets] of Object.entries(index.by_task) as [string, Record<string, { cost: number }>][]) {
      totals[id] = Object.entries(buckets).reduce((sum, [date, bucket]) => sum + (date >= from && date <= to ? bucket.cost : 0), 0);
    }
  } else {
    for (const row of readTaskCostRows(dir)) {
      const at = new Date(row.timestamp ?? row.observed_at);
      if (!Number.isFinite(at.getTime())) continue;
      const date = todayYMD(timezone, at);
      if (date < from || date > to) continue;
      if (!row.bucket) preUpgrade = true;
      for (const share of allocateTaskShares(row)) totals[share.task_id] = (totals[share.task_id] ?? 0) + share.cost;
    }
  }
  const people = new Map<string, PersonTasks>();
  const person = (identity: string, name: string | null = null) => {
    if (!people.has(identity)) people.set(identity, { identity, name, promised: [], late: [], waiting: [] });
    const p = people.get(identity)!;
    if (name) p.name = name;
    return p;
  };
  for (const record of records.filter(r => r.status === 'open').sort((a, b) => (a.due ?? 'z').localeCompare(b.due ?? 'z'))) {
    const listing = taskListing(record, records);
    const summary = { id: record.id, handle: record.handle, title: record.title, due: record.due, cost_usd: totals[record.id] ?? 0, listing };
    const p = person(record.requester, record.requester_name);
    p.promised.push(summary);
    if (listing.includes('late')) p.late.push(summary);
    if (record.waiting_on) person(record.waiting_on).waiting.push(summary);
  }
  return { byPerson: [...people.values()].sort((a, b) => a.identity.localeCompare(b.identity)), closed: Object.fromEntries(['check', 'confirmed', 'cancelled'].map(by => [by, records.filter(r => r.closed_by === by && r.closed_at && todayYMD(timezone, new Date(r.closed_at)) >= from).map(r => ({ id: r.id, handle: r.handle, title: r.title, cost_usd: totals[r.id] ?? 0 }))])), pre_upgrade: preUpgrade ? 'pre-upgrade' : null, execution: readExecution(dir, { registryFallback: true }) };
}
export function startupTasks(dir: string): string[] {
  const list = listTasks(dir);
  return [`Open tasks: ${list.total}`, ...list.rows.slice(0, 4).map(r => `${r.id} ${r.handle} ${r.listing.join(', ')} ${r.requester} ${r.due ?? '-'}`)];
}

export function deriveDuties(dir: string): { name: string; last_run: string | null; last_verdict: string | null; scope?: string }[] {
  const metrics = path.join(dir, 'state/routine-metrics.jsonl');
  const names = new Set<string>();
  const config = readConfigRaw(dir);
  for (const routine of config?.routines ?? []) if (typeof routine.id === 'string') names.add(routine.id);
  const rows: ReturnType<typeof deriveDuties> = [...names].sort().map(name => ({ name: `routine:${name}`, last_run: lastRoutineFire(metrics, name), last_verdict: lastRoutineEvent(metrics, name) }));
  const alert = readAlertState(path.join(dir, 'state/alert-state.json'));
  const value = alert.kind === 'ok' ? alert.value : null;
  const valid = value && value.alerts && typeof value.alerts === 'object' && !Array.isArray(value.alerts) && typeof value.total_ticks === 'number';
  const active = valid ? Object.values(value.alerts).filter((entry: any) => !entry.suppressed && !entry.resolved_at).length : 0;
  rows.push({ name: 'heartbeat', last_run: valid ? value.last_clean_eval_at ?? null : null, last_verdict: !valid || value.last_clean_eval_at === null ? 'frozen' : active ? `findings:${active}` : 'ok' });
  const registry = readJson(path.join(dir, 'state/monitors.runtime.json'));
  for (const watch of registry?.monitors ?? []) rows.push({ name: `watch:${watch.id}`, last_run: watch.last_event_at ?? null, last_verdict: watch.last_verdict ?? null, scope: 'since session start' });
  return rows;
}
export function recordWatchDuty(dir: string, id: string, verdict: string): void {
  const file = path.join(dir, 'state/monitors.runtime.json');
  const lock = file + '.lock';
  if (!acquireLockWithWait(lock, 2000)) throw new Error('lock-unavailable');
  try {
    const registry = readJson(file);
    const watch = registry?.monitors?.find((entry: any) => entry.id === id);
    if (!watch) throw new Error('watch-not-found');
    watch.last_event_at = new Date().toISOString();
    watch.last_verdict = clean(verdict);
    writeFileAtomic(file, JSON.stringify(registry) + '\n');
  } finally { releaseLock(lock); }
}
