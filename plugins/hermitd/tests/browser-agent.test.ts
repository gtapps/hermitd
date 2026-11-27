import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { browserSocketDir } from '../scripts/browser-agent';
import { ensureDisplay } from '../scripts/browser-display';
import { browserLease } from '../scripts/lib/browser-lease';
import { mutateTask } from '../scripts/lib/tasks';
import { browserUserAgent } from '../scripts/lib/browser-runtime';
import { freshDirFactory, writeConfig } from './helpers/workdir';
import { PLUGIN_ROOT } from './helpers/run';

const DOCKER_WEBGL = ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader-webgl'];
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
  const browserData = path.join(root, 'browser-data');
  const callsFile = path.join(root, 'binary-calls');
  fs.writeFileSync(binary, `#!${process.execPath}
import fs from 'node:fs';
const argv = process.argv.slice(2);
const env = process.env;
const stdin = argv.includes('--password-stdin') ? await Bun.stdin.text() : '';
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ argv, stdin, env }) + '\\n');
if (argv[2] === 'auth' && argv[3] === 'list') {
  console.log(env.TEST_AUTH_LIST ?? JSON.stringify({ success: true, data: { profiles: [] } }));
} else if (argv.includes('--password-stdin')) {
  console.log(stdin);
  console.error(stdin);
} else {
  console.log(JSON.stringify({ argv, env }));
}
process.exit(Number((argv[3] === 'save' ? env.TEST_SAVE_EXIT : undefined) ?? env.TEST_EXIT ?? 0));
`, { mode: 0o755 });
  type RunOptions = { deployment?: 'host' | 'container'; data?: string; platform?: NodeJS.Platform; takeoverReset?: boolean };
  // With a file, a shell appends stdout and stderr to it the way the Bash tool collects output.
  const spawnAgent = (argv: string[], env: Record<string, string>, options: RunOptions, stdin: string | undefined, file?: string) => Bun.spawn([...file ? ['sh', '-c', 'exec "$@" >>"$OUTPUT_FILE" 2>&1', 'sh'] : [], process.execPath, '-e', `import { runBrowserAgent } from ${JSON.stringify(path.join(PLUGIN_ROOT, 'scripts/browser-agent.ts'))}; process.exitCode = await runBrowserAgent(${JSON.stringify(argv)}, ${JSON.stringify(binary)}, () => true, { deployment: 'container', browserData: ${JSON.stringify(browserData)}, marker: ${JSON.stringify(path.join(root, 'marker'))}, ...${JSON.stringify(options)}, ensureDisplay: async () => {
      const fs = await import('node:fs');
      fs.appendFileSync(${JSON.stringify(path.join(root, 'display-calls'))}, 'ensure\\n');
      return process.env.TEST_BLOCKER ? { blocker: process.env.TEST_BLOCKER } : JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, 'state/browser-display.json'))}, 'utf8'));
    } });`], {
      cwd: root, env: { ...process.env, HOME: root, AGENT_DIR: dir, HERMIT_PLUGIN_ROOT: PLUGIN_ROOT, DISPLAY: ':99', AGENT_BROWSER_PROFILE: '/bad', AGENT_BROWSER_HEADED: '1', AGENT_BROWSER_IDLE_TIMEOUT_MS: '15', XDG_RUNTIME_DIR: '/run/shared', ...file ? { OUTPUT_FILE: file } : {}, ...env }, stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe',
    });
  const runCaptured = async (argv: string[], env: Record<string, string> = {}, options: RunOptions = {}, stdin?: string) => {
    const child = spawnAgent(argv, env, options, stdin);
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr, data: JSON.parse(stdout) };
  };
  const runToFile = async (argv: string[]) => {
    const file = path.join(root, 'shared-output');
    fs.writeFileSync(file, 'before\n');
    await spawnAgent(argv, {}, {}, undefined, file).exited;
    return fs.readFileSync(file, 'utf8');
  };
  const run = async (...args: Parameters<typeof runCaptured>) => {
    const { code, stderr, data } = await runCaptured(...args);
    return { code, stderr, data };
  };
  const calls = (): { argv: string[]; stdin: string; env: Record<string, string> }[] =>
    fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line)) : [];
  return { dir, root, binary, browserData, socket, run, runCaptured, runToFile, calls };
}

