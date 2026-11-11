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
// channel-responder carries the chat-boundary and sign-in-link rules every reply needs, so its cap is higher.
for (const [name, budget] of [['channel-responder', 19_500], ['task', 18_800], ['proposal-create', 18_500]] as const) {
  test(`${name} fits the rendered retention budget`, () => {
    const text = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', name, 'SKILL.md'), 'utf-8');
    const rendered = text.replaceAll('${CLAUDE_PLUGIN_ROOT}', '/' + 'p'.repeat(99));
    expect(rendered.length).toBeLessThanOrEqual(budget);
  });
}

test('responder sibling procedure references exist', () => {
  const siblings = [...skill.matchAll(/`([a-z][a-z0-9-]*\.md)`/g)].map(match => match[1]);
  expect(siblings).toContain('reference.md');
  for (const sibling of siblings) {
    expect(fs.existsSync(path.join(path.dirname(SKILL_PATH), sibling))).toBe(true);
  }
});

test('task points its rare conversation commands at the branches sibling', () => {
  const dir = path.join(PLUGIN_ROOT, 'skills', 'task');
  const task = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
  const branches = fs.readFileSync(path.join(dir, 'branches.md'), 'utf-8');
  for (const section of ['Conversation command', 'Replace an unreachable worker', 'Standup and duties']) {
    expect(task).toContain(`[branches.md](branches.md) § ${section}`);
    expect(branches).toContain(`## ${section}`);
  }
  // branches.md is read raw, so every command it names must be a SKILL.md Commands entry.
  for (const name of branches.matchAll(/`([a-z-]+)` \(Commands\)/g)) expect(task).toContain(`- \`${name[1]}\`: \`bun `);
});

test('spawn-session names the trust command and untrusted-folder sibling', () => {
  const dir = path.join(PLUGIN_ROOT, 'skills', 'spawn-session');
  const spawn = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const branch = fs.readFileSync(path.join(dir, 'untrusted-folder.md'), 'utf8');
  expect(spawn).toContain('- `trust-workspace`: `bun ');
  expect(spawn).toContain('[untrusted-folder.md](untrusted-folder.md)');
  expect(branch).toContain('`trust-workspace` (Commands)');
});

// Consumer half of the annotations the UserPromptSubmit stages inject
// (pause-keyword.ts, harness-command.ts, conversation.ts).
test('responder branches on every hook annotation the prompt stages emit', () => {
  const annotations = ['[pause] Hermit paused by', '[pause] Hermit resumed by',
    '[harness-command] … requested', '[conversation command: ...]'];
  expect(annotations.filter((a) => !skill.includes(a))).toEqual([]);
});

test('already-done replies target only the preceding explicit records', () => {
  expect(skill).toContain('§ Already-done items');
  expect(approvals).toContain('## Already-done items');
  expect(approvals).toContain('Never guess targets');
  expect(approvals).toContain('reason `already done`');
  expect(approvals).toContain('do not bypass pending consent');
});

test('one answer route accepts tokens, numbers and labels and respects authority', () => {
  expect(skill.slice(0, 20000)).toContain('task answer [<id>] --chat <key> --user <sender-id> --reply <token>');
  expect(approvals).toContain('task answer [<task-id>] --chat <key> --user <sender-id> --reply');
  for (const status of ['match', 'ambiguous', 'refused', 'stale', 'none/no_pending']) expect(approvals).toContain(status);
  expect(approvals).toContain('Input "no" is an answer');
});
