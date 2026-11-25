import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT } from './helpers/run';

describe('static file checks', () => {
  test('hermitd-exec reports version skew, not corruption, on a missing script', () => {
    const src = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'hermitd-exec.sh'), 'utf8');
    expect(src).not.toContain('may be corrupted');
    expect(src).toContain('may predate this command');
    expect(src).toContain('hermitd update');
  });
});