test('concurrent first calls and later calls use one private vault key instead of the ambient key', async () => {
  const { browserData, run } = fixture();
  const [first, concurrent] = await Promise.all([
    run(['--session', 'one', 'snapshot'], { AGENT_BROWSER_ENCRYPTION_KEY: 'ambient' }),
    run(['--session', 'two', 'snapshot']),
  ]);
  const file = path.join(browserData, 'vault.key');
  const key = fs.readFileSync(file, 'utf8');
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(first.data.env.AGENT_BROWSER_ENCRYPTION_KEY).toBe(key);
  expect(concurrent.data.env.AGENT_BROWSER_ENCRYPTION_KEY).toBe(key);
  const later = await run(['--session', 'one', 'snapshot']);
  expect(later.data.env.AGENT_BROWSER_ENCRYPTION_KEY).toBe(key);
  expect(fs.readdirSync(browserData).filter(name => name.startsWith('vault.key'))).toEqual(['vault.key']);
});

test('passthrough always denies vault writes and also denies login when saved logins are off', async () => {
  const deny = ['auth_save', 'auth_delete', 'credentials_set', 'credentials_delete'];
  for (const config of [undefined, { approvals: 'personal', browser: { saved_logins: true } },
    { approvals: 'team' }, { browser: { saved_logins: false } }]) {
    const { root, socket, run } = fixture();
    if (config) writeConfig(root, config);
    const result = await run(['--session', 'public', 'snapshot'], { AGENT_BROWSER_ACTION_POLICY: '/ambient.json' });
    const policy = path.join(socket, 'policy.json');
    expect(result.code).toBe(0);
    expect(result.data.env.AGENT_BROWSER_ACTION_POLICY).toBe(policy);
    expect(JSON.parse(fs.readFileSync(policy, 'utf8'))).toEqual({
      default: 'allow',
      deny: config?.browser?.saved_logins === false ? [...deny, 'auth_login'] : deny,
    });
  }
});

test('container vault directories are private and the same link is reused', async () => {
  const { browserData, root, run } = fixture();
  const home = path.join(root, '.agent-browser');
  const auth = path.join(home, 'auth');
  const vault = path.join(browserData, 'vault');
  for (let call = 0; call < 2; call++) {
    expect((await run(['--session', 'public', 'snapshot'])).code).toBe(0);
    expect(fs.readlinkSync(auth)).toBe(vault);
    for (const dir of [home, vault]) expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    if (call === 0) fs.writeFileSync(path.join(auth, 'entry'), 'existing');
  }
  expect(fs.readFileSync(path.join(vault, 'entry'), 'utf8')).toBe('existing');
});

test('container vault setup preserves existing auth directories and ignores setup errors', async () => {
  const { browserData, root, run } = fixture();
  const auth = path.join(root, '.agent-browser', 'auth');
  fs.mkdirSync(auth, { recursive: true });
  const home = path.dirname(auth);
  fs.chmodSync(home, 0o755);
  fs.writeFileSync(path.join(auth, 'entry'), 'existing');
  expect((await run(['--session', 'public', 'snapshot'])).code).toBe(0);
  expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  expect(fs.lstatSync(auth).isDirectory()).toBe(true);
  expect(fs.readFileSync(path.join(auth, 'entry'), 'utf8')).toBe('existing');
  const vault = path.join(browserData, 'vault');
  fs.rmdirSync(vault);
  fs.writeFileSync(vault, 'blocked');
  expect((await run(['--session', 'public', 'snapshot'], { TEST_EXIT: '7' })).code).toBe(7);
});

test('host deployment leaves the upstream vault and home alone', async () => {
  const { browserData, root, run } = fixture();
  expect((await run(['--session', 'public', 'snapshot'], {}, { deployment: 'host' })).code).toBe(0);
  expect(fs.existsSync(path.join(root, '.agent-browser'))).toBe(false);
  expect(fs.existsSync(path.join(browserData, 'vault'))).toBe(false);
});

const saveLogin = ['save-login', 'example', '--url', 'https://example.com/login', '--username', 'agent'];
const deleteLogin = ['delete-login', 'example'];
const authList = (...profiles: object[]) => ({ TEST_AUTH_LIST: JSON.stringify({ success: true, data: { profiles } }) });
const savedCommand = ['auth', 'save', ...saveLogin.slice(1), '--password-stdin'];

