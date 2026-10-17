#!/usr/bin/env bun
import { readTaskReports } from './lib/task-report';
import { taskStandup } from './lib/tasks';
import { dutySummary } from './lib/duty-summary';
// weekly-review.ts — generates a weekly review report
// Zero npm dependencies. Node stdlib only.
// Usage: bun weekly-review.ts <hermit-state-dir>
//   hermit-state-dir: path to .hermit/ in the target project (default: .hermit)
// Output: `{"path":"<review file>","knowledge_findings":N,"usage_docs":N}`, the two
// counts sizing the review's Knowledge Health and Usage sections (0 = section absent).

import fs from 'node:fs';
import path from 'node:path';
import { readFrontmatter, readFileWithFrontmatter, parseFrontmatter, newestByType, globDir } from './lib/frontmatter';
import { costLogPath, hermitDir as resolveHermitRoot } from './lib/cc-compat';
import { readSettledConfig } from './lib/config-read';
import { readRoutineHistory } from './lib/routines/history';
import { formatTokens } from './lib/format';
import { writeFileAtomic } from './lib/md-write';
import { shortPropId } from './lib/dashboard';
import { lint as knowledgeLint } from './knowledge-lint';
import { printJson } from './lib/cli';

type Json = any;

// --- Args ---
// An absolute arg (as tests pass) is used verbatim; a relative/absent arg is
// resolved via the anchored hermitDir() so state access survives cwd drift.
const hermitArg = process.argv[2];
const hermitDir = hermitArg && path.isAbsolute(hermitArg) ? hermitArg : resolveHermitRoot();

// --- ISO week calculation ---

function getISOWeek(date: Date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week: weekNo };
}

