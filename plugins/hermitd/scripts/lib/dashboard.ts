import { readTaskReports, type TaskReport } from './task-report';
import { readExecution, taskStandup, type PersonTasks } from './tasks';
// Deterministic renderer for the Hermit Dashboard artifact — the render itself is
// script-authored, not model-authored, so a publish costs a render (pennies) instead
// of a generation (dollars). Reads only state already on disk (runtime.json,
// cost-index.json, alert-state.json, proposals-index.json + proposal bodies, latest
// compiled/review-weekly-*.md, state/last-brief.json, compiled/*.md) and produces one
// self-contained HTML fragment. Note last-brief.json's `text` field is itself
// model-composed (written by the brief skill) — the render step is deterministic given
// that state, but the state is not exclusively machine-generated. The Artifact tool
// wraps the fragment in the page shell — this file must not include
// <!DOCTYPE>/<html>/<head>/<body> (see https://code.claude.com/docs/en/artifacts,
// Page constraints).

import fs from 'node:fs';
import path from 'node:path';
import { readFileWithFrontmatter, globDir } from './frontmatter';
import { formatTokens } from './format';
import { sha256 } from './hash';
import { readMergedAlerts, PROPOSAL_PREFIX } from './alert-state';
import { todayYMD } from './time';
import { readSettledConfig, agentNameFromConfig } from './config-read';
import { costIndexPath, readCostIndex } from './cost-log';
import { rebuildIndex, type ProposalsIndex } from './proposals/index-rebuild';
import { sharedLivenessAgeSecs, LIVENESS_FRESH_SECS } from './liveness';
import { loadStrings, fmt, type ArtifactStrings } from './artifact-strings';
import { chipHtml, card, statTile, railRow, pageShell, META_SEP } from './artifact-theme';

type Json = any;

const OPEN_STATUSES = new Set(['proposed', 'accepted']);
const OTHER_CAP = 20;
/** Placeholder standing in for the "last updated" stamp while the content hash is
 *  computed, so an unchanged page hashes identically across renders. Exported for
 *  hermit-local renderers, which must reproduce the same hash-then-swap order. */
export const UPDATED_TOKEN = '__DASHBOARD_UPDATED__';

export interface AlertRow {
  key: string;
  message: string;
  timestamp: string | null;
}

export interface ProposalRow {
  id: string;
  title: string;
  status: string;
  created: string | null;
  ageDays: number | null;
}

export interface OpenProposalRow extends ProposalRow {
  body: string;
}

export interface OldestAccepted {
  id: string;
  title: string;
  ageDays: number | null;
}

export interface WeeklyState {
  week: string;
  costUsd: number | null;
  createdCount: number | null;
  resolvedCount: number | null;
  priorCostUsd: number | null;
  hasPrior: boolean;
  bodyHtml: string;
}

export interface LastBriefState {
  kind: string;
  text: string;
  generatedAt: string | null;
}

export interface CompiledDocRow {
  name: string;
  title: string;
}

export interface DashboardState {
  byPerson: PersonTasks[];
  agentName: string;
  executionState: string;
  tasks: TaskReport[];
  aliveNow: boolean;
  todayCostUsd: number;
  todayTokens: number;
  alerts: AlertRow[];
  proposals: {
    open: OpenProposalRow[];
    other: ProposalRow[];
    otherOmitted: number;
    oldestOpenAccepted: OldestAccepted | null;
  };
  weekly: WeeklyState | null;
  lastBrief: LastBriefState | null;
  compiledIndex: { docs: CompiledDocRow[]; omitted: number };
  strings: ArtifactStrings;
}

// ---------- loading ----------