test('personal save sends the password only on stdin in a private session without admission or policy', async () => {
  const { root, browserData, socket, calls, runCaptured } = fixture();
  writeConfig(root, { approvals: 'personal' });
  const password = 'fixture password ';
  const result = await runCaptured(saveLogin, { AGENT_BROWSER_ACTION_POLICY: '/ambient.json' }, {}, password + '\n');
  expect(result).toMatchObject({ code: 0, stderr: '', data: { status: 'saved', login: 'example' } });
  expect(result.stdout).not.toContain(password);
  const children = calls();
  expect(children.map(child => child.argv.slice(2))).toEqual([['auth', 'list', '--json'], savedCommand, ['close']]);
  expect(children.map(child => child.stdin)).toEqual(['', password, '']);
  const session = children[0].argv[1];
  expect(session).toMatch(/^login-/);
  const key = fs.readFileSync(path.join(browserData, 'vault.key'), 'utf8');
  for (const { argv, env } of children) {
    expect(argv.slice(0, 2)).toEqual(['--session', session]);
    expect(argv).not.toContain(password);
    expect(env.AGENT_BROWSER_ACTION_POLICY).toBeUndefined();
    expect(env.AGENT_BROWSER_SOCKET_DIR).not.toBe(socket);
    expect(env.AGENT_BROWSER_ENCRYPTION_KEY).toBe(key);
  }
  expect(fs.existsSync(path.join(socket, 'admissions.json'))).toBe(false);
});

test('a failed save hides upstream output and closes the session', async () => {
  const { calls, runCaptured } = fixture();
  const result = await runCaptured(saveLogin, { TEST_SAVE_EXIT: '7' }, {}, 'fixture secret');
  expect(result).toMatchObject({ code: 1, stderr: '', data: { error: 'login_failed:save' } });
  expect(result.stdout).not.toContain('fixture secret');
  expect(calls().map(child => child.argv.slice(2))).toEqual([['auth', 'list', '--json'], savedCommand, ['close']]);
});

test('delete checks ownership then deletes and closes without policy', async () => {
  const { calls, run } = fixture();
  expect(await run(deleteLogin, authList({ name: 'example' }))).toMatchObject({ code: 0, data: { status: 'deleted', login: 'example' } });
  expect(calls().map(child => child.argv.slice(2))).toEqual([['auth', 'list', '--json'], ['auth', 'delete', 'example'], ['close']]);
  expect(calls().every(child => child.env.AGENT_BROWSER_ACTION_POLICY === undefined)).toBe(true);
});

test('empty input and an unlinked container vault are refused before invoking the binary', async () => {
  const { root, calls, run } = fixture();
  expect(await run(saveLogin, {}, {}, '\n')).toMatchObject({ code: 0, data: { status: 'refused', reason: 'empty_password' } });
  const auth = path.join(root, '.agent-browser', 'auth');
  fs.unlinkSync(auth);
  fs.mkdirSync(auth);
  expect(await run(saveLogin, {}, {}, 'fixture secret')).toMatchObject({ code: 0, data: { status: 'refused', reason: 'vault_not_linked' } });
  expect(calls()).toEqual([]);
});

test('unreadable entries and malformed lists fail closed, and deleting a missing entry is refused', async () => {
  for (const [argv, env, reason] of [
    [saveLogin, authList({ name: 'example', error: 'Failed to decrypt' }), 'name_taken'],
    [saveLogin, { TEST_AUTH_LIST: 'invalid' }, 'name_taken'],
    [deleteLogin, authList({ name: 'example', error: null }), 'name_taken'],
    [deleteLogin, authList(), 'not_found'],
  ] as const) {
    const { calls, run } = fixture();
    expect(await run(argv, env, {}, 'fixture secret')).toMatchObject({ code: 0, data: { status: 'refused', reason } });
    expect(calls().map(child => child.argv.slice(2))).toEqual([['auth', 'list', '--json'], ['close']]);
  }
});

test('team login changes require a terminal and logins switched off can still be deleted', async () => {
  const { root, calls, run } = fixture();
  writeConfig(root, { approvals: 'team' });
  for (const argv of [saveLogin, deleteLogin]) {
    expect(await run(argv, {}, {}, 'fixture secret')).toMatchObject({ code: 0, data: { status: 'refused', reason: 'terminal_only' } });
  }
  writeConfig(root, { browser: { saved_logins: false } });
  expect(await run(saveLogin, {}, {}, 'fixture secret')).toMatchObject({ code: 0, data: { status: 'refused', reason: 'saved_logins_off' } });
  expect(calls()).toEqual([]);
  expect(await run(deleteLogin, authList({ name: 'example' }))).toMatchObject({ code: 0, data: { status: 'deleted', login: 'example' } });
});

