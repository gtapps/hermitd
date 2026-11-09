// UI-chrome string table for the script-rendered artifact pages (dashboard,
// proposals). The renderers stay deterministic and model-free per publish
// (see docs/artifacts.md): language arrives as *input state*, not per-render
// model work — mirroring state/last-brief.json (model-composed once, rendered
// deterministically forever). DEFAULT_STRINGS is English; loadStrings() overlays
// an operator-language table (written once at language-set time) per key, so a
// missing key or an absent file falls back to English and byte-identical output.
//
// Convention: DEFAULT_STRINGS values are trusted (hardcoded, no HTML markup) and
// injected raw by the renderers; an overlay value is file-derived, so loadStrings()
// escapes it the same way renderer-side data (proposal ids/titles, agent name,
// alert text) already is — a corrupt or malformed translation file can't inject
// markup into a published page. Parameterized strings use {placeholder} tokens so
// word order stays translatable; fill them with fmt() (escaping doesn't touch braces).

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_STRINGS = {
  // Page shell / shared chrome. Both page titles lead with the hermit's own name
  // ({name} = config.agent_name, "Hermit" when unset) so an operator running
  // several hermits can tell two tabs apart — and so a hermit that *is* named
  // "Hermit" reads "Hermit — Dashboard", not "Hermit — Hermit Dashboard".
  dashboard_title: '{name} — Dashboard',
  label_updated: 'updated',

  // Status card
  status_heading: 'Status',
  status_session: 'Session',
  status_today: 'Spent today',
  status_tokens: 'Tokens',
  status_alerts: 'Needs you',
  status_no_alerts: 'No active alerts.',
  status_execution: 'Execution',
  status_open_tasks: 'Open tasks',

  // Execution labels, retaining the installed translation keys.
  session_in_progress: 'Working',
  session_idle: 'Idle',
  session_on_watch: 'On watch',
  session_unknown: 'Unknown',

  // Budget-alert synthesis (message-less budget alerts)
  budget_text: '{period} budget {state}{amounts}',
  budget_state_breached: 'breached',
  budget_state_warning: 'warning',
  budget_amounts: ' ({spend} of {cap})',

  // Age labels
  age_today: 'today',
  age_days: '{n}d',

  // Brief card
  brief_heading: 'Latest brief',
  brief_none: 'No brief yet.',

  waiting_heading: 'Waiting on you',
  waiting_none: 'Nothing waiting on you.',
  // One whole sentence per decision authority, so translations keep their own grammar.
  waiting_row_admin: 'From the agent: {title}. Waiting on you.',
  waiting_row_requester: 'From the agent: {title}. Waiting on the requester.',
  waiting_row_chat: 'From the agent: {title}. Waiting on the chat.',

  // By-person card (not on the default page; offered to custom renderers)
  by_person_heading: 'By person',
  by_person_promised: 'Promised',
  by_person_late: 'Late',
  by_person_waiting: 'Waiting on them',
  by_person_no_due: 'no due date',
  by_person_none: 'No open tasks',

  // Weekly card. No empty state: the card is omitted entirely when there is no
  // review, rather than spending a section on saying so.
  weekly_week: 'Week {week}',
  weekly_cost: 'Cost: {amount}{delta}',
  weekly_proposals: 'Proposals: +{created} created, {resolved} resolved',
  weekly_full_review: 'Full review',
  weekly_delta_cost: ' (vs {prior} prior, {sign}{pct}%)',
  weekly_delta_cost_no_pct: ' (vs {prior} prior)',

  // Compiled-docs card
  compiled_heading: 'Compiled docs',
  compiled_none: 'Nothing compiled yet.',
  compiled_hint: 'Ask to open any of these as a page.',

  // Shared
  common_more_not_shown: '+{n} more not shown',
};

export type ArtifactStrings = typeof DEFAULT_STRINGS;

// Local copy of dashboard.ts's escapeHtml — that file already imports from this
// one, so importing it back would be circular. Kept in sync by the shared
// five-char HTML-escape contract; not worth a third shared module for one line.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Overlay state/artifact-strings.json over the English defaults, per key. Missing
 *  keys fall back to English; unknown keys are ignored; an absent or invalid file
 *  yields the pristine defaults (byte-identical to a hermit with no translation).
 *  Overlay values are escaped (defaults are not — they're trusted literals). */
export function loadStrings(hermitDir: string): ArtifactStrings {
  const merged: ArtifactStrings = { ...DEFAULT_STRINGS };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(hermitDir, 'state', 'artifact-strings.json'), 'utf8'));
    const overlay = raw?.strings;
    if (overlay && typeof overlay === 'object') {
      for (const key of Object.keys(DEFAULT_STRINGS) as (keyof ArtifactStrings)[]) {
        const v = overlay[key];
        if (typeof v === 'string') merged[key] = escapeHtml(v);
      }
    }
  } catch {
    // absent/unreadable/invalid JSON -> English defaults
  }
  return merged;
}

/** Fill {placeholder} tokens in a chrome template. Unmatched tokens are left
 *  intact rather than blanked, so a malformed translation degrades visibly. */
export function fmt(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}
