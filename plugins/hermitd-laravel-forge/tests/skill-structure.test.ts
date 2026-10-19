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

const servers = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/forge-servers/SKILL.md'), 'utf-8');
const deploy = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/forge-deploy/SKILL.md'), 'utf-8');
const logs = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/forge-logs/SKILL.md'), 'utf-8');
ok('keeps the deploy and reboot previews', deploy.includes('preview-deploy <server> <site>') && servers.includes('preview-reboot'));
ok('keeps the outage consequence', servers.includes('A wrong reboot causes an outage'));
ok('keeps the plan-bound write fact', servers.includes('execute <plan-id>') && servers.includes('mismatch'));
ok('keeps secret hygiene', logs.includes('[REDACTED]'));

process.exit(summary() === 0 ? 0 : 1);