test('passthrough preserves raw auth arguments and strips attempts to replace the policy', async () => {
  const { root, socket, run } = fixture();
  writeConfig(root, { approvals: 'personal' });
  const argv = ['--session', 'public', 'auth', 'save', 'n', '--url', 'u', '--username', 'x', '--password', 'p'];
  const result = await run([...argv, '--action-policy', '/other.json', '--action-policy=/other.json']);
  expect(result.data.argv).toEqual(argv);
  expect(result.data.env.AGENT_BROWSER_ACTION_POLICY).toBe(path.join(socket, 'policy.json'));
});

test('login writes reject values that the upstream binary could treat as options', async () => {
  const { calls, run } = fixture();
  for (const argv of [['delete-login', '--json'], [...saveLogin.slice(0, -1), '-p']]) {
    expect(await run(argv, {}, {}, 'fixture secret')).toMatchObject({ code: 1, data: { error: 'login_failed:arguments' } });
  }
  expect(calls()).toEqual([]);
});

test('persistent commands require a live claim, renew it and preserve argv and exit code', async () => {
  const { dir, run } = fixture();
  expect(await run(['open', 'https://example.com'])).toMatchObject({ code: 1, data: { error: 'browser_not_claimed' } });
  browserLease('claim', 'task-a', dir, Date.now() - 5000);
  const before = browserLease('status', undefined, dir).expires_at!;
  const result = await run(['--task', 'task-a', 'open', 'https://example.com/a?x=1&y=two words'], { TEST_EXIT: '7' });
  expect(result.code).toBe(7);
  expect(result.data.argv).toEqual(['open', 'https://example.com/a?x=1&y=two words']);
  expect(result.data.env).toMatchObject({ DISPLAY: ':17', AGENT_BROWSER_HEADED: '1', AGENT_BROWSER_PROFILE: '/home/claude/.claude/browser/profile', AGENT_BROWSER_ARGS: ['--no-sandbox', '--host-resolver-rules=MAP 169.254.* ^NOTFOUND', '--disable-blink-features=AutomationControlled', ...DOCKER_WEBGL, '--window-size=500,1082', '--window-position=0,0'].join('\n'), AGENT_BROWSER_IDLE_TIMEOUT_MS: '0' });
  expect(browserLease('status', undefined, dir).expires_at!).toBeGreaterThan(before);
});

test('the browser gets a usable configured time zone, else the inherited one', async () => {
  const { dir, root, run } = fixture();
  writeConfig(root, { timezone: 'Europe/Lisbon' });
  expect((await run(['--session', 'public', 'snapshot'], { TZ: 'Asia/Tokyo' })).data.env.TZ).toBe('Europe/Lisbon');
  browserLease('claim', 'task', dir);
  expect((await run(['--task', 'task', 'snapshot'], { TZ: 'Asia/Tokyo' })).data.env.TZ).toBe('Europe/Lisbon');
  const unset = fixture();
  writeConfig(unset.root, { timezone: null });
  expect((await unset.run(['--session', 'public', 'snapshot'], { TZ: 'Asia/Tokyo' })).data.env.TZ).toBe('Asia/Tokyo');
  writeConfig(unset.root, { timezone: 'Not/A_Zone' });
  expect((await unset.run(['--session', 'public', 'snapshot'], { TZ: 'Asia/Tokyo' })).data.env.TZ).toBe('Asia/Tokyo');
});

test('output survives when stdout and stderr share a file and stderr is empty', async () => {
  const { runToFile } = fixture();
  const output = await runToFile(['--session', 'public', 'get', 'url']);
  expect(output.startsWith('before\n')).toBe(true);
  expect(JSON.parse(output.slice('before\n'.length)).argv).toEqual(['--session', 'public', 'get', 'url']);
});

