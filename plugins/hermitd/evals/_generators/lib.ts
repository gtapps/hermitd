// Shared helpers for the eval generators and tests/evals-drift.test.ts: paths,
// the live text cases copy (agent bodies, the resident prompt), and the YAML
// spelling every generated case.yaml uses. Fixture JSON is plain JSON.stringify:
// compact for script stdout, indented where the script writes the file that way.

import fs from 'node:fs';
import path from 'node:path';

import { readFileWithFrontmatter } from '../../scripts/lib/frontmatter';
import { buildResidentPrompt } from '../../scripts/lib/resident-prompt';

export const EVALS = path.resolve(import.meta.dir, '..');
export const PLUGIN = path.dirname(EVALS);

export type Grader = Record<string, unknown>;

/** Synthetic Discord ids the generated cases share: the operator's chat and user. */
export const CHAT = '400000000000000001';
export const USER = '100000000000000001';

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

/** A grader as a YAML block mapping; `criteria` becomes a literal block. */
export function graderYaml(g: Grader): string {
  const out = [`  - name: ${g.name}`];
  for (const [k, v] of Object.entries(g)) {
    if (k === 'name') continue;
    if (typeof v === 'number' || typeof v === 'boolean') out.push(`    ${k}: ${v}`);
    else if (k === 'criteria') out.push(`    ${k}: |`, indent(String(v), 6));
    else out.push(`    ${k}: ${yq(String(v))}`);
  }
  return out.join('\n');
}

/** config.json as config-write.ts writes it. */
export const configJson = (v: object) => JSON.stringify(v, null, 2) + '\n';

/** Bash lines that write each file through a quoted heredoc, in path order. */
export function heredocs(files: Record<string, string>): string[] {
  return Object.keys(files).sort().flatMap(p => [`mkdir -p "${path.dirname(p)}"`, `cat > '${p}' <<'HERMIT_FIXTURE'\n${files[p]}HERMIT_FIXTURE`]);
}

const VERSION_SH = String.raw`ver=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$here/../../../.claude-plugin/plugin.json" | head -1)`;

/**
 * scaffold.sh for a resident install: the live TASKS.md template, `config`, the plugin
 * files named in `copies` (copied at run time), and fixture files.
 */
export function residentScaffold(config: object, fixtures: Record<string, string> = {}, copies: [string, string][] = []): string {
  const files = { 'memory/MEMORY.md': '', ...fixtures };
  const sh = ['#!/usr/bin/env bash', '# Seeds a resident hermit state dir for this case (runs only with --scaffold).', 'set -e',
    'here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"', 'mkdir -p .hermit/tasks .hermit/state',
    'cp "$here/../../../state-templates/TASKS.md.template" .hermit/TASKS.md',
    // Stamp the loaded plugin version so the real SessionStart hook injects no upgrade notice.
    VERSION_SH,
    // Unquoted heredoc, so bash expands $ver.
    'cat > .hermit/config.json <<HERMIT_CONFIG\n' + configJson({ ...config, _hermit_versions: { hermitd: '$ver' } }) + 'HERMIT_CONFIG'];
  for (const [src, dst] of copies) sh.push(`mkdir -p "${path.dirname(dst)}"`, `cp "$here/../../../${src}" "${dst}"`);
  sh.push(...heredocs(files));
  return sh.join('\n') + '\n';
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
