import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-test-all-')));
  for (const dir of ['scripts', 'bin', 'logs']) fs.mkdirSync(path.join(root, dir));
  fs.copyFileSync(path.resolve(import.meta.dir, '../../scripts/test-all.sh'), path.join(root, 'scripts/test-all.sh'));
  for (const slug of [
    'hermitd', 'hermitd-homeassistant', 'hermitd-feed', 'hermitd-connector',
    'hermitd-dev', 'hermitd-fitness', 'hermitd-scribe', 'hermitd-laravel-forge',
  ]) {
    const dir = path.join(root, 'plugins', slug, 'tests');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run-all.sh'), 'exit 0\n');
  }
  fs.writeFileSync(path.join(root, 'bin/bun'), `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const root = process.env.TEST_RUNNER_ROOT;
if (process.argv[2] === '-e') {
  // Real bun colorizes console.log values when FORCE_COLOR is set.
  console.log(process.env.FORCE_COLOR ? '\u001b[0m\u001b[33m2\u001b[0m' : '2');
  process.exit(0);
}
const slug = path.basename(process.cwd());
if (slug === 'hermitd') {
  fs.writeFileSync(path.join(root, 'core-args.json'), JSON.stringify(process.argv.slice(2)));
  fs.writeFileSync(path.join(root, 'core-started'), '');
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(root, 'release-core')) && Date.now() < deadline) await Bun.sleep(10);
  if (!fs.existsSync(path.join(root, 'release-core'))) process.exit(1);
}
if (process.cwd() === root) {
  fs.writeFileSync(path.join(root, 'root-args.json'), JSON.stringify(process.argv.slice(2)));
  if (process.env.TEST_ROOT_FAIL) { console.error('root failure'); process.exit(3); }
}
if (slug === 'hermitd-feed' && process.env.TEST_FEED_FAIL) {
  console.error('original failure detail');
  for (let i = 0; i < 30; i++) console.log('later output');
  process.exit(7);
}
`, { mode: 0o755 });
  return root;
}

function run(root: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn(['bash', 'scripts/test-all.sh'], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
      TMPDIR: path.join(root, 'logs'),
      TEST_RUNNER_ROOT: root,
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let stdout = '';
  const output = (async () => {
    for await (const chunk of proc.stdout) stdout += Buffer.from(chunk).toString();
  })();
  const stderr = new Response(proc.stderr).text();
  return { proc, output, stderr, stdout: () => stdout };
}

test('reports a completed plugin while core is still running, then includes shared root tests', async () => {
  const root = fixture();
  const r = run(root);
  try {
    const deadline = Date.now() + 5000;
    while ((!fs.existsSync(path.join(root, 'core-started')) || !/hermitd-feed\s+PASS/.test(r.stdout())) && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    expect(r.stdout()).toMatch(/hermitd-feed\s+PASS/);
    expect(r.proc.exitCode).toBeNull();
    fs.writeFileSync(path.join(root, 'release-core'), '');
    expect(await r.proc.exited).toBe(0);
    await r.output;
    expect(JSON.parse(fs.readFileSync(path.join(root, 'root-args.json'), 'utf8')))
      .toEqual(['test', 'tests/cross-plugin/', 'tests/lib/']);
    expect(fs.readdirSync(path.join(root, 'logs'))).toEqual([]);
  } finally {
    fs.writeFileSync(path.join(root, 'release-core'), '');
    await Promise.all([r.proc.exited, r.output, r.stderr]);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test('a fast plugin failure and root failure remain failures and retain complete logs', async () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'release-core'), '');
  const r = run(root, { TEST_FEED_FAIL: '1', TEST_ROOT_FAIL: '1' });
  try {
    expect(await r.proc.exited).toBe(1);
    await r.output;
    expect(r.stdout()).toMatch(/hermitd-feed\s+FAIL/);
    expect(r.stdout()).toMatch(/root\s+FAIL/);
    const logs = r.stdout().match(/Full test logs: (.+)/)![1];
    expect(fs.readFileSync(path.join(logs, 'hermitd-feed.log'), 'utf8')).toContain('original failure detail');
    expect(fs.readFileSync(path.join(logs, 'root.log'), 'utf8')).toContain('root failure');
  } finally {
    await Promise.all([r.proc.exited, r.output, r.stderr]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('core worker count survives FORCE_COLOR as a bare integer', async () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'release-core'), '');
  const r = run(root, { FORCE_COLOR: '3' });
  try {
    expect(await r.proc.exited).toBe(0);
    await r.output;
    const args: string[] = JSON.parse(fs.readFileSync(path.join(root, 'core-args.json'), 'utf8'));
    expect(args).toContain('--parallel=2');
  } finally {
    await Promise.all([r.proc.exited, r.output, r.stderr]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
