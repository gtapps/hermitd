import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPinnedScript } from './helpers/run';

function agent() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-doctor-fix-')));
  const dir = path.join(root, '.hermit');
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), '{}\n');
  return { root, dir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('relays doctor output and its exit code as one JSON object', async () => {
  const a = agent();
  // A `claude` that cannot list plugins makes doctor stop with its own explanation.
  const bin = path.join(a.root, 'fakebin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "no plugins here" >&2\nexit 1\n', { mode: 0o700 });
  try {
    const out = await runPinnedScript('doctor-fix.ts', a.dir, [a.dir], { cwd: os.tmpdir(), env: { PATH: `${bin}:${process.env.PATH}` } });
    expect(out.exitCode).toBe(0);
    const result = JSON.parse(out.stdout);
    expect(result.status).toBe('done');
    expect(result.exit_code).not.toBe(0);
    expect(result.lines.length).toBeGreaterThan(0);
    expect(result.lines.length).toBeLessThanOrEqual(40);
  } finally { a.cleanup(); }
});

test('refuses inside a container', async () => {
  const a = agent();
  try {
    const out = await runPinnedScript('doctor-fix.ts', a.dir, [a.dir], { cwd: a.root, env: { container: 'docker' } });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ status: 'refused', reason: 'host_only' });
  } finally { a.cleanup(); }
});
