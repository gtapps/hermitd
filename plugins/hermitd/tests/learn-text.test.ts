import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dir, '..');
test('close-time learning and handoffs retain their core instructions', () => {
  const checks: Record<string, string[]> = {
    'skills/task/SKILL.md': ['`next`', 'learn.md', 'best effort'],
    'skills/task/learn.md': ['main session', 'Always read the closed task record', '## Progress', '## Outcome', '## Lessons', '## Decisions', 'conversation still in context', 'reusable technique or workaround', 'proved wrong or missing a step', 'general correction from the primary operator', '`nothing` is a normal result', 'learned skill in play', 'learned umbrella skill', 'references/', 'class-level skill', 'procedure first', 'one clause of why', 'No dates, PR numbers, quoted chat or incident narrative', 'fix wrong text in place', 'never append a duplicate', 'environment failures', 'negative claims about tools', 'transient errors', 'failures that never resolved', 'learned skills only', 'non-primary sender', 'unclear author does not count', 'is not a skill', 'hermitd:proposal-create', 'never widens authority', 'skills status --skill <name>', 'native Write and Edit only', 'No shell writes', 'allow rules', 'denied write ends', 'skills pin <name> --origin operator', 'skills.notify', '`off` adds nothing', 'only when a skill changed', '`verbose` adds a short change preview'],
    'agents/task-worker.md': ['<id>.procedure.md', 'inputs, pitfalls', 'requester message, unchanged'],
    'prompts/helper.md': ['Evidence:', 'Procedure:'],
    'prompts/resident.md': ['Procedure:', '[guest:<name>]'],
    'skills/channel-responder/SKILL.md': ['Learned skill control', 'skills pin', 'skills rollback', '§1c authorization'],
    'skills/resident-start/SKILL.md': ['task.ts list .hermit --open'],
  };
  for (const [file, phrases] of Object.entries(checks)) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const phrase of phrases) expect(text).toContain(phrase);
  }
});
