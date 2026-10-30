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
    const child = Bun.spawn([process.execPath, '-e', `import { runBrowserAgent } from ${JSON.stringify(path.join(PLUGIN_ROOT, 'scripts/browser-agent.ts'))}; process.exitCode = await runBrowserAgent(${JSON.stringify(argv)}, ${JSON.stringify(binary)});`], {
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
  const result = await run(['open', 'https://example.com/a?x=1&y=two words'], { TEST_EXIT: '7' });
  expect(result.code).toBe(7);
  expect(result.data.argv).toEqual(['open', 'https://example.com/a?x=1&y=two words']);
  expect(result.data.env).toMatchObject({ DISPLAY: ':1', AGENT_BROWSER_HEADED: '1', AGENT_BROWSER_PROFILE: '/home/claude/.claude/browser/profile', AGENT_BROWSER_ARGS: '--no-sandbox,--window-size=500,1082,--window-position=0,0', AGENT_BROWSER_IDLE_TIMEOUT_MS: '0' });
  expect(browserLease('status', undefined, dir).expires_at!).toBeGreaterThan(before);
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
  expect(result.data.env.AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe('0');
  fs.writeFileSync(path.join(socket, 'three.pid'), '99999999');
  expect((await run(['--session', 'four', 'open', 'https://example.com'])).code).toBe(0);
});

test('plugin absence fails closed and hermits do not share sockets', async () => {
  const { run, dir } = fixture();
  expect(await run(['--session', 'one', 'open', 'https://example.com'], { HERMIT_PLUGIN_ROOT: '/missing' })).toMatchObject({ code: 1, data: { error: 'plugin_unavailable' } });
  expect(browserSocketDir(dir)).not.toBe(browserSocketDir(`${dir}-other`));
});

test('explicit launch flags cannot override the managed profile or anonymous isolation', async () => {
  const { dir, run } = fixture();
  browserLease('claim', 'task', dir);
  const flags = ['--profile', '/unmanaged', '--args=--bad', '--executable-path', '/bad', '--headed'];
  const persistent = await run([...flags, 'open', 'https://example.com']);
  expect(persistent.data.argv).toEqual(['open', 'https://example.com']);
  expect(persistent.data.env.AGENT_BROWSER_PROFILE).toBe('/home/claude/.claude/browser/profile');
  const anonymous = await run(['--session', 'public', ...flags, 'open', 'https://example.com']);
  expect(anonymous.data.argv).toEqual(['--session', 'public', 'open', 'https://example.com']);
  expect(anonymous.data.env.AGENT_BROWSER_PROFILE).toBeUndefined();
});