function isoWeekKey(date: Date) {
  const { year, week } = getISOWeek(date);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function weekDateRange(year: number, week: number) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1) + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const fmt = (d: Date) => `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return `${fmt(monday)}–${fmt(sunday)}, ${year}`;
}

// --- Determine current week ---
const now = new Date();
const { year: currentYear, week: currentWeek } = getISOWeek(now);
const weekKey = isoWeekKey(now);

// Week boundaries (Mon 00:00 UTC → Sun 23:59 UTC)
const jan4 = new Date(Date.UTC(currentYear, 0, 4));
const jan4Day = jan4.getUTCDay() || 7;
const weekStart = new Date(jan4);
weekStart.setUTCDate(jan4.getUTCDate() - (jan4Day - 1) + (currentWeek - 1) * 7);
const weekEnd = new Date(weekStart);
weekEnd.setUTCDate(weekStart.getUTCDate() + 7); // exclusive

// Task reports are the only work-record input; frozen archives are not read.
const reports = readTaskReports(hermitDir);
const allSessions = reports.filter(record => record.closed_at !== null).map(record => ({
  file: record.source_path,
  fm: { id: path.basename(record.source_path, '.md'), date: record.closed_at!, cost_usd: record.cost,
    status: record.outcome, tags: [] as string[], tokens: undefined as number | undefined },
  content: record.lessons.join('\n'), parsedDate: new Date(record.closed_at!),
}));
const weekSessions = allSessions.filter(s => s.parsedDate >= weekStart && s.parsedDate < weekEnd);
const delivered = reports.filter(record => record.outcome === 'done' && record.closed_at
  && new Date(record.closed_at) >= weekStart && new Date(record.closed_at) < weekEnd).map(record => record.title);

// --- Load proposals ---
const proposalsDir = path.join(hermitDir, 'proposals');
const proposalFiles = globDir(proposalsDir, /^PROP-\d+(?:-.+)?\.md$/);
const allProposals = proposalFiles
  .map(f => ({ file: f, fm: readFrontmatter(f) }))
  .filter(p => p.fm && p.fm.id);

const weekCreated = allProposals.filter(p => {
  if (!p.fm.created) return false;
  const d = new Date(p.fm.created);
  return d >= weekStart && d < weekEnd;
});

const weekAccepted = allProposals.filter(p => {
  if (!p.fm.accepted_date) return false;
  const d = new Date(p.fm.accepted_date);
  return d >= weekStart && d < weekEnd;
});

const weekResolved = allProposals.filter(p => {
  if (p.fm.status !== 'resolved' || !p.fm.resolved_date) return false;
  const d = new Date(p.fm.resolved_date);
  return d >= weekStart && d < weekEnd;
});

// --- Metrics ---
const sessionsCount = weekSessions.length;
const attributedCost = weekSessions.reduce((sum, s) => sum + Number(s.fm.cost_usd || 0), 0);
const avgCost = sessionsCount > 0 ? attributedCost / sessionsCount : 0;

// Task reports carry only the cost attributed to each task; the week's spend and
// token totals come from the cost-log rows, so they hold when no task closed.
let totalCost = 0;
let totalTokens = 0;
const weekCostLog = costLogPath(hermitDir);
const weekStartStr = weekStart.toISOString().slice(0, 10);
const weekEndStr = weekEnd.toISOString().slice(0, 10);
try {
  const lines = fs.readFileSync(weekCostLog, 'utf-8').trim().split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const d = (e.timestamp || '').slice(0, 10);
      if (d >= weekStartStr && d < weekEndStr) {
        totalCost += e.estimated_cost_usd || 0;
        totalTokens += e.total_tokens || 0;
      }
    } catch {}
  }
} catch {}
const avgTokens = sessionsCount > 0 ? Math.round(totalTokens / sessionsCount) : 0;

// --- Honesty rule: pre-build tag counts for O(1) lookup ---
const totalSessionCount = allSessions.length;
const IMPACT_THRESHOLD = 0.3;
const tagCounts = new Map<string, number>();
for (const s of allSessions) {
  for (const tag of (s.fm.tags || [])) {
    tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
  }
}

function canShowTagImpact(tag: string) {
  if (totalSessionCount === 0) return false;
  return (tagCounts.get(tag) || 0) / totalSessionCount < IMPACT_THRESHOLD;
}

// --- Recently resolved: show numeric impact only when honesty rule passes ---
function countIncompleteSessions(propTags: string[], datePredicate: (d: Date) => boolean) {
  return allSessions.filter(s =>
    datePredicate(s.parsedDate) &&
    (s.fm.status === 'cancelled' || s.fm.status === 'unconfirmed') &&
    propTags.some(t => (s.fm.tags || []).includes(t))
  ).length;
}

const resolvedWithImpact = weekResolved.map(p => {
  const propTags = p.fm.tags || [];
  const resolvedDate = new Date(p.fm.resolved_date);
  const preCount = countIncompleteSessions(propTags, d => d < resolvedDate);
  const postCount = countIncompleteSessions(propTags, d => d >= resolvedDate);
  const showImpact = propTags.some((t: string) => canShowTagImpact(t));
  return { p, preCount, postCount, showImpact };
});

// --- Open loops (proposals proposed for a long time without response) ---
const openLoops = allProposals
  .filter(p => p.fm.status === 'proposed' && p.fm.created)
  .map(p => {
    const created = new Date(p.fm.created);
    const sessionsSince = allSessions.filter(s => s.parsedDate > created).length;
    return { p, sessionsSince };
  })
  .filter(o => o.sessionsSince >= 5)
  .sort((a, b) => (a.p.fm.created || '').localeCompare(b.p.fm.created || ''));

// --- Reflect vital-signs ---
// Weekly runs come from routine fires; surfaced and accepted counts come from
// reflect-exclusive micro-proposal events. All reads fail open to zeros.
const reflectRoutineIds = new Set(readSettledConfig(hermitDir).routines
  .filter((routine: any) => String(routine.skill ?? '').split(/\s+/)[0] === 'hermitd:reflect')
  .map((routine: any) => routine.id));
const reflectRuns = readRoutineHistory(path.join(hermitDir, 'state', 'routine-metrics.jsonl'), 7, new Date(weekEnd.getTime() - 1))
  .routines.filter(routine => reflectRoutineIds.has(routine.id))
  .reduce((sum, routine) => sum + routine.fires, 0);

// micro-queued / micro-resolved are reflect-exclusive event types: only the
// reflect loop queues micro-proposals, so approving one is approving reflect
// output regardless of which surface records the approval. `created`/`responded`
// are shared by capability-brainstorm, operator-request, and channel callers and
// carry no reflect-distinguishing field (the `source` enum value `auto-detected`
// is shared), so Tier-3 reflect proposals routing through them are deliberately
// excluded — undercount, never over-claim non-reflect activity as reflect's.
// Bridged asks (kind:"ask") ride the same micro-queued event for ID sequencing
// but are other skills' bounded asks, not reflect candidates — exclude them.
let reflectSurfaced = 0;
let reflectAccepted = 0;
try {
  const lines = fs.readFileSync(path.join(hermitDir, 'state', 'proposal-metrics.jsonl'), 'utf-8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const d = new Date(e.ts);
      if (!(d >= weekStart && d < weekEnd)) continue;
      if (e.type === 'micro-queued' && e.kind !== 'ask') reflectSurfaced++;
      if (e.type === 'micro-resolved' && e.action === 'approved') reflectAccepted++;
    } catch {}
  }
} catch {}

// Approximation: only reflect runs attributed as routine cost-log sources are
// counted; quick-mode reflect_after runs inside other sessions are not.
let reflectCost = 0;
try {
  const lines = fs.readFileSync(costLogPath(hermitDir), 'utf-8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (!(e.source || '').startsWith('routine:reflect')) continue;
      const d = new Date(e.timestamp);
      if (d >= weekStart && d < weekEnd) reflectCost += e.estimated_cost_usd || 0;
    } catch {}
  }
} catch {}

// observations.jsonl is the reflect ledger's kill signal: empty everywhere =
// graduation never fires.
let reflectObsTotal = 0;
let reflectObsWeek = 0;
try {
  const lines = fs.readFileSync(path.join(hermitDir, 'state', 'observations.jsonl'), 'utf-8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    reflectObsTotal++;
    try {
      const e = JSON.parse(line);
      const d = new Date(e.ts);
      if (d >= weekStart && d < weekEnd) reflectObsWeek++;
    } catch {}
  }
} catch {}

// --- Usage (usage-metrics.jsonl → auto-archive of untouched compiled/ docs) ---
// Subagent reads do reach the ledger (PostToolUse fires for sidechain calls,
// probed on CC 2.1.239), so "no tracked use" is real evidence — docs with none
// in the window are archived move-only, with the digest as the operator's veto.
// Startup injection stays untracked, which is why foundational/topic/review
// artifacts are exempt below. A young or missing ledger never reads as unused.
let usageStaleDays = 30;
let usageAutoArchive = true;
try {
  // Already settled: `knowledge` is always an object and both keys are coerced
  // to their declared types. Only the >0 floor does work — a hand-edited 0 or
  // negative would make every doc instantly stale.
  const knowledgeCfg = readSettledConfig(hermitDir).knowledge;
  if (knowledgeCfg.usage_stale_days > 0) usageStaleDays = knowledgeCfg.usage_stale_days;
  // `!== true` rather than `=== false`: an explicit null is preserved by
  // settleValue as a deliberate operator value with disable semantics
  // (lib/config-read.ts), so it has to turn archiving off like `false` does.
  if (knowledgeCfg.usage_auto_archive !== true) usageAutoArchive = false;
} catch {}
const usageStaleMs = usageStaleDays * 86400000;
const compiledDir = path.join(hermitDir, 'compiled');
const usageLedgerPath = path.join(hermitDir, 'state', 'usage-metrics.jsonl');

let ledgerStartMs: number | null = null;
let compiledEvidence = false;
const lastCompiledReadMs = new Map<string, number>(); // key: compiled/ doc stem
try {
  const usageLines = fs.readFileSync(usageLedgerPath, 'utf-8').split('\n');
  for (const line of usageLines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const tsMs = Date.parse(e.ts);
      if (!Number.isFinite(tsMs)) continue;
      if (ledgerStartMs === null || tsMs < ledgerStartMs) ledgerStartMs = tsMs;
      if (e.kind === 'compiled' && typeof e.name === 'string') {
        compiledEvidence = true;
        const prev = lastCompiledReadMs.get(e.name);
        if (prev === undefined || tsMs > prev) lastCompiledReadMs.set(e.name, tsMs);
      }
    } catch {}
  }
} catch {}

let untouchedDocs: { stem: string; lastRead: number | null; date: Date }[] = [];

// Guard: a ledger younger than the staleness window (or missing entirely)
// would make every doc look unused — say nothing rather than mislead.
if (ledgerStartMs !== null && (now.getTime() - ledgerStartMs) >= usageStaleMs) {
  const cutoffMs = now.getTime() - usageStaleMs;

  try {
    for (const docPath of globDir(compiledDir, /^[^.].*\.md$/)) {
      const fm = readFrontmatter(docPath);
      if (!fm || !fm.type) continue;
      // Same exemptions as archive-compiled.ts: foundational + topic pages are
      // living documents; also skip weekly-review's own generated output.
      if ((fm.tags || []).includes('foundational') || fm.type === 'topic' || fm.type === 'review' || fm.generated) continue;
      const dateStr = fm.updated || fm.created;
      if (!dateStr) continue;
      const date = new Date(dateStr);
      if (isNaN(date.getTime()) || (now.getTime() - date.getTime()) < usageStaleMs) continue;
      const stem = path.basename(docPath, '.md');
      const lastRead = lastCompiledReadMs.get(stem) ?? null;
      if (lastRead !== null && lastRead >= cutoffMs) continue; // read recently — not stale
      untouchedDocs.push({ stem, lastRead, date });
    }
  } catch {}
  untouchedDocs.sort((a, b) => a.date.getTime() - b.date.getTime());
}

// Archive the untouched docs: move-only into compiled/.archive/, reported in
// the digest so the operator can veto by moving one back. A failed move drops
// the doc back to a suggestion rather than losing it silently.
//
// Three limits beyond the ledger-age guard, all of them about evidence:
//  - The ledger must hold at least one compiled read. A hook that never fired
//    (not installed, silently failing, dropping reads at the old stdin cap)
//    produces exactly the same "nothing was used" ledger as a genuinely idle
//    week, and the first post-upgrade run is where the two are least
//    distinguishable. Without capture evidence the docs stay suggestions.
//  - A stem archived once is never archived again. Moving the file back is the
//    documented restore, and a move leaves no read event and no marker — the
//    operator's veto would otherwise lose again every week.
//  - At most RUN_CAP moves per run. A backlogged hermit's first run would
//    otherwise empty compiled/ in one go and emit an unbounded digest; the
//    remainder carries over to the following weeks as suggestions.
const RUN_CAP = 10;
const archivedOncePath = path.join(hermitDir, 'state', 'usage-archived.json');
const archivedOnce = new Set<string>();
try {
  const prior = JSON.parse(fs.readFileSync(archivedOncePath, 'utf-8'));
  if (Array.isArray(prior?.stems)) for (const s of prior.stems) if (typeof s === 'string') archivedOnce.add(s);
} catch {}

const autoArchived: string[] = [];
if (usageAutoArchive && compiledEvidence && untouchedDocs.length > 0) {
  const usageArchiveDir = path.join(compiledDir, '.archive');
  const stillUntouched: typeof untouchedDocs = [];
  let archiveDirReady = false;
  try {
    fs.mkdirSync(usageArchiveDir, { recursive: true });
    archiveDirReady = true;
  } catch {}
  for (const doc of untouchedDocs) {
    if (archivedOnce.has(doc.stem)) continue; // operator moved it back — theirs to keep
    if (!archiveDirReady || autoArchived.length >= RUN_CAP) {
      stillUntouched.push(doc);
      continue;
    }
    let dest = path.join(usageArchiveDir, `${doc.stem}.md`);
    if (fs.existsSync(dest)) dest = path.join(usageArchiveDir, `${doc.stem}-${Date.now()}.md`);
    try {
      fs.renameSync(path.join(compiledDir, `${doc.stem}.md`), dest);
      autoArchived.push(doc.stem);
    } catch {
      stillUntouched.push(doc);
    }
  }
  untouchedDocs = stillUntouched;
  if (autoArchived.length > 0) {
    for (const stem of autoArchived) archivedOnce.add(stem);
    try {
      writeFileAtomic(archivedOncePath, JSON.stringify({ stems: [...archivedOnce] }, null, 2));
    } catch {}
  }
}

const usageUntouchedCount = untouchedDocs.length;

let usageSection = '';
if (autoArchived.length > 0 || untouchedDocs.length > 0) {
  const DOC_CAP = 10;
  usageSection = `### Usage (no tracked use ≥${usageStaleDays}d)\n`;
  for (const stem of autoArchived) {
    usageSection += `- compiled/${stem}.md — auto-archived to compiled/.archive/ (restore by moving it back)\n`;
  }
  for (const d of untouchedDocs.slice(0, DOC_CAP)) {
    const lastReadStr = d.lastRead !== null ? new Date(d.lastRead).toISOString().slice(0, 10) : 'never';
    usageSection += `- compiled/${d.stem}.md — last tracked read ${lastReadStr}, updated ${d.date.toISOString().slice(0, 10)}\n`;
  }
  if (untouchedDocs.length > DOC_CAP) usageSection += `- (+${untouchedDocs.length - DOC_CAP} more)\n`;
  if (usageAutoArchive && !compiledEvidence) {
    usageSection += `Nothing was auto-archived: the ledger holds no compiled/ read at all, which reads as a tracking gap rather than as disuse. These stay suggestions until it records one.\n`;
  }
  usageSection += `Tracked sources: compiled/ Reads (subagent reads included); startup injection is not tracked.\n\n`;
}

