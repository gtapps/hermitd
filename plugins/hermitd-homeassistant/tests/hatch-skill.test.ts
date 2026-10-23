// Structural lint for the /hatch skill, HA-specific checks only. The shared
// domain-hatch protocol (verbs, stamping, markers, no restated core rules) is
// asserted for every domain plugin by the repo-root cross-plugin contract test
// (tests/cross-plugin/domain-hatch.contract.test.ts) — nothing here may
// duplicate it. Grep-level checks against the skill markdown. No runtime skill
// execution.

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PLUGIN_ROOT = resolve(import.meta.dir, '..');
const skillText = readFileSync(join(PLUGIN_ROOT, 'skills', 'hatch', 'SKILL.md'), 'utf8');

// --- Knowledge-schema extension (Step 6.6) ---

test('knowledge-schema extension declares every HA type', () => {
  expect(skillText).toContain('Knowledge-schema extension');
  // The sentinel must appear as the actual typed bullet in the appended block,
  // not just as a backtick-quoted example in the prose description.
  expect(skillText).toContain('- analysis: HA pattern analysis');
  const types = ['context', 'brief', 'presence-report', 'domain-brainstorm', 'audit', 'simulation', 'apply', 'remove'];
  for (const type of types) {
    expect(skillText).toContain(`- ${type}:`);
  }
});

// --- MCP entry (§4 Step B) ---

test('hatch writes the MCP entry via the CLI, never by reading .env', () => {
  expect(skillText).toContain('ha-agent-lab boot mcp-config');
  expect(skillText).not.toMatch(/\*\*Read\*\* tool on `\.env`/);
  expect(skillText).not.toContain('HOMEASSISTANT_TOKEN=...');
});

test('house routines match full skills and coexist with core briefs', () => {
  expect(skillText).toContain('full skill string, including arguments');
  expect(skillText).toContain('Never replace or disable core routines');
  expect(skillText).not.toContain('boot_skill');
  expect(skillText).not.toContain('unified mode');
  for (const id of ['daily-ha-context', 'morning-brief', 'evening-brief', 'ha-patterns', 'ha-safety-audit', 'ha-integration-health', 'ha-update-check']) {
    expect(skillText).toContain(`"id": "hermitd-homeassistant:${id}"`);
  }
});
