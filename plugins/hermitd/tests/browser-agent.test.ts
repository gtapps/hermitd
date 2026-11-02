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
  const binary = path.join(root, 'real-browser');
  fs.writeFileSync(binary, `#!${process.execPath}\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\nprocess.exit(Number(process.env.TEST_EXIT ?? 0));\n`, { mode: 0o755 });
  const run = async (argv: string[], env: Record<string, string> = {}) => {
    const child = Bun.spawn([process.execPath, '-e', `import { runBrowserAgent } from ${JSON.stringify(path.join(PLUGIN_ROOT, 'scripts/browser-agent.ts'))}; process.exitCode = await runBrowserAgent(${JSON.stringify(argv)}, ${JSON.stringify(binary)}, () => true, { deployment: 'container' });`], {
      cwd: root, env: { ...process.env, AGENT_DIR: dir, HERMIT_PLUGIN_ROOT: PLUGIN_ROOT, DISPLAY: ':99', AGENT_BROWSER_PROFILE: '/bad', AGENT_BROWSER_HEADED: '1', AGENT_BROWSER_IDLE_TIMEOUT_MS: '15', XDG_RUNTIME_DIR: '/run/shared', ...env }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stderr, data: JSON.parse(stdout) };
  };
  return { dir, socket, run };
}

test('persistent commands require a live claim, renew it and preserve argv and exit code', async () => {
  const { dir, run } = fixture();
  expect(await run(['open', 'https://example.com'])).toMatchObject({ code: 1, data: { error: 'browser_not_claimed' } });
  browserLease('claim', 'task-a', dir, Date.now() - 5000);
  const before = browserLease('status', undefined, dir).expires_at!;
  const result = await run(['--task', 'task-a', 'open', 'https://example.com/a?x=1&y=two words'], { TEST_EXIT: '7' });
  expect(result.code).toBe(7);
  expect(result.data.argv).toEqual(['open', 'https://example.com/a?x=1&y=two words']);
  expect(result.data.env).toMatchObject({ DISPLAY: ':1', AGENT_BROWSER_HEADED: '1', AGENT_BROWSER_PROFILE: '/home/claude/.claude/browser/profile', AGENT_BROWSER_ARGS: '--no-sandbox,--host-resolver-rules=MAP 169.254.* ^NOTFOUND,--window-size=500,1082,--window-position=0,0', AGENT_BROWSER_IDLE_TIMEOUT_MS: '0' });
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
  fs.writeFileSync(path.join(dir, 'config.json'), '{"browser":{"enabled":false}}');
  expect(await run(['--session', 'public', 'snapshot'])).toMatchObject({ code: 0, data: { status: 'disabled' } });
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