function readJsonSafe(p: string): Json | null {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// "Today" = the timezone-aware daily bucket in cost-index.json (sums every session
// that ran today), not .status.json's current-session running total.
function loadTodayCost(hermitDir: string, timezone: string): { costUsd: number; tokens: number } {
  const index = readCostIndex(costIndexPath(hermitDir));
  const entry = index?.by_date?.[todayYMD(timezone)];
  return {
    costUsd: typeof entry?.cost === 'number' ? entry.cost : 0,
    tokens: typeof entry?.tokens === 'number' ? entry.tokens : 0,
  };
}

function ageDaysFrom(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

export function loadProposals(hermitDir: string): DashboardState['proposals'] {
  // Always rebuild: rebuildIndex() is a cheap frontmatter read (no LLM/token cost) and
  // this self-heals any out-of-band drift (e.g. a Bash `mv` rename) that the
  // write-event-gated generate-summary hook never sees. It already reads each open
  // proposal's full body while parsing frontmatter — capture it via bodyOut instead of
  // re-reading every open proposal's file a second time below.
  const bodies = new Map<string, string>();
  const index: ProposalsIndex | null = rebuildIndex(hermitDir, bodies);
  if (!index || !Array.isArray(index.proposals)) {
    return { open: [], other: [], otherOmitted: 0, oldestOpenAccepted: null };
  }

  const open: OpenProposalRow[] = [];
  const other: ProposalRow[] = [];
  let oldestOpenAccepted: OldestAccepted | null = null;

  for (const row of index.proposals) {
    const status = row.status ?? 'unknown';
    const base: ProposalRow = {
      id: row.id,
      title: row.title ?? 'untitled',
      status,
      created: row.created,
      ageDays: ageDaysFrom(row.created),
    };

    if (status === 'accepted') {
      // Age since acceptance (the "since accepted" label), not since creation.
      const acceptedAge = ageDaysFrom(row.accepted_date ?? row.created);
      if (!oldestOpenAccepted || (acceptedAge ?? -1) > (oldestOpenAccepted.ageDays ?? -1)) {
        oldestOpenAccepted = { id: base.id, title: base.title, ageDays: acceptedAge };
      }
    }

    if (OPEN_STATUSES.has(status)) {
      // Body already captured during the rebuild pass above (same read, no re-open).
      // A missing entry means rebuildIndex itself couldn't read the file (a TOCTOU race
      // between its readdir and per-file read) — surface that loudly instead of
      // rendering an empty card that reads as "proposal exists but has no content."
      const cached = row.file ? bodies.get(row.file) : undefined;
      const body = cached !== undefined ? cached : (row.file ? `_(file missing: ${row.file})_` : '');
      open.push({ ...base, body });
    } else {
      other.push(base);
    }
  }

  // Oldest-waiting first: proposed/accepted proposals are the action items.
  open.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));
  // Most recent activity first for the resolved/dismissed history.
  other.sort((a, b) => (a.ageDays ?? Infinity) - (b.ageDays ?? Infinity));

  const otherOmitted = Math.max(0, other.length - OTHER_CAP);
  return {
    open,
    other: other.slice(0, OTHER_CAP),
    otherOmitted,
    oldestOpenAccepted,
  };
}

function loadWeekly(hermitDir: string): WeeklyState | null {
  const compiledDir = path.join(hermitDir, 'compiled');
  const files = globDir(compiledDir, /^review-weekly-.*\.md$/); // YYYY-Wnn sorts chronologically by name
  if (files.length === 0) return null;

  const latest = readFileWithFrontmatter(files[files.length - 1]);
  if (!latest || !latest.fm) return null;
  const prior = files.length > 1 ? readFileWithFrontmatter(files[files.length - 2]) : null;

  const num = (v: unknown): number | null => {
    const n = typeof v === 'string' ? parseFloat(v) : (typeof v === 'number' ? v : NaN);
    return Number.isFinite(n) ? n : null;
  };

  return {
    week: typeof latest.fm.week === 'string' ? latest.fm.week : 'unknown',
    costUsd: num(latest.fm.total_cost_usd),
    createdCount: num(latest.fm.proposals_created),
    resolvedCount: num(latest.fm.proposals_resolved),
    priorCostUsd: prior?.fm ? num(prior.fm.total_cost_usd) : null,
    hasPrior: !!prior?.fm,
    bodyHtml: mdToHtml(latest.body),
  };
}

function loadLastBrief(hermitDir: string): LastBriefState | null {
  const raw = readJsonSafe(path.join(hermitDir, 'state', 'last-brief.json'));
  if (!raw || typeof raw.text !== 'string' || !raw.text.trim()) return null;
  return {
    kind: typeof raw.kind === 'string' && raw.kind ? raw.kind : 'brief',
    text: raw.text,
    generatedAt: typeof raw.generated_at === 'string' ? raw.generated_at : null,
  };
}

const COMPILED_INDEX_CAP = 20;

