import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
test('the retired resolution-action writer is absent', () => {
  expect(fs.existsSync(path.join(import.meta.dir, '../scripts/apply-reflection-actions.ts'))).toBe(false);
});
