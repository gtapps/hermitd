// Channel-ask contract test (PROP-017).
//
// Every core skill is reachable from channel-responder's §2 classification
// table (slash-command passthrough alone makes any skill reachable), so a
// channel-tagged turn must never strand on a terminal-shaped ask. A skill
// carrying `disable-model-invocation` (rc-gate) is unreachable from a channel
// and so cannot strand one, but it is still scanned below: the flag is a
// reachability choice that can be reverted, and the scan costs nothing. A skill
// either carries the Step-0 "channel reply" marker (and routes its asks
// through the reply tool / channel-safe ask bridge accordingly), or it must
// contain no AskUserQuestion call and no interactive "Ask" line (both the
// colon form `Ask:` and the imperative prose form `Ask the operator …`).
//
// Fails the build the moment a new skill adds an ask (in any of those spellings)
// without also adding the Step-0 marker — the drift guard this proposal's item 5
// asks for. Coverage note: this is a static string/regex scan, so an ask phrased
// without a leading `Ask` token or the literal `AskUserQuestion` (e.g. "prompt the
// operator …") would slip through; it also asserts only that the marker is
// present, not that every ask is wired through the bridge. A sentence forbidding
// the tool ("Never call AskUserQuestion") is stripped before the scan, so only a
// prohibition spelled in those verbs is recognised as one.
//
// Usage: bun test tests/channel-ask-contract.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const SKILLS_DIR = path.join(PLUGIN_ROOT, 'skills');
const STEP0_MARKER = 'Step 0 — Channel reply';
const CHANNEL_TAG_FRAGMENT = '<channel source="';
// Matches a line-leading ask in either the colon form (`Ask:`) or the imperative
// prose form (`Ask what to add`, `Ask the operator …`). The `(?::|\s)` after `Ask`
// keeps `Asking`/`Asks` from matching.
const UNGUARDED_ASK_RE = /^\s*(?:\d+\.\s*|[a-z]\d*\.\s*|-\s*)?Ask(?::|\s)/m;
// A skill that forbids the tool is strengthening this contract, not breaking
// it, so prohibitions are stripped before the call scan below. Without this a
// sentence like "Never call AskUserQuestion" reads as an unguarded ask.
const PROHIBITION_RE = /\b(?:Never|Do not|Don't)\s+(?:call|use|invoke)\s+AskUserQuestion\b/g;

// Skills exempt from the "must bridge or have no ask" rule, with the reason
// each is exempt spelled out — this list is a deliberate exception, not a
// default, and every entry is re-verified below to still exist.
const TERMINAL_ONLY: Record<string, string> = {
  hatch: 'first-run setup wizard; channels do not exist yet when this runs',
  'channel-setup': 'configures channels; runs before any channel is usable',
  'docker-setup': 'one-time container scaffolding wizard, terminal by nature',
  'docker-security': 'one-time container hardening wizard, terminal by nature',
  'hermit-evolve': 'plugin upgrade wizard, run interactively by the maintainer',
  'channel-responder': 'owns the reply protocol itself (see its own §0 / §6)',

};

function listSkillNames(): string[] {
  return fs
    .readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(SKILLS_DIR, name, 'SKILL.md')));
}

const skillNames = listSkillNames();
const skillContent = new Map(
  skillNames.map((name) => [name, fs.readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf-8')]),
);

describe('channel-ask contract', () => {
  test('every channel-reachable skill with an ask carries the Step-0 marker', () => {
    const unguarded = skillNames.filter((name) => {
      if (name in TERMINAL_ONLY) return false;
      const content = skillContent.get(name)!;
      const hasAskUserQuestion = content.replace(PROHIBITION_RE, '').includes('AskUserQuestion');
      const hasUnguardedAskLine = UNGUARDED_ASK_RE.test(content);
      return (hasAskUserQuestion || hasUnguardedAskLine) && !content.includes(STEP0_MARKER);
    });
    expect(unguarded).toEqual([]);
  });

  test('every Step-0 marker names the <channel source="..."> tag test', () => {
    const missingTag = skillNames.filter((name) => {
      const content = skillContent.get(name)!;
      return content.includes(STEP0_MARKER) && !content.includes(CHANNEL_TAG_FRAGMENT);
    });
    expect(missingTag).toEqual([]);
  });

  test('every allowlisted terminal-only skill still exists', () => {
    const missing = Object.keys(TERMINAL_ONLY)
      .filter((name) => !fs.existsSync(path.join(SKILLS_DIR, name, 'SKILL.md')));
    expect(missing).toEqual([]);
  });
});

// Suggestion cards (PROP audit §8 item 2): a static drift guard for the
// three markers a channel-facing proposal flow depends on. Same caveat as
// above — proves the text is present, not that the model obeys it at runtime.
describe('suggestion cards: channel-facing proposal vocabulary stays plain', () => {
  test('proposal-list/SKILL.md carries the Step-0 marker and a Suggestion-cards path', () => {
    const content = skillContent.get('proposal-list')!;
    expect(content).toContain(STEP0_MARKER);
    expect(content).toContain('Suggestion cards');
  });

  test('channel-responder/approvals.md maps YES/LATER/NO replies to accept/defer/dismiss', () => {
    const content = fs.readFileSync(path.join(SKILLS_DIR, 'channel-responder', 'approvals.md'), 'utf8');
    expect(content).toContain('`YES`');
    expect(content).toContain('`LATER`');
    expect(content).toMatch(/`NO`.*dismiss/);
  });

  test('proposal-act/SKILL.md confirms accept/defer/dismiss in plain voice on a channel-tagged turn', () => {
    const content = skillContent.get('proposal-act')! + '\n'
      + fs.readFileSync(path.join(SKILLS_DIR, 'proposal-act', 'branches.md'), 'utf-8');
    expect(content).toContain('Got it — starting on Suggestion #N.');
    expect(content).toContain('Held Suggestion #N for later.');
    expect(content).toContain('Dropped Suggestion #N.');
  });
});
