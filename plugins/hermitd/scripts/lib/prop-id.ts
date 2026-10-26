// lib/prop-id.ts — proposal ID assignment (number + slug + timestamp). The pieces
// here are un-claimed: proposal.ts's create verb combines them and then claims the
// ID atomically with the file write (exclusive create, looping SUFFIX_LETTERS on
// EEXIST), so no caller can burn an ID without producing the file it names.

import fs from 'node:fs';
import path from 'node:path';
import { nowHHMMSS } from './time';
import { readSettledConfig } from './config-read';

export function nextNumber(proposalsDir: string): string {
  let files: string[] = [];
  try { files = fs.readdirSync(proposalsDir); } catch { files = []; }
  let max = 0;
  for (const f of files) {
    const m = f.match(/^PROP-(\d+)/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return String(max + 1).padStart(3, '0');
}

const STOPWORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'by', 'from', 'as', 'is', 'are']);

export function slugify(title: string): string {
  // a. drop non-ASCII, lowercase
  const ascii = title.replace(/[^\x00-\x7F]/g, '').toLowerCase();
  // b. runs of non-[a-z0-9] -> single space
  const spaced = ascii.replace(/[^a-z0-9]+/g, ' ').trim();
  const allTokens = spaced.split(/\s+/).filter(Boolean);
  // c-d. drop stopwords; fall back to the pre-filter token list if that empties it
  const filtered = allTokens.filter(t => !STOPWORDS.has(t));
  const tokens = filtered.length > 0 ? filtered : allTokens;
  // e. first 5 tokens, join, truncate to 40 chars at a word boundary
  let slug = tokens.slice(0, 5).join('-');
  if (slug.length > 40) {
    const parts = slug.split('-');
    while (parts.length > 1 && parts.join('-').length > 40) parts.pop();
    slug = parts.join('-');
    if (slug.length > 40) slug = slug.slice(0, 40); // single token exceeds 40: hard-cut
  }
  // f. empty slug -> literal fallback; never a double dash
  return slug || 'proposal';
}

// The `PROP-NNN` key metrics rows join on: `created` rows carry the full file id,
// answer rows the bare number.
export function shortProposalId(id: string): string {
  return /^PROP-\d+/i.exec(id)?.[0].toUpperCase() ?? id;
}

export const SUFFIX_LETTERS = 'abcdefghijklmnopqrstuvwxyz';

export interface BaseId {
  num: string;
  slug: string;
  hhmmss: string;
}

// The un-suffixed, un-claimed parts of the next ID — shared by both suffix
// strategies below. `now` is injectable so callers can pin `created` and the
// `HHMMSS` suffix to the same instant (decision 7) and so collision behavior
// is deterministically testable.
export function computeBase(
  stateDir: string,
  title: string,
  now: Date = new Date(),
  timezone: string = readSettledConfig(stateDir).timezone ?? 'UTC',
): BaseId {
  const proposalsDir = path.join(stateDir, 'proposals');
  return {
    num: nextNumber(proposalsDir),
    slug: slugify(title),
    hhmmss: nowHHMMSS(timezone, now),
  };
}

