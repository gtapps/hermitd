// Structural lint for the /ha-setup-house skill.
// Grep-level checks against the skill markdown. No runtime skill execution.

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PLUGIN_ROOT = resolve(import.meta.dir, '..');
const skillPath = join(PLUGIN_ROOT, 'skills', 'ha-setup-house', 'SKILL.md');
const skillText = readFileSync(skillPath, 'utf8');

test('has valid frontmatter name', () => {
  expect(skillText).toContain('name: ha-setup-house');
});

test('has description', () => {
  expect(/^description: .+/m.test(skillText)).toBe(true);
});

test('documents native approval and strict denial handling', () => {
  expect(skillText).toContain('native approval');
  expect(skillText).toContain('blocked');
  expect(skillText).not.toContain('--confirm');
  expect(skillText).not.toContain('requires_confirm');
});
