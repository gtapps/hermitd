// Structural invariants for SKILL.md files in hermitd-laravel-forge.
// Run with: bun test tests/skill-structure.test.ts

import fs from 'node:fs';
import path from 'node:path';
import { makeReporter, lintSkills } from '../../../tests/lib/skill-lint';

const PLUGIN_ROOT = path.join(import.meta.dir, '..');

const SKILLS = [
  { name: 'hatch', gates: 0 },
  { name: 'forge-servers', gates: 0 },
  { name: 'forge-sites', gates: 0 },
  { name: 'forge-deploy', gates: 0 },
  { name: 'forge-logs', gates: 0 },
  { name: 'forge-failed-deploys', gates: 0 },
];

const { ok, summary } = makeReporter();

console.log('\nskill structure:');
const lintFailures = lintSkills(PLUGIN_ROOT, SKILLS);
ok(`${SKILLS.length} skills pass structural lint`, lintFailures.length === 0, lintFailures.join('; '));

// The shared domain-hatch protocol is asserted by the repo-root cross-plugin
// contract test; the PHP floor is the one hatch invariant that stays
// forge-specific (the contract test deliberately scopes its no-version-floor
// rule to the CORE floor, so this hatch may state its own PHP requirement).
// The floor itself is read from php/composer.json — the manifest that actually
// enforces it — so the prose can't drift when the constraint bumps. hatch's
// existence is already asserted by the SKILLS loop above; a missing file here
// should throw, not silently skip.
console.log('\nhatch/SKILL.md forge-specific floor:');
const hatchText = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'hatch', 'SKILL.md'), 'utf-8');
const composerJson = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, '..', 'php', 'composer.json'), 'utf-8'),
);
const phpFloor = (composerJson.require.php as string).replace(/^[<>=^~]+/, '');
ok(`still states its own PHP floor (${phpFloor}, from composer.json)`,
  new RegExp(`PHP ${phpFloor.replace(/\./g, '\\.')}\\+? is required`).test(hatchText));

// CLAUDE-APPEND token-efficiency guard. The block is re-paid on every session
// load and every subagent dispatch, so the size ceiling keeps the trim from
// creeping back, and the safety rules it was not allowed to touch must stay.
console.log('\nstate-templates/CLAUDE-APPEND.md:');
const appendPath = path.join(import.meta.dir, '..', 'state-templates', 'CLAUDE-APPEND.md');
ok('CLAUDE-APPEND exists', fs.existsSync(appendPath), appendPath);
if (fs.existsSync(appendPath)) {
  const append = fs.readFileSync(appendPath, 'utf-8');
  // Pre-trim 2,993 B → ~2,265 B.
  ok('under post-trim ceiling (~2265 B)', Buffer.byteLength(append, 'utf-8') <= 2600, `${Buffer.byteLength(append, 'utf-8')} B`);

  ok('keeps the deploy and reboot previews', append.includes('preview-deploy <server> <site>') && append.includes('preview-reboot'));
  ok('relays the target before execution', append.includes('relay the canonical target to the operator, then run the write command for native approval'));
  ok('keeps the outage consequence', append.includes('A wrong reboot causes an outage'));
  // Replaced the closed-allowlist assertion: reads no longer use an allowlist,
  // so asserting it would keep the template documenting a guarantee the code
  // does not make. The plan hash is the guarantee that took its place.
  ok('keeps the plan-bound write fact', append.includes('hash-checked plan'));
  ok('keeps secret hygiene', append.includes('[REDACTED]'));
}

process.exit(summary() === 0 ? 0 : 1);
