import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dir, '..');
test('close-time learning and handoffs retain their core instructions', () => {
  const checks: Record<string, string[]> = {
    'skills/task/SKILL.md': ['skill_review: "pending"', 'learn.md'],
    'skills/task/learn.md': ['## Progress', 'umbrella learned skill', 'references/', 'capability-named', 'hermitd:proposal-create', 'Skill Writing Guide', 'hermitd:skill-eval-runner', 'model: sonnet', 'duplicate_of', 'skills pin <name> --origin operator', 'skills.notify', '--disposition saved|covered|nothing'],
    'skills/task/skill-gate-reference.md': ['draft skill', 'existing skill names and descriptions', 'duplicate_of', 'findings'],
    'agents/task-worker.md': ['<id>.procedure.md', 'inputs, pitfalls', 'requester message, unchanged'],
    'prompts/helper.md': ['Evidence:', 'Procedure:'],
    'prompts/resident.md': ['Procedure:', '[guest:<name>]'],
    'skills/channel-responder/SKILL.md': ['Learned skill control', 'skills pin', 'skills rollback', '§1c authorization'],
    'skills/resident-start/SKILL.md': ['task.ts list .hermit --skill-review pending', '/hermitd:task` § Closure'],
  };
  for (const [file, phrases] of Object.entries(checks)) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const phrase of phrases) expect(text).toContain(phrase);
  }
});
