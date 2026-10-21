// Folder-shared review state. The routine owns snapshots/cursors/proposals; the
// resident resolves proposals after a chat reply. Only this module writes it.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256 as hash } from './hash';
import { allowedUserIds, chatInstructions } from './channel-auth';
import { lookupChat } from './channel-chats';
import { roleReviewHistory, type ReviewRow } from './channel-log';
import { memoryDirFor } from './cc-compat';
import { defaultConfigDir } from './setup-token';
import { readSettledConfig } from './config-read';
import { writeFileAtomic } from './md-write';

const DAY = 86_400_000;
export const ROW_TEXT_CAP = 2000;
export const SNAPSHOT_TEXT_BUDGET = 24_000;
type Json = any;
type Kind = 'memory' | 'instructions';
interface Target { kind: Kind; target: string; text: string }
interface Snapshot {
  chat: string;
  cursor: number;
  upper_id: number;
  since?: string;
  chat_ids: string[];
  evidence_ids: number[];
}
interface Proposal {
  id: string;
  chat: string;
  kind: Kind;
  target: string;
  current_text: string;
  proposed_text: string;
  evidence_ids: number[];
  base_hash: string;
  created_at: string;
  state: 'pending' | 'applied' | 'declined';
}
interface ReviewState {
  routines: Record<string, { cursor_row_id?: number; snapshot?: Snapshot }>;
  proposals: Proposal[];
}
const stateFile = (dir: string) => path.join(dir, 'state', 'role-review.json');
function readState(dir: string): ReviewState {
  try { return JSON.parse(fs.readFileSync(stateFile(dir), 'utf8')); }
  catch (error: any) {
    if (error.code === 'ENOENT') return { routines: {}, proposals: [] };
    throw new Error('review_state_unreadable');
  }
}
function save(dir: string, state: ReviewState): void {
  fs.mkdirSync(path.dirname(stateFile(dir)), { recursive: true });
  writeFileAtomic(stateFile(dir), JSON.stringify(state, null, 2) + '\n');
}
function owner(config: Json, id: string): { chat: string; source: string; chatId: string } | { status: string } {
  const routines = (config.routines ?? []).filter((r: Json) => r.id === id);
  if (routines.length > 1) return { status: 'ambiguous_routine' };
  const chat = routines[0]?.chat;
  if (!chat) return { status: 'no_owning_chat' };
  const at = chat.indexOf(':');
  if (at < 1 || at === chat.length - 1) throw new Error('invalid_owning_chat');
  return { chat, source: chat.slice(0, at), chatId: chat.slice(at + 1) };
}

/** Refuse derivations Claude Code may key elsewhere; never guess another memory directory. */
function resolvedMemoryDir(dir: string): string | null {
  const root = path.dirname(dir);
  if (process.env.CLAUDE_CODE_PROJECT_DIR_NAME) return null;
  let ancestor = root;
  while (true) {
    const git = path.join(ancestor, '.git');
    if (fs.existsSync(git)) {
      if (ancestor !== root || !fs.statSync(git).isDirectory()) return null;
      break;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const configDir = defaultConfigDir();
  for (const file of [path.join(configDir, 'settings.json'), path.join(root, '.claude', 'settings.json'),
    path.join(root, '.claude', 'settings.local.json'), path.join(dir, 'claude-settings.json')]) {
    try {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).autoMemoryDirectory) return null;
    } catch (error: any) { if (error.code !== 'ENOENT') return null; }
  }
  return memoryDirFor(root);
}
function pinnedRoles(memory: string, chat: string): Target[] {
  let index: string;
  try { index = fs.readFileSync(path.join(memory, 'MEMORY.md'), 'utf8'); }
  catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
  const targets: Target[] = [];
  for (const line of index.split('\n')) {
    if (!line.includes(`[role ${chat}]`)) continue;
    const file = line.match(/\]\(([^)]+)\)/)?.[1];
    if (!file || path.basename(file) !== file || targets.some(t => t.target === file)) continue;
    const full = path.join(memory, file);
    try {
      if (path.dirname(fs.realpathSync(full)) !== fs.realpathSync(memory)) continue;
      if (fs.statSync(full).size > 16_000 || targets.length >= 32) throw new Error('role_text_budget_exceeded');
      targets.push({ kind: 'memory', target: file, text: fs.readFileSync(full, 'utf8') });
    } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
  return targets;
}
async function targetsFor(dir: string, config: Json, chat: string): Promise<{ targets: Target[]; instructions: Json } | null> {
  const memory = resolvedMemoryDir(dir);
  if (!memory) return null;
  const at = chat.indexOf(':');
  const instructions = await chatInstructions(dir, config, chat.slice(0, at), chat.slice(at + 1));
  const inherited = !!instructions && instructions.chat_id !== chat.slice(at + 1);
  const targets = pinnedRoles(memory, chat);
  if (instructions && !inherited) targets.push({ kind: 'instructions', target: chat, text: instructions.text });
  return { targets, instructions: { text: instructions?.text ?? '', inherited } };
}

