import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findStorageDrift } from '../scripts/lib/drift';

function mkHermitDir(base: string, config?: object): string {
  const hermitDir = path.join(base, '.hermit');
  fs.mkdirSync(hermitDir, { recursive: true });
  if (config !== undefined) {
    fs.writeFileSync(path.join(hermitDir, 'config.json'), JSON.stringify(config), 'utf-8');
  }
  return hermitDir;
}

function mkDir(hermitDir: string, name: string): void {
  fs.mkdirSync(path.join(hermitDir, name), { recursive: true });
  // Put one file inside so countEntries returns > 0.
  fs.writeFileSync(path.join(hermitDir, name, 'placeholder'), '', 'utf-8');
}

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-drift-'));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('findStorageDrift — allowlist', () => {
  it('does NOT flag a dir listed in storage_drift.ignore', () => {
    const base = path.join(tmp, 'test-exempt');
    fs.mkdirSync(base);
    const hermitDir = mkHermitDir(base, { storage_drift: { ignore: ['forge-runtime'] } });
    mkDir(hermitDir, 'forge-runtime');

    const hits = findStorageDrift(hermitDir);
    expect(hits.every(h => !h.includes('forge-runtime'))).toBe(true);
  });

  it('does NOT flag helper-reports without an ignore entry', () => {
    const base = path.join(tmp, 'test-helper-reports');
    fs.mkdirSync(base);
    const hermitDir = mkHermitDir(base, { storage_drift: { ignore: [] } });
    mkDir(hermitDir, 'helper-reports');

    const hits = findStorageDrift(hermitDir);
    expect(hits.every(h => !h.includes('helper-reports'))).toBe(true);
  });

  it('still flags an unknown dir NOT in the ignore list', () => {
    const base = path.join(tmp, 'test-garbage');
    fs.mkdirSync(base);
    const hermitDir = mkHermitDir(base, { storage_drift: { ignore: ['forge-runtime'] } });
    mkDir(hermitDir, 'garbage');

    const hits = findStorageDrift(hermitDir);
    expect(hits.some(h => h.includes('garbage'))).toBe(true);
  });

  it('exempts multiple dirs in the ignore list', () => {
    const base = path.join(tmp, 'test-multi');
    fs.mkdirSync(base);
    const hermitDir = mkHermitDir(base, { storage_drift: { ignore: ['foo-runtime', 'bar-runtime'] } });
    mkDir(hermitDir, 'foo-runtime');
    mkDir(hermitDir, 'bar-runtime');

    const hits = findStorageDrift(hermitDir);
    expect(hits.every(h => !h.includes('foo-runtime') && !h.includes('bar-runtime'))).toBe(true);
  });
});

describe('findStorageDrift — fail-open', () => {
  it('still flags drift when config.json is missing', () => {
    const base = path.join(tmp, 'test-no-config');
    fs.mkdirSync(base);
    const hermitDir = mkHermitDir(base);
    mkDir(hermitDir, 'garbage');

    const hits = findStorageDrift(hermitDir);
    expect(hits.some(h => h.includes('garbage'))).toBe(true);
  });

  it('still flags drift when config.json is invalid JSON', () => {
    const base = path.join(tmp, 'test-bad-config');
    fs.mkdirSync(base);
    const hermitDir = mkHermitDir(base);
    fs.writeFileSync(path.join(hermitDir, 'config.json'), 'NOT JSON', 'utf-8');
    mkDir(hermitDir, 'garbage');

    const hits = findStorageDrift(hermitDir);
    expect(hits.some(h => h.includes('garbage'))).toBe(true);
  });

  it('still flags drift when storage_drift.ignore is not an array', () => {
    const base = path.join(tmp, 'test-bad-ignore');
    fs.mkdirSync(base);
    const hermitDir = mkHermitDir(base, { storage_drift: { ignore: 'forge-runtime' } });
    mkDir(hermitDir, 'garbage');

    const hits = findStorageDrift(hermitDir);
    expect(hits.some(h => h.includes('garbage'))).toBe(true);
  });
});
