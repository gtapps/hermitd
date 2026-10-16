// Derived cache of every proposal's frontmatter. Writes state/proposals-index.json
// (full rebuild — never incremental, so it cannot drift). Driven by `proposal.ts
// index`, and imported directly by the generate-summary PostToolUse hook and
// lib/dashboard.ts, which call rebuildIndex() on every proposal write.
//
// Why this exists: proposal-list otherwise reads every PROP-*.md body in full
// (~22K tokens for a dozen proposals) just to render a table from frontmatter.
// It also carries proposal counts for proposal-list. (Note: state-summary.md and
// reflection-state.json still tally proposal events independently from
// proposal-metrics.jsonl — those are event counters, a different quantity, and
// were not migrated onto this index.)
//
// Named index-rebuild, not index: a bare `index.ts` here would make
// `import … from './lib/proposals'` silently resolve to this module.

import fs from 'node:fs';
import path from 'node:path';
import { readFileWithFrontmatter, globDir } from '../frontmatter';
import { emitJson } from '../cli';

type Json = any;

export interface ProposalRow {
  id: string;
  file: string;
  status: string | null;
  source: string | null;
  category: string | null;
  title: string | null;
  created: string | null;
  session: string | null;
  responded: boolean;
  accepted_date: string | null;
  resolved_date: string | null;
  tags: string[];
  self_eval_key: string | null;
  // True when this row is a placeholder because the file's frontmatter couldn't
  // be read at all — every other field is null. Not "old format": bullet
  // metadata is no longer parsed, so there is nothing to recover.
  unparseable: boolean;
}

export interface ProposalsIndex {
  updated: string;
  count: number;
  counts: Record<string, number>;
  proposals: ProposalRow[];
}

// Title comes from frontmatter `title` when set, else the H1 heading
// `# Proposal: PROP-NNN — [Title]`.
function extractTitle(fm: Json, body: string): string | null {
  if (typeof fm.title === 'string' && fm.title.trim()) return fm.title.trim();
  const m = body.match(/^#\s+Proposal:\s+\S+\s+[—-]\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

// Minimal row for a proposal whose frontmatter can't be read — an fs error, or a
// file without a `---` block at all. Don't silently drop it: it would vanish from
// proposal-list while heartbeat, which reads disk directly, still wakes on it, so
// the two surfaces would disagree about whether it exists. `status: null` counts
// as 'unknown', which is also honest about what the lifecycle can do with it —
// proposal.ts's patch verb can only write frontmatter.
function placeholderRow(id: string, file: string): ProposalRow {
  return {
    id, file, status: null, source: null, category: null,
    title: null, created: null, session: null, responded: false,
    accepted_date: null, resolved_date: null, tags: [], self_eval_key: null,
    unparseable: true,
  };
}

export function rebuildIndex(stateDir: string, bodyOut?: Map<string, string>): ProposalsIndex | null {
  const proposalsDir = path.join(stateDir, 'proposals');
  if (!fs.existsSync(proposalsDir)) return null;

  const files = globDir(proposalsDir, /^PROP-.*\.md$/);
  const proposals: ProposalRow[] = [];

  for (const file of files) {
    const base = path.basename(file);
    const idStem = base.replace(/\.md$/, '');
    const parsed = readFileWithFrontmatter(file);
    if (!parsed) {
      proposals.push(placeholderRow(idStem, base));
      continue;
    }

    // Captured for callers (dashboard.ts) that need the body too — avoids a second
    // full-file read of the same proposal just parsed here.
    if (bodyOut) bodyOut.set(base, parsed.body);

    if (parsed.fm && typeof parsed.fm === 'object') {
      const fm = parsed.fm;
      proposals.push({
        id: typeof fm.id === 'string' && fm.id.trim() ? fm.id.trim() : idStem,
        file: base,
        status: typeof fm.status === 'string' ? fm.status : null,
        source: typeof fm.source === 'string' ? fm.source : null,
        category: typeof fm.category === 'string' ? fm.category : null,
        title: extractTitle(fm, parsed.body),
        created: typeof fm.created === 'string' ? fm.created : null,
        session: typeof fm.session === 'string' ? fm.session : null,
        responded: fm.responded === true,
        accepted_date: typeof fm.accepted_date === 'string' ? fm.accepted_date : null,
        resolved_date: typeof fm.resolved_date === 'string' ? fm.resolved_date : null,
        tags: Array.isArray(fm.tags) ? fm.tags.filter((t: unknown) => typeof t === 'string') : [],
        self_eval_key: typeof fm.self_eval_key === 'string' ? fm.self_eval_key : null,
        unparseable: false,
      });
    } else {
      proposals.push(placeholderRow(idStem, base));
    }
  }

  const counts: Record<string, number> = {};
  for (const p of proposals) {
    const k = p.status ?? 'unknown';
    counts[k] = (counts[k] ?? 0) + 1;
  }

  const index: ProposalsIndex = {
    updated: new Date().toISOString(),
    count: proposals.length,
    counts,
    proposals,
  };

  try {
    const stateSubdir = path.join(stateDir, 'state');
    fs.mkdirSync(stateSubdir, { recursive: true }); // state/ may be absent on a partial layout
    // Atomic write: this runs from a PostToolUse hook that can overlap concurrent
    // proposal writes; a torn index would make proposal-list's JSON.parse throw.
    const target = path.join(stateSubdir, 'proposals-index.json');
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, target);
  } catch { /* fail-open: a failed write just means a reader rebuilds next time */ }

  return index;
}

// `proposal.ts index <stateDir>`: full rebuild, one bounded verdict line:
// `{"count":<n>}`, or `{"status":"skip","reason":"no_proposals_dir"}`.
export function run(stateDir: string): never {
  const index = rebuildIndex(stateDir);
  emitJson(index ? { count: index.count } : { status: 'skip', reason: 'no_proposals_dir' });
}
