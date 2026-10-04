import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { openTask } from './helpers/tasks';
import { markGuest } from '../scripts/lib/guest-marker';
import { inboundSince } from '../scripts/lib/channel-log';
import { startHttpStub } from './helpers/http-stub';

const workdirs: Workdir[] = [];
afterAll(() => workdirs.forEach(w => w.cleanup()));
function fixture() {
  const wd = setupWorkdir();
  workdirs.push(wd);
  const dir = path.join(wd.dir, '.hermit');
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ timezone: 'UTC', channels: {
    telegram: { enabled: true, allowed_users: ['u1'], dm_channel_id: '12345', bot_username: 'bot', bot_user_id: '777' },
  } }));
  fs.writeFileSync(path.join(dir, 'state/runtime.json'), JSON.stringify({ version: 1, cc_session_id: 'resident', runtime_mode: 'interactive' }));
  return { wd, dir };
}
function envelope(body: string, user = 'u1') {
  return `<channel source="telegram" chat_id="12345" user="${user}">${body}</channel>`;
}
async function call(wd: Workdir, verb: string, payload = '', session = 'resident', env = {}) {
  const result = await runScript('harness-mod.ts', { cwd: wd.dir,
    env: { AGENT_DIR: path.join(wd.dir, '.hermit'), ...env }, args: [verb, session, payload] });
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout);
}

test('interactive resident accepts trusted commands and intake writes only audit state', async () => {
  const { wd, dir } = fixture();
  const before = fs.readFileSync(path.join(dir, 'state/runtime.json'), 'utf8');
  const result = await call(wd, 'intake', envelope('!model sonnet'));
  expect(result.decision).toBe('run');
  expect(result.commands).toEqual([{ command: '/model', arg: 'sonnet' }]);
  expect(inboundSince(dir, '2000-01-01T00:00:00Z')).toHaveLength(1);
  expect(fs.existsSync(path.join(dir, 'state/last-operator-action.json'))).toBe(true);
  for (const file of ['pending-harness-command.json', 'pending-harness-switch.json', 'harness-switch-verify.json', 'operator-turn-open.json']) {
    expect(fs.existsSync(path.join(dir, 'state', file))).toBe(false);
  }
  expect(fs.readFileSync(path.join(dir, 'state/runtime.json'), 'utf8')).toBe(before);
});

for (const body of ['<@777> !clear', '!clear@bot']) {
  test(`addresses ${body}`, async () => {
    const { wd } = fixture();
    expect((await call(wd, 'intake', envelope(body))).decision).toBe('run');
  });
}
for (const [body, user, session] of [['!clear@otherbot', 'u1', 'resident'], ['!clear', 'stranger', 'resident'], ['!clear', 'u1', 'other']]) {
  test(`passes without audit: ${body}, ${user}, ${session}`, async () => {
    const { wd, dir } = fixture();
    expect(await call(wd, 'intake', envelope(body, user), session)).toEqual({ decision: 'pass' });
    expect(fs.existsSync(path.join(dir, 'state/last-operator-action.json'))).toBe(false);
  });
}

test('guest session and every nonresident subcommand leave state untouched', async () => {
  const { wd, dir } = fixture();
  markGuest(path.join(dir, 'state'), 'guest');
  const before = fs.readdirSync(path.join(dir, 'state'));
  for (const verb of ['intake', 'loaded', 'claim', 'ack', 'finalize']) {
    expect(await call(wd, verb, envelope('!clear'), 'guest')).toEqual({ decision: 'pass' });
  }
  expect(fs.readdirSync(path.join(dir, 'state'))).toEqual(before);
});

test('worker-owned thread passes before audit; resident-owned thread runs', async () => {
  for (const owner of ['worker:a1b2c3d4e5f6a7b8c', 'resident']) {
    const { wd, dir } = fixture();
    expect((await openTask(wd.dir, dir, ['--owner', owner, '--requester', 'telegram:u1', '--conversation', 'telegram:12345'])).exitCode).toBe(0);
    expect((await call(wd, 'intake', envelope('!clear'))).decision).toBe(owner === 'resident' ? 'run' : 'pass');
    expect(fs.existsSync(path.join(dir, 'state/last-operator-action.json'))).toBe(owner === 'resident');
  }
});

test('failed and unknown outcomes write no state; ok clear records reset', async () => {
  const { wd, dir } = fixture();
  const runtimePath = path.join(dir, 'state/runtime.json');
  const before = fs.readFileSync(runtimePath, 'utf8');
  for (const status of ['failed', 'unknown']) {
    await call(wd, 'finalize', JSON.stringify({ outcomes: ['/clear', '/model', '/effort'].map(command => ({ command, arg: null, status, text: 'observed failure' })) }));
    expect(fs.readFileSync(runtimePath, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.join(dir, 'state'))).toEqual(['runtime.json']);
  }
  await call(wd, 'finalize', JSON.stringify({ outcomes: [{ command: '/clear', arg: null, status: 'ok', text: '' }] }));
  expect(JSON.parse(fs.readFileSync(runtimePath, 'utf8')).context_cleared).toBe(true);
});

test('claim respects transitions and ack preserves a newer request', async () => {
  const { wd, dir } = fixture();
  const file = path.join(dir, 'state/pending-harness-switch.json');
  const request = { commands: [{ command: '/model', arg: 'sonnet' }], by: 'terminal', requested_at: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(request));
  expect((await call(wd, 'claim')).requested_at).toBe(request.requested_at);
  await call(wd, 'ack', 'stale');
  expect(fs.existsSync(file)).toBe(true);
  fs.writeFileSync(path.join(dir, 'state/runtime.json'), JSON.stringify({ cc_session_id: 'resident', transition: 'restart' }));
  expect((await call(wd, 'claim')).decision).toBe('pass');
  await call(wd, 'ack', request.requested_at);
  expect(fs.existsSync(file)).toBe(false);
});

