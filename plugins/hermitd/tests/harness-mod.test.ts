import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { openTask } from './helpers/tasks';
import { markGuest } from '../scripts/lib/guest-marker';
import { inboundSince } from '../scripts/lib/channel-log';
import { startHttpStub } from './helpers/http-stub';
import {
  claim, enqueue, finalize, legReason, outcomeStatus, parseSkill, readOutcome, recover, recordLegs, validCommand,
  INFLIGHT_DIR, OUTCOMES_DIR, QUEUE_DIR, type QueueEntry, type Unanswered,
} from '../scripts/lib/harness-mod';

const VERSION = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, '../.claude-plugin/plugin.json'), 'utf8')).version;
const workdirs: Workdir[] = [];
afterAll(() => workdirs.forEach(w => w.cleanup()));
function fixture(runtime: object = {}) {
  const wd = setupWorkdir();
  workdirs.push(wd);
  const dir = path.join(wd.dir, '.hermit');
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ timezone: 'UTC', channels: {
    telegram: { enabled: true, allowed_users: ['u1'], default_chat_id: '12345', bot_username: 'bot', bot_user_id: '777' },
  } }));
  setRuntime(dir, runtime);
  fs.writeFileSync(path.join(dir, 'state/harness-mod-loaded.json'), JSON.stringify({ session_id: 'resident' }));
  return { wd, dir };
}
function setRuntime(dir: string, extra: object = {}) {
  fs.writeFileSync(path.join(dir, 'state/runtime.json'), JSON.stringify({ version: 1, cc_session_id: 'resident', runtime_mode: 'interactive', ...extra }));
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
const listing = (dir: string, sub: string) => { try { return fs.readdirSync(path.join(dir, 'state', sub)); } catch { return []; } };
const chat = (commands: { command: string; arg: string | null }[] = [{ command: '/effort', arg: 'low' }]) => ({ source: 'chat' as const, by: 'u1', commands, reply_to: { source: 'telegram', chat_id: '12345' } });
function idleExecution(dir: string) {
  fs.writeFileSync(path.join(dir, 'state/execution.json'), JSON.stringify({
    state: 'idle', turn_id: 't', at: new Date(Date.now() - 120_000).toISOString(), source: 'heartbeat', cc_session_id: 'resident', reason: null,
  }));
}

// --- Queue library ---

test('per-command validation keeps each contract', () => {
  for (const command of [
    { command: '/advisor', arg: 'opus' }, { command: '/doctor', arg: null }, { command: '/compact', arg: null },
    { command: '/compact', arg: 'focus on unfinished work' }, { command: '/reload-plugins', arg: null },
    { command: '/hermitd:hermit-evolve', arg: 'unattended' }, { command: '/hermitd:heartbeat', arg: null },
  ]) expect(validCommand(command)).toBe(true);
  for (const command of [
    { command: '/advisor', arg: null }, { command: '/model', arg: 'a b' }, { command: '/clear', arg: 'x' },
    { command: '/permission-mode', arg: 'auto' }, { command: '/compact', arg: 'line\n/clear' },
    { command: '/hermitd:x', arg: 'a'.repeat(513) }, { command: '/rm', arg: null }, { command: '/hermitd:../x', arg: null },
  ]) expect(validCommand(command)).toBe(false);
  const { dir } = fixture();
  expect(() => enqueue(dir, { source: 'chat', commands: [{ command: '/advisor', arg: null }] })).toThrow('invalid_command');
});

test('claims in FIFO order and a pause goes first', () => {
  const { dir } = fixture();
  const now = Date.now();
  const a = enqueue(dir, chat(), now);
  const b = enqueue(dir, chat([{ command: '/model', arg: 'sonnet' }]), now + 1);
  const p = enqueue(dir, { source: 'pause', commands: [] }, now + 2);
  const ids = [claim(dir, 'resident', VERSION)?.id, claim(dir, 'resident', VERSION)?.id, claim(dir, 'resident', VERSION)?.id];
  expect(ids).toEqual([p, a, b].map(r => (r as { id: string }).id));
  expect(claim(dir, 'resident', VERSION)).toBeNull();
  expect(listing(dir, INFLIGHT_DIR)).toHaveLength(3);
});

test('pause-only claim leaves ordinary work queued', () => {
  const { dir } = fixture();
  enqueue(dir, chat());
  expect(claim(dir, 'resident', VERSION, { pauseOnly: true })).toBeNull();
  expect(listing(dir, QUEUE_DIR)).toHaveLength(1);
});

test('concurrent enqueue and claim under the lock lose nothing and claim once', async () => {
  const { wd, dir } = fixture();
  const script = path.join(wd.dir, 'race.ts');
  fs.writeFileSync(script, `import { enqueue, claim } from ${JSON.stringify(path.resolve(import.meta.dir, '../scripts/lib/harness-mod.ts'))};
const [dir, mode] = process.argv.slice(2);
if (mode === 'enqueue') enqueue(dir, { source: 'chat', commands: [{ command: '/effort', arg: 'low' }] });
else { const e = claim(dir, 'resident', 'v'); console.log(e ? e.id : ''); }
`);
  const run = (mode: string) => Bun.spawn(['bun', script, dir, mode], { stdout: 'pipe' });
  await Promise.all(Array.from({ length: 6 }, () => run('enqueue').exited));
  const claimers = Array.from({ length: 6 }, () => run('claim'));
  await Promise.all(claimers.map(p => p.exited));
  const claimed = (await Promise.all(claimers.map(p => new Response(p.stdout).text()))).map(s => s.trim()).filter(Boolean);
  expect(new Set(claimed).size).toBe(6);
  expect(listing(dir, QUEUE_DIR)).toEqual([]);
});

test('session-bound requests from another session end unknown; chat survives', () => {
  const { dir } = fixture();
  const watchdog = enqueue(dir, { source: 'watchdog', purpose: 'watchdog-compact', commands: [{ command: '/compact', arg: null }] });
  const chatted = enqueue(dir, chat());
  expect(claim(dir, 'next', VERSION)?.id).toBe((chatted as { id: string }).id);
  const outcome = readOutcome(dir, (watchdog as { id: string }).id)!;
  expect(outcome.legs[0]).toMatchObject({ status: 'unknown', text: 'stale_session' });
});

test('shutdown barrier admits only the stop request', () => {
  const { dir } = fixture();
  const chatted = enqueue(dir, chat()) as { id: string };
  setRuntime(dir, { shutdown_requested_at: new Date().toISOString() });
  expect(enqueue(dir, chat())).toEqual({ status: 'skipped', reason: 'shutdown' });
  const stop = enqueue(dir, { source: 'stop', purpose: 'stop', commands: [{ command: '/hermitd:session-close', arg: null }] }) as { id: string };
  expect(claim(dir, 'resident', VERSION)?.id).toBe(stop.id);
  expect(outcomeStatus(readOutcome(dir, chatted.id)!)).toBe('unknown');
  for (const state of [{ transition: 'restart' }, { shutdown_completed_at: 'now' }]) {
    enqueue(dir, { source: 'stop', purpose: `stop-${Object.keys(state)[0]}`, commands: [{ command: '/hermitd:session-close', arg: null }] });
    setRuntime(dir, state);
    expect(claim(dir, 'resident', VERSION)).toBeNull();
    setRuntime(dir);
  }
});

test('watchdog requests are revalidated at claim', () => {
  const { dir } = fixture();
  const first = enqueue(dir, { source: 'watchdog', purpose: 'monitor-rearm', commands: [{ command: '/hermitd:heartbeat', arg: 'start' }] }) as { id: string };
  expect(claim(dir, 'resident', VERSION)).toBeNull();
  expect(readOutcome(dir, first.id)!.legs[0]).toMatchObject({ status: 'skipped', text: 'execution-not-idle' });
  idleExecution(dir);
  const second = enqueue(dir, { source: 'watchdog', purpose: 'monitor-rearm', commands: [{ command: '/hermitd:heartbeat', arg: 'start' }] }) as { id: string };
  expect(claim(dir, 'resident', VERSION)?.id).toBe(second.id);
});

test('purpose dedupes within one session, not across sessions', () => {
  const { dir } = fixture();
  const request = { source: 'watchdog' as const, purpose: 'watchdog-clear', commands: [{ command: '/clear', arg: null }] };
  const a = enqueue(dir, request);
  expect(enqueue(dir, request)).toEqual(a);
  expect(listing(dir, QUEUE_DIR)).toHaveLength(1);
  expect(enqueue(dir, { ...request, session_id: 'other' })).not.toEqual(a);
});

test('enqueue skips when the mod has not loaded for the resident session', () => {
  const { dir } = fixture();
  fs.writeFileSync(path.join(dir, 'state/harness-mod-loaded.json'), JSON.stringify({ session_id: 'old' }));
  expect(enqueue(dir, chat())).toEqual({ status: 'skipped', reason: 'mod_not_loaded' });
  expect(listing(dir, QUEUE_DIR)).toEqual([]);
});

test('finalize is idempotent and an unknown attempt is never replayed', () => {
  const { dir } = fixture();
  const { id } = enqueue(dir, chat([{ command: '/model', arg: 'x' }, { command: '/effort', arg: 'low' }])) as { id: string };
  expect(claim(dir, 'resident', VERSION)?.id).toBe(id);
  const first = finalize(dir, id, { legs: [{ command: '/model', status: 'unknown', text: '' }] })!;
  const second = finalize(dir, id, { legs: [{ command: '/model', status: 'ok', text: '' }] })!;
  expect(second).toEqual(first);
  expect(outcomeStatus(first)).toBe('unknown');
  expect(listing(dir, INFLIGHT_DIR)).toEqual([]);
  expect(claim(dir, 'resident', VERSION)).toBeNull();
  expect(recover(dir, VERSION)).toBeNull();
});

test('expired requests and day-old outcomes are swept', () => {
  const { dir } = fixture();
  const old = enqueue(dir, chat(), Date.now() - 2 * 3600_000) as { id: string };
  expect(claim(dir, 'resident', VERSION)).toBeNull();
  expect(readOutcome(dir, old.id)!.legs[0]).toMatchObject({ status: 'skipped', text: 'expired' });
  const file = path.join(dir, 'state', OUTCOMES_DIR, `${old.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...readOutcome(dir, old.id), finished_at: new Date(Date.now() - 25 * 3600_000).toISOString() }));
  claim(dir, 'resident', VERSION);
  expect(fs.existsSync(file)).toBe(false);
});

// --- Recovery after a reload ---

function inflight(dir: string, entry: Partial<QueueEntry>) {
  const full = { id: 'r1', source: 'update', requested_at: new Date().toISOString(), session_id: 'resident', claimer_version: '0.0.1', ...entry } as QueueEntry;
  fs.mkdirSync(path.join(dir, 'state', INFLIGHT_DIR), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state', INFLIGHT_DIR, `${full.requested_at}-${full.id}.json`), JSON.stringify(full));
}
const batch = [{ command: '/reload-plugins', arg: null }, { command: '/hermitd:hermit-evolve', arg: 'unattended' }];

test('recover continues a batch only when the new copy has the expected version', async () => {
  const { wd, dir } = fixture();
  inflight(dir, { commands: batch, expect_version: VERSION });
  const resumed = await call(wd, 'recover');
  expect(resumed).toMatchObject({ decision: 'run', id: 'r1', claimer_version: VERSION, legs: [{ command: '/reload-plugins', status: 'ok' }] });
  expect(listing(dir, INFLIGHT_DIR)).toHaveLength(1);
  // Recorded progress survives a second loss: the evolve leg was uncertain, so it ends unknown.
  expect(await call(wd, 'recover')).toEqual({ decision: 'pass' });
  expect(readOutcome(dir, 'r1')!.legs.map(l => l.status)).toEqual(['ok', 'unknown']);
});

for (const [label, entry] of [
  ['mismatched version', { commands: batch, expect_version: '9.9.9' }],
  ['same copy', { commands: batch, expect_version: VERSION, claimer_version: VERSION }],
  ['unrelated request', { commands: [{ command: '/compact', arg: null }, { command: '/effort', arg: 'low' }] }],
] as const) {
  test(`recover ends ${label} unknown and skips the dependent leg`, async () => {
    const { wd, dir } = fixture();
    inflight(dir, entry as Partial<QueueEntry>);
    expect(await call(wd, 'recover')).toEqual({ decision: 'pass' });
    expect(readOutcome(dir, 'r1')!.legs.map(l => [l.status, l.text])).toEqual([['unknown', 'worker_lost'], ['skipped', 'not run']]);
  });
}

test('leg progress lands on the in-flight entry', () => {
  const { dir } = fixture();
  const { id } = enqueue(dir, { source: 'update', commands: batch }) as { id: string };
  claim(dir, 'resident', VERSION);
  expect(recordLegs(dir, id, [{ command: '/reload-plugins', status: 'ok', text: 'Reloaded: 1 plugin' }])).toBe(true);
  const name = listing(dir, INFLIGHT_DIR)[0];
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'state', INFLIGHT_DIR, name), 'utf8')).legs).toHaveLength(1);
});

// --- Bridge ---

test('resident intake queues trusted commands and writes only audit state', async () => {
  const { wd, dir } = fixture();
  const before = fs.readFileSync(path.join(dir, 'state/runtime.json'), 'utf8');
  const result = await call(wd, 'intake', envelope('!model sonnet'));
  expect(result.decision).toBe('queued');
  const [name] = listing(dir, QUEUE_DIR);
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'state', QUEUE_DIR, name), 'utf8'))).toMatchObject({
    id: result.id, source: 'chat', commands: [{ command: '/model', arg: 'sonnet' }], reply_to: { source: 'telegram', chat_id: '12345' },
  });
  expect(inboundSince(dir, '2000-01-01T00:00:00Z')).toHaveLength(1);
  expect(fs.existsSync(path.join(dir, 'state/last-operator-action.json'))).toBe(true);
  for (const file of ['pending-harness-command.json', 'harness-switch-verify.json', 'operator-turn-open.json']) {
    expect(fs.existsSync(path.join(dir, 'state', file))).toBe(false);
  }
  expect(fs.readFileSync(path.join(dir, 'state/runtime.json'), 'utf8')).toBe(before);
});

test('intake refuses with a reply when the mod has not loaded for the session', async () => {
  const { wd, dir } = fixture();
  fs.rmSync(path.join(dir, 'state/harness-mod-loaded.json'));
  expect(await call(wd, 'intake', envelope('!clear'))).toMatchObject({ decision: 'refuse', reply_to: { source: 'telegram', chat_id: '12345' } });
});

for (const body of ['<@777> !clear', '!clear@bot', '!compact', '!advisor opus', '!effort low', '!doctor', '!checkup']) {
  test(`queues ${body}`, async () => {
    const { wd } = fixture();
    expect((await call(wd, 'intake', envelope(body))).decision).toBe('queued');
  });
}
for (const [body, user, session] of [['!clear@otherbot', 'u1', 'resident'], ['!clear', 'stranger', 'resident'], ['!clear', 'u1', 'other']]) {
  test(`passes without audit: ${body}, ${user}, ${session}`, async () => {
    const { wd, dir } = fixture();
    expect(await call(wd, 'intake', envelope(body, user), session)).toEqual({ decision: 'pass' });
    expect(fs.existsSync(path.join(dir, 'state/last-operator-action.json'))).toBe(false);
  });
}

test('guest session and every nonresident verb leave state untouched', async () => {
  const { wd, dir } = fixture();
  markGuest(path.join(dir, 'state'), 'guest');
  const before = fs.readdirSync(path.join(dir, 'state'));
  for (const verb of ['intake', 'loaded', 'claim', 'recover', 'leg', 'finalize']) {
    expect(await call(wd, verb, envelope('!clear'), 'guest')).toEqual({ decision: 'pass' });
  }
  expect(fs.readdirSync(path.join(dir, 'state'))).toEqual(before);
});

test('worker-owned thread passes before audit; resident-owned thread queues', async () => {
  for (const owner of ['worker:a1b2c3d4e5f6a7b8c', 'resident']) {
    const { wd, dir } = fixture();
    expect((await openTask(wd.dir, dir, ['--owner', owner, '--requester', 'telegram:u1', '--conversation', 'telegram:12345'])).exitCode).toBe(0);
    expect((await call(wd, 'intake', envelope('!clear'))).decision).toBe(owner === 'resident' ? 'queued' : 'pass');
    expect(fs.existsSync(path.join(dir, 'state/last-operator-action.json'))).toBe(owner === 'resident');
  }
});

test('loaded stamps the marker and names the state directory', async () => {
  const { wd, dir } = fixture();
  fs.rmSync(path.join(dir, 'state/harness-mod-loaded.json'));
  expect(await call(wd, 'loaded')).toEqual({ decision: 'ok', state: path.join(dir, 'state'), session_id: 'resident' });
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'state/harness-mod-loaded.json'), 'utf8'))).toEqual({ session_id: 'resident' });
});

test('claim leaves the loaded marker alone', async () => {
  const { wd, dir } = fixture();
  const file = path.join(dir, 'state/harness-mod-loaded.json');
  fs.writeFileSync(file, JSON.stringify({ session_id: 'old' }));
  expect(await call(wd, 'claim')).toEqual({ decision: 'pass' });
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ session_id: 'old' });
});

test('bridge claim returns the entry with the caller version', async () => {
  const { wd, dir } = fixture();
  const { id } = enqueue(dir, chat()) as { id: string };
  expect(await call(wd, 'claim', 'pause')).toEqual({ decision: 'pass' });
  expect(await call(wd, 'claim')).toMatchObject({ decision: 'run', id, claimer_version: VERSION });
});

test('missing hermit directory is a no-op for all verbs', async () => {
  const { wd } = fixture();
  for (const verb of ['intake', 'loaded', 'claim', 'recover', 'finalize']) {
    expect(await call(wd, verb, '', 'resident', { AGENT_DIR: path.join(wd.dir, 'absent') })).toEqual({ decision: 'pass' });
  }
  expect(fs.existsSync(path.join(wd.dir, 'absent'))).toBe(false);
});

async function claimed(wd: Workdir, dir: string, commands: { command: string; arg: string | null }[] = [{ command: '/effort', arg: 'low' }]) {
  const { id } = enqueue(dir, chat(commands)) as { id: string };
  await call(wd, 'claim');
  return id;
}

test('failed and unknown outcomes write no state; ok clear leaves the reset to SessionStart', async () => {
  const { wd, dir } = fixture();
  const runtimePath = path.join(dir, 'state/runtime.json');
  const before = fs.readFileSync(runtimePath, 'utf8');
  for (const status of ['failed', 'unknown', 'ok']) {
    const id = await claimed(wd, dir, [{ command: status === 'ok' ? '/clear' : '/model', arg: status === 'ok' ? null : 'x' }]);
    expect(await call(wd, 'finalize', JSON.stringify({ id, legs: [{ command: status === 'ok' ? '/clear' : '/model', status, text: '' }] }), 'resident', { HERMIT_TELEGRAM_API_URL: 'http://127.0.0.1:9' })).toBeDefined();
    expect(fs.readFileSync(runtimePath, 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(dir, 'state/harness-switch-verify.json'))).toBe(false);
  }
});

for (const command of ['/model', '/effort']) {
  test(`${command} ok records observed completion`, async () => {
    const { wd, dir } = fixture();
    const id = await claimed(wd, dir, [{ command, arg: 'target' }]);
    await call(wd, 'finalize', JSON.stringify({ id, legs: [{ command, status: 'ok', text: 'Observed success' }] }), 'resident', { HERMIT_TELEGRAM_API_URL: 'http://127.0.0.1:9' });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'state/harness-switch-verify.json'), 'utf8'))).toMatchObject({ command, arg: 'target', by: 'u1' });
    expect(outcomeStatus(readOutcome(dir, id)!)).toBe('ok');
  });
}

test('finalize sends the observed result once on Telegram', async () => {
  const { wd, dir } = fixture();
  const stub = startHttpStub();
  try {
    const channelDir = path.join(wd.dir, '.claude.local/channels/telegram');
    fs.mkdirSync(channelDir, { recursive: true });
    fs.writeFileSync(path.join(channelDir, '.env'), 'TELEGRAM_BOT_TOKEN=test-token\n');
    const id = await claimed(wd, dir, [{ command: '/advisor', arg: 'opus' }]);
    const result = await call(wd, 'finalize', JSON.stringify({ id, legs: [{ command: '/advisor', status: 'ok', text: 'Advisor set to Opus' }] }), 'resident', { HERMIT_TELEGRAM_API_URL: stub.url });
    expect(result.decision).toBe('ok');
    expect(stub.requests.length).toBe(1);
    expect(JSON.stringify(stub.requests[0])).toContain('Advisor set to Opus');
  } finally { stub.stop(); }
});

test('shutdown refusal and a failed reply return a relay outcome', async () => {
  const { wd, dir } = fixture({ shutdown_requested_at: new Date().toISOString() });
  const result = await call(wd, 'intake', envelope('!clear'));
  expect(result.decision).toBe('refuse');
  expect((await call(wd, 'finalize', JSON.stringify(result))).decision).toBe('send_failed');
  expect(listing(dir, QUEUE_DIR)).toEqual([]);
});

test('intake refuses during a lifecycle transition', async () => {
  const { wd } = fixture({ transition: 'restart' });
  const result = await call(wd, 'intake', envelope('!clear'));
  expect(result.decision).toBe('refuse');
  expect(result.reply_to).toEqual({ source: 'telegram', chat_id: '12345' });
});

test('doctor relay writes the reply target and a failed start clears it', async () => {
  const { wd, dir } = fixture();
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(configPath, 'utf8')), operator_profile: 'non-technical' }));
  expect((await call(wd, 'intake', envelope('!doctor'))).decision).toBe('queued');
  const request = await call(wd, 'claim');
  expect(request).toMatchObject({ decision: 'run', commands: [{ command: '/doctor', arg: null }], reply_to: { source: 'telegram', chat_id: '12345' } });
  // The mod relays only the entry's id, source and commands.
  expect(await call(wd, 'relay', JSON.stringify({ id: request.id, source: request.source, commands: request.commands }))).toEqual({ decision: 'ok' });
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'state/pending-skill-relay.json'), 'utf8')))
    .toMatchObject({ command: '/doctor', arg: null, reply_to: { source: 'telegram', chat_id: '12345' } });
  await call(wd, 'finalize', JSON.stringify({ id: request.id, legs: [{ command: '/doctor', status: 'failed', text: 'no command' }] }), 'resident', { HERMIT_TELEGRAM_API_URL: 'http://127.0.0.1:9' });
  expect(fs.existsSync(path.join(dir, 'state/pending-skill-relay.json'))).toBe(false);
});

test('threaded harness requests preserve their reply target through finalize and shutdown', async () => {
  const { wd, dir } = fixture();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ channels: { custom: {
    allowed_users: ['U1'], send_script: 'send.sh', attributes: { thread_id: 'thread_ts' },
  } } }));
  fs.writeFileSync(path.join(wd.dir, 'send.sh'), '#!/bin/sh\ncat > reply.out\nprintf "%s" "$HERMIT_THREAD_ID" > thread.out\n', { mode: 0o755 });
  const prompt = '<channel source="custom" chat_id="C1" user_id="U1" thread_ts="T1">!model sonnet</channel>';
  expect((await call(wd, 'intake', prompt)).decision).toBe('queued');
  const request = await call(wd, 'claim');
  expect(request.reply_to).toEqual({ source: 'custom', chat_id: 'C1', thread: 'T1' });
  expect(await call(wd, 'finalize', JSON.stringify({ id: request.id, legs: [{ command: '/model', status: 'failed', text: 'no' }] }))).toEqual({ decision: 'ok' });
  expect(fs.readFileSync(path.join(wd.dir, 'thread.out'), 'utf8')).toBe('T1');
  setRuntime(dir, { shutdown_requested_at: new Date().toISOString() });
  const refused = await call(wd, 'intake', prompt);
  expect(refused.decision).toBe('refuse');
  expect(refused.reply_to).toEqual(request.reply_to);
});

// --- Configured shutdown skill ---

function withShutdownSkill(dir: string, skill: string) {
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(configPath, 'utf8')), shutdown_skill: skill }));
}

test('a stop request may carry an unnamespaced configured shutdown skill', () => {
  const { dir } = fixture();
  withShutdownSkill(dir, '/session-close now');
  expect(enqueue(dir, { source: 'stop', purpose: 'stop', commands: [parseSkill('/session-close now')] }).status).toBe('queued');
});

test('/exit stays rejected for terminal and update', () => {
  const { dir } = fixture();
  withShutdownSkill(dir, '/exit');
  for (const source of ['terminal', 'update'] as const) {
    expect(() => enqueue(dir, { source, commands: [{ command: '/exit', arg: null }] })).toThrow('invalid_command');
  }
});

test('a stop request differing from the configured shutdown skill is rejected', () => {
  const { dir } = fixture();
  withShutdownSkill(dir, '/session-close now');
  for (const command of [{ command: '/session-close', arg: null }, { command: '/exit', arg: null }, { command: '/session-close', arg: 'later' }]) {
    expect(() => enqueue(dir, { source: 'stop', purpose: 'stop', commands: [command] })).toThrow('invalid_command');
  }
  withShutdownSkill(dir, '/session-close \u0007');
  expect(() => enqueue(dir, { source: 'stop', purpose: 'stop', commands: [parseSkill('/session-close \u0007')] })).toThrow('invalid_command');
});

// --- Requests the queue settles without running ---

const replyTo = { source: 'telegram', chat_id: '12345' };

test('claim and recover return the settled requests that await a chat reply', () => {
  const { dir } = fixture();
  const expired = enqueue(dir, chat(), Date.now() - 2 * 3600_000) as { id: string };
  const stale = enqueue(dir, { source: 'watchdog', commands: [{ command: '/clear', arg: null }], session_id: 'old', reply_to: replyTo }) as { id: string };
  enqueue(dir, { source: 'watchdog', commands: [{ command: '/clear', arg: null }], session_id: 'old' });
  let unanswered: Unanswered[] = [];
  expect(claim(dir, 'resident', VERSION, { unanswered })).toBeNull();
  expect(unanswered.map(u => [u.entry.id, u.legs[0].text])).toEqual([[expired.id, 'expired'], [stale.id, 'stale_session']]);

  const stopped = enqueue(dir, chat()) as { id: string };
  setRuntime(dir, { shutdown_requested_at: new Date().toISOString() });
  unanswered = [];
  claim(dir, 'resident', VERSION, { unanswered });
  expect(unanswered.map(u => [u.entry.id, u.legs[0].text])).toEqual([[stopped.id, 'shutdown']]);

  inflight(dir, { commands: [{ command: '/effort', arg: 'low' }], reply_to: replyTo });
  unanswered = [];
  expect(recover(dir, VERSION, Date.now(), unanswered)).toBeNull();
  expect(unanswered.map(u => [u.entry.id, u.legs[0].text])).toEqual([['r1', 'worker_lost']]);
});

function customChannel(wd: Workdir, dir: string, script = '#!/bin/sh\ncat >> reply.out\necho >> reply.out\n') {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ channels: { custom: { allowed_users: ['U1'], send_script: 'send.sh' } } }));
  fs.writeFileSync(path.join(wd.dir, 'send.sh'), script, { mode: 0o755 });
}
const customChat = () => ({ ...chat(), reply_to: { source: 'custom', chat_id: 'C1' } });

test('bridge claim answers expired, stale-session and shutdown requests after the lock', async () => {
  const { wd, dir } = fixture();
  customChannel(wd, dir);
  enqueue(dir, customChat(), Date.now() - 2 * 3600_000);
  enqueue(dir, { source: 'watchdog', commands: [{ command: '/clear', arg: null }], session_id: 'old', reply_to: { source: 'custom', chat_id: 'C1' } });
  expect(await call(wd, 'claim')).toEqual({ decision: 'pass' });
  enqueue(dir, customChat());
  setRuntime(dir, { shutdown_requested_at: new Date().toISOString() });
  expect(await call(wd, 'claim')).toEqual({ decision: 'pass' });
  const replies = fs.readFileSync(path.join(wd.dir, 'reply.out'), 'utf8');
  expect(replies).toContain('/effort low: skipped (expired)');
  expect(replies).toContain('/clear: outcome unknown (stale_session)');
  expect(replies).toContain('/effort low: outcome unknown (shutdown)');
  expect(fs.existsSync(path.join(dir, 'state/.harness-queue.lock'))).toBe(false);
});

test('bridge recover answers a lost request, and a failed send returns a relay', async () => {
  const { wd, dir } = fixture();
  customChannel(wd, dir);
  inflight(dir, { commands: [{ command: '/effort', arg: 'low' }], reply_to: { source: 'custom', chat_id: 'C1' } });
  expect(await call(wd, 'recover')).toEqual({ decision: 'pass' });
  expect(fs.readFileSync(path.join(wd.dir, 'reply.out'), 'utf8')).toContain('/effort low: outcome unknown (worker_lost)');
  customChannel(wd, dir, '#!/bin/sh\nexit 1\n');
  enqueue(dir, customChat(), Date.now() - 2 * 3600_000);
  expect(await call(wd, 'claim')).toEqual({ decision: 'pass', relays: [{ text: '/effort low: skipped (expired)', reply_to: { source: 'custom', chat_id: 'C1' } }] });
});

test('leg reasons are snake_case tokens; the text stays the human detail', () => {
  expect(legReason({ command: '/x', status: 'skipped', text: 'not run' })).toBe('not_run');
  expect(legReason({ command: '/x', status: 'unknown', text: 'deadline reached' })).toBe('deadline');
  expect(legReason({ command: '/x', status: 'failed', text: 'Failed to reload' })).toBe('rejected');
  expect(legReason({ command: '/x', status: 'skipped', text: 'execution-not-idle' })).toBe('execution_not_idle');
  for (const token of ['expired', 'stale_session', 'shutdown', 'worker_lost']) expect(legReason({ command: '/x', status: 'unknown', text: token })).toBe(token);
});
