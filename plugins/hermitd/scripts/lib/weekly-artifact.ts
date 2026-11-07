// Weekly-review artifact source: finds the latest compiled/review-weekly-*.md and
// strips its YAML frontmatter (rendered raw it's an ugly wall of metrics; every
// field is already legible in the report body's evolution block and the
// dashboard's weekly section). The Artifact tool renders .md directly — no HTML
// renderer needed for this page, so unlike lib/dashboard.ts and
//
// Driven by `artifact.ts render weekly`. Throws on no-source/unreadable; the
// caller turns that into the shared exit-1 path.

import path from 'node:path';
import { readFileWithFrontmatter, globDir } from './frontmatter';
import { sha256 } from './hash';

export function renderWeeklyArtifact(hermitDir: string): { content: string; hash: string } {
  const compiledDir = path.join(hermitDir, 'compiled');
  const files = globDir(compiledDir, /^review-weekly-.*\.md$/); // YYYY-Wnn sorts chronologically by name
  if (files.length === 0) throw new Error('no compiled/review-weekly-*.md found');
  const latest = readFileWithFrontmatter(files[files.length - 1]);
  if (!latest) throw new Error('latest weekly review file unreadable');
  return { content: latest.body, hash: sha256(latest.body) };
}
