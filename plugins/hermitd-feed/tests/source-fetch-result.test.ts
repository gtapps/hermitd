import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const script = join(import.meta.dir, '../scripts/source-fetch-result.ts');
const fixtures: string[] = [];

function fixture(content: string): string {
  const dir = mkdtempSync(join(import.meta.dir, '.source-fetch-result-'));
  fixtures.push(dir);
  const path = join(dir, 'items.json');
  writeFileSync(path, content);
  return path;
}

function run(...args: string[]) {
  const result = Bun.spawnSync([process.execPath, script, ...args]);
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function expectRejected(...args: string[]) {
  const result = run(...args);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Source fetch verification failed:');
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('new-run emits distinct UUIDs without candidate data', () => {
  const missing = `${fixture('')}.missing`;
  const first = run('new-run', missing);
  const second = run('new-run', missing);
  for (const result of [first, second]) {
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }
  expect(first.stdout).not.toBe(second.stdout);
});

test('new-run deletes the previous output before dispatch', () => {
  const path = fixture(JSON.stringify({ run_id: 'earlier-run', sources: [], pad: 'x'.repeat(100_000) }));
  const result = run('new-run', path);
  expect(result.code).toBe(0);
  expect(existsSync(path)).toBe(false);
  expectRejected('verify', path, result.stdout.trim());
});

test('an unsuccessful replacement leaves an old file rejected and untouched', () => {
  const original = JSON.stringify({ run_id: 'earlier-run', sources: [{ name: 'Example', status: 'ok', items: [] }] });
  const path = fixture(original);
  // A failed writer leaves this previous payload in place, regardless of its reply.
  expectRejected('verify', path, 'current-run');
  expect(readFileSync(path, 'utf8')).toBe(original);
});

test('current-run output preserves unchanged articles, quiet sources, and partial failures', () => {
  const sources = [
    { name: 'Example', status: 'ok', items: [{ title: 'Unchanged article', url: 'https://example.com/article' }] },
    { name: 'Quiet', status: 'ok', items: [] },
    { name: 'Unavailable', status: 'failed', error: 'timeout' },
  ];
  const payload = { run_id: 'current-run', fetch_date: '2026-01-15T09:00:00Z', sources };
  const path = fixture(JSON.stringify(payload));
  const result = run('verify', path, 'current-run');
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  expect(JSON.parse(result.stdout)).toEqual(payload);
  expectRejected('verify', path, 'overlapping-run');
});

test('current-run empty sources array is accepted', () => {
  const payload = { run_id: 'current-run', sources: [] };
  const result = run('verify', fixture(JSON.stringify(payload)), 'current-run');
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(payload);
});

for (const payload of [null, [], 'text', 1, {}, { sources: [] }, { run_id: 1, sources: [] },
  { run_id: 'current-run' }, { run_id: 'current-run', sources: {} }]) {
  test(`rejects invalid envelope ${JSON.stringify(payload)}`, () => {
    expectRejected('verify', fixture(JSON.stringify(payload)), 'current-run');
  });
}

test('malformed, missing, and unreadable file targets emit no candidate data', () => {
  const path = fixture('not json');
  expectRejected('verify', path, 'current-run');
  expectRejected('verify', `${path}.missing`, 'current-run');
  expectRejected('verify', fixtures[0], 'current-run');
});

for (const args of [[], ['unknown'], ['new-run'], ['new-run', 'relative.json'], ['new-run', '/file.json', 'extra'], ['verify'], ['verify', 'relative.json', 'run'],
  ['verify', '/file.json', ''], ['verify', '/file.json', 'run', 'extra']]) {
  test(`rejects invalid invocation ${JSON.stringify(args)}`, () => expectRejected(...args));
}
