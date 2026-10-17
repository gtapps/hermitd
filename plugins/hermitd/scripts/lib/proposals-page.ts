// Deterministic renderer for the Hermit Proposals-page artifact — mirrors
// scripts/lib/dashboard.ts's render/hash-gate discipline (see docs/artifacts.md).
// Open (proposed/accepted) proposals render as collapsed-by-default
// <details class="proposal" id="prop-nnn"> — a one-line summary that expands to
// full text on click. The id is inert in the claude.ai artifact viewer (sandboxed
// cross-origin iframe, no fragment reaches it) but is kept for a locally opened or
// remixed copy of the page; deferred/resolved/dismissed proposals are one-line
// history entries, same bucket the
// dashboard already computes. Self-contained fragment — no
// <!DOCTYPE>/<html>/<head>/<body> (Artifact tool wraps it).

import { loadProposals, loadAgentName, mdToHtml, escapeHtml, proposalLabel, shortPropId, type ProposalRow, type OpenProposalRow } from './dashboard';
import { sha256 } from './hash';
import { loadStrings, fmt, type ArtifactStrings } from './artifact-strings';
import { card, pills, pageShell } from './artifact-theme';

const UPDATED_TOKEN = '__PROPOSALS_PAGE_UPDATED__';

export interface ProposalsPageState {
  agent_name: string;
  open: OpenProposalRow[];
  other: ProposalRow[];
  other_omitted: number;
  strings: ArtifactStrings;
}

export function loadProposalsPageState(hermitDir: string): ProposalsPageState {
  const { open, other, other_omitted } = loadProposals(hermitDir);
  return { agent_name: loadAgentName(hermitDir), open, other, other_omitted, strings: loadStrings(hermitDir) };
}

// "PROP-025-some-slug-123243" -> "prop-025". Falls back to a full slugified id
// for legacy rows with no PROP-NNN prefix.
export function proposalAnchorId(id: string): string {
  return shortPropId(id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Calendar date only. The stored value is a full ISO stamp with an offset, which
// is noise in a scan line — and the date alone stays activity-driven, so the
// hash-gate rationale in this file's header still holds.
function createdMeta(created: string | null): string[] {
  if (!created) return [];
  const day = created.slice(0, 10);
  return [`<span title="${escapeHtml(created)}">${escapeHtml(day)}</span>`];
}

function renderOpen(open: OpenProposalRow[], s: ArtifactStrings): string {
  if (!open.length) return `<p class="muted">${s.proposals_none_open}</p>`;
  const items = open
    .map(p => `<details class="proposal" id="${proposalAnchorId(p.id)}">
      <summary>${proposalLabel(p, createdMeta(p.created))}</summary>
      <div class="proposal-body">${mdToHtml(p.body)}</div>
    </details>`)
    .join('');
  return card(fmt(s.proposals_open_count, { n: open.length }), items);
}

function renderOther(other: ProposalRow[], otherOmitted: number, s: ArtifactStrings): string {
  if (!other.length) return '';
  const items = other
    .map(p => `<li>${proposalLabel(p, createdMeta(p.created))}</li>`)
    .join('');
  const omittedLine = otherOmitted > 0 ? `<li class="muted">${fmt(s.common_more_not_shown, { n: otherOmitted })}</li>` : '';
  return card(s.proposals_history, `<ul class="proposal-history">${items}${omittedLine}</ul>`);
}

/** Renders the full artifact fragment plus a content hash stable across
 *  identical underlying state (the "last updated" stamp is excluded from the hash
 *  via a placeholder token, so the publish gate can skip no-op republishes).
 *  Deliberately omits proposal age-in-days (unlike the dashboard) — age is
 *  Date.now()-derived and would otherwise mint a new artifact version once a
 *  day even with zero proposal activity; created-date is shown instead. */
export function renderProposalsPage(state: ProposalsPageState, opts?: { now?: string }): { html: string; hash: string } {
  const s = state.strings;
  // Counts before the list: how many need a decision vs. how many are already
  // settled is the question this page answers, and it should not require
  // counting rows. `decided` includes the capped tail, so the total stays true.
  const decided = state.other.length + state.other_omitted;
  const summary = pills([
    ...(state.open.length ? [{ tone: 'warn' as const, value: String(state.open.length), label: s.proposals_pill_open }] : []),
    ...(decided ? [{ tone: 'good' as const, value: String(decided), label: s.proposals_pill_decided }] : []),
  ]);

  const templated = pageShell({
    title: fmt(s.proposals_page_title, { name: escapeHtml(state.agent_name) }),
    heading: s.proposals_page_header,
    updatedLabel: s.label_updated,
    updatedToken: UPDATED_TOKEN,
    body: `${summary}
  ${renderOpen(state.open, s)}
  ${renderOther(state.other, state.other_omitted, s)}`,
  });

  const hash = sha256(templated);
  const now = opts?.now ?? new Date().toISOString();
  const html = templated.replace(UPDATED_TOKEN, escapeHtml(now));
  return { html, hash };
}
