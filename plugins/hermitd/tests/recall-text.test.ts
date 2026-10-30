import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

test('recall distinguishes evidence, inference and search limits', () => {
  const text = fs.readFileSync(path.resolve(import.meta.dir, '../skills/recall/SKILL.md'), 'utf8');
  for (const phrase of ['list the searches you ran', 'does not say', 'shows what changed, not why',
    'sources actually searched', 'no change was recorded', '.hermit/tasks/', 'A snippet is an excerpt']) {
    expect(text).toContain(phrase);
  }
  expect(text).not.toContain('An empty ledger means nothing has changed');
});
