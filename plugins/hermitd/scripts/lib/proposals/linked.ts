import fs from 'node:fs';
import path from 'node:path';
import { decodeTask } from '../tasks';
import { parseFrontmatter } from '../frontmatter';
import { resolveProposalId } from './resolve';
import { verbResolve } from '../../proposal';
import { shortProposalId } from '../prop-id';

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
  const patch = verbResolve(dir,
    `Decision: Resolved on @now; record ${id} closed by its check: ${record.closed_reason}.`, verdict.file);
  return patch.error ? { proposal_resolve_error: patch.error } : { proposal_resolved: shortProposalId(verdict.file) };
}

// Adds the linked proposal's outcome to a task digest that closed by check. A resolve failure
// lands in the digest and never undoes the close.
export function resolveProposalOnCheckClose(dir: string, id: string, digest: Record<string, unknown>): void {
  if (digest.closed_by !== 'check') return;
  try { Object.assign(digest, resolveLinkedProposal(dir, id)); }
  catch { digest.proposal_resolve_error = 'proposal_resolve_failed'; }
}
