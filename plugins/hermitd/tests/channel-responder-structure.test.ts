// Channel-responder static contract test.
//
// Asserts that the responder skills fit the rendered retention budget, that the
// sibling procedure files channel-responder names exist, and that the approvals
// procedure names the micro-proposal resolver's reply grammar.
//
// Usage: bun test tests/channel-responder-structure.test.ts   (from the plugin root)

import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const SKILL_PATH = path.join(PLUGIN_ROOT, 'skills', 'channel-responder', 'SKILL.md');

const skill = fs.readFileSync(SKILL_PATH, 'utf-8');
const approvals = fs.readFileSync(path.join(path.dirname(SKILL_PATH), 'approvals.md'), 'utf-8');

// ~/.agents/probe-results/cc-skill-truncation-after-compaction-and-reinvoke.md
// records a 20,000-character rendered retention limit; leave room for growth.
// The Commands block costs ~700 rendered chars.
for (const name of ['channel-responder', 'task', 'proposal-act']) {
  test(`${name} fits the rendered retention budget`, () => {
    const text = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', name, 'SKILL.md'), 'utf-8');
    const rendered = text.replaceAll('${CLAUDE_PLUGIN_ROOT}', '/' + 'p'.repeat(99));
    expect(rendered.length).toBeLessThanOrEqual(18_500);
  });
}

test('responder sibling procedure references exist', () => {
  const siblings = [...skill.matchAll(/`([a-z][a-z0-9-]*\.md)`/g)].map(match => match[1]);
  expect(siblings).toContain('reference.md');
  for (const sibling of siblings) {
    expect(fs.existsSync(path.join(path.dirname(SKILL_PATH), sibling))).toBe(true);
  }
});

// Consumer half of the annotations the UserPromptSubmit stages inject
// (pause-keyword.ts, harness-command.ts, conversation.ts).
test('responder branches on every hook annotation the prompt stages emit', () => {
  const annotations = ['[pause] Hermit paused by', '[pause] Hermit resumed by',
    '[harness-command] … requested', '[conversation command: ...]'];
  expect(annotations.filter((a) => !skill.includes(a))).toEqual([]);
});

// Channel-safe approvals: the micro-proposal resolver's reply grammar.
test('resolver accepts numbered and label replies', () => {
  expect(approvals).toContain('match [<MP-id>] --reply');
  expect(approvals).toContain('MATCH|<id>|<yes|no|label>|<tier>|<on_resolve or ->');
  expect(approvals).toContain('AMBIGUOUS|<reason>');
});
