// Operator-facing surfaces must not name a plugin-root doc by a bare path.
//
// CLAUDE-APPEND blocks are cat'd verbatim into a downstream operator's
// CLAUDE.md, and SessionStart injections are emitted into operator context —
// both read from the operator's project cwd, where a bare `docs/foo.md`
// resolves to `<operator-project>/docs/foo.md` and does not exist (the docs
// live only under the plugin root). This guard fails on any such bare ref so
// the class of bug can't creep back in. Allowed forms all resolve:
//   ${CLAUDE_PLUGIN_ROOT}/docs/...   (skill-execution context, installed mode)
//   https://.../docs/...             (absolute URL)
//   ../../docs/...                    (markdown relative link)
//
// Usage: bun test tests/operator-doc-refs.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT, MONOREPO_ROOT, walkFiles } from './helpers/run';

// A bare doc ref: `docs/<name>.md` NOT preceded by `/` (URL or ${...}/docs or
// ../docs), `.` (relative), a word char, `:`, or `}`. The name class allows
// upper/lower/digits/-/_ so uppercase doc names (docs/GIT-SAFETY.md) are caught
// too. Global so we can report every hit, not just the first.
const BARE_DOCS = /(?<![./\w:}])docs\/[A-Za-z0-9_-]+\.md/g;

function bareRefs(text: string): string[] {
  return [...text.matchAll(BARE_DOCS)].map(m => m[0]);
}

// Walk plugins/*/state-templates for *.md and *.template — the surfaces cat'd
// or rendered into the operator's project (CLAUDE.md blocks, docker compose).
// Siblings are guaranteed present in the monorepo.
function stateTemplateSurfaces(): string[] {
  const out: string[] = [];
  const pluginsDir = path.join(MONOREPO_ROOT, 'plugins');
  for (const plugin of fs.readdirSync(pluginsDir)) {
    out.push(...walkFiles(
      path.join(pluginsDir, plugin, 'state-templates'),
      name => name.endsWith('.md') || name.endsWith('.template'),
    ));
  }
  return out;
}

describe('operator surfaces have no bare docs/ refs', () => {
  test('state templates name no bare docs/ ref', () => {
    // Each offender is reported as `<path>: <ref>`.
    const offenders = stateTemplateSurfaces().flatMap(file =>
      bareRefs(fs.readFileSync(file, 'utf8')).map(ref => `${path.relative(MONOREPO_ROOT, file)}: ${ref}`));
    expect(offenders).toEqual([]);
  });

  // Scripts that print doc pointers to the operator's terminal from their
  // project cwd, where a bare `docs/foo.md` dangles. Listed explicitly (not a
  // blanket scripts/ walk) so code-comment refs in helper libs don't trip the
  // guard — only strings the operator actually sees are in scope.
  test('operator-facing scripts emit no bare docs/ ref', () => {
    const offenders = ['startup-context.ts', 'hermitd-start.ts'].flatMap(script =>
      bareRefs(fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', script), 'utf8')).map(ref => `scripts/${script}: ${ref}`));
    expect(offenders).toEqual([]);
  });
});
