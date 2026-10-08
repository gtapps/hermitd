import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT } from './helpers/run';

const read = (name: string) => fs.readFileSync(path.join(PLUGIN_ROOT, name), 'utf8');

describe('resident startup', () => {
  test('launch default and injected-prompt classification use resident-start', () => {
    expect(fs.existsSync(path.join(PLUGIN_ROOT, 'skills/resident-start/SKILL.md'))).toBe(true);
    expect(read('scripts/hermitd-start.ts')).toContain("config.boot_skill || '/hermitd:resident-start'");
    expect(read('scripts/record-operator-action.ts')).toContain("'/hermitd:resident-start'");
    for (const name of ['session', 'session-start']) expect(fs.existsSync(path.join(PLUGIN_ROOT, 'skills', name))).toBe(false);
  });
  test('launch and shutdown no longer assign lifecycle session_state', () => {
    for (const file of ['hermitd-start.ts', 'hermitd-stop.ts']) {
      const code = read('scripts/' + file);
      expect(code).not.toMatch(/session_state\s*[:=]\s*['"]/);
    }
  });
});