// --- Build report ---

const frontmatter = [
  '---',
  'type: review',
  `title: "Weekly Review: ${weekKey}"`,
  `created: ${now.toISOString()}`,
  'tags: [weekly, review]',
  'generated: true',
  `week: ${weekKey}`,
  `tasks_count: ${sessionsCount}`,
  // Commas neutralized — the shared frontmatter array parser (lib/frontmatter.ts)
  // naively splits on every comma with no quote-awareness, so a comma inside an
  // annotation would corrupt this into extra array entries. Quotes need no
  // escaping: the parser strips only the outer quote pair and never unescapes.
  `delivered_count: ${delivered.length}`,
  `delivered: [${delivered.map(d => `"${d.replace(/,/g, ';')}"`).join(', ')}]`,
  `proposals_created: ${weekCreated.length}`,
  `proposals_accepted: ${weekAccepted.length}`,
  `proposals_resolved: ${weekResolved.length}`,
  `open_loops_count: ${openLoops.length}`,
  `total_cost_usd: ${totalCost.toFixed(2)}`,
  `total_tokens: ${totalTokens}`,
  `avg_task_cost_usd: ${avgCost.toFixed(2)}`,
  `avg_task_tokens: ${avgTokens}`,
  `reflect_runs: ${reflectRuns}`,
  `reflect_surfaced: ${reflectSurfaced}`,
  `reflect_accepted: ${reflectAccepted}`,
  `reflect_cost_usd: ${reflectCost.toFixed(2)}`,
  `reflect_observations: ${reflectObsTotal}`,
  `usage_untouched_count: ${usageUntouchedCount}`,
  `usage_auto_archived: [${autoArchived.map(s => `"${s.replace(/,/g, ';')}"`).join(', ')}]`,
  '---',
].join('\n');

