import { afterAll, describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { sharedLivenessAgeSecs, LIVENESS_FRESH_SECS } from '../scripts/lib/liveness';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('liveness-');
afterAll(cleanup);

function makeRoot(): string {
  const dir = freshDir();
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  return dir;
}

/** Write a file and force its mtime to `ageSecs` in the past. */
function writeAged(root: string, rel: string, ageSecs: number) {
  const p = path.join(root, rel);
  fs.writeFileSync(p, '{}');
  const when = (Date.now() - ageSecs * 1000) / 1000;
  fs.utimesSync(p, when, when);
}

describe('sharedLivenessAgeSecs', () => {
  test('null when no liveness files exist', () => {
    const root = makeRoot();
    expect(sharedLivenessAgeSecs(root)).toBeNull();
  });

  test('returns the age of the freshest file', () => {
    const root = makeRoot();
    writeAged(root, 'state/heartbeat-liveness.json', 4000);
    writeAged(root, 'state/routine-monitor-liveness.json', 30);
    const age = sharedLivenessAgeSecs(root);
    expect(age).not.toBeNull();
    // freshest is the 30s file, not the 4000s one
    expect(age!).toBeLessThan(120);
    expect(age!).toBeGreaterThanOrEqual(25);
  });

  test('a single stale file reads older than the fresh threshold', () => {
    const root = makeRoot();
    writeAged(root, 'state/routine-monitor-liveness.json', LIVENESS_FRESH_SECS + 300);
    const age = sharedLivenessAgeSecs(root, 0);
    expect(age!).toBeGreaterThan(LIVENESS_FRESH_SECS);
  });

  test('retired cost cache does not prove liveness', () => {
    const root = makeRoot();
    writeAged(root, 'sessions/.status.json', 0);
    expect(sharedLivenessAgeSecs(root)).toBeNull();
  });

  test('picks up the bare .heartbeat file', () => {
    const root = makeRoot();
    writeAged(root, 'state/.heartbeat', 10);
    expect(sharedLivenessAgeSecs(root)!).toBeLessThan(120);
  });

  test('ignores a file written before the current boot', () => {
    const root = makeRoot();
    writeAged(root, 'state/routine-monitor-liveness.json', 30);
    expect(sharedLivenessAgeSecs(root, Date.now() - 10_000)).toBeNull();
  });

  test('keeps a file written after the boot', () => {
    const root = makeRoot();
    writeAged(root, 'state/routine-monitor-liveness.json', 30);
    expect(sharedLivenessAgeSecs(root, Date.now() - 3_600_000)!).toBeLessThan(120);
  });

  test('ignores a file written before the last launch', () => {
    const root = makeRoot();
    writeAged(root, 'state/routine-monitor-liveness.json', 30);
    writeAged(root, 'state/.boot-id', 5);
    expect(sharedLivenessAgeSecs(root)).toBeNull();
  });

  test('keeps a file written after the last launch', () => {
    const root = makeRoot();
    writeAged(root, 'state/.boot-id', 30);
    writeAged(root, 'state/routine-monitor-liveness.json', 5);
    expect(sharedLivenessAgeSecs(root)!).toBeLessThan(30);
  });
});
