#!/usr/bin/env bun
// archive-raw.ts — moves expired raw artifacts to raw/.archive/
// Zero npm dependencies. Node stdlib only.
// Usage: bun archive-raw.ts <hermit-state-dir>
//   hermit-state-dir: path to .hermit/ in the target project (default: .hermit)
// Output: `{"archived":N,"retained":N,"skipped":[{"file","reason"}],"pinned":N,"purged":N}`.
// Each purged .archive/ entry is also logged on stderr.
//
// Safety: a raw artifact is retained if any compiled/ body references its filename.

import fs from 'node:fs';
import path from 'node:path';
import { readFrontmatter, globDir } from './lib/frontmatter';
import { readSettledConfig } from './lib/config-read';
import { emitJson } from './lib/cli';

const hermitDir = process.argv[2] || '.hermit';
const rawDir = path.join(hermitDir, 'raw');
const archiveDir = path.join(rawDir, '.archive');
const compiledDir = path.join(hermitDir, 'compiled');

// --- Read retention from config ---
let retentionDays = 14;
let archiveRetentionDays: number | null = null;
try {
  const config = readSettledConfig(hermitDir);
  if (config.knowledge) {
    if (typeof config.knowledge.raw_retention_days === 'number') {
      retentionDays = config.knowledge.raw_retention_days;
    }
    const arc = config.knowledge.archive_retention_days;
    // Guard against a hand-edited 0/negative, which would purge the whole archive.
    if (typeof arc === 'number' && arc > 0) archiveRetentionDays = arc;
  }
} catch {}

const cutoffMs = retentionDays * 24 * 60 * 60 * 1000;
const now = Date.now();

// --- Load compiled artifact bodies for reference check ---
// review-weekly-*.md are auto-generated weekly review reports; they list expired raw filenames
// in their Knowledge Health section, which would falsely "pin" those files and prevent
// archiving. Exclude them — only genuine compiled work products count as protective references.
const compiledBodies = new Map<string, string>(); // basename -> body text
for (const fullPath of globDir(compiledDir, /^[^.].*\.md$/)) {
  if (path.basename(fullPath).startsWith('review-weekly-')) continue;
  try {
    compiledBodies.set(path.basename(fullPath), fs.readFileSync(fullPath, 'utf8'));
  } catch {}
}

// --- Scan raw/ ---
const rawFullPaths = globDir(rawDir, /^[^.].*\.(md|json)$/);
if (rawFullPaths.length === 0) {
  if (archiveRetentionDays === null) emitJson({ archived: 0, retained: 0, skipped: [], pinned: 0, purged: 0 });
  // archiveRetentionDays configured: skip moves, fall through to purge.
}

let archived = 0;
let retained = 0;
let pinned = 0;
const skippedFiles: { file: string; reason: string }[] = []; // surfaced by name so operators can fix the root cause

// Ensure .archive/ exists before moving files
fs.mkdirSync(archiveDir, { recursive: true });
for (const filePath of rawFullPaths) {
  const filename = path.basename(filePath);

  // Pin -latest.* aliases — they're overwritten in place, never accumulate
  if (/-latest\.(md|json)$/.test(filename)) {
    pinned++;
    continue;
  }

  // Resolve artifact age: prefer frontmatter `created`, fall back to a YYYY-MM-DD
  // date in the filename (dated .json snapshots carry no frontmatter).
  const fm = readFrontmatter(filePath);
  const m = filename.match(/(\d{4}-\d{2}-\d{2})/);
  const filenameDate = m ? m[1] : null;

  let created: Date | null;
  if (fm && fm.created) {
    created = new Date(fm.created);
    if (isNaN(created.getTime())) {
      created = filenameDate ? new Date(filenameDate) : null;
    }
    if (!created || isNaN(created.getTime())) {
      skippedFiles.push({ file: filename, reason: 'unparseable_created' });
      continue;
    }
  } else {
    created = filenameDate ? new Date(filenameDate) : null;
    if (!created || isNaN(created.getTime())) {
      skippedFiles.push({ file: filename, reason: 'missing_created' });
      continue;
    }
  }

  // Not yet past retention
  if (now - created.getTime() < cutoffMs) {
    retained++;
    continue;
  }

  // Check if any compiled body references this filename
  let referenced = false;
  for (const [, body] of compiledBodies) {
    if (body.includes(filename)) {
      referenced = true;
      break;
    }
  }

  if (referenced) {
    retained++;
    continue;
  }

  // Archive it
  const dest = path.join(archiveDir, filename);
  try {
    fs.renameSync(filePath, dest);
    archived++;
  } catch (err: any) {
    skippedFiles.push({ file: filename, reason: `move_failed:${err.message}` });
  }
}

// --- Purge expired .archive/ entries (only when archive_retention_days is set) ---
let purged = 0;
if (archiveRetentionDays !== null) {
  const archiveCutoffMs = archiveRetentionDays * 24 * 60 * 60 * 1000;
  try {
    for (const filename of fs.readdirSync(archiveDir).filter(f => /^[^.].*\.(md|json)$/.test(f))) {
      if (/-latest\.(md|json)$/.test(filename)) continue;
      const filePath = path.join(archiveDir, filename);
      const fm = readFrontmatter(filePath);
      const m = filename.match(/(\d{4}-\d{2}-\d{2})/);
      const fileDate = m ? new Date(m[1]) : null;
      let created: Date | null = null;
      if (fm?.created) {
        const d = new Date(fm.created);
        created = isNaN(d.getTime()) ? fileDate : d;
      } else {
        created = fileDate;
      }
      if (!created || isNaN(created.getTime())) continue; // can't date → keep
      if (now - created.getTime() >= archiveCutoffMs) {
        try {
          fs.unlinkSync(filePath);
          purged++;
          process.stderr.write(`archive-raw: purged ${filename} (${created.toISOString().slice(0, 10)})\n`);
        } catch (err: any) {
          process.stderr.write(`archive-raw: purge failed ${filename} — ${err.message}\n`);
        }
      }
    }
  } catch { /* .archive/ may not exist yet */ }
}

emitJson({ archived, retained, skipped: skippedFiles, pinned, purged });