test('a signed-in viewport override is marked until close, and the takeover reset needs no claim', async () => {
  const { dir, run } = fixture();
  const marker = path.join(browserSocketDir(dir), 'viewport-override');
  browserLease('claim', 'task', dir);
  expect((await run(['--task', 'task', 'snapshot'])).code).toBe(0);
  expect(fs.existsSync(marker)).toBe(false);
  expect((await run(['--task', 'task', 'set', 'viewport', '1280', '900'])).code).toBe(0);
  expect(fs.existsSync(marker)).toBe(true);
  expect((await run(['--task', 'task', 'close'])).code).toBe(0);
  expect(fs.existsSync(marker)).toBe(false);
  expect((await run(['--session', 'public', 'set', 'device', 'iPhone 15'])).code).toBe(0);
  expect(fs.existsSync(marker)).toBe(false);
  browserLease('release', 'task', dir);
  const reset = await run(['set', 'viewport', '500', '935'], {}, { takeoverReset: true });
  expect(reset.code).toBe(0);
  expect(reset.data.argv).toEqual(['set', 'viewport', '500', '935']);
  expect(fs.existsSync(marker)).toBe(false);
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
    '--no-sandbox', '--host-resolver-rules=MAP 169.254.* ^NOTFOUND', '--disable-blink-features=AutomationControlled', ...DOCKER_WEBGL,
  ]);
  fs.writeFileSync(marker, 'display=plugin\nchrome=156.0.8078.80\n');
  const result = await run(argv);
  expect(result.data.env.AGENT_BROWSER_ARGS.split('\n')).toEqual([
    '--no-sandbox', '--host-resolver-rules=MAP 169.254.* ^NOTFOUND', '--disable-blink-features=AutomationControlled', ...DOCKER_WEBGL,
    '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
  ]);
  expect(await ensureDisplay(dir, { deployment: 'container', platform: 'linux', marker, available: false })).toEqual({ blocker: 'display_start_failed' });
  fs.writeFileSync(marker, 'display=plugin\nchrome=156.bad\n');
  expect((await run(argv)).data.env.AGENT_BROWSER_ARGS).not.toContain('--user-agent=');
});

test('browser config turns software WebGL off and appends operator Chrome flags', async () => {
  const { root, run } = fixture();
  writeConfig(root, { browser: { software_webgl: false, chrome_args: ['--lang=pt-PT', '--disable-features=A,B', '--no-sandbox'] } });
  const result = await run(['--session', 'public', 'snapshot']);
  expect(result.data.env.AGENT_BROWSER_ARGS.split('\n')).toEqual([
    '--no-sandbox', '--host-resolver-rules=MAP 169.254.* ^NOTFOUND', '--disable-blink-features=AutomationControlled',
    '--lang=pt-PT', '--disable-features=A,B', '--no-sandbox',
  ]);
});

test('browser config refuses Chrome flags that override the wrapper policy', async () => {
  const refused: [unknown, string][] = [
    ['--remote-debugging-address=0.0.0.0', '--remote-debugging-address'], ['--host-resolver-rules=MAP * 1.2.3.4', '--host-resolver-rules'],
    ['--load-extension', '--load-extension'], ['--user-data-dir=/tmp/x', '--user-data-dir'], ['--disable-web-security', '--disable-web-security'],
    ['--lang=pt\n--headless', '--lang'], ['--lang=pt, --headless', '--lang'], ['--headless ', '--headless'], ['lang=pt', 'lang'], [7, 'not_a_string'],
  ];
  for (const [arg, flag] of refused) {
    const { root, run, calls } = fixture();
    writeConfig(root, { browser: { chrome_args: [arg] } });
    expect(await run(['--session', 'public', 'snapshot'])).toMatchObject({ code: 1, data: { error: `browser_arg_refused:${flag}` } });
    expect(calls()).toEqual([]);
  }
  const { dir, root, run } = fixture();
  const data = path.join(dir, '../browser-data');
  const install = path.join(data, '0.41.0-156.0.8078.80');
  fs.mkdirSync(path.join(install, 'chrome'), { recursive: true });
  for (const file of ['agent-browser', 'chrome/chrome']) fs.writeFileSync(path.join(install, file), '', { mode: 0o755 });
  fs.writeFileSync(path.join(install, 'config.json'), '{}');
  fs.writeFileSync(path.join(install, 'complete.json'), '{"binary":"agent-browser","chrome":"chrome/chrome"}');
  writeConfig(root, { browser: { chrome_args: ['--no-sandbox'] } });
  expect(await run(['--session', 'public', 'snapshot'], {}, { deployment: 'host', data, platform: 'linux' })).toMatchObject({ code: 1, data: { error: 'browser_arg_refused:--no-sandbox' } });
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
    '--host-resolver-rules=MAP 169.254.* ^NOTFOUND', '--disable-blink-features=AutomationControlled', '--enable-unsafe-swiftshader',
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