export async function snapshot(dir: string, routineId: string): Promise<Json> {
  const config = readSettledConfig(dir);
  const owning = owner(config, routineId);
  if ('status' in owning) return owning;
  const targetData = await targetsFor(dir, config, owning.chat);
  if (!targetData) return { status: 'memory_dir_unresolved', chat: owning.chat };
  const state = readState(dir);
  const cursor = state.routines[routineId]?.cursor_row_id ?? 0;
  const since = cursor ? undefined : new Date(Date.now() - 7 * DAY).toISOString();
  const options = { cursor, since, senderIds: allowedUserIds(config, owning.source) };
  const bounds = roleReviewHistory(dir, owning.source, options);
  if (bounds.status === 'error') throw new Error(bounds.error);
  if (bounds.status !== 'ok') return { status: 'empty', reason: bounds.status };
  const chatIds = [owning.chatId];
  if (owning.source === 'discord') {
    for (const id of bounds.chat_ids) {
      if (id === owning.chatId) continue;
      if ((await lookupChat(dir, config, id))?.parent_id === owning.chatId) chatIds.push(id);
    }
  }
  const result = roleReviewHistory(dir, owning.source, { ...options, upper: bounds.upper_id, chatIds });
  if (result.status !== 'ok') throw new Error('channel_log_read_failed');
  if (!result.rows.length) {
    // Nothing for this chat up to the bound: advance so a capped discovery window moves on.
    state.routines[routineId] = { cursor_row_id: bounds.upper_id };
    save(dir, state);
    return { status: 'empty', reason: 'no_rows' };
  }
  const rows: ReviewRow[] = [];
  const seen = new Set<string>();
  let budget = 0;
  let upper = bounds.upper_id;
  let truncated = false;
  for (const row of result.rows) {
    const key = row.message_id ? JSON.stringify([row.chat_id, row.message_id]) : `row:${row.id}`;
    if (seen.has(key)) continue;
    const text = row.text.slice(0, ROW_TEXT_CAP);
    if (budget + text.length > SNAPSHOT_TEXT_BUDGET || rows.length >= 1000) {
      truncated = true;
      upper = rows.at(-1)!.id;
      break;
    }
    rows.push({ ...row, text });
    seen.add(key);
    budget += text.length;
  }
  // A SQL row cap can be reached even when most rows were duplicates.
  if (!truncated && result.rows.length === 1001) {
    upper = result.rows.at(-1)!.id;
    truncated = true;
  }
  const frozen: Snapshot = { chat: owning.chat, cursor, upper_id: upper, since, chat_ids: chatIds,
    evidence_ids: rows.filter(row => row.direction === 'in').map(row => row.id) };
  state.routines[routineId] = { cursor_row_id: cursor, snapshot: frozen };
  save(dir, state);
  return { status: 'ready', routine: routineId, chat: owning.chat, upper_id: upper, truncated, rows,
    roles: targetData.targets.filter(t => t.kind === 'memory'), instructions: targetData.instructions };
}

