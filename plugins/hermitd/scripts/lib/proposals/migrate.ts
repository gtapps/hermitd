// One-shot importer for the retired proposal files and question queue.
import fs from 'node:fs';
import path from 'node:path';
import { listProposalFiles, parseFrontmatter } from '../frontmatter';
import { readSettledConfig } from '../config-read';
import { importTaskRecords, type TaskImport } from '../tasks';
import { homeChatKey } from '../home-chat';
import { isKey } from '../conversation-key';
import { alertStatePath, readAlertState, writeAlertState } from '../alert-state';
import { acquireLockWithWait, releaseLock } from '../lockfile';

export type MigrationReceipt = { imported: number; enriched: number; archived: number; alerts_dropped: number; skipped: { source: string; reason: string }[] };
const statuses = new Set(['proposed', 'deferred', 'dismissed', 'accepted', 'resolved']);
export function migrate(dir: string): MigrationReceipt | { error: string } {
  const receipt: MigrationReceipt = { imported: 0, enriched: 0, archived: 0, alerts_dropped: 0, skipped: [] };
  const proposalDir = path.join(dir, 'proposals');
  const files = listProposalFiles(proposalDir);
  if (!files.ok) return { error: 'proposals_unreadable' };
  const sources: TaskImport[] = [];
  const paths = new Map<string, string>();
  const skip = (source: string, reason: string) => receipt.skipped.push({ source, reason });
  const idCounts = new Map<string, number>();
  for (const file of files.files) {
    const legacy = /^PROP-\d+/.exec(file)?.[0];
    if (legacy) idCounts.set(legacy, (idCounts.get(legacy) ?? 0) + 1);
  }
  for (const file of files.files) {
    const legacy = /^PROP-\d+/.exec(file)?.[0];
    if (legacy && idCounts.get(legacy)! > 1) { skip(file, 'conflicting_proposal_id'); continue; }
    try {
      const content = fs.readFileSync(path.join(proposalDir, file), 'utf8');
      const fm = parseFrontmatter(content);
      if (!fm || !legacy || typeof fm.title !== 'string' || !fm.title.trim() || !Number.isFinite(Date.parse(fm.created))) { skip(file, 'invalid_proposal'); continue; }
      if (!statuses.has(fm.status)) { skip(file, 'unknown_status'); continue; }
      if (fm.tags !== undefined && (!Array.isArray(fm.tags) || fm.tags.some((tag: unknown) => typeof tag !== 'string'))) { skip(file, 'invalid_tags'); continue; }
      const key = `proposal:${legacy}`;
      sources.push({ key, title: fm.title, created: new Date(fm.created).toISOString(), body: content,
        status: fm.status, source: typeof fm.source === 'string' ? fm.source : null,
        category: typeof fm.category === 'string' ? fm.category : null, tags: JSON.stringify(fm.tags ?? []),
        closedAt: fm.resolved_date && Number.isFinite(Date.parse(fm.resolved_date)) ? new Date(fm.resolved_date).toISOString() : null,
        reason: typeof fm.reason === 'string' ? fm.reason : fm.status === 'dismissed' ? 'Dismissed before migration; see original decision in Proposal.' : 'Resolved before migration.',
      });
      paths.set(key, path.join(proposalDir, file));
    } catch { skip(file, 'unreadable_proposal'); }
  }
  const microPath = path.join(dir, 'state', 'micro-proposals.json');
  const micro = readMicroProposals(microPath);
  if (micro.status === 'corrupt') skip('state/micro-proposals.json', 'corrupt_queue');
  const homeKey = homeChatKey(readSettledConfig(dir).channels);
  if (micro.status === 'ok') {
    for (const entry of micro.data.pending) {
      if (!entry || typeof entry.id !== 'string' || entry.status !== 'pending') {
        if (entry && typeof entry.id === 'string' && ['approved', 'rejected', 'answered', 'expired', 'resolved'].includes(entry.status)) continue;
        skip('state/micro-proposals.json', 'unknown_entry'); continue;
      }
      const link = typeof entry.proposal_id === 'string' ? /^PROP-\d+/.exec(entry.proposal_id)?.[0]
        : typeof entry.on_resolve === 'string' ? /PROP-\d+/.exec(entry.on_resolve)?.[0] : undefined;
      if (link) {
        if (!paths.has(`proposal:${link}`) && !fs.existsSync(path.join(proposalDir, 'archive'))) skip(entry.id, 'proposal_not_imported');
        continue;
      }
      const chat = entry.chat ?? homeKey;
      if (typeof entry.question !== 'string' || !entry.question.trim() || !Number.isFinite(Date.parse(entry.ts))
        || (chat !== null && !isKey(chat)) || (entry.options !== undefined && (!Array.isArray(entry.options) || entry.options.some((option: unknown) => typeof option !== 'string')))
        || (entry.user !== undefined && (typeof entry.user !== 'string' || !entry.user))) { skip(entry.id, 'unknown_entry_shape'); continue; }
      sources.push({ key: `question:${entry.id}`, title: entry.question, created: new Date(entry.ts).toISOString(), body: entry.question,
        status: 'question', conversation: chat, requester: entry.user && chat ? `${chat.split(':')[0]}:${entry.user}` : 'agent',
        decision: { purpose: 'input', authority: entry.user ? 'requester' : 'admin', generation: 1,
          ...(entry.options ? { options: entry.options } : {}), ...(typeof entry.on_resolve === 'string' ? { resume: entry.on_resolve } : {}) },
      });
    }
  }
  let results: ReturnType<typeof importTaskRecords>;
  try { results = importTaskRecords(dir, sources); }
  catch (error: any) { return { error: `import_failed:${error.message}` }; }
  for (const result of results) {
    if (result.error) { skip(result.key, result.error); continue; }
    if (result.action === 'imported') receipt.imported++;
    if (result.action === 'enriched') receipt.enriched++;
    const sourcePath = paths.get(result.key);
    if (sourcePath) {
      try {
        const archive = path.join(proposalDir, 'archive');
        fs.mkdirSync(archive, { recursive: true });
        const destination = path.join(archive, path.basename(sourcePath));
        if (fs.existsSync(destination)) { skip(path.basename(sourcePath), 'archive_conflict'); continue; }
        fs.renameSync(sourcePath, destination);
        receipt.archived++;
      } catch { skip(path.basename(sourcePath), 'archive_failed'); }
    }
  }
  dropLegacyAlerts(dir, receipt);
  if (!receipt.skipped.length) {
    try {
      if (micro.status !== 'missing') fs.unlinkSync(microPath);
      fs.rmSync(path.join(dir, 'state', 'proposals-index.json'), { force: true });
    } catch { skip('state', 'cleanup_failed'); }
  }
  return receipt;
}

