// Guards the token-efficiency trim of the HA CLAUDE-APPEND block.
//
// The block is injected into every hatched operator project's CLAUDE.md and is
// re-paid on every session load and subagent dispatch. The skills/subagents/CLI
// catalogs that used to live here duplicated content already carried by each
// SKILL.md/agent description and by `ha-agent-lab --help`, so they were removed
// in favor of a self-advertise pointer + `ha-agent-lab --help`. This test keeps
// the catalogs from creeping back and ensures the CLI reference doc exists.

import { expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PLUGIN_ROOT = join(import.meta.dir, '..');
const APPEND = readFileSync(join(PLUGIN_ROOT, 'state-templates', 'CLAUDE-APPEND.md'), 'utf8');

test('HA APPEND carries no skills/subagents/tool catalog tables', () => {
  expect(/^\|\s*Skill\s*\|/m.test(APPEND)).toBe(false);
  expect(/^\|\s*Agent\s*\|/m.test(APPEND)).toBe(false);
  expect(/^\|\s*Tool\s*\|/m.test(APPEND)).toBe(false);
});

test('HA APPEND points to the resolvable CLI reference, and the doc exists', () => {
  // The operator's CLAUDE.md must name a pointer that resolves from their
  // project cwd: `ha-agent-lab --help`. A bare `docs/cli-reference.md` would
  // resolve to <operator-project>/docs/... and not exist (the doc ships only
  // under the plugin root, where it remains the written catalog).
  expect(APPEND.includes('ha-agent-lab --help')).toBe(true);
  expect(APPEND.includes('docs/cli-reference.md')).toBe(false);
  expect(existsSync(join(PLUGIN_ROOT, 'docs', 'cli-reference.md'))).toBe(true);
});

test('HA APPEND stays under the post-trim ceiling', () => {
  // Pre-trim was 9,565 B; trimmed to ~5,076 B; the context-engineering pass then
  // removed §Environment, §Entry Flow, the channel-routing examples, and the
  // per-install routine-mode narrative, landing at ~2,814 B.
  expect(Buffer.byteLength(APPEND, 'utf8')).toBeLessThanOrEqual(3200);
});

test('HA APPEND keeps every safety rule the trim was not allowed to touch', () => {
  expect(APPEND.includes('Never commit real HA URLs, tokens, or device inventories.')).toBe(true);
  expect(/[Uu]ncertain entities default to sensitive/.test(APPEND)).toBe(true);
  // Changing safety policy still requires explicit operator approval.
  expect(/approval[\s\S]{0,80}modifying safety policy/.test(APPEND)).toBe(true);
});

test('HA APPEND preserves previews, native approval, and policy-block handling', () => {
  expect(APPEND.includes('Preview sensitive actuation')).toBe(true);
  expect(APPEND.includes('and structural writes')).toBe(true);
  expect(APPEND.includes('Claude Code requests native approval before execution.')).toBe(true);
  expect(APPEND.includes('Surface policy blocks as proposals.')).toBe(true);
});

test('HA APPEND carries no per-install config state or env setup', () => {
  // Routine schedules, mode-conditional enabled flags, and .env var docs drift
  // the moment an operator edits config; hatch and config.json own them.
  expect(APPEND.includes('HOMEASSISTANT_URL')).toBe(false);
  expect(APPEND.includes('unified mode')).toBe(false);
  expect(APPEND.includes('legacy mode')).toBe(false);
});

test('HA notification skills defer to the core push-format owner', () => {
  // Distributed half of the single-owner guard: core's APPEND states ≤200 chars,
  // and this assertion runs whenever HA's own files change under path-filtered CI.
  for (const skill of ['ha-morning-brief', 'ha-evening-brief']) {
    const body = readFileSync(join(PLUGIN_ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
    expect(/≤\s*200\s*chars/.test(body)).toBe(false);
    expect(body.includes('Operator Notification push format')).toBe(true);
  }
});
