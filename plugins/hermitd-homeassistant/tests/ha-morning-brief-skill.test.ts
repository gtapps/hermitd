// Structural lint for the house-only morning brief boundary.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const skill = readFileSync(join(resolve(import.meta.dir, '..'), 'skills', 'ha-morning-brief', 'SKILL.md'), 'utf8');

test('morning brief uses house inputs and leaves core work to core', () => {
  for (const input of ['GetLiveContext', 'fetch-history --window-days 1', 'ha updates --digest', 'snapshot-ha-context-latest.json']) {
    expect(skill).toContain(input);
  }
  for (const coreRead of ['OPERATOR.md', '.hermit/proposals', 'reflection-state', 'task list', 'proposal micro']) {
    expect(skill).not.toContain(coreRead);
  }
  expect(skill).not.toContain('Awaiting decision:');
  expect(skill).not.toContain("Today's priorities:");
  expect(skill).toContain('neither brief replaces or disables the other');
});
