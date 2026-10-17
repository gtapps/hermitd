// Structural lint for the /ha-morning-brief skill markdown.

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SKILL = join(resolve(import.meta.dir, '..'), 'skills', 'ha-morning-brief', 'SKILL.md');

test('pending tasks come only from the live task list', () => {
  expect(readFileSync(SKILL, 'utf8')).toContain('Pending tasks come only from that list, never from an earlier brief');
});

test('pending work lists proposals whose status is proposed', () => {
  const skill = readFileSync(SKILL, 'utf8');
  expect(skill).toContain('list any `proposed` proposals');
  expect(skill).not.toContain('`pending` proposal');
  expect(skill).toContain('Skip a `[ha-update]` proposal whose id step 8a already appended to an `Updates:` line');
});
