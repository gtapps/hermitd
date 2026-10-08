// Structural invariants for SKILL.md files in hermitd-fitness.
// Run with: bun tests/skill-structure.test.ts
// The shared checks live in tests/lib/skill-lint.ts; this file holds the
// expectations and the fitness-only CLAUDE-APPEND trim guard.

import fs from 'node:fs';
import path from 'node:path';
import { makeReporter, lintSkills } from '../../../tests/lib/skill-lint';

const PLUGIN_ROOT = path.join(import.meta.dir, '..');

// Per-skill expectations. Update if a skill's gate count changes.
// gates: 0 → skill has no Gate N — section structure (e.g., read-only status skills).
const SKILLS = [
  { name: 'activity-deep-dive', gates: 0 },
  { name: 'capture-activity-rpe', gates: 0 },
  { name: 'domain-brainstorm', gates: 5 }, // Gate 0..4
  { name: 'fitness-brief', gates: 0 },
  { name: 'hatch', gates: 0 },
  { name: 'set-rpe', gates: 0 },
  { name: 'weekly-load-review', gates: 0 },
  { name: 'monday-planning', gates: 0 },
  { name: 'weekly-coaching-patterns', gates: 0 },
];

const { ok, summary } = makeReporter();

console.log('\nskill structure:');
const lintFailures = lintSkills(PLUGIN_ROOT, SKILLS);
ok(`${SKILLS.length} skills pass structural lint`, lintFailures.length === 0, lintFailures.join('; '));

// CLAUDE-APPEND token-efficiency trim guard.
// The block is re-paid on every session load and subagent dispatch; the skills
// and Strava-tool catalogs were removed in favor of self-advertise pointers
// (the descriptions and MCP schemas already carry that content). Keep them out.
console.log('\nstate-templates/CLAUDE-APPEND.md:');
const appendPath = path.join(import.meta.dir, '..', 'state-templates', 'CLAUDE-APPEND.md');
ok('CLAUDE-APPEND exists', fs.existsSync(appendPath), appendPath);
if (fs.existsSync(appendPath)) {
  const append = fs.readFileSync(appendPath, 'utf-8');
  ok('no Skill catalog table', !/^\|\s*Skill\s*\|/m.test(append));
  ok('no Tool catalog table', !/^\|\s*Tool\s*\|/m.test(append));
  ok('no Agent catalog table', !/^\|\s*Agent\s*\|/m.test(append));
  // The context-engineering pass then dropped the routine/check tables and the
  // five-file state map (docs/knowledge-schema.md owns it), landing at ~2,881 B.
  ok('under post-trim ceiling (~2881 B)', Buffer.byteLength(append, 'utf-8') <= 3200, `${Buffer.byteLength(append, 'utf-8')} B`);
  ok('points at the schema for state wiring', append.includes('`knowledge-schema.md` doc'));

  // The state contracts the APPEND stopped enumerating must exist where it points.
  const schemaPath = path.join(import.meta.dir, '..', 'docs', 'knowledge-schema.md');
  const schema = fs.existsSync(schemaPath) ? fs.readFileSync(schemaPath, 'utf-8') : '';
  for (const contract of [
    'strava-last-activity-id.txt',
    'strava-weekly-baselines.json',
    'activity-notes.json',
    'strava-pending-rpe.json',
  ]) {
    ok(`schema documents ${contract}`, schema.includes(contract));
  }

  // Distributed half of the single-owner guard for the push-format constant:
  // core's CLAUDE-APPEND states ≤200 chars; this runs when fitness files change.
  const brief = fs.readFileSync(path.join(import.meta.dir, '..', 'skills', 'fitness-brief', 'SKILL.md'), 'utf-8');
  ok('fitness-brief defers to the core push-format owner',
    !/≤\s*200\s*chars/.test(brief) && brief.includes('Operator Notification push format'));
}

const gatePath = path.join(PLUGIN_ROOT, 'state-templates/bin/fitness-weekly-patterns-gate');
ok('weekly patterns gate template exists', fs.existsSync(gatePath));
const hatch = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/hatch/SKILL.md'), 'utf-8');
ok('hatch installs weekly patterns gate', hatch.includes('install -m 755') && hatch.includes('state-templates/bin/fitness-weekly-patterns-gate'));

const routineEntries = [...hatch.matchAll(/\{\n  "id": "([^"]+)",[\s\S]*?\n\}/g)]
  .map(([block]) => JSON.parse(block));
for (const [id, skill] of [
  ['morning-brief', 'hermitd-fitness:fitness-brief --morning'],
  ['evening-brief', 'hermitd-fitness:fitness-brief --evening'],
  ['weekly-load-review', 'hermitd-fitness:weekly-load-review'],
  ['monday-planning', 'hermitd-fitness:monday-planning'],
]) {
  ok(`${id} invokes its domain skill`, routineEntries.find((entry) => entry.id === id)?.skill === skill);
}

process.exit(summary() === 0 ? 0 : 1);
