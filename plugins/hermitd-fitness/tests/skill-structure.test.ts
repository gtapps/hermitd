// Structural invariants for SKILL.md files in hermitd-fitness.
// Run with: bun tests/skill-structure.test.ts
// The shared checks live in tests/lib/skill-lint.ts; this file holds the
// expectations for fitness workflows.

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

const brief = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/fitness-brief/SKILL.md'), 'utf-8');
const cruncher = fs.readFileSync(path.join(PLUGIN_ROOT, 'agents/strava-data-cruncher.md'), 'utf-8');
const deepDive = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/activity-deep-dive/SKILL.md'), 'utf-8');
ok('keeps connection-first', brief.includes('check-strava-connection'));
ok('keeps the secrets rule', brief.includes('Never include Strava tokens, credentials'));
ok('keeps the zones rule', cruncher.includes('get-athlete-zones'));
ok('keeps the fitness-lab mediation boundary', deepDive.includes('fitness-lab.ts'));

const schema = fs.readFileSync(path.join(PLUGIN_ROOT, 'docs/knowledge-schema.md'), 'utf-8');
for (const contract of [
  'strava-last-activity-id.txt',
  'strava-weekly-baselines.json',
  'activity-notes.json',
  'strava-pending-rpe.json',
]) {
  ok(`schema documents ${contract}`, schema.includes(contract));
}
ok('fitness-brief defers to the core push-format owner',
  !/≤\s*200\s*chars/.test(brief) && brief.includes('Operator Notification push format'));

const gatePath = path.join(PLUGIN_ROOT, 'state-templates/bin/fitness-weekly-patterns-gate');
ok('weekly patterns gate template exists', fs.existsSync(gatePath));
const hatch = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/hatch/SKILL.md'), 'utf-8');
ok('hatch installs weekly patterns gate', hatch.includes('install -m 755') && hatch.includes('state-templates/bin/fitness-weekly-patterns-gate'));
ok('hatch checks and writes Strava credentials via fitness-lab, never by reading .env',
  hatch.includes('fitness-lab.ts env-check') && hatch.includes('fitness-lab.ts mcp-config') &&
  !hatch.includes('Use the **Read tool** to read `.env`') && !hatch.includes('held in working context'));

ok('hatch matches complete skill strings without overwriting existing rows', hatch.includes('full skill string, including arguments') && hatch.includes('preserve every field'));

const routineEntries = [...hatch.matchAll(/\{\n  "id": "([^"]+)",[\s\S]*?\n\}/g)]
  .map(([block]) => JSON.parse(block));
for (const [id, skill] of [
  ['hermitd-fitness:morning-brief', 'hermitd-fitness:fitness-brief --morning'],
  ['hermitd-fitness:evening-brief', 'hermitd-fitness:fitness-brief --evening'],
  ['hermitd-fitness:weekly-load-review', 'hermitd-fitness:weekly-load-review'],
  ['hermitd-fitness:monday-planning', 'hermitd-fitness:monday-planning'],
]) {
  ok(`${id} invokes its domain skill`, routineEntries.find((entry) => entry.id === id)?.skill === skill);
}

process.exit(summary() === 0 ? 0 : 1);
