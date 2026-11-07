#!/usr/bin/env bun
/**
 * Builds a bounded evidence bundle for the $stale-proposals audit.
 *
 * The matching step is semantic and has to see both the open proposals and
 * everything that shipped after them. Read naively, that is thousands of
 * changelog lines in the user's session. This script collects the evidence
 * into one file and prints only counts, so the corpus reaches an isolated
 * worker by path and never enters the calling context.
 *
 * Usage: bun collect-evidence.ts [--hermit-dir DIR] [--out FILE]
 * --hermit-dir is the state folder holding tasks/ (default: <repo>/.hermit).
 * A checkout whose .hermit is a projection has no tasks/, so pass the real one.
 * Proposals are task records with kind: proposal. Legacy ids survive as the
 * dedupe key proposal:PROP-NNN; newer ones are identified by their T- id.
 *
 * Prints: OK|<out-path>|<open-count>|<bullet-count>|<commit-count>|<cutoff>|<task-count>
 *         NONE|no-open-proposals
 * A missing tasks/ folder, or legacy proposals/*.md not yet imported by
 * `proposal.ts migrate`, is an error: message on stderr, exit 1.
 */

import { basename, join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readTaskInventory } from '../../../../plugins/hermitd/scripts/lib/tasks';
import { readTaskReports } from '../../../../plugins/hermitd/scripts/lib/task-report';

const OPEN_STATUSES = new Set(['proposed', 'accepted']);
const EXCERPT_CHARS = 700;
const BULLET_CHARS = 500;

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const repoRoot = execSync('git rev-parse --show-toplevel').toString().trim();
const hermitDir = resolve(arg('--hermit-dir', join(repoRoot, '.hermit')));
const outPath = arg(
  '--out',
  join(tmpdir(), `stale-proposals-evidence-${process.pid}.md`),
);

type Proposal = {
  id: string;
  task: string;
  title: string;
  status: string;
  created: string;
  category: string;
  tags: string;
  excerpt: string;
};

/** Prefer the Problem section because it states what a shipped changelog entry
 * should answer. Fall back through Proposed Solution and Context. */
function excerpt(body: string): string {
  for (const heading of ['## Problem', '## Proposed Solution', '## Context']) {
    const i = body.indexOf(heading);
    if (i === -1) continue;
    const section = body.slice(i + heading.length).split(/\n## /)[0];
    const prose = section.replace(/\s+/g, ' ').trim();
    if (prose.length > 40) return prose.slice(0, EXCERPT_CHARS);
  }
  return body.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS);
}

if (!existsSync(join(hermitDir, 'tasks'))) {
  console.error(
    `no tasks folder at ${join(hermitDir, 'tasks')}; pass --hermit-dir <state dir> (this checkout's .hermit may be a projection)`,
  );
  process.exit(1);
}
const legacyDir = join(hermitDir, 'proposals');
if (existsSync(legacyDir) && readdirSync(legacyDir).some((name) => name.endsWith('.md'))) {
  console.error(
    `unmigrated proposal files in ${legacyDir}; run: bun plugins/hermitd/scripts/proposal.ts migrate ${hermitDir}`,
  );
  process.exit(1);
}

const inventory = readTaskInventory(hermitDir);
if (!inventory.ok) {
  console.error(`task inventory unreadable at ${hermitDir}`);
  process.exit(1);
}

const open: Proposal[] = [];
for (const task of inventory.records.sort((x, y) => x.created.localeCompare(y.created))) {
  if (task.kind !== 'proposal' || task.status !== 'open') continue;
  const legacy = task.dedupe_key?.match(/^proposal:(PROP-\d+)$/)?.[1];
  open.push({
    id: legacy ?? task.id,
    task: task.id,
    title: task.title || '(untitled)',
    status: task.approved_rev === null ? 'proposed' : 'accepted',
    created: task.created.slice(0, 10),
    category: task.category || '',
    tags: Array.isArray(task.tags) ? task.tags.filter((tag) => tag !== 'task').join(',') : String(task.tags ?? ''),
    excerpt: excerpt(task.body),
  });
}

