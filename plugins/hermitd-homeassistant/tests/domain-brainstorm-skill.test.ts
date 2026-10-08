// Structural lint for the /domain-brainstorm skill. Originally a
// 1:1 port of tests/test_domain_brainstorm_skill.py; the two metrics-emit
// cases were retired when the skill stopped writing its own `brainstorm-emit`
// event and started riding core's triage ledger via proposal tags.
// Grep-level checks against the skill markdown. No runtime skill execution.
// Guards:
//   - 5-gate structure (Gate 0..4)
//   - contract references (Evidence Source, category, proposal tags)
//   - boundary: suppression artifacts appear under a suppression framing,
//     not as idea sources

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PLUGIN_ROOT = resolve(import.meta.dir, '..');
const skillText = readFileSync(
  join(PLUGIN_ROOT, 'skills', 'domain-brainstorm', 'SKILL.md'),
  'utf8',
);
const EXPECTED_GATES = 5;

const parts = skillText.split('---');
const skillBody = parts.length >= 3 ? parts.slice(2).join('---') : '';

function frontmatter(): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of (parts[1] ?? '').split('\n')) {
    const colon = line.indexOf(':');
    if (colon !== -1) fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return fields;
}

// --- File and frontmatter ---

test('skill file has frontmatter', () => {
  expect(parts.length >= 3).toBe(true);
});

test('frontmatter has name', () => {
  expect(frontmatter().name).toBe('domain-brainstorm');
});

test('frontmatter has description', () => {
  const desc = frontmatter().description ?? '';
  expect(desc.length).toBeGreaterThan(20);
});

// --- Gate structure ---

test('gates are numbered 0..4', () => {
  const gates = [...skillBody.matchAll(/^### Gate (\d+) —/gm)].map((m) => Number(m[1]));
  expect(gates).toEqual([...Array(EXPECTED_GATES).keys()]);
});

// --- Contract references ---

test('evidence source capability-brainstorm', () => {
  expect(skillBody).toContain('Evidence Source: capability-brainstorm');
});

test('category improvement', () => {
  expect(skillBody).toContain('category: improvement');
});

test('proposal tags carry brainstorm provenance', () => {
  // proposal-create writes these onto both the triage-verdict row and the
  // proposal frontmatter; that is what the kill-criteria segment reads.
  expect(skillBody).toContain('tags: [capability-brainstorm]');
});

test('every title prefix the HA APPEND advertises is one the skill emits', () => {
  const append = readFileSync(join(PLUGIN_ROOT, 'state-templates', 'CLAUDE-APPEND.md'), 'utf8');
  const prefixes = [...append.matchAll(/^- \*\*(\[[a-z-]+\])\*\*/gm)].map((m) => m[1]);
  expect(prefixes.length).toBeGreaterThan(0);
  for (const prefix of prefixes) expect(skillBody).toContain(prefix);
});

// --- Boundary guard: suppression framing ---
// Gate 0 legitimately reads integration-health-degraded-domains.json and
// pattern-analysis as SUPPRESSION FILTERS. The assertion is positive (they
// appear in a suppression context), not negative (absence of a term).

test('integration-health appears in suppression context', () => {
  expect(skillBody).toContain('integration-health-degraded-domains.json');
  const idx = skillBody.indexOf('integration-health-degraded-domains.json');
  const window = skillBody.slice(Math.max(0, idx - 300), idx + 300).toLowerCase();
  expect(
    ['suppress', 'skip', 'exclude', 'filter'].some((kw) => window.includes(kw)),
  ).toBe(true);
});

test('no proposal-create call in gate 0', () => {
  // Gate 0 must not invoke proposal-create — that belongs to Gate 2.
  const gate0Match = /### Gate 0 —([\s\S]+?)### Gate 1 —/.exec(skillBody);
  expect(gate0Match).not.toBeNull();
  expect(gate0Match![1]).not.toContain('proposal-create');
});
