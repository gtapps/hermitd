import fs from 'node:fs';
import path from 'node:path';
import { hermitDir } from './lib/cc-compat';
import { runEvidence } from './lib/evidence-runner';
import { scanForInjection } from './lib/injection-scan';
import { decodeTask, mutateTask, reportTaskError, TASK_ID } from './lib/tasks';
import { readFrontmatter } from './lib/frontmatter';
import { resolveProposalId } from './lib/proposals/resolve';
import { appendEvent, respondedEvent, resolvedEvent } from './lib/proposals/event';
import { verbPatch } from './proposal';

function resolveLinkedProposal(dir: string, id: string, digest: Record<string, unknown>): void {
  if (digest.closed_by !== 'check') return;
  try {
    const record = decodeTask(fs.readFileSync(path.join(dir, 'tasks', `${id}.md`), 'utf8'));
    if (!record.dedupe_key?.startsWith('proposal:')) return;
    const verdict = resolveProposalId(dir, record.dedupe_key.slice('proposal:'.length));
    if (verdict.status !== 'match') return;
    const status = readFrontmatter(path.join(dir, 'proposals', verdict.file))?.status;
    if (status !== 'proposed' && status !== 'accepted') return;
    const proposalId = /^PROP-\d+/i.exec(verdict.file)![0].toUpperCase();
    const args = [verdict.file, '--set', 'status=resolved', '--set', 'resolved_date=@now', '--request-compact'];
    if (status === 'proposed') {
      const error = appendEvent(dir, respondedEvent(proposalId, 'accept'));
      if (error) throw new Error('proposal_responded_event_failed');
      args.push('--set', 'accepted_date=@now', '--set', 'responded=true');
    }
    const error = appendEvent(dir, resolvedEvent(proposalId));
    if (error) throw new Error('proposal_resolved_event_failed');
    const patch = verbPatch(dir,
      `Decision: Resolved on @now; record ${id} closed by its check: ${record.closed_reason}.`, args);
    if (patch.error) {
      digest.proposal_resolve_error = patch.error;
      return;
    }
    digest.proposal_resolved = proposalId;
  } catch (error) {
    digest.proposal_resolve_error = error instanceof Error && /^proposal_\w+$/.test(error.message)
      ? error.message : 'proposal_resolve_failed';
  }
}

async function main(): Promise<void> {
  const [id, ...extra] = process.argv.slice(2);
  if (!id || !TASK_ID.test(id) || extra.length) throw new Error('invalid_id');
  const dir = hermitDir();
  const snapshot = mutateTask(dir, 'check-snapshot', id, {}, '') as { check: string | null; result_rev: number; status: string };
  if (snapshot.status !== 'open' || !snapshot.check) throw new Error('no_open_check');
  const hit = scanForInjection(snapshot.check);
  const result = hit
    ? { exit: 1, output: `injection-suspect:${hit.cls}` }
    : await runEvidence(snapshot.check, path.dirname(dir), 30);
  // Recorded in-process, never through task.ts: task.ts is pre-approved, so a CLI verb would let
  // a turn close a task by check without running it. Each mutateTask call holds the lock briefly.
  const digest = mutateTask(dir, 'check-result', id, {
    'result-rev': String(snapshot.result_rev), exit: String(result.exit), 'output-stdin': true,
  }, result.output) as Record<string, unknown>;
  resolveLinkedProposal(dir, id, digest);
  console.log(JSON.stringify(digest));
}
main().catch(reportTaskError);
