#!/usr/bin/env bun
// knowledge-lint.ts — lint raw/ and compiled/ knowledge directories
// Zero npm dependencies. Node stdlib only.
//
// Usage as CLI:   bun knowledge-lint.ts <hermit-state-dir>
// Usage as lib:   import { lint } from './knowledge-lint' — lint(hermitDir) => { findings, counts }
//
// findings: array of { type, file, age, reason }
//   type: 'unreferenced' | 'stale' | 'missing-type' | 'oversized' | 'working-set' | 'stale-compiled' | 'line-limit' | 'tag-variant' | 'undeclared-type' | 'unused-declaration' | 'topic-missing-updated'
// counts: { raw, compiled, archived }
// options: { verbose: false } — unused-declaration findings only included when verbose=true
//
// The CLI is a display renderer, not a JSON verb: /hermit-health relays its
// grouped report verbatim and branches on no field. Code reads lint() instead.

import fs from 'node:fs';
import path from 'node:path';
import { readFrontmatter, readFileWithFrontmatter, newestByType, globDirRecursive } from './lib/frontmatter';
import { readSettledConfig } from './lib/config-read';

type Json = any;

function parseSchema(schemaPath: string): { workProducts: Set<string>; rawCaptures: Set<string> } | null | false {
  // Returns { workProducts: Set<string>, rawCaptures: Set<string> }, null if present but empty, false if missing.
  // Bullet grammar: lines matching `^-\s+([\w-]+):` or `^-\s+\*\*([\w-]+)\*\*:` under each section heading.
  let text: string;
  try { text = fs.readFileSync(schemaPath, 'utf8'); } catch { return false; }
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  const workProducts = new Set<string>();
  const rawCaptures = new Set<string>();
  let section: string | null = null;
  for (const line of text.split('\n')) {
    if (/^##\s+Work Products\b/.test(line)) { section = 'work'; continue; }
    if (/^##\s+Raw Captures\b/.test(line)) { section = 'raw'; continue; }
    if (/^##/.test(line)) { section = null; continue; }
    const m = line.match(/^-\s+(?:\*\*([\w-]+)\*\*|([\w-]+)):/);
    if (!m) continue;
    const type = m[1] || m[2];
    if (section === 'work') workProducts.add(type);
    if (section === 'raw') rawCaptures.add(type);
  }
  if (workProducts.size === 0 && rawCaptures.size === 0) return null;
  return { workProducts, rawCaptures };
}

function lint(hermitDir: string, options: Json = {}): { findings: Json[]; counts: { raw: number; compiled: number; archived: number }; schemaPresent: boolean } {
  const verbose = !!options.verbose;
  const rawDir = path.join(hermitDir, 'raw');
  const archiveDir = path.join(rawDir, '.archive');
  const compiledDir = path.join(hermitDir, 'compiled');
  const now = Date.now();

  // --- Read config ---
  let retentionDays = 14;
  let compiledBudgetChars = 1000;
  let workingSetWarn = 20;
  try {
    const config = readSettledConfig(hermitDir);
    if (config.knowledge) {
      if (typeof config.knowledge.raw_retention_days === 'number') retentionDays = config.knowledge.raw_retention_days;
      if (typeof config.knowledge.compiled_budget_chars === 'number') compiledBudgetChars = config.knowledge.compiled_budget_chars;
      if (typeof config.knowledge.working_set_warn === 'number') workingSetWarn = config.knowledge.working_set_warn;
    }
  } catch {}

  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  const STALE_COMPILED_DAYS = 60;
  const staleCutoffMs = STALE_COMPILED_DAYS * 24 * 60 * 60 * 1000;
  const LINE_LIMIT = 150;
  const TAG_VARIANTS = ['foundation', 'core', 'important', 'essential', 'permanent'];

  const findings: Json[] = [];

  // --- Schema (parsed once; false=missing, null=present-but-empty, object=usable) ---
  const schemaPath = path.join(hermitDir, 'knowledge-schema.md');
  const schema = parseSchema(schemaPath);

  // --- Load compiled artifacts (shared across checks) ---
  let compiledArtifacts: Json[] = [];
  const compiledBodies = new Map<string, string>(); // filename -> body text
  try {
    const files = fs.readdirSync(compiledDir).filter(f => f.endsWith('.md') && !f.startsWith('.'));
    compiledArtifacts = files.map(f => {
      try {
        const result = readFileWithFrontmatter(path.join(compiledDir, f));
        if (!result || !result.fm) return null;
        const lineCount = result.content.split('\n').length;
        const bodyChars = result.body.length;
        if (!f.startsWith('review-weekly-')) compiledBodies.set(f, result.body);
        return { file: f, fm: result.fm, lineCount, bodyChars };
      } catch { return null; }
    }).filter(Boolean);
  } catch {}

  // --- Raw checks (active files only, not archive) ---
  let rawFiles: Json[] = [];
  try {
    rawFiles = fs.readdirSync(rawDir)
      .filter(f => f.endsWith('.md') && !f.startsWith('.'))
      .map(f => ({ file: f, fm: readFrontmatter(path.join(rawDir, f)) }))
      .filter(r => r.fm);
  } catch {}

  // --- Schema presence check — only when artifacts exist (no-op on empty hermit) ---
  if (rawFiles.length > 0 || compiledArtifacts.length > 0) {
    if (schema === false) {
      findings.push({
        type: 'schema-missing',
        file: 'knowledge-schema.md',
        age: '—',
        reason: 'knowledge-schema.md not found — type declarations not enforced. Run /hatch or create the file.'
      });
    } else if (schema === null) {
      findings.push({
        type: 'schema-empty',
        file: 'knowledge-schema.md',
        age: '—',
        reason: 'knowledge-schema.md has no declared types — add entries under ## Work Products and ## Raw Captures.'
      });
    }
  }

  for (const raw of rawFiles) {
    const filename = raw.file;

    // Check if any compiled/ body references this filename.
    // review-weekly-*.md are excluded from compiledBodies at build time above so they
    // don't mask the very files they report as expired.
    let referenced = false;
    for (const [, body] of compiledBodies) {
      if (body.includes(filename)) { referenced = true; break; }
    }

    if (!referenced) {
      const created = raw.fm.created ? new Date(raw.fm.created) : null;
      const ageMs = created && !isNaN(created.getTime()) ? now - created.getTime() : null;
      const age = ageMs !== null ? Math.floor(ageMs / 86400000) : null;
      const ageStr = age !== null ? `${age}d` : 'unknown';

      if (ageMs !== null && ageMs > retentionMs) {
        // Stale subsumes unreferenced — emit only stale to avoid double-counting
        findings.push({
          type: 'stale',
          file: `raw/${filename}`,
          age: ageStr,
          reason: `Past retention (>${retentionDays}d) and unreferenced.`
        });
      } else {
        findings.push({
          type: 'unreferenced',
          file: `raw/${filename}`,
          age: ageStr,
          reason: 'Possibly unreferenced — no compiled/ body mentions this filename.'
        });
      }
    }

    // Schema: undeclared raw type
    if (schema && raw.fm.type && !schema.rawCaptures.has(raw.fm.type)) {
      findings.push({
        type: 'undeclared-type',
        file: `raw/${filename}`,
        age: '—',
        reason: `Type \`${raw.fm.type}\` not declared in knowledge-schema.md ## Raw Captures.`
      });
    }
  }

  // Schema: unused raw declarations (verbose only)
  if (schema && verbose) {
    const usedRawTypes = new Set<string>(rawFiles.map(r => r.fm.type).filter(Boolean));
    for (const declared of schema.rawCaptures) {
      if (!usedRawTypes.has(declared)) {
        findings.push({
          type: 'unused-declaration',
          file: 'raw/',
          age: '—',
          reason: `Type \`${declared}\` declared in knowledge-schema.md but no raw/ files use it.`
        });
      }
    }
  }

  // --- Compiled checks ---
  if (compiledArtifacts.length > 0) {
    const workingSet: Json[] = Array.from(newestByType(compiledArtifacts).values());

    // Working set size
    if (workingSet.length > workingSetWarn) {
      findings.push({
        type: 'working-set',
        file: 'compiled/',
        age: '—',
        reason: `Working set has ${workingSet.length} active types (warn threshold: ${workingSetWarn}).`
      });
    }

    // Stale compiled (not foundational, older than 60 days by updated ?? created).
    // Topic pages all share one type, so the newestByType working set would only
    // stale-check the most recent one — include every topic page explicitly.
    const staleCandidates: Json[] = [
      ...Array.from(newestByType(compiledArtifacts.filter(a => a.fm.type !== 'topic')).values()),
      ...compiledArtifacts.filter(a => a.fm.type === 'topic'),
    ];
    for (const a of staleCandidates) {
      const lastTouch = (typeof a.fm.updated === 'string' && a.fm.updated) || a.fm.created;
      if (!lastTouch) continue;
      if ((a.fm.tags || []).includes('foundational')) continue;
      const lastTouchMs = new Date(lastTouch).getTime();
      if (now - lastTouchMs > staleCutoffMs) {
        const age = Math.floor((now - lastTouchMs) / 86400000);
        findings.push({
          type: 'stale-compiled',
          file: `compiled/${a.file}`,
          age: `${age}d`,
          reason: `Stale (>${STALE_COMPILED_DAYS}d, not foundational).`
        });
      }
    }

    for (const a of compiledArtifacts) {
      // Missing type
      if (!a.fm.type) {
        findings.push({
          type: 'missing-type',
          file: `compiled/${a.file}`,
          age: '—',
          reason: 'No `type` field in frontmatter — won\'t be grouped at session start.'
        });
      }

      // Topic pages are update-in-place — they must carry an `updated` field
      if (a.fm.type === 'topic' && !a.fm.updated) {
        findings.push({
          type: 'topic-missing-updated',
          file: `compiled/${a.file}`,
          age: '—',
          reason: 'Topic pages are update-in-place — add an `updated` field.'
        });
      }

      // Oversized by char budget (skip if artifact has an injection_stub — body is never injected)
      const stub = typeof a.fm.injection_stub === 'string' ? a.fm.injection_stub.trim() : '';
      if (a.bodyChars > compiledBudgetChars && !stub) {
        findings.push({
          type: 'oversized',
          file: `compiled/${a.file}`,
          age: '—',
          reason: `Body is ${a.bodyChars} chars (budget: ${compiledBudgetChars}). Exceeds the compiled budget — compact or split; foundational bodies are truncated at injection.`
        });
      }

      // Line count violations
      if (a.lineCount > LINE_LIMIT) {
        findings.push({
          type: 'line-limit',
          file: `compiled/${a.file}`,
          age: '—',
          reason: `${a.lineCount} lines (limit: ${LINE_LIMIT}).`
        });
      }

      // Tag variant warnings
      const offenders = (a.fm.tags || []).filter((t: string) => TAG_VARIANTS.includes(t));
      if (offenders.length > 0) {
        findings.push({
          type: 'tag-variant',
          file: `compiled/${a.file}`,
          age: '—',
          reason: `Tag [${offenders.join(', ')}] — did you mean \`foundational\`?`
        });
      }

      // Schema: undeclared compiled type
      if (schema && a.fm.type && !schema.workProducts.has(a.fm.type)) {
        findings.push({
          type: 'undeclared-type',
          file: `compiled/${a.file}`,
          age: '—',
          reason: `Type \`${a.fm.type}\` not declared in knowledge-schema.md ## Work Products.`
        });
      }
    }

    // Schema: unused work-product declarations (verbose only)
    if (schema && verbose) {
      const usedCompiledTypes = new Set<string>(compiledArtifacts.map(a => a.fm.type).filter(Boolean));
      for (const declared of schema.workProducts) {
        if (!usedCompiledTypes.has(declared)) {
          findings.push({
            type: 'unused-declaration',
            file: 'compiled/',
            age: '—',
            reason: `Type \`${declared}\` declared in knowledge-schema.md but no compiled/ files use it.`
          });
        }
      }
    }
  }

  // --- Counts ---
  let archivedCount = 0;
  try {
    archivedCount = globDirRecursive(archiveDir).length
                  + globDirRecursive(path.join(compiledDir, '.archive')).length;
  } catch {}

  return {
    findings,
    counts: {
      raw: rawFiles.length,
      compiled: compiledArtifacts.length,
      archived: archivedCount
    },
    schemaPresent: schema !== false
  };
}

export { lint, parseSchema };

// --- CLI mode ---
if (import.meta.main) {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const hermitDir = args.find(a => !a.startsWith('--')) || '.hermit';
  const { findings, counts, schemaPresent } = lint(hermitDir, { verbose });

  if (findings.length === 0) {
    console.log(`Knowledge base is clean. (${counts.raw} raw, ${counts.compiled} compiled, ${counts.archived} archived)`);
    if (verbose && !schemaPresent) {
      console.log('info: knowledge-schema.md missing — type declarations not enforced');
    }
    process.exit(0);
  }

  // Group by type
  const groups = new Map<string, Json[]>();
  for (const f of findings) {
    if (!groups.has(f.type)) groups.set(f.type, []);
    groups.get(f.type)!.push(f);
  }

  for (const [type, items] of groups) {
    console.log(`\n${type} (${items.length}):`);
    for (const item of items) {
      console.log(`  ${item.file} [${item.age}] — ${item.reason}`);
    }
  }

  // Advice
  console.log('');
  if (groups.has('stale')) console.log('Stale raw files will be archived on next weekly review.');
  if (groups.has('oversized')) console.log('Oversized compiled artifacts exceed the compiled budget — compact or split them.');
  if (groups.has('topic-missing-updated')) console.log('Topic pages are update-in-place — set `updated` whenever you merge new findings.');
  if (groups.has('unreferenced')) console.log('Possibly unreferenced — verify before cleanup.');
  if (groups.has('missing-type')) console.log('Add a `type` field to frontmatter for proper grouping at session start.');
  if (groups.has('undeclared-type')) console.log('Undeclared types — add entries to knowledge-schema.md or remove unused type values.');
  if (groups.has('schema-empty')) console.log('Add type declarations to knowledge-schema.md — Work Products and Raw Captures sections.');
  if (groups.has('schema-missing')) console.log('Create knowledge-schema.md (run /hatch or copy the template).');

  console.log(`\n(${counts.raw} raw, ${counts.compiled} compiled, ${counts.archived} archived)`);
}
