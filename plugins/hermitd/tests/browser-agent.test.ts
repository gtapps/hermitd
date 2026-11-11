import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { browserSocketDir } from '../scripts/browser-agent';
import { browserLease } from '../scripts/lib/browser-lease';
import { freshDirFactory } from './helpers/workdir';
import { PLUGIN_ROOT } from './helpers/run';
const { freshDir, cleanup } = freshDirFactory('browser-agent-');
const sockets: string[] = [];
afterAll(() => { cleanup(); for (const dir of sockets) fs.rmSync(dir, { recursive: true }); });

function fixture() {
  const root = freshDir();
  const dir = path.join(root, '.hermit');
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  const socket = browserSocketDir(dir);
  sockets.push(socket);
  fs.mkdirSync(socket, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state/browser-display.json'), JSON.stringify({ display: ':17', vncSocket: path.join(socket, 'vnc.sock') }));
  const binary = path.join(root, 'real-browser');
  fs.writeFileSync(binary, `#!${process.execPath}\nif (process.env.TEST_SLEEP) { require('node:fs').writeFileSync(process.env.TEST_SLEEP, String(process.pid)); await Bun.sleep(60000); }\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\nprocess.exit(Number(process.env.TEST_EXIT ?? 0));\n`, { mode: 0o755 });
  const run = async (argv: string[], env: Record<string, string> = {}) => {
    const child = Bun.spawn([process.execPath, '-e', `import { runBrowserAgent } from ${JSON.stringify(path.join(PLUGIN_ROOT, 'scripts/browser-agent.ts'))}; process.exitCode = await runBrowserAgent(${JSON.stringify(argv)}, ${JSON.stringify(binary)}, () => true, { deployment: 'container', commandTimeoutMs: Number(process.env.TEST_TIMEOUT_MS) || undefined, startIdleWatch: () => require('node:fs').appendFileSync(${JSON.stringify(path.join(root, 'watch-calls'))}, 'watch\\n'), marker: ${JSON.stringify(path.join(root, 'marker'))}, ensureDisplay: async () => {
      const fs = await import('node:fs');
      fs.appendFileSync(${JSON.stringify(path.join(root, 'display-calls'))}, 'ensure\\n');
      return process.env.TEST_BLOCKER ? { blocker: process.env.TEST_BLOCKER } : JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, 'state/browser-display.json'))}, 'utf8'));
    } });`], {
      cwd: root, env: { ...process.env, AGENT_DIR: dir, HERMIT_PLUGIN_ROOT: PLUGIN_ROOT, DISPLAY: ':99', AGENT_BROWSER_PROFILE: '/bad', AGENT_BROWSER_HEADED: '1', AGENT_BROWSER_IDLE_TIMEOUT_MS: '15', XDG_RUNTIME_DIR: '/run/shared', ...env }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stderr, data: JSON.parse(stdout) };
  };
  return { root, dir, socket, run };
}

test('signed-in commands start the inactivity watcher; close and named sessions do not', async () => {
  const { root, dir, run } = fixture();
  const calls = () => { try { return fs.readFileSync(path.join(root, 'watch-calls'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  browserLease('claim', 'task-a', dir);
  expect((await run(['--task', 'task-a', 'open', 'https://example.com'])).code).toBe(0);
  expect(calls()).toBe(1);
  expect((await run(['--task', 'task-a', 'close'])).code).toBe(0);
  expect((await run(['--session', 'anon', 'open', 'https://example.com'])).code).toBe(0);
  expect(calls()).toBe(1);
});

test('a command past the timeout is killed and returns browser_command_timeout', async () => {
  const { root, dir, run } = fixture();
  browserLease('claim', 'task-a', dir);
  const pidFile = path.join(root, 'sleeper.pid');
  expect(await run(['--task', 'task-a', 'open', 'https://example.com'], { TEST_SLEEP: pidFile, TEST_TIMEOUT_MS: '1500' })).toMatchObject({ code: 1, data: { error: 'browser_command_timeout' } });
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();
  expect(fs.readFileSync(path.join(root, 'watch-calls'), 'utf8')).toBe('watch\n');
});

test('persistent commands require a live claim, renew it and preserve argv and exit code', async () => {
  const { dir, run } = fixture();
  expect(await run(['open', 'https://example.com'])).toMatchObject({ code: 1, data: { error: 'browser_not_claimed' } });
  browserLease('claim', 'task-a', dir, Date.now() - 5000);
  const before = browserLease('status', undefined, dir).expires_at!;
  const result = await run(['--task', 'task-a', 'open', 'https://example.com/a?x=1&y=two words'], { TEST_EXIT: '7' });
  expect(result.code).toBe(7);
  expect(result.data.argv).toEqual(['open', 'https://example.com/a?x=1&y=two words']);
  expect(result.data.env).toMatchObject({ DISPLAY: ':17', AGENT_BROWSER_HEADED: '1', AGENT_BROWSER_PROFILE: '/home/claude/.claude/browser/profile', AGENT_BROWSER_ARGS: '--no-sandbox,--host-resolver-rules=MAP 169.254.* ^NOTFOUND,--window-size=500,1082,--window-position=0,0', AGENT_BROWSER_IDLE_TIMEOUT_MS: '0' });
  expect(browserLease('status', undefined, dir).expires_at!).toBeGreaterThan(before);
});

test('only the holding task drives the persistent browser', async () => {
  const { dir, run } = fixture();
  browserLease('claim', 'task-b', dir);
  const before = browserLease('status', undefined, dir).expires_at!;
  expect(await run(['open', 'https://example.com'])).toMatchObject({ code: 1, data: { error: 'browser_not_claimed', holder: 'task-b' } });
  expect(await run(['--task', 'task-a', 'open', 'https://example.com'])).toMatchObject({ code: 1, data: { error: 'browser_not_claimed', holder: 'task-b' } });
  expect(browserLease('status', undefined, dir).expires_at!).toBe(before);
  expect((await run(['--task=task-b', 'snapshot'])).data.argv).toEqual(['snapshot']);
});

test('named sessions strip headed and ambient profile/display and cap live sessions at three', async () => {
  const { run, socket } = fixture();
  for (const name of ['one', 'two', 'three']) fs.writeFileSync(path.join(socket, `${name}.pid`), String(process.pid));
  expect(await run(['--session', 'four', 'open', 'https://example.com'])).toMatchObject({ code: 1, data: { error: 'session_cap' } });
  const result = await run(['--session', 'one', '--headed', 'open', 'https://example.com']);
  expect(result.code).toBe(0);
  expect(result.data.argv).toEqual(['--session', 'one', 'open', 'https://example.com']);
  for (const key of ['DISPLAY', 'AGENT_BROWSER_PROFILE', 'AGENT_BROWSER_HEADED']) expect(result.data.env[key]).toBeUndefined();
  expect(result.data.env.AGENT_BROWSER_SOCKET_DIR).toBe(socket);
  expect(result.data.env.AGENT_BROWSER_IDLE_TIMEOUT_MS).toBeUndefined();
  fs.writeFileSync(path.join(socket, 'three.pid'), '99999999');
  expect((await run(['--session', 'four', 'open', 'https://example.com'])).code).toBe(0);
});

test('the cap ignores the dashboard pid file and reads no invalid pid as live', async () => {
  const { run, socket } = fixture();
  for (const name of ['one', 'two']) fs.writeFileSync(path.join(socket, `${name}.pid`), String(process.pid));
  fs.writeFileSync(path.join(socket, 'dashboard.pid'), String(process.pid));
  fs.writeFileSync(path.join(socket, 'empty.pid'), '');
  expect((await run(['--session', 'three', 'open', 'https://example.com'])).code).toBe(0);
});

test('plugin root env is unnecessary and hermits do not share sockets', async () => {
  const { run, dir } = fixture();
  expect(await run(['--session', 'one', 'open', 'https://example.com'], { HERMIT_PLUGIN_ROOT: '/missing' })).toMatchObject({ code: 0 });
  expect(browserSocketDir(dir)).not.toBe(browserSocketDir(`${dir}-other`));
});

test('explicit launch flags cannot override the managed profile or anonymous isolation', async () => {
  const { dir, run } = fixture();
  browserLease('claim', 'task', dir);
  const flags = ['--profile', '/unmanaged', '--args=--bad', '--executable-path', '/bad', '--namespace', 'other', '--session-name', 'kept', '--config', '/bad.json', '--idle-timeout', '10s', '--headed', 'false'];
  const persistent = await run(['--task', 'task', ...flags, 'open', 'https://example.com']);
  expect(persistent.data.argv).toEqual(['open', 'https://example.com']);
  expect(persistent.data.env.AGENT_BROWSER_PROFILE).toBe('/home/claude/.claude/browser/profile');
  const anonymous = await run(['--session', 'public', ...flags, 'open', 'https://example.com']);
  expect(anonymous.data.argv).toEqual(['--session', 'public', 'open', 'https://example.com']);
  expect(anonymous.data.env.AGENT_BROWSER_PROFILE).toBeUndefined();
});


test('human control refuses persistent commands without renewing and keeps anonymous sessions usable', async () => {
  const { dir, run } = fixture();
  browserLease('claim', 'task', dir);
  browserLease('takeover', undefined, dir, Date.now(), { login: 'admin' });
  const file = path.join(dir, 'state/browser-lease.json');
  const before = fs.readFileSync(file, 'utf8');
  expect(await run(['--task', 'task', 'snapshot'])).toMatchObject({ code: 1, data: { error: 'human_has_control' } });
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
  expect((await run(['--session', 'public', 'snapshot'])).code).toBe(0);
});

test('takeover during a command discards stdout and stderr and the child exit code', async () => {
  const { dir, run } = fixture();
  browserLease('claim', 'task', dir);
  const binary = path.join(dir, '../real-browser');
  fs.writeFileSync(binary, `#!${process.execPath}\nimport { browserLease } from ${JSON.stringify(path.join(PLUGIN_ROOT, 'scripts/lib/browser-lease.ts'))};\nbrowserLease('takeover', undefined, process.env.AGENT_DIR, Date.now(), { login: 'admin' });\nconsole.log('stale page'); console.error('stale error'); process.exit(7);\n`, { mode: 0o755 });
  expect(await run(['--task', 'task', 'snapshot'])).toEqual({ code: 1, stderr: '', data: { error: 'human_has_control' } });
});


test('disabled config wins on every command and metadata URLs are refused', async () => {
  const { dir, run } = fixture();
  for (const host of ['169.254.169.254', 'metadata.google.internal', 'metadata.goog', '100.100.100.200', '[fd00:ec2::254]']) {
    expect(await run(['--session', 'public', 'open', `http://${host}/latest`])).toMatchObject({ code: 1, data: { error: 'metadata_url_refused' } });
  }
  for (const argv of [['--session', 'public', 'goto', 'http://169.254.169.254/latest'], ['--session', 'open', 'open', 'http://169.254.169.254/'], ['--session', 'public', 'open', '169.254.169.254/latest']]) {
    expect(await run(argv)).toMatchObject({ code: 1, data: { error: 'metadata_url_refused' } });
  }
  fs.writeFileSync(path.join(dir, 'config.json'), '{"browser":{"enabled":false}}');
  expect(await run(['--session', 'public', 'snapshot'])).toMatchObject({ code: 0, data: { status: 'disabled' } });
});

test('only a live install lock reports installing', async () => {
  const root = freshDir(), dir = path.join(root, '.hermit'), data = path.join(root, 'browser-data');
  fs.mkdirSync(dir); fs.mkdirSync(data);
  const run = async () => {
    const child = Bun.spawn([process.execPath, '-e', `import { runBrowserAgent } from ${JSON.stringify(path.join(PLUGIN_ROOT, 'scripts/browser-agent.ts'))}; process.exitCode = await runBrowserAgent(['--session', 'public', 'snapshot'], undefined, () => false, { deployment: 'host', data: ${JSON.stringify(data)}, waitMs: 1 });`], {
      cwd: root, env: { ...process.env, AGENT_DIR: dir, CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(root, 'cache') }, stdout: 'pipe', stderr: 'pipe',
    });
    return new Response(child.stdout).json();
  };
  fs.writeFileSync(path.join(data, 'install.lock'), String(process.pid));
  expect(await run()).toEqual({ status: 'installing' });
  // The recorded error stands in for the retry, so this test never starts a real download.
  fs.writeFileSync(path.join(data, 'install.lock'), '99999999');
  fs.writeFileSync(path.join(data, 'install-error.json'), '{"error":"prior failure"}');
  expect(await run()).toEqual({ error: 'browser_install_failed:prior failure' });
});


test('close with an absent host install never starts an installer, including stale install errors', async () => {
  const root = freshDir(), dir = path.join(root, '.hermit'), data = path.join(root, 'browser-data');
  fs.mkdirSync(dir); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'install-error.json'), '{"error":"prior failure"}');
  const child = Bun.spawn([process.execPath, '-e', `import { runBrowserAgent } from ${JSON.stringify(path.join(PLUGIN_ROOT, 'scripts/browser-agent.ts'))}; process.exitCode = await runBrowserAgent(['--task', 'shutdown', 'close'], undefined, () => false, { deployment: 'host', data: ${JSON.stringify(data)}, waitMs: 1 });`], {
    cwd: root, env: { ...process.env, AGENT_DIR: dir, CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(root, 'cache') }, stdout: 'pipe', stderr: 'pipe', timeout: 2000,
  });
  expect(await new Response(child.stdout).json()).toEqual({ status: 'closed' });
  expect(await child.exited).toBe(0);
  expect(fs.readdirSync(data)).toEqual(['install-error.json']);
  expect(fs.existsSync(path.join(root, 'cache'))).toBe(false);
});

test('container executable path follows the managed image marker', async () => {
  const { dir, run } = fixture();
  const argv = ['--session', 'public', 'snapshot'];
  expect((await run(argv, { AGENT_BROWSER_EXECUTABLE_PATH: '/stale' })).data.env.AGENT_BROWSER_EXECUTABLE_PATH).toBeUndefined();
  fs.writeFileSync(path.join(dir, '../marker'), 'display=plugin\n');
  expect((await run(argv)).data.env.AGENT_BROWSER_EXECUTABLE_PATH).toBe('/opt/chrome-linux64/chrome');
});

test('Docker display blockers name the merge candidate or the image rebuild', async () => {
  const { dir, run } = fixture();
  browserLease('claim', 'task', dir);
  const parked = path.join(dir, 'state/Dockerfile.hermit.20261103.upstream');
  fs.writeFileSync(parked, 'new template');
  let result = await run(['--task', 'task', 'snapshot'], { TEST_BLOCKER: 'image_missing' });
  expect(result.data).toMatchObject({ error: 'browser_display_missing', reason: 'image_missing' });
  expect(result.data.detail).toContain('managed-browser merge');
  expect(result.data.detail).toContain(parked);
  fs.writeFileSync(path.join(dir, '../Dockerfile.hermit'), '# --- managed browser ---\n# --- end managed browser ---');
  result = await run(['--task', 'task', 'snapshot'], { TEST_BLOCKER: 'image_rebuild_pending' });
  expect(result.data.reason).toBe('image_rebuild_pending');
  expect(result.data.detail).toContain('hermitd update');
  expect(result.data.detail).not.toContain('merge');
});

test('anonymous commands and close never ensure a display', async () => {
  const { dir, run } = fixture();
  await run(['--session', 'public', 'snapshot']);
  browserLease('claim', 'shutdown', dir);
  await run(['--task', 'shutdown', 'close']);
  expect(fs.existsSync(path.join(dir, '../display-calls'))).toBe(false);
});