const dateRange = weekDateRange(currentYear, currentWeek);

let body = `## Week of ${dateRange}\n\n`;

// Sessions
const weekSpend = `Week spend $${totalCost.toFixed(2)} (${formatTokens(totalTokens)}).`;
if (sessionsCount > 0) {
  body += `### Tasks\n`;
  body += `${sessionsCount} task${sessionsCount !== 1 ? 's' : ''} closed ($${avgCost.toFixed(2)} avg attributed). ${weekSpend}\n\n`;
} else {
  body += `### Tasks\nNo closed tasks this week. ${weekSpend}\n\n`;
}

body += '### By person\n';
for (const person of taskStandup(hermitDir).by_person) {
  body += `- ${person.name ?? person.identity}: ${person.promised.length} open, ${person.late.length} late, ${person.waiting.length} waiting\n`;
}
const reviewRoutinePrefixes = readSettledConfig(hermitDir).routines
  .filter((routine: any) => routine.skill === 'hermitd:weekly-review')
  .map((routine: any) => `routine:${routine.id}: requested `);
body += '\n### Duties\n' + dutySummary(hermitDir).map(line => {
  // Only a start stamped this week is this review; an older dangling `started` is a stuck fire.
  const started = line.match(/last_event=started@(\S+)$/);
  if (started && new Date(started[1]) >= weekStart && reviewRoutinePrefixes.some((prefix: string) => line.startsWith(prefix))) {
    line = line.slice(0, started.index) + 'last_event=in progress (this review)';
  }
  return '- ' + line;
}).join('\n') + '\n\n';

