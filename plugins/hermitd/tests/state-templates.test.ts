import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT } from './helpers/run';
import { readJson } from './helpers/workdir';

describe('static file checks', () => {
  test('deny-patterns.json', () => {
    const d = readJson(path.join(PLUGIN_ROOT, 'state-templates', 'deny-patterns.json'));
    expect(Object.keys(d).sort()).toEqual(['ask', 'deny']);
    expect(Array.isArray(d.deny)).toBe(true);
    expect(Array.isArray(d.ask)).toBe(true);
    // The OPERATOR.md redirect pair is deny, never ask: unlike the settings redirect
    // twins (hook-only, retired with the hook), these were always native profile-
    // independent denies, and there is no sanctioned shell-redirect path into the
    // operator-curated file that an approval prompt would legitimize.
    expect(d.deny).toContain('Bash(*> *.hermit/OPERATOR.md*)');
    expect(d.deny).toContain('Bash(*>.hermit/OPERATOR.md*)');
  });

  test('bin scripts executable', () => {
    const binDir = path.join(PLUGIN_ROOT, 'state-templates', 'bin');
    for (const f of fs.readdirSync(binDir)) {
      expect(() => fs.accessSync(path.join(binDir, f), fs.constants.X_OK)).not.toThrow();
    }
  });
});
