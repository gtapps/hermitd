// Shared helpers for the eval generators and tests/evals-drift.test.ts: paths,
// the live text cases copy (agent bodies, the resident prompt), and the YAML and
// JSON spellings every generated case.yaml uses.

import fs from 'node:fs';
import path from 'node:path';

import { readFileWithFrontmatter } from '../../scripts/lib/frontmatter';
import { buildResidentPrompt } from '../../scripts/lib/resident-prompt';

export const EVALS = path.resolve(import.meta.dir, '..');
export const PLUGIN = path.dirname(EVALS);

export type Grader = Record<string, unknown>;

/** A shipped agent's body, as `append_system_prompt` carries it. */
export function agentBody(name: string): string {
  return readFileWithFrontmatter(path.join(PLUGIN, 'agents', `${name}.md`))!.body.trim();
}

/** The system prompt hermitd-start appends for the resident (resident.md + rules.md). */
export function residentPrompt(): string {
  return buildResidentPrompt('/nonexistent-project').trim();
}

/** Prefix every non-blank line, as YAML block scalars need. */
export function indent(s: string, n = 4): string {
  const pad = ' '.repeat(n);
  return s.split(/(?<=\n)/).map(l => (l.trim() ? pad + l : l)).join('');
}

/** A single-quoted YAML scalar. */
export function yq(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

/**
 * JSON with `, ` and `: ` separators (or `indent`), every non-ASCII character
 * escaped unless `ascii` is false. Fixture data and graders keep this one spelling.
 */
export function json(v: unknown, opts: { ascii?: boolean; indent?: number } = {}): string {
  const enc = (x: unknown): string => {
    if (Array.isArray(x)) return `[${x.map(enc).join(', ')}]`;
    if (x !== null && typeof x === 'object') {
      return `{${Object.entries(x).map(([k, val]) => `${JSON.stringify(k)}: ${enc(val)}`).join(', ')}}`;
    }
    return JSON.stringify(x);
  };
  const s = opts.indent ? JSON.stringify(v, null, opts.indent) : enc(v);
  return opts.ascii === false ? s : s.replace(/[^\x00-\x7f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** A grader as a YAML block mapping; `criteria` becomes a literal block. */
export function graderYaml(g: Grader): string {
  const out = [`  - name: ${g.name}`];
  for (const [k, v] of Object.entries(g)) {
    if (k === 'name') continue;
    if (typeof v === 'number') out.push(`    ${k}: ${v}`);
    else if (k === 'criteria') out.push(`    ${k}: |`, indent(String(v), 6));
    else out.push(`    ${k}: ${yq(String(v))}`);
  }
  return out.join('\n');
}

/** Write a case directory: case.yaml from its lines, plus an executable scaffold.sh when given. */
export function writeCase(dir: string, yaml: string[], scaffold?: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'case.yaml'), yaml.join('\n') + '\n');
  if (scaffold === undefined) return;
  const p = path.join(dir, 'scaffold.sh');
  fs.writeFileSync(p, scaffold);
  fs.chmodSync(p, 0o755);
}

/** The generator's one-line result: the suite and how many cases it now holds. */
export function report(suite: string): void {
  console.log(JSON.stringify({ suite, cases: fs.readdirSync(path.join(EVALS, suite)).length }));
}