test('missing hermit directory is a no-op for all verbs', async () => {
  const { wd } = fixture();
  for (const verb of ['intake', 'loaded', 'claim', 'ack', 'finalize']) {
    expect(await call(wd, verb, '', 'resident', { AGENT_DIR: path.join(wd.dir, 'absent') })).toEqual({ decision: 'pass' });
  }
  expect(fs.existsSync(path.join(wd.dir, 'absent'))).toBe(false);
});

test('shutdown takes precedence and failed reply returns a relay outcome', async () => {
  const { wd, dir } = fixture();
  fs.writeFileSync(path.join(dir, 'state/runtime.json'), JSON.stringify({ cc_session_id: 'resident', shutdown_requested_at: new Date().toISOString() }));
  const result = await call(wd, 'intake', envelope('!clear'));
  expect(result.decision).toBe('refuse');
  expect((await call(wd, 'finalize', JSON.stringify(result))).decision).toBe('send_failed');
});

test('finalize sends the observed result once on Telegram', async () => {
  const { wd, dir } = fixture();
  const stub = startHttpStub();
  try {
    const channelDir = path.join(wd.dir, '.claude.local/channels/telegram');
    fs.mkdirSync(channelDir, { recursive: true });
    fs.writeFileSync(path.join(channelDir, '.env'), 'TELEGRAM_BOT_TOKEN=test-token\n');
    const result = await call(wd, 'finalize', JSON.stringify({ reply_to: { source: 'telegram', chat_id: '12345' },
      outcomes: [{ command: '/advisor', arg: 'opus', status: 'ok', text: 'Advisor set to Opus' }] }), 'resident', { HERMIT_TELEGRAM_API_URL: stub.url });
    expect(result.decision).toBe('ok');
    expect(stub.requests.length).toBe(1);
    expect(JSON.stringify(stub.requests[0])).toContain('Advisor set to Opus');
  } finally { stub.stop(); }
});

for (const command of ['/model', '/effort']) {
  test(`${command} ok records observed completion`, async () => {
    const { wd, dir } = fixture();
    await call(wd, 'finalize', JSON.stringify({ outcomes: [{ command, arg: 'target', status: 'ok', text: 'Observed success' }] }));
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'state/harness-switch-verify.json'), 'utf8'))).toMatchObject({ command, arg: 'target' });
  });
}

for (const body of ['!compact', '!advisor opus', '!effort low', '!doctor', '!checkup']) {
  test(`${body} uses the native route`, async () => {
    const { wd } = fixture();
    expect((await call(wd, 'intake', envelope(body))).decision).toBe('run');
  });
}

test('concurrent arm and stale acknowledgement preserve the new request', async () => {
  const { wd, dir } = fixture();
  const old = new Date(Date.now() - 1000).toISOString();
  const file = path.join(dir, 'state/pending-harness-switch.json');
  fs.writeFileSync(file, JSON.stringify({ commands: [{ command: '/model', arg: 'old' }], by: 'terminal', requested_at: old }));
  const [, armed] = await Promise.all([
    call(wd, 'ack', old),
    runScript('arm-harness-switch.ts', { cwd: wd.dir, args: [dir, '--model', 'sonnet'] }),
  ]);
  expect(armed.exitCode).toBe(0);
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).commands).toEqual([{ command: '/model', arg: 'sonnet' }]);
});

test('intake refuses during a lifecycle transition', async () => {
  const { wd, dir } = fixture();
  fs.writeFileSync(path.join(dir, 'state/runtime.json'), JSON.stringify({ cc_session_id: 'resident', transition: 'restart' }));
  const result = await call(wd, 'intake', envelope('!clear'));
  expect(result.decision).toBe('refuse');
  expect(result.reply_to).toEqual({ source: 'telegram', chat_id: '12345' });
});

test('claim ignores an expired deferred switch', async () => {
  const { wd, dir } = fixture();
  fs.writeFileSync(path.join(dir, 'state/pending-harness-switch.json'), JSON.stringify({
    commands: [{ command: '/model', arg: 'sonnet' }], by: 'terminal', requested_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
  }));
  expect(await call(wd, 'claim')).toEqual({ decision: 'pass' });
});

test('doctor intake runs on a non-technical install and relay writes the reply target', async () => {
  const { wd, dir } = fixture();
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(configPath, 'utf8')), operator_profile: 'non-technical' }));
  const request = await call(wd, 'intake', envelope('!doctor'));
  expect(request).toMatchObject({ decision: 'run', commands: [{ command: '/doctor', arg: null }], reply_to: { source: 'telegram', chat_id: '12345' } });
  expect(fs.existsSync(path.join(dir, 'state/pending-skill-relay.json'))).toBe(false);
  expect(await call(wd, 'relay', JSON.stringify(request))).toEqual({ decision: 'ok' });
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'state/pending-skill-relay.json'), 'utf8')))
    .toMatchObject({ command: '/doctor', arg: null, reply_to: { source: 'telegram', chat_id: '12345' } });
  await call(wd, 'finalize', JSON.stringify({ ...request, outcomes: [{ command: '/doctor', arg: null, status: 'failed', text: 'no command' }] }));
  expect(fs.existsSync(path.join(dir, 'state/pending-skill-relay.json'))).toBe(false);
});