function statMtimeMs(file: string): number {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

// Excludes review-weekly-*.md — those already have their own dedicated section
// (renderWeekly) so listing them again here would just be confusing duplication.
// Newest-first (by mtime) before the cap, so on a hermit with >20 compiled docs the
// discovery surface shows the most recently compiled ones rather than an arbitrary
// alphabetical slice that could hide a just-written doc.
function loadCompiledIndex(hermitDir: string): { docs: CompiledDocRow[]; omitted: number } {
  const compiledDir = path.join(hermitDir, 'compiled');
  const files = globDir(compiledDir, /\.md$/)
    .filter(f => !/^review-weekly-.*\.md$/.test(path.basename(f)))
    .map(f => ({ f, mtime: statMtimeMs(f) })) // stat once per file, not O(n log n) times in the comparator
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ f }) => f);
  const docs: CompiledDocRow[] = files.slice(0, COMPILED_INDEX_CAP).map(f => {
    const name = path.basename(f);
    const parsed = readFileWithFrontmatter(f);
    const title = typeof parsed?.fm?.title === 'string' && parsed.fm.title.trim() ? parsed.fm.title : name;
    return { name, title };
  });
  const omitted = Math.max(0, files.length - COMPILED_INDEX_CAP);
  return { docs, omitted };
}

// Alert entries have no single schema. Telemetry alerts carry `message`; the
// heartbeat checklist writer stores its human sentence under `text` (with a
// `channelText` variant for chat); budget alerts store structured fields and no
// prose at all. Read both prose fields before synthesizing or giving up —
// checking only `message` sent every checklist alert to the raw-dedup-key
// fallback below, so a page of proposal alerts rendered as
// "proposal-pending:PROP-012" while the proposal title sat unused on disk.
// Returns an already-escaped, safe-to-inject-raw string: file-derived parts (message,
// period, dedup key) are escaped here; the chrome templates are pre-escaped by
// loadStrings(). renderStatus injects the result without re-escaping, so a translated
// budget-alert string isn't double-escaped.
function alertMessage(key: string, v: Json, s: ArtifactStrings): string {
  if (typeof v?.message === 'string') return escapeHtml(v.message);
  if (typeof v?.text === 'string') return escapeHtml(v.text);
  if (v?.kind === 'budget') {
    const period = escapeHtml(typeof v.period === 'string' ? v.period : 'budget');
    const state = v.level === 'breach' ? s.budget_state_breached : s.budget_state_warning;
    const spend = typeof v.spend === 'number' ? `$${v.spend.toFixed(2)}` : null;
    const cap = typeof v.cap === 'number' ? `$${v.cap.toFixed(2)}` : null;
    const amounts = spend && cap ? fmt(s.budget_amounts, { spend, cap }) : '';
    return fmt(s.budget_text, { period, state, amounts });
  }
  return escapeHtml(key);
}

/** The hermit's own name, used to lead both page titles. Shared with
 *  proposals-page.ts, which has no other reason to read config.json. */
export function loadAgentName(hermitDir: string): string {
  return agentNameFromConfig(readSettledConfig(hermitDir));
}

export function loadDashboardState(hermitDir: string): DashboardState {
  const config = readSettledConfig(hermitDir);
  const timezone = typeof config.timezone === 'string' && config.timezone ? config.timezone : 'UTC';
  const strings = loadStrings(hermitDir);
  const liveAge = sharedLivenessAgeSecs(hermitDir);
  const aliveNow = liveAge !== null && liveAge < LIVENESS_FRESH_SECS;
  const today = loadTodayCost(hermitDir, timezone);
  // Union alerts across the per-writer files (skill/checklist + budget + telemetry).
  const alerts: AlertRow[] = [];
  for (const [key, v] of Object.entries<Json>(readMergedAlerts(hermitDir))) {
    if (v?.suppressed === true) continue; // dismissed/digested — not an active alert
    alerts.push({
      key,
      message: alertMessage(key, v, strings),
      timestamp: typeof v?.timestamp === 'string' ? v.timestamp : null,
    });
  }

  let byPerson: PersonTasks[] = [];
  try { byPerson = taskStandup(hermitDir).by_person; } catch { /* malformed task record: render the rest */ }

  return {
    byPerson,
    agentName: agentNameFromConfig(config),
    executionState: readExecution(hermitDir).state,
    tasks: readTaskReports(hermitDir),
    aliveNow,
    todayCostUsd: today.costUsd,
    todayTokens: today.tokens,
    alerts,
    proposals: loadProposals(hermitDir),
    weekly: loadWeekly(hermitDir),
    lastBrief: loadLastBrief(hermitDir),
    compiledIndex: loadCompiledIndex(hermitDir),
    strings,
  };
}