// Delivered (durable compiled/ outputs produced this week, per session ## Artifacts)
if (delivered.length > 0) {
  body += `### Delivered\n`;
  for (const d of delivered) {
    body += `- ${d}\n`;
  }
  body += '\n';
}

// Proposals
if (weekCreated.length > 0 || weekAccepted.length > 0 || weekResolved.length > 0) {
  body += `### Proposals\n`;
  if (weekCreated.length > 0) {
    body += `${weekCreated.length} created: ${weekCreated.map(p => shortPropId(p.fm.id)).join(', ')}.\n`;
  }
  if (weekAccepted.length > 0) {
    body += `${weekAccepted.length} accepted: ${weekAccepted.map(p => shortPropId(p.fm.id)).join(', ')}.\n`;
  }
  if (weekResolved.length > 0) {
    // Each one is listed with its title under Recently Resolved.
    body += `${weekResolved.length} resolved.\n`;
  }
  body += '\n';
}

// Recently resolved with impact
if (resolvedWithImpact.length > 0) {
  body += `### Recently Resolved\n`;
  for (const { p, preCount, postCount, showImpact } of resolvedWithImpact) {
    const title = p.fm.title || p.fm.id;
    if (showImpact && preCount > 0) {
      body += `- ${shortPropId(p.fm.id)}: ${title} — ${preCount} incomplete session${preCount !== 1 ? 's' : ''} pre-resolution, ${postCount} post.\n`;
    } else {
      body += `- ${shortPropId(p.fm.id)}: ${title} — observed trend.\n`;
    }
  }
  body += '\n';
}