export async function commit(dir: string, routineId: string, upper: number, input: unknown): Promise<Json> {
  if (!Number.isSafeInteger(upper) || upper < 0 || !Array.isArray(input)) throw new Error('invalid_commit');
  const state = readState(dir);
  const routine = state.routines[routineId];
  if (upper <= (routine?.cursor_row_id ?? 0)) return { status: 'stale_snapshot' };
  const frozen = routine?.snapshot;
  if (!frozen || frozen.upper_id !== upper) throw new Error('snapshot_not_found');
  const config = readSettledConfig(dir);
  const owning = owner(config, routineId);
  if ('status' in owning) return owning;
  if (owning.chat !== frozen.chat) throw new Error('owning_chat_changed');
  const targetData = await targetsFor(dir, config, owning.chat);
  if (!targetData) return { status: 'memory_dir_unresolved', chat: owning.chat };
  const result = roleReviewHistory(dir, owning.source, { cursor: frozen.cursor, upper, since: frozen.since,
    chatIds: frozen.chat_ids, senderIds: allowedUserIds(config, owning.source) });
  if (result.status !== 'ok') throw new Error('channel_log_read_failed');
  const evidenceIds = new Set(frozen.evidence_ids);
  const evidence = new Map(result.rows.filter(r => r.direction === 'in' && evidenceIds.has(r.id)).map(r => [r.id, r]));
  const saved: Proposal[] = [];
  const rejected: { index: number; reason: string }[] = [];
  let instructionsSaved = false;
  for (const [index, proposal] of input.entries()) {
    const target = targetData.targets.find(t => t.kind === proposal?.kind && t.target === proposal?.target);
    let reason: string | null = null;
    if (!target) reason = 'invalid_target';
    else if (typeof proposal.proposed_text !== 'string' || !proposal.proposed_text.trim()) reason = 'invalid_text';
    else if (proposal.kind === 'instructions' && (proposal.proposed_text.length > 2000 || instructionsSaved)) reason = 'instructions_limit';
    else if (saved.some(s => s.kind === target.kind && s.target === target.target)) reason = 'duplicate_target';
    else if (!Array.isArray(proposal.evidence_ids) || proposal.evidence_ids.some((id: unknown) => !Number.isSafeInteger(id) || !evidence.has(id as number))) reason = 'invalid_evidence';
    else {
      const distinct = new Set(proposal.evidence_ids.map((id: number) => {
        const row = evidence.get(id)!;
        return row.message_id ? `message:${row.message_id}` : `row:${row.id}`;
      }));
      if (distinct.size < 2) reason = 'insufficient_evidence';
    }
    if (reason) { rejected.push({ index, reason }); continue; }
    state.proposals = state.proposals.filter(p => !(p.state === 'pending' && p.chat === owning.chat && p.kind === target!.kind && p.target === target!.target));
    const accepted: Proposal = { id: randomUUID(), chat: owning.chat, kind: target!.kind, target: target!.target,
      current_text: target!.text, proposed_text: proposal.proposed_text, evidence_ids: [...new Set<number>(proposal.evidence_ids)],
      base_hash: hash(target!.text), created_at: new Date().toISOString(), state: 'pending' };
    state.proposals.push(accepted);
    saved.push(accepted);
    if (accepted.kind === 'instructions') instructionsSaved = true;
  }
  state.proposals = state.proposals.filter(p => p.state === 'pending' && Date.parse(p.created_at) >= Date.now() - 30 * DAY);
  routine.cursor_row_id = upper;
  delete routine.snapshot;
  save(dir, state);
  return { status: 'committed', chat: owning.chat, saved, rejected, cursor_row_id: upper };
}

export async function get(dir: string, chat: string): Promise<Json> {
  const pending = readState(dir).proposals.filter(p => p.chat === chat && p.state === 'pending'
    && Date.parse(p.created_at) >= Date.now() - 30 * DAY);
  if (!pending.length) return { status: 'ok', proposals: [] };
  const targets = (await targetsFor(dir, readSettledConfig(dir), chat))?.targets ?? [];
  return { status: 'ok', proposals: pending.map(p => {
    const target = targets.find(t => t.kind === p.kind && t.target === p.target);
    return { ...p, stale: !target || hash(target.text) !== p.base_hash };
  }) };
}
export function resolve(dir: string, id: string, outcome: string): Json {
  if (outcome !== 'applied' && outcome !== 'declined') throw new Error('invalid_resolution');
  const state = readState(dir);
  const proposal = state.proposals.find(p => p.id === id && p.state === 'pending');
  if (!proposal) return { status: 'not_found' };
  proposal.state = outcome;
  save(dir, state);
  return { status: 'resolved', id, state: outcome };
}
