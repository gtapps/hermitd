// Structural lint for the /ha-morning-brief skill markdown.

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SKILL = join(resolve(import.meta.dir, '..'), 'skills', 'ha-morning-brief', 'SKILL.md');

test('pending tasks come only from the live task list', () => {
  expect(readFileSync(SKILL, 'utf8')).toContain('Pending tasks come only from that list, never from an earlier brief');
});