// ---------- markdown-subset -> HTML ----------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(escaped: string): string {
  const codeSpans: string[] = [];
  let s = escaped.replace(/`([^`]+)`/g, (_m, code) => {
    codeSpans.push(`<code>${code}</code>`);
    return `~~CODE~~${codeSpans.length - 1}~~CODE~~`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, url) => {
    if (/^(https?:|#|mailto:)/i.test(url)) {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    }
    return text; // unknown/unsafe scheme: keep the label, drop the link
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  s = s.replace(/~~CODE~~(\d+)~~CODE~~/g, (_m, i) => codeSpans[Number(i)]);
  return s;
}

/** Small markdown subset — headings, lists, fenced/inline code, bold/italic, links.
 *  Not CommonMark; sized for proposal bodies and weekly-review reports. */
export function mdToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let listBuffer: string[] = [];
  let paraBuffer: string[] = [];

  const flushList = () => {
    if (listBuffer.length) {
      out.push('<ul>' + listBuffer.map(item => `<li>${inline(item)}</li>`).join('') + '</ul>');
      listBuffer = [];
    }
  };
  const flushPara = () => {
    if (paraBuffer.length) {
      out.push(`<p>${inline(paraBuffer.join(' '))}</p>`);
      paraBuffer = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];

    if (/^```/.test(raw.trim())) {
      flushList(); flushPara();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        code.push(escapeHtml(lines[i]));
        i++;
      }
      out.push(`<pre><code>${code.join('\n')}</code></pre>`);
      i++; // skip closing fence
      continue;
    }

    const heading = raw.match(/^(#{1,4})\s+(.*)/);
    if (heading) {
      flushList(); flushPara();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(escapeHtml(heading[2]))}</h${level}>`);
      i++;
      continue;
    }

    const listItem = raw.match(/^[-*]\s+(.*)/);
    if (listItem) {
      flushPara();
      listBuffer.push(escapeHtml(listItem[1]));
      i++;
      continue;
    }

    if (raw.trim() === '') {
      flushList(); flushPara();
      i++;
      continue;
    }

    flushList();
    paraBuffer.push(escapeHtml(raw));
    i++;
  }
  flushList();
  flushPara();
  return out.join('\n');
}

// ---------- rendering ----------

export function chip(status: string): string {
  return chipHtml(status, escapeHtml(status));
}

/** "PROP-012-graphify-optional-recall-source-094353" -> "PROP-012". The slug
 *  restates the title it sits next to and the trailing HHMMSS is noise; the
 *  short form is also the handle the operator uses in chat ("accept PROP-012").
 *  Callers keep the full id in a `title=` attribute. */
export function shortPropId(id: string): string {
  const m = id.match(/^(PROP-\d+)/i);
  return m ? m[1] : id;
}

function ageLabel(days: number | null, s: ArtifactStrings): string {
  if (days == null) return '';
  if (days === 0) return s.age_today;
  return fmt(s.age_days, { n: days });
}

// Age as a meta part, or nothing at all when unknown — callers spread this into
// the monospace meta line, so an absent age contributes no separator.
function ageMeta(days: number | null, s: ArtifactStrings): string[] {
  const label = ageLabel(days, s);
  return label ? [label] : [];
}

function delta(current: number | null, prior: number | null, s: ArtifactStrings): string {
  if (current == null || prior == null) return '';
  const diff = current - prior;
  const sign = diff >= 0 ? '+' : '';
  const relBase = Math.abs(prior) > 0.0001 ? prior : null;
  const relPct = relBase != null ? Math.round((diff / relBase) * 100) : null;
  return relPct != null
    ? fmt(s.weekly_delta_cost, { prior: `$${prior.toFixed(2)}`, sign, pct: relPct })
    : fmt(s.weekly_delta_cost_no_pct, { prior: `$${prior.toFixed(2)}` });
}

// The proposals card below is the canonical surface for pending proposals — it
// carries titles, chips and full bodies, which an alert row cannot. Rendering
// them here too turned a 20-proposal backlog into twenty near-identical lines
// that buried every other alert. They still count toward the "Needs you" tile,
// so the number stays honest and the card explains it.
function renderAlerts(state: DashboardState): string {
  const s = state.strings;
  if (!state.alerts.length) return `<p class="muted">${s.status_no_alerts}</p>`;

  const shown = state.alerts.filter(a => !a.key.startsWith(PROPOSAL_PREFIX));
  // Every alert was card-owned. That is not "no alerts" — the tile says 20 — so
  // render nothing rather than contradicting it.
  if (!shown.length) return '';

  const rows = shown.map(a => railRow({ tone: 'warn', title: a.message }));
  return `<div class="alerts">${rows.join('')}</div>`;
}

function executionDisplay(state: DashboardState): { label: string; tone: 'acc' | 'good' } {
  const raw = state.executionState;
  if (raw === 'idle' && state.aliveNow) return { label: state.strings.session_on_watch, tone: 'good' };
  if (raw === 'in_flight') return { label: state.strings.session_in_progress, tone: 'acc' };
  if (raw === 'idle') return { label: state.strings.session_idle, tone: 'acc' };
  return { label: 'Unknown', tone: 'acc' };
}

function renderStatus(state: DashboardState): string {
  const s = state.strings;
  const execution = executionDisplay(state);
  const tiles = [
    statTile('Execution', execution.label, execution.tone),
    statTile('Open tasks', String(state.tasks.filter(task => task.outcome === 'open' || task.outcome === 'unconfirmed').length)),
    statTile(s.status_today, `$${state.todayCostUsd.toFixed(2)}`),
    statTile(s.status_tokens, escapeHtml(formatTokens(state.todayTokens))),
    statTile(s.status_alerts, String(state.alerts.length), state.alerts.length ? 'warn' : undefined),
  ].join('');
  return card(s.status_heading, `<div class="stat-row">${tiles}</div>${renderAlerts(state)}`);
}

// Shared two-line template for a proposal row: the title carries the scan, and
// the machine values (status chip, short id, plus caller-supplied meta — age
// here, created date on the proposals page) drop to a monospace second line.
// The full id rides along in `title=` so it stays copyable and searchable
// without being the loudest thing in the row.
// Exported so proposals-page.ts's open/history rows reuse the same template.
export function proposalLabel(p: ProposalRow, meta: string[]): string {
  const parts = [
    chip(p.status),
    `<span title="${escapeHtml(p.id)}">${escapeHtml(shortPropId(p.id))}</span>`,
    ...meta,
  ];
  return `<p class="rail-title">${escapeHtml(p.title)}</p>` +
    `<p class="rail-meta">${parts.join(META_SEP)}</p>`;
}

function renderProposals(state: DashboardState): string {
  const s = state.strings;
  const { open, other, otherOmitted, oldestOpenAccepted } = state.proposals;

  const openHtml = open.length
    ? open
        .map(
          p => `<details class="proposal">
            <summary>${proposalLabel(p, ageMeta(p.ageDays, s))}</summary>
            <div class="proposal-body">${mdToHtml(p.body)}</div>
          </details>`
        )
        .join('')
    : `<p class="muted">${s.proposals_none_open}</p>`;

  const otherHtml = other.length
    ? `<ul class="proposal-history">${other
        .map(p => `<li>${proposalLabel(p, ageMeta(p.ageDays, s))}</li>`)
        .join('')}${otherOmitted > 0 ? `<li class="muted">${fmt(s.common_more_not_shown, { n: otherOmitted })}</li>` : ''}</ul>`
    : '';

  const oldestLine = oldestOpenAccepted
    ? `<p class="muted">${fmt(s.proposals_oldest_accepted, {
        id: escapeHtml(oldestOpenAccepted.id),
        age: oldestOpenAccepted.ageDays != null
          ? fmt(s.proposals_since_accepted, { age: ageLabel(oldestOpenAccepted.ageDays, s) })
          : '',
      })}</p>`
    : '';

  return card(s.proposals_heading, `${oldestLine}${openHtml}${otherHtml}`);
}

// Omits the card entirely when there is no review yet — an empty section costs a
// heading and a line of prose to say nothing.
function renderWeekly(state: DashboardState): string {
  const s = state.strings;
  const w = state.weekly;
  if (!w) return '';

  const costLine = w.costUsd != null
    ? fmt(s.weekly_cost, { amount: `$${w.costUsd.toFixed(2)}`, delta: w.hasPrior ? delta(w.costUsd, w.priorCostUsd, s) : '' })
    : null;
  const proposalsLine = (w.createdCount != null || w.resolvedCount != null)
    ? fmt(s.weekly_proposals, { created: w.createdCount ?? 0, resolved: w.resolvedCount ?? 0 })
    : null;

  const summary = [costLine, proposalsLine].filter(Boolean) as string[];

  return card(fmt(s.weekly_week, { week: escapeHtml(w.week) }), `
      <ul class="evolution">${summary.map(l => `<li>${l}</li>`).join('')}</ul>
      <details class="weekly-body">
        <summary>${s.weekly_full_review}</summary>
        <div>${w.bodyHtml}</div>
      </details>`);
}

function renderBrief(state: DashboardState): string {
  const s = state.strings;
  const b = state.lastBrief;
  if (!b) return card(s.brief_heading, `<p class="muted">${s.brief_none}</p>`);
  const when = b.generatedAt ? ` <span class="muted">· ${escapeHtml(b.generatedAt)}</span>` : '';
  return card(`${s.brief_heading} <span class="muted">(${escapeHtml(b.kind)})</span>${when}`, mdToHtml(b.text));
}

function renderCompiledIndex(state: DashboardState): string {
  const s = state.strings;
  const { docs, omitted } = state.compiledIndex;
  if (!docs.length) return card(s.compiled_heading, `<p class="muted">${s.compiled_none}</p>`);
  const items = docs
    .map(d => `<li>${escapeHtml(d.title)}<span class="rail-meta">${escapeHtml(d.name)}</span></li>`)
    .join('');
  const omittedLine = omitted > 0 ? `<li class="muted">${fmt(s.common_more_not_shown, { n: omitted })}</li>` : '';
  return card(s.compiled_heading, `
      <p class="muted">${s.compiled_hint}</p>
      <ul class="proposal-history">${items}${omittedLine}</ul>`);
}

function renderByPerson(state: DashboardState): string {
  const groups = (state.byPerson ?? []).map(person => {
    const sections = ([['Promised', person.promised], ['Late', person.late], ['Waiting on them', person.waiting]] as const).map(([title, rows]) =>
      `<h3>${title}</h3><ul>${rows.map(row => `<li>${escapeHtml(row.handle)}: ${escapeHtml(row.title)} (${escapeHtml(row.due ?? 'no due date')}) ${escapeHtml(row.listing.join(', '))} $${row.cost_usd.toFixed(4)}</li>`).join('')}</ul>`).join('');
    return `<article><h2>${escapeHtml(person.identity)}${person.name ? ` (${escapeHtml(person.name)})` : ''}</h2>${sections}</article>`;
  });
  return `<section class="card"><h2>By person</h2>${groups.join('') || '<p>No open tasks</p>'}</section>`;
}

/** The default page's cards, each as a standalone HTML fragment. Exported so a
 *  hermit-local dashboard renderer (see docs/artifacts.md § Custom renderer) can embed
 *  any of them verbatim instead of reimplementing them; `renderDashboard` composes the
 *  same map, so the two cannot drift. `weekly` is empty when there is no review yet. */
export function renderCoreSections(state: DashboardState): Record<string, string> {
  return {
    status: renderStatus(state),
    byPerson: renderByPerson(state),
    brief: renderBrief(state),
    proposals: renderProposals(state),
    weekly: renderWeekly(state),
    compiledIndex: renderCompiledIndex(state),
  };
}

/** Renders the full artifact fragment plus a content hash stable across
 *  identical underlying state (the "last updated" stamp is excluded from the hash
 *  via a placeholder token, so the publish gate can skip no-op republishes).
 *  One caveat: `state.aliveNow` is derived from file mtimes at load time, so a
 *  render that straddles the liveness freshness window can flip the session tile
 *  (and therefore the hash) with no persisted state change. That costs at most one
 *  extra republish per flip, and only on a hermit whose liveness signal goes stale
 *  between refreshes. */
export function renderDashboard(state: DashboardState, opts?: { now?: string }): { html: string; hash: string } {
  const s = state.strings;
  const title = fmt(s.dashboard_title, { name: escapeHtml(state.agentName) });
  const sections = renderCoreSections(state);
  const templated = pageShell({
    title,
    heading: title,
    updatedLabel: s.label_updated,
    updatedToken: UPDATED_TOKEN,
    body: [
      sections.status,
      sections.byPerson,
      sections.brief,
      sections.proposals,
      sections.weekly,
      sections.compiledIndex,
    ].filter(Boolean).join('\n  '),
  });

  const hash = sha256(templated);
  const now = opts?.now ?? new Date().toISOString();
  const html = templated.replace(UPDATED_TOKEN, escapeHtml(now));
  return { html, hash };
}
