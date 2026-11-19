import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { browserSocketDir } from '../scripts/browser-agent';
import { ensureDisplay } from '../scripts/browser-display';
import { browserLease } from '../scripts/lib/browser-lease';
import { mutateTask } from '../scripts/lib/tasks';
import { browserUserAgent } from '../scripts/lib/browser-runtime';
import { freshDirFactory } from './helpers/workdir';
import { PLUGIN_ROOT } from './helpers/run';
const { freshDir, cleanup } = freshDirFactory('browser-agent-');
const sockets: string[] = [];
afterAll(() => { cleanup(); for (const dir of sockets) fs.rmSync(dir, { recursive: true }); });

test('reduced user agent requires a valid Chrome version and supported platform', () => {
  expect(browserUserAgent('156.0.8078.80', 'linux')).toBe('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36');
  expect(browserUserAgent('156.0.8078.80', 'darwin')).toBe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36');
  for (const version of [undefined, '', '156', '156.0.8078.80-extra']) expect(browserUserAgent(version, 'linux')).toBeUndefined();
  expect(browserUserAgent('156.0.8078.80', 'win32')).toBeUndefined();
});

function fixture() {
  const root = freshDir();
  const dir = path.join(root, '.hermit');
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  const socket = browserSocketDir(dir);
  sockets.push(socket);
  fs.mkdirSync(socket, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state/browser-display.json'), JSON.stringify({ display: ':17', vncSocket: path.join(socket, 'vnc.sock') }));
  const binary = path.join(root, 'real-browser');
  fs.writeFileSync(binary, `#!${process.execPath}\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\nprocess.exit(Number(process.env.TEST_EXIT ?? 0));\n`, { mode: 0o755 });
  const runCaptured = async (argv: string[], env: Record<string, string> = {}, options: { deployment?: 'host' | 'container'; data?: string; platform?: NodeJS.Platform } = {}) => {
    const child = Bun.spawn([process.execPath, '-e', `import { runBrowserAgent } from ${JSON.stringify(path.join(PLUGIN_ROOT, 'scripts/browser-agent.ts'))}; process.exitCode = await runBrowserAgent(${JSON.stringify(argv)}, ${JSON.stringify(binary)}, () => true, { deployment: 'container', marker: ${JSON.stringify(path.join(root, 'marker'))}, ...${JSON.stringify(options)}, ensureDisplay: async () => {
      const fs = await import('node:fs');
      fs.appendFileSync(${JSON.stringify(path.join(root, 'display-calls'))}, 'ensure\\n');
      return process.env.TEST_BLOCKER ? { blocker: process.env.TEST_BLOCKER } : JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, 'state/browser-display.json'))}, 'utf8'));
    } });`], {
      cwd: root, env: { ...process.env, AGENT_DIR: dir, HERMIT_PLUGIN_ROOT: PLUGIN_ROOT, DISPLAY: ':99', AGENT_BROWSER_PROFILE: '/bad', AGENT_BROWSER_HEADED: '1', AGENT_BROWSER_IDLE_TIMEOUT_MS: '15', XDG_RUNTIME_DIR: '/run/shared', ...env }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr, data: JSON.parse(stdout) };
  };
  const run = async (...args: Parameters<typeof runCaptured>) => {
    const { code, stderr, data } = await runCaptured(...args);
    return { code, stderr, data };
  };
  return { dir, root, binary, socket, run, runCaptured };
}

test('persistent commands require a live claim, renew it and preserve argv and exit code', async () => {
  const { dir, run } = fixture();
  expect(await run(['open', 'https://example.com'])).toMatchObject({ code: 1, data: { error: 'browser_not_claimed' } });
  browserLease('claim', 'task-a', dir, Date.now() - 5000);
  const before = browserLease('status', undefined, dir).expires_at!;
  const result = await run(['--task', 'task-a', 'open', 'https://example.com/a?x=1&y=two words'], { TEST_EXIT: '7' });
  expect(result.code).toBe(7);
  expect(result.data.argv).toEqual(['open', 'https://example.com/a?x=1&y=two words']);
  expect(result.data.env).toMatchObject({ DISPLAY: ':17', AGENT_BROWSER_HEADED: '1', AGENT_BROWSER_PROFILE: '/home/claude/.claude/browser/profile', AGENT_BROWSER_ARGS: ['--no-sandbox', '--host-resolver-rules=MAP 169.254.* ^NOTFOUND', '--disable-blink-features=AutomationControlled', '--window-size=500,1082', '--window-position=0,0'].join('\n'), AGENT_BROWSER_IDLE_TIMEOUT_MS: '0' });
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

test('the browser never goes through the credential proxy; other proxies reach it', async () => {
  const { dir, run } = fixture();
  const mount = path.join(path.dirname(dir), 'credproxy');
  fs.mkdirSync(mount);
  fs.writeFileSync(path.join(mount, 'proxy.json'), JSON.stringify({ address: 'http://127.0.0.1:18443', hosts: [] }));
  const proxied = { HTTPS_PROXY: 'http://127.0.0.1:18443', https_proxy: 'http://127.0.0.1:18443', HTTP_PROXY: 'http://corp:3128' };
  const on = await run(['--session', 'one', 'open', 'https://example.com'], { ...proxied, HERMIT_CREDPROXY_DIR: mount });
  expect(on.code).toBe(0);
  expect(on.data.env.HTTPS_PROXY).toBeUndefined();
  expect(on.data.env.https_proxy).toBeUndefined();
  expect(on.data.env.HTTP_PROXY).toBe('http://corp:3128');
  const off = await run(['--session', 'one', 'open', 'https://example.com'], { HTTPS_PROXY: 'http://corp:3128', HERMIT_CREDPROXY_DIR: path.join(mount, 'absent') });
  expect(off.data.env.HTTPS_PROXY).toBe('http://corp:3128');
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
  const flags = ['--profile', '/unmanaged', '--args=--bad', '--executable-path', '/bad', '--namespace', 'other', '--session-name', 'kept', '--config', '/bad.json', '--idle-timeout', '10s', '--headed', 'false', '--user-agent', 'bad', '--user-agent=also-bad'];
  const persistent = await run(['--task', 'task', ...flags, 'open', 'https://example.com'], { AGENT_BROWSER_USER_AGENT: 'ambient' });
  expect(persistent.data.argv).toEqual(['open', 'https://example.com']);
  expect(persistent.data.env.AGENT_BROWSER_PROFILE).toBe('/home/claude/.claude/browser/profile');
  expect(persistent.data.env.AGENT_BROWSER_USER_AGENT).toBeUndefined();
  const anonymous = await run(['--session', 'public', ...flags, 'open', 'https://example.com'], { AGENT_BROWSER_USER_AGENT: 'ambient' });
  expect(anonymous.data.argv).toEqual(['--session', 'public', 'open', 'https://example.com']);
  expect(anonymous.data.env.AGENT_BROWSER_PROFILE).toBeUndefined();
  expect(anonymous.data.env.AGENT_BROWSER_USER_AGENT).toBeUndefined();
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
  const marker = path.join(dir, '../marker');
  fs.writeFileSync(marker, 'display=plugin\n');
  const oldImage = await run(argv);
  expect(oldImage.data.env.AGENT_BROWSER_EXECUTABLE_PATH).toBe('/opt/chrome-linux64/chrome');
  expect(oldImage.data.env.AGENT_BROWSER_ARGS.split('\n')).toEqual([
    '--no-sandbox', '--host-resolver-rules=MAP 169.254.* ^NOTFOUND', '--disable-blink-features=AutomationControlled',
  ]);
  fs.writeFileSync(marker, 'display=plugin\nchrome=156.0.8078.80\n');
  const result = await run(argv);
  expect(result.data.env.AGENT_BROWSER_ARGS.split('\n')).toEqual([
    '--no-sandbox', '--host-resolver-rules=MAP 169.254.* ^NOTFOUND', '--disable-blink-features=AutomationControlled',
    '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  ]);
  expect(await ensureDisplay(dir, { deployment: 'container', platform: 'linux', marker, available: false })).toEqual({ blocker: 'display_start_failed' });
  fs.writeFileSync(marker, 'display=plugin\nchrome=156.bad\n');
  expect((await run(argv)).data.env.AGENT_BROWSER_ARGS).not.toContain('--user-agent=');
});

test('host anonymous sessions derive the Chrome major from the installed directory', async () => {
  const { dir, run } = fixture();
  const data = path.join(dir, '../browser-data');
  const install = path.join(data, '0.41.0-156.0.8078.80');
  fs.mkdirSync(path.join(install, 'chrome'), { recursive: true });
  for (const file of ['agent-browser', 'chrome/chrome']) fs.writeFileSync(path.join(install, file), '', { mode: 0o755 });
  fs.writeFileSync(path.join(install, 'config.json'), '{}');
  fs.writeFileSync(path.join(install, 'complete.json'), '{"binary":"agent-browser","chrome":"chrome/chrome"}');
  const options = { deployment: 'host' as const, data, platform: 'linux' as const };
  const result = await run(['--session', 'public', 'snapshot'], {}, options);
  expect(result.data.env.AGENT_BROWSER_ARGS.split('\n')).toEqual([
    '--host-resolver-rules=MAP 169.254.* ^NOTFOUND', '--disable-blink-features=AutomationControlled',
    '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  ]);
  fs.renameSync(install, path.join(data, '0.41.0-preview-157.0.1.2'));
  expect((await run(['--session', 'public', 'snapshot'], {}, options)).data.env.AGENT_BROWSER_ARGS).toContain('Chrome/157.0.0.0');
  fs.renameSync(path.join(data, '0.41.0-preview-157.0.1.2'), path.join(data, '0.41.0-unknown'));
  expect((await run(['--session', 'public', 'snapshot'], {}, options)).data.env.AGENT_BROWSER_ARGS).not.toContain('--user-agent=');
});

test('Docker display blockers name the image rebuild', async () => {
  const { dir, run } = fixture();
  browserLease('claim', 'task', dir);
  const parked = path.join(dir, 'state/Dockerfile.hermit.20261103.upstream');
  fs.writeFileSync(parked, 'new template');
  let result = await run(['--task', 'task', 'snapshot'], { TEST_BLOCKER: 'image_missing' });
  expect(result.data).toMatchObject({ error: 'browser_display_missing', reason: 'image_missing' });
  expect(result.data.detail).toContain('hermitd update');
  expect(result.data.detail).not.toContain(parked);
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

const STORE_FILE = '.claude.local/channels/demo/.env';
const SINK = 'data:text/html,<textarea id=p></textarea>';
const TEST_SECRET = 'synthetic-token=abc';

function storeFixture() {
  const { root, dir, binary, run, runCaptured } = fixture();
  const { id } = mutateTask(dir, 'open', undefined, { title: 'Save credential', requester: 'operator', done: 'saved' }, '') as { id: string };
  browserLease('claim', id, dir);
  const log = path.join(root, 'argv.jsonl');
  fs.writeFileSync(log, '');
  fs.writeFileSync(binary, `#!${process.execPath}
import fs from 'node:fs';
const args = process.argv.slice(2);
const verb = args.join(' ');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
console.error(${JSON.stringify(TEST_SECRET)});
if (process.env.TEST_FAIL === verb) {
  console.log(${JSON.stringify(TEST_SECRET)});
  process.exit(7);
}
if (args[0] === '--json') {
  console.log(JSON.stringify({ success: true, data: { value: process.env.TEST_VALUE ?? ${JSON.stringify(TEST_SECRET)} } }));
} else if (args[0] === 'snapshot' || args[0] === 'close') {
  console.log(JSON.stringify({ argv: args }));
} else {
  console.log(${JSON.stringify(TEST_SECRET)});
}
`, { mode: 0o755 });
  const invoke = (args: string[], env?: Record<string, string>) => runCaptured(['--task', id, ...args], env);
  const store = (env?: Record<string, string>) => invoke(['store-copied', 'TOKEN', STORE_FILE], env);
  const handBack = () => {
    const opts = { login: 'admin', admins: ['admin'], chromeAlive: () => true };
    mutateTask(dir, 'block', id, { 'waiting-on': 'admin', 'status-line': 'Copy token', next: 'Save token' }, '');
    const { epoch } = browserLease('takeover', id, dir, Date.now(), opts);
    browserLease('hand-back', undefined, dir, Date.now(), { ...opts, generation: epoch });
  };
  const lease = () => browserLease('inspect', undefined, dir);
  const commands = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { dir, root, id, run, invoke, store, handBack, lease, commands };
}

const armed = { code: 0, data: { status: 'armed', var: 'TOKEN' }, stderr: '' };
const refused = (reason: string) => ({ code: 0, data: { status: 'refused', reason }, stderr: '' });

test('store-copied arms, waits for hand back and privately saves the copied value', async () => {
  const { store, handBack, lease, commands, root } = storeFixture();
  expect(await store()).toMatchObject(armed);
  const placeholder = lease().pending_store!.placeholder;
  const prepare = [['tab', 'new', SINK], ['fill', '#p', placeholder], ['press', 'Control+a'], ['clipboard', 'copy'], ['tab', 'close']];
  expect(commands()).toEqual(prepare);
  expect(await store()).toMatchObject(armed);
  expect(commands()).toEqual(prepare);
  handBack();
  const result = await store();
  expect(result).toMatchObject({ code: 0, data: { status: 'saved', var: 'TOKEN', length: TEST_SECRET.length }, stderr: '' });
  expect(result.stdout).not.toContain(TEST_SECRET);
  expect(commands()).toEqual([...prepare, ['open', SINK], ['click', '#p'], ['clipboard', 'paste'],
    ['--json', 'get', 'value', '#p'], ['fill', '#p', placeholder], ['press', 'Control+a'], ['clipboard', 'copy'], ['open', 'about:blank']]);
  expect(lease().pending_store).toBeUndefined();
  const file = path.join(root, STORE_FILE);
  expect(fs.readFileSync(file, 'utf8')).toBe(`TOKEN=${TEST_SECRET}\n`);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});

test('only store-copied or close passes for the preparing task and a new holder cleans up first', async () => {
  const { dir, id, run, invoke, store, lease, commands } = storeFixture();
  expect(await store()).toMatchObject(armed);
  const placeholder = lease().pending_store!.placeholder;
  expect(await invoke(['snapshot'])).toMatchObject(refused('store_pending'));
  expect(await invoke(['open', 'close'])).toMatchObject(refused('store_pending'));
  expect(commands()).toHaveLength(5);
  browserLease('release', id, dir);
  browserLease('claim', 'next', dir);
  expect(await run(['--task', 'next', 'snapshot'])).toMatchObject({ code: 0, data: { argv: ['snapshot'] } });
  expect(commands().slice(5)).toEqual([['open', SINK], ['fill', '#p', placeholder], ['press', 'Control+a'],
    ['clipboard', 'copy'], ['open', 'about:blank'], ['snapshot']]);
  expect(lease().pending_store).toBeUndefined();
});

test('validates preparation, refuses mismatches and supports cancel and close', async () => {
  const { invoke, store, lease, commands } = storeFixture();
  expect(await invoke(['store-copied', 'token', STORE_FILE])).toMatchObject(refused('bad_name'));
  expect(await invoke(['store-copied', 'TOKEN', '.env'])).toMatchObject(refused('bad_destination'));
  expect(await invoke(['--session', 'test', 'store-copied', 'TOKEN', STORE_FILE])).toMatchObject(refused('persistent_only'));
  expect(commands()).toEqual([]);
  expect(await store()).toMatchObject(armed);
  expect(await invoke(['store-copied', 'OTHER', STORE_FILE])).toMatchObject(refused('mismatch'));
  expect(await invoke(['store-copied', 'TOKEN', '.claude.local/other/.env'])).toMatchObject(refused('mismatch'));
  expect(await invoke(['store-copied', '--cancel'])).toMatchObject({ code: 0, data: { status: 'cancelled' }, stderr: '' });
  expect(commands().at(-1)).toEqual(['open', 'about:blank']);
  expect(lease().pending_store).toBeUndefined();
  expect(await store()).toMatchObject(armed);
  expect(await invoke(['close'])).toMatchObject({ code: 0, data: { argv: ['close'] } });
  expect(lease().pending_store).toBeUndefined();
});

test.each([
  ['', 'nothing_copied'], [null, 'nothing_copied'], ['a\nb', 'multiline'], ['a b', 'bad_value'],
  ['a\u0001b', 'bad_value'], ['é'.repeat(2049), 'bad_value'],
])('refuses unsafe or absent clipboard values (%#)', async (value, reason) => {
  const { store, handBack, lease, root, commands } = storeFixture();
  expect(await store()).toMatchObject(armed);
  const placeholder = lease().pending_store!.placeholder;
  handBack();
  expect(await store({ TEST_VALUE: value ?? placeholder })).toMatchObject(refused(reason!));
  expect(lease().pending_store).toBeUndefined();
  expect(commands().at(-1)).toEqual(['open', 'about:blank']);
  expect(fs.existsSync(path.join(root, STORE_FILE))).toBe(false);
});

test('upstream failures hide output both before and after writing the file', async () => {
  const { store, handBack, lease, root, commands } = storeFixture();
  expect(await store()).toMatchObject(armed);
  handBack();
  let result = await store({ TEST_FAIL: '--json get value #p' });
  expect(result).toMatchObject({ code: 1, data: { error: 'store_failed:get_value' }, stderr: '' });
  expect(result.stdout).not.toContain(TEST_SECRET);
  expect(commands().at(-1)).toEqual(['open', 'about:blank']);
  expect(lease().pending_store).toBeUndefined();
  expect(fs.existsSync(path.join(root, STORE_FILE))).toBe(false);
  expect(await store()).toMatchObject(armed);
  handBack();
  result = await store({ TEST_FAIL: 'open about:blank' });
  expect(result).toMatchObject({
    code: 0, data: { status: 'saved', var: 'TOKEN', length: TEST_SECRET.length, cleanup: 'failed' }, stderr: '',
  });
  expect(result.stdout).not.toContain(TEST_SECRET);
  expect(lease().pending_store).toBeUndefined();
  expect(fs.readFileSync(path.join(root, STORE_FILE), 'utf8')).toContain(TEST_SECRET);
});

test('a preparation that fails before its tab opens leaves the console page alone', async () => {
  const { store, lease, commands } = storeFixture();
  const result = await store({ TEST_FAIL: `tab new ${SINK}` });
  expect(result).toMatchObject({ code: 1, data: { error: 'store_failed:tab_new' }, stderr: '' });
  expect(commands()).toEqual([['tab', 'new', SINK]]);
  expect(lease().pending_store).toBeUndefined();
});
