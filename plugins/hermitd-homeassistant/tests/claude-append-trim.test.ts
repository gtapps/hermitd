import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PLUGIN_ROOT = join(import.meta.dir, '..');

test('HA notification skills defer to the core push-format owner', () => {
  // Distributed half of the single-owner guard: core's resident prompt states ≤200 chars,
  // and this assertion runs whenever HA's own files change under path-filtered CI.
  for (const skill of ['ha-morning-brief', 'ha-evening-brief']) {
    const body = readFileSync(join(PLUGIN_ROOT, 'skills', skill, 'SKILL.md'), 'utf8');
    expect(/≤\s*200\s*chars/.test(body)).toBe(false);
    expect(body.includes('Operator Notification push format')).toBe(true);
  }
});