// The retired proposal and question alert ladders left entries nothing resolves any more.
const LEGACY_ALERT = /^(micro-)?proposal-pending:/;
function dropLegacyAlerts(dir: string, receipt: MigrationReceipt): void {
  const file = alertStatePath(dir);
  const read = readAlertState(file);
  if (read.kind === 'missing') return;
  if (read.kind !== 'ok') { receipt.skipped.push({ source: 'state/alert-state.json', reason: 'alert_state_unreadable' }); return; }
  const lock = path.join(dir, 'state', 'tasks.lock');
  if (!acquireLockWithWait(lock, 2000)) { receipt.skipped.push({ source: 'state/alert-state.json', reason: 'lock_unavailable' }); return; }
  try {
    // Re-read under the lock so a concurrent heartbeat write is not overwritten with stale state.
    const current = readAlertState(file);
    if (current.kind !== 'ok' || !current.value.alerts || typeof current.value.alerts !== 'object') return;
    const legacy = Object.keys(current.value.alerts).filter(key => LEGACY_ALERT.test(key));
    if (!legacy.length) return;
    for (const key of legacy) delete current.value.alerts[key];
    if (writeAlertState(file, current.value)) receipt.alerts_dropped = legacy.length;
    else receipt.skipped.push({ source: 'state/alert-state.json', reason: 'alert_state_write_failed' });
  } finally { releaseLock(lock); }
}

type Json = any;

type MicroProposalsRead =
  | { status: 'ok'; data: Json }
  | { status: 'missing' }
  | { status: 'corrupt'; error: string };

function readMicroProposals(microPath: string): MicroProposalsRead {
  if (!fs.existsSync(microPath)) return { status: 'missing' };
  let data: Json;
  try {
    data = JSON.parse(fs.readFileSync(microPath, 'utf-8'));
  } catch (e: any) {
    return { status: 'corrupt', error: `micro-proposals.json is unparseable (${e.message})` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { status: 'corrupt', error: 'micro-proposals.json is not a JSON object' };
  }
  // A parseable object with no `pending` key at all (a hand-seeded `{}`, or the
  // pre-1.0 `{"active": null}` shape on an install that never ran the migration)
  // holds no backlog to destroy, so heal it to an empty queue instead of wedging
  // every future queue/resolve on a hard failure. Other keys are preserved.
  if (data.pending === undefined || data.pending === null) {
    return { status: 'ok', data: { ...data, pending: [] } };
  }
  if (!Array.isArray(data.pending)) {
    return { status: 'corrupt', error: 'micro-proposals.json `pending` is not an array' };
  }
  return { status: 'ok', data };
}