if (open.length === 0) {
  console.log('NONE|no-open-proposals');
  process.exit(0);
}

const cutoff = open
  .map((proposal) => proposal.created)
  .filter(Boolean)
  .sort()[0];

// task-report.ts owns the task file format and exposes closed_reason. A record
// titled or closed with a PROP id is often the clearest sign it shipped.
const taskRows = readTaskReports(hermitDir).filter(
  (task) =>
    task.closed_at &&
    task.closed_at.slice(0, 10) >= cutoff &&
    /PROP-\d+/.test(`${task.title} ${task.closed_reason ?? ''}`),
);

type Entry = {
  plugin: string;
  version: string;
  date: string;
  bullets: string[];
};

const entries: Entry[] = [];
for (const dir of readdirSync(join(repoRoot, 'plugins')).sort()) {
  const path = join(repoRoot, 'plugins', dir, 'CHANGELOG.md');
  if (!existsSync(path)) continue;

  let current: Entry | null = null;
  let kind = '';
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const header = line.match(
      /^## \[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?/,
    );
    if (header) {
      const [, version, date] = header;
      const unreleased = version.toLowerCase() === 'unreleased';
      current =
        unreleased || (date && date >= cutoff)
          ? { plugin: dir, version, date: date || 'unreleased', bullets: [] }
          : null;
      if (current) entries.push(current);
      kind = '';
      continue;
    }

    const subheading = line.match(/^### (.+)/);
    if (subheading) {
      kind = subheading[1].trim();
      continue;
    }

    if (!current || kind.startsWith('Upgrade')) continue;
    if (line.startsWith('- ')) {
      current.bullets.push(
        `(${kind}) ${line.slice(2).trim()}`.slice(0, BULLET_CHARS),
      );
    }
  }
}

const commits = execSync(
  `git log --first-parent --since=${cutoff} --pretty=%cs%x09%s`,
  { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 },
)
  .toString()
  .trim()
  .split('\n')
  .filter(Boolean);

const today = new Date().toISOString().slice(0, 10);
const lines: string[] = [
  '# Stale-proposal evidence bundle',
  '',
  `Generated ${today}. Evidence floor: ${cutoff} (oldest open proposal).`,
  '',
  `## Open proposals (${open.length})`,
  '',
];

for (const proposal of open) {
  const age = Math.round(
    (Date.parse(today) - Date.parse(proposal.created || today)) / 86_400_000,
  );
  lines.push(
    `### ${proposal.id} — ${proposal.title}`,
    `task: ${proposal.task} | status: ${proposal.status} | created: ${proposal.created} | age: ${age}d | category: ${proposal.category} | tags: ${proposal.tags}`,
    '',
    proposal.excerpt,
    '',
  );
}

const bulletCount = entries.reduce(
  (count, entry) => count + entry.bullets.length,
  0,
);
lines.push(`## Shipped changelog entries (${bulletCount} bullets)`, '');
for (const entry of entries) {
  if (entry.bullets.length === 0) continue;
  lines.push(`### ${entry.plugin} ${entry.version} — ${entry.date}`);
  lines.push(...entry.bullets.map((bullet) => `- ${bullet}`), '');
}

lines.push(`## Closed task records naming a PROP (${taskRows.length})`, '');
for (const task of taskRows) {
  const note = (task.closed_reason ?? '').replace(/\s+/g, ' ').slice(0, BULLET_CHARS);
  lines.push(
    `- ${basename(task.source_path, '.md')} | ${task.outcome} | closed ${task.closed_at!.slice(0, 10)} | ${task.title} | closed_reason: ${note}`,
  );
}
lines.push('');

lines.push(`## First-parent history since ${cutoff} (${commits.length})`, '');
lines.push(...commits.map((commit) => `- ${commit.replace(/\t/, ' | ')}`));

writeFileSync(outPath, lines.join('\n'));
console.log(
  `OK|${outPath}|${open.length}|${bulletCount}|${commits.length}|${cutoff}|${taskRows.length}`,
);