// Open loops
if (openLoops.length > 0) {
  body += `### Open Loops\n`;
  for (const { p, sessionsSince } of openLoops) {
    body += `- ${shortPropId(p.fm.id)}: ${p.fm.title || 'untitled'} — proposed ${sessionsSince} sessions ago, no action taken.\n`;
  }
  body += '\n';
}

// Reflect vital-signs — makes healthy-quiet distinguishable from dead: a week
// of runs with zero surfaced/accepted while cost accumulates is the loop
// telling the operator to prune it.
{
  body += `### Reflect\n`;
  let line = `reflect: ${reflectRuns} run${reflectRuns !== 1 ? 's' : ''}, ${reflectSurfaced} surfaced, ${reflectAccepted} accepted, ~$${reflectCost.toFixed(2)}`;
  line += `; obs: ${reflectObsTotal} ledger${reflectObsWeek > 0 ? ` (+${reflectObsWeek} this week)` : ''}`;
  body += `${line}.\n\n`;
}

// --- Knowledge Health (via shared knowledge-lint.ts) ---
let knowledgeSection = '';
let knowledgeFindings = 0;
try {
  const { findings } = knowledgeLint(hermitDir);
  knowledgeFindings = findings.length;
  if (findings.length > 0) {
    knowledgeSection = `### Knowledge Health\n`;
    for (const f of findings) {
      knowledgeSection += `- ${f.file} [${f.age}] — ${f.reason}\n`;
    }
    knowledgeSection += '\n';
  }
} catch {}

if (knowledgeSection) body += knowledgeSection;
if (usageSection) body += usageSection;

const report = `${frontmatter}\n${body}`;

// --- Write review file ---
fs.mkdirSync(compiledDir, { recursive: true });

const reviewPath = path.join(compiledDir, `review-weekly-${weekKey}.md`);
fs.writeFileSync(reviewPath, report, 'utf8');
printJson({ path: reviewPath, knowledge_findings: knowledgeFindings, usage_docs: autoArchived.length + untouchedDocs.length });

// --- Compact the usage ledger: keep events <180d, plus the single newest
// event per stale kind:name pair (preserves last-used forever), plus the
// ledger-start meta line. Same tmp+rename pattern as prune-observations.ts.
try {
  const USAGE_RETENTION_DAYS = 180;
  const cutoffMs = now.getTime() - USAGE_RETENTION_DAYS * 86400000;
  const rawLedger = fs.readFileSync(usageLedgerPath, 'utf-8');
  const ledgerLines = rawLedger.split('\n').filter(l => l.trim());

  let metaLine: string | null = null;
  const recent: string[] = [];
  const staleLatest = new Map<string, { ts: number; line: string }>();

  for (const line of ledgerLines) {
    let e: Json;
    try { e = JSON.parse(line); } catch { recent.push(line); continue; }
    if (e.kind === 'meta' && e.event === 'ledger-start') {
      if (!metaLine) metaLine = line;
      continue;
    }
    const tsMs = Date.parse(e.ts);
    if (!Number.isFinite(tsMs) || tsMs >= cutoffMs) { recent.push(line); continue; }
    const key = `${e.kind}:${e.name}`;
    const prev = staleLatest.get(key);
    if (!prev || tsMs > prev.ts) staleLatest.set(key, { ts: tsMs, line });
  }

  const kept = [
    ...(metaLine ? [metaLine] : []),
    ...[...staleLatest.values()].map(v => v.line),
    ...recent,
  ];

  if (kept.length < ledgerLines.length) {
    const tmp = usageLedgerPath + '.tmp';
    fs.writeFileSync(tmp, kept.join('\n') + (kept.length ? '\n' : ''), 'utf-8');
    fs.renameSync(tmp, usageLedgerPath);
  }
} catch { /* fail-open — no ledger yet, or unreadable */ }
