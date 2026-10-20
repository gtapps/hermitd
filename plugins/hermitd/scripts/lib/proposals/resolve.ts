// `proposal.ts resolve-id <stateDir> <operator-input>` — resolves an operator's
// PROP-id input to a proposal filename.
// Output (stdout, one JSON line):
//   {"status":"match","file":"<filename>"}
//   {"status":"ambiguous","matches":[{"file","title"}]}
//   {"status":"none","reason":"not_a_prop_id"|"no_match"}
// Exit 0 always: resolution failures are reported via the verdict, not exit code.
// Implements proposal-act/SKILL.md § Resolving a Proposal ID. Glob matching is
// case-insensitive: step 1 uppercases the whole input (including any slug suffix),
// while real proposal filenames carry a lowercase slug — case-insensitive matching
// is required for the suffix form to ever match a real file.

import fs from 'node:fs';
import path from 'node:path';
import { readFrontmatter } from '../frontmatter';
import { emitJson } from '../cli';

// Anchored glob → regex. Never a bare `PROP-NNN*` — that collides with 4-digit NNN
// filenames (e.g. `PROP-0061.md`) once proposal counts cross 1000.
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

type ResolveVerdict =
  | { status: 'match'; file: string }
  | { status: 'ambiguous'; matches: { file: string; title: string | null }[] }
  | { status: 'none'; reason: 'not_a_prop_id' | 'no_match' };

export function resolveProposalId(stateDir: string, rawInput: string | undefined): ResolveVerdict {
  if (rawInput === undefined) return { status: 'none', reason: 'not_a_prop_id' };

  const input = rawInput.trim().toUpperCase();
  const m = input.match(/^PROP-(\d+)(?:-(.+))?$/);
  if (!m) return { status: 'none', reason: 'not_a_prop_id' };

  const num = m[1].padStart(3, '0');
  const suffix = m[2];

  const proposalsDir = path.join(stateDir, 'proposals');
  let files: string[] = [];
  try {
    files = fs.readdirSync(proposalsDir).filter(f => f.endsWith('.md')).sort();
  } catch {
    return { status: 'none', reason: 'no_match' };
  }

  let matches: string[];
  if (!suffix) {
    const legacy = globToRegExp(`PROP-${num}.md`);
    const newFormat = globToRegExp(`PROP-${num}-*.md`);
    matches = files.filter(f => legacy.test(f) || newFormat.test(f));
  } else {
    const pattern = globToRegExp(`PROP-${num}-*${suffix}*.md`);
    matches = files.filter(f => pattern.test(f));
  }

  if (matches.length === 0) return { status: 'none', reason: 'no_match' };
  if (matches.length === 1) return { status: 'match', file: matches[0] };

  const payload = matches.map(f => ({
    file: f,
    title: readFrontmatter(path.join(proposalsDir, f))?.title ?? null,
  }));
  return { status: 'ambiguous', matches: payload };
}

export function run(stateDir: string, rawInput: string | undefined): never {
  emitJson(resolveProposalId(stateDir, rawInput));
}
