import fs from 'node:fs';
import path from 'node:path';
import { decodeTask } from '../tasks';
import { parseFrontmatter } from '../frontmatter';
import { findSection } from '../md-write';
import { resolveProposalId } from './resolve';
import { appendEvent, respondedEvent, resolvedEvent } from './event';
import { verbPatch } from '../../proposal';

// The digest fields a record closed by check adds, or null when it links no open proposal.
function resolveLinkedProposal(dir: string, id: string): Record<string, string> | null {
  const record = decodeTask(fs.readFileSync(path.join(dir, 'tasks', `${id}.md`), 'utf8'));
  if (!record.dedupe_key?.startsWith('proposal:')) return null;
  const verdict = resolveProposalId(dir, record.dedupe_key.slice('proposal:'.length));
  if (verdict.status === 'ambiguous') return { proposal_resolve_error: 'proposal_ambiguous' };
  if (verdict.status !== 'match') return null;
  const content = fs.readFileSync(path.join(dir, 'proposals', verdict.file), 'utf8');
  const fm = parseFrontmatter(content) as Record<string, unknown> | null;
  if (fm?.status !== 'proposed' && fm?.status !== 'accepted') return null;
  // Checked before any ledger row lands: a patch refused afterwards would leave resolved rows
  // for a proposal that stays open, and the closed record never runs its check again.
  if (!findSection(content, 'Operator Decision')) return { proposal_resolve_error: 'no_operator_decision_section' };
  const proposalId = /^PROP-\d+/i.exec(verdict.file)![0].toUpperCase();
  const args = [verdict.file, '--set', 'status=resolved', '--set', 'resolved_date=@now', '--request-compact'];
  if (fm.status === 'proposed') {
    args.push('--set', 'accepted_date=@now');
    if (String(fm.responded) !== 'true') {
      if (appendEvent(dir, respondedEvent(proposalId, 'accept'))) return { proposal_resolve_error: 'proposal_responded_event_failed' };
      args.push('--set', 'responded=true');
    }
  }
  if (appendEvent(dir, resolvedEvent(proposalId))) return { proposal_resolve_error: 'proposal_resolved_event_failed' };
  const patch = verbPatch(dir,
    `Decision: Resolved on @now; record ${id} closed by its check: ${record.closed_reason}.`, args);
  return patch.error ? { proposal_resolve_error: patch.error } : { proposal_resolved: proposalId };
}

// Adds the linked proposal's outcome to a task digest that closed by check. A resolve failure
// lands in the digest and never undoes the close.
export function resolveProposalOnCheckClose(dir: string, id: string, digest: Record<string, unknown>): void {
  if (digest.closed_by !== 'check') return;
  try { Object.assign(digest, resolveLinkedProposal(dir, id)); }
  catch { digest.proposal_resolve_error = 'proposal_resolve_failed'; }
}
