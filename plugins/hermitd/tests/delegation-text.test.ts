import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dir, '..');
test('helper and worker dispatch read the delegation defaults', () => {
  const checks: Record<string, string[]> = {
    'skills/spawn-session/SKILL.md': ['`delegation.model` and `delegation.effort`', 'the invocation did not name', '--resume <sessionId>', 'with no other flag'],
    'skills/task/SKILL.md': ['`delegation` that `task.ts open` printed', ".delegation // {}", 'omitting nulls'],
  };
  for (const [file, phrases] of Object.entries(checks)) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const phrase of phrases) expect(text).toContain(phrase);
  }
});
