// proposal-act SKILL.md / branches.md split contract.
//
// Usage: bun test tests/proposal-act-branches.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const SKILL_PATH = path.join(PLUGIN_ROOT, 'skills', 'proposal-act', 'SKILL.md');
const BRANCHES_PATH = path.join(PLUGIN_ROOT, 'skills', 'proposal-act', 'branches.md');

const front = fs.readFileSync(SKILL_PATH, 'utf-8');
const branches = fs.readFileSync(BRANCHES_PATH, 'utf-8');

// SKILL.md is what every invocation pays for and what survives a compaction
// cut; each branch it dispatches to must exist under the name it uses.
describe('proposal-act branches.md dispatch', () => {
  const SECTIONS = [
    'Start implementing now',
    'Queue a task',
    'Channel re-entry (`--answer`)',
  ];

  for (const section of SECTIONS) {
    test(`SKILL.md points at branches.md § ${section} and the section exists`, () => {
      expect(front).toContain(`branches.md § ${section}`);
      expect(branches).toContain(`\n## ${section}\n`);
    });
  }

  test('defer, dismiss and resolve stay inline in SKILL.md', () => {
    for (const flow of ['Defer Flow', 'Dismiss Flow', 'Resolve Flow']) {
      expect(front).toContain(`\n## ${flow}\n`);
      expect(branches).not.toContain(`## ${flow}`);
    }
  });

  test('front page keeps the option labels the micro-proposal queue needs', () => {
    expect(front).toContain('"Start implementing now"');
    expect(front).toContain('"Queue a task"');
    expect(front).toContain("I'll handle it manually");
  });
});
