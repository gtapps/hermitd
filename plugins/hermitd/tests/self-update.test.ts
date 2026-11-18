import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPinnedScript } from './helpers/run';

function agent(updater: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-self-update-')));
  const dir = path.join(root, '.hermit');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'hermitd-update'), `#!/bin/sh\n${updater}\n`, { mode: 0o700 });
  return { root, dir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('runs the updater with --yes from the project root and reports the row it wrote', async () => {
  const a = agent(`printf '%s|%s\\n' "$(pwd)" "$*" > args.receipt
echo '{"plugins":[{"id":"hermitd@hermitd","before":"1.0.0","after":"1.1.0"}]}' >> .hermit/state/update-history.jsonl
echo noise; echo more noise >&2
exit 0`);
  try {
    fs.writeFileSync(path.join(a.dir, 'state', 'update-history.jsonl'), '{"old":true}\n');
    const out = await runPinnedScript('self-update.ts', a.dir, [a.dir], { cwd: os.tmpdir() });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ status: 'done', exit_code: 0, update: { plugins: [{ id: 'hermitd@hermitd', before: '1.0.0', after: '1.1.0' }] } });
    expect(fs.readFileSync(path.join(a.root, 'args.receipt'), 'utf8').trim()).toBe(`${a.root}|--yes`);
  } finally { a.cleanup(); }
});

test('reports the updater exit code and no row when none was written', async () => {
  const a = agent('exit 3');
  try {
    fs.writeFileSync(path.join(a.dir, 'state', 'update-history.jsonl'), '{"old":true}\n');
    const out = await runPinnedScript('self-update.ts', a.dir, [a.dir], { cwd: a.root });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ status: 'done', exit_code: 3, update: null });
  } finally { a.cleanup(); }
});

test('refuses inside a container without running the updater', async () => {
  const a = agent('touch ran.receipt');
  try {
    const out = await runPinnedScript('self-update.ts', a.dir, [a.dir], { cwd: a.root, env: { container: 'docker' } });
    expect(JSON.parse(out.stdout)).toEqual({ status: 'refused', reason: 'host_only' });
    expect(fs.existsSync(path.join(a.root, 'ran.receipt'))).toBe(false);
  } finally { a.cleanup(); }
});
