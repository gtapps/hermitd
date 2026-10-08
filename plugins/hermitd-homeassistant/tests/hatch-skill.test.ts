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
  const types = ['context', 'brief', 'presence-report', 'audit', 'simulation', 'apply', 'remove'];
  for (const type of types) {
    expect(skillText).toContain(`- ${type}:`);
  }
});
