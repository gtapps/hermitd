// Contract tests for scripts/user-prompt-pipeline.ts — the single UserPromptSubmit
// process — covering the two things the seven-hook shape could not express.
//
// 1. Shutdown is terminal. While a shutdown is pending, no later stage runs: not
//    status (which used to send and block on its own after a FAILED shutdown send,
//    discarding the shutdown relay instruction), not pause/resume, not a harness
//    command. Each of those was reachable by construction before, because no hook
//    could see what another had already done.
// 2. One disposition per prompt. A block prints the decision JSON alone — mixed
//    context text alongside it does not parse as a decision and the block is lost.
//
// Driven as a subprocess against a local HTTP stub, mirroring shutdown-gate.test.ts
// and channel-status-responder.test.ts.

import { afterAll, describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { writeRegistryEntry } from './helpers/registry-fixture';
import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { openTask } from './helpers/tasks';
import { readTasks, encodeTask } from '../scripts/lib/tasks';
import { assistantEntry } from './helpers/transcript';
import { markGuest } from '../scripts/lib/guest-marker';
import { startHttpStub } from './helpers/http-stub';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.hermit', ...p);

const workdirs: Workdir[] = [];
afterAll(() => {
  for (const wd of workdirs.splice(0)) wd.cleanup();
});

function trackedWorkdir(): Workdir {
  const wd = setupWorkdir();
  workdirs.push(wd);
  return wd;
}

function envelope(body: string, user = 'u1', chatId = '12345'): string {
  return `<channel source="telegram" chat_id="${chatId}" user="${user}">${body}</channel>`;
}

function setupChannelWorkdir(channelExtra: Record<string, unknown> = {}): Workdir {
  const wd = trackedWorkdir();
  const stateDir = path.join(wd.dir, '.claude.local', 'channels', 'telegram');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=test-token\n');
  fs.writeFileSync(hermit(wd.dir, 'config.json'), JSON.stringify({
    timezone: 'UTC',
    channels: {
      telegram: {
        enabled: true, dm_channel_id: '12345', allowed_users: ['u1'],
        state_dir: '.claude.local/channels/telegram', ...channelExtra,
      },
    },
  }));
  return wd;
}

function writeRuntime(wd: Workdir, patch: Record<string, unknown>): void {
  const p = hermit(wd.dir, 'state', 'runtime.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ version: 1, ...patch }));
}

// A shutdown in flight, plus the pane facts a harness command needs — so the
// harness stage is refused for the shutdown, not for a missing tmux session.
const PENDING_SHUTDOWN = {
  shutdown_requested_at: '2026-07-24T09:00:00+0000',
  shutdown_completed_at: null,
  runtime_mode: 'headless',
  tmux_session: 'hermit-test',
};

async function run(wd: Workdir, body: string, stubUrl: string) {
  return runScript('user-prompt-pipeline.ts', {
    stdin: JSON.stringify({ prompt: envelope(body) }),
    cwd: wd.dir,
    env: { HERMIT_TELEGRAM_API_URL: stubUrl },
  });
}

function openThreadTask(wd: Workdir, key: string, owner: string, muted: boolean) {
  return openTask(wd.dir, hermit(wd.dir),
    ['--owner', owner, '--muted', String(muted), '--requester', `${key.split(':')[0]}:u1`, '--conversation', key]);
}

describe('user-prompt-pipeline: shutdown is terminal', () => {
  test('/status during a pending shutdown → one send, one block, status never answers', async () => {
    const stub = startHttpStub();
    try {
      const wd = setupChannelWorkdir();
      writeRuntime(wd, PENDING_SHUTDOWN);

      const r = await run(wd, '!status', stub.url);

      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toMatchObject({ decision: 'block' });
      // Exactly one outbound message: the shutdown reply. Two would mean the
      // status stage answered the same prompt.
      expect(stub.requests.length).toBe(1);
      // And the block is the ONLY thing on stdout — no [Now:], no reply reminder.
      expect(r.stdout).not.toContain('[Now:');
      expect(r.stdout).not.toContain('[status]');
    } finally {
      stub.stop();
    }
  });

  test('an allowlisted channel message blocked by pending shutdown does not open the turn marker', async () => {
    const stub = startHttpStub();
    try {
      const wd = setupChannelWorkdir();
      writeRuntime(wd, PENDING_SHUTDOWN);

      const r = await run(wd, 'any updates?', stub.url);

      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toMatchObject({ decision: 'block' });
      expect(fs.existsSync(hermit(wd.dir, 'state', 'operator-turn-open.json'))).toBe(false);
      // The other half of the contract: the message is still operator activity.
      expect(fs.existsSync(hermit(wd.dir, 'state', 'last-operator-action.json'))).toBe(true);
    } finally {
      stub.stop();
    }
  });

  test('/status during a pending shutdown with a FAILED send → shutdown relay only, status never answers', async () => {
    const wd = setupChannelWorkdir();
    writeRuntime(wd, PENDING_SHUTDOWN);

    // Dead listener: the shutdown send fails. Previously the prompt then fell
    // through and the status stage composed its own relay, swallowing the
    // shutdown instruction the model was supposed to act on. No stub here on
    // purpose — both stages read the same HERMIT_TELEGRAM_API_URL, so a request
    // count could not tell the two senders apart; the discriminator is that the
    // `[status]` relay is absent while the `[shutdown]` one is present.
    const r = await run(wd, '!status', 'http://127.0.0.1:1');

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('[shutdown]');
    expect(r.stdout).not.toContain('[status]');
    expect(r.stdout).not.toContain('"decision"'); // a failed send must not block
  });

  test('a harness command during a pending shutdown is refused, not acknowledged', async () => {
    const stub = startHttpStub();
    try {
      const wd = setupChannelWorkdir();
      writeRuntime(wd, PENDING_SHUTDOWN);

      const r = await run(wd, '!model opus', stub.url);

      expect(r.exitCode).toBe(0);
      // The Stop-stage drain refuses to deliver a command during shutdown, so
      // recording one here would acknowledge something that never lands.
      expect(fs.existsSync(hermit(wd.dir, 'state', 'pending-harness-command.json'))).toBe(false);
      expect(r.stdout).not.toContain('[harness-command]');
    } finally {
      stub.stop();
    }
  });

  test('an unsettable permission mode is refused with a reason, and records nothing', async () => {
    const stub = startHttpStub();
    try {
      const wd = setupChannelWorkdir();
      writeRuntime(wd, { runtime_mode: 'headless', tmux_session: 'hermit-test', shutdown_requested_at: null, shutdown_completed_at: null });

      // plan mode would silence the very channel this request arrived on.
      const r = await run(wd, '!permission-mode plan', stub.url);

      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('refused "/permission-mode plan"');
      expect(r.stdout).toContain('replying');
      expect(fs.existsSync(hermit(wd.dir, 'state', 'pending-harness-command.json'))).toBe(false);
    } finally {
      stub.stop();
    }
  });

  test('a settable permission mode is recorded for the Stop hook', async () => {
    const stub = startHttpStub();
    try {
      const wd = setupChannelWorkdir();
      writeRuntime(wd, { runtime_mode: 'headless', tmux_session: 'hermit-test', shutdown_requested_at: null, shutdown_completed_at: null });

      const r = await run(wd, '!permission-mode acceptEdits', stub.url);

      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('[harness-command]');
      expect(r.stdout).not.toContain('refused');
      const pending = JSON.parse(fs.readFileSync(hermit(wd.dir, 'state', 'pending-harness-command.json'), 'utf-8'));
      expect(pending).toMatchObject({ command: '/permission-mode', arg: 'acceptEdits' });
    } finally {
      stub.stop();
    }
  });

  test('a trusted /advisor <model> never records a Stop command', async () => {
    const stub = startHttpStub();
    try {
      const wd = setupChannelWorkdir();
      writeRuntime(wd, { runtime_mode: 'headless', tmux_session: 'hermit-test', shutdown_requested_at: null, shutdown_completed_at: null });

      const r = await run(wd, '!advisor opus', stub.url);

      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('[harness-command]');
      expect(fs.existsSync(hermit(wd.dir, 'state', 'pending-harness-command.json'))).toBe(false);
    } finally {
      stub.stop();
    }
  });

  // /code-review is model-invocable, so the stage must NOT claim it: no marker, no
  // refusal, no context line — it reaches the model as an ordinary channel message.
  test('a code review is not intercepted and records nothing', async () => {
    const stub = startHttpStub();
    try {
      const wd = setupChannelWorkdir();
      writeRuntime(wd, { runtime_mode: 'headless', tmux_session: 'hermit-test', shutdown_requested_at: null, shutdown_completed_at: null });

      const r = await run(wd, '/code-review low', stub.url);

      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('[harness-command]');
      expect(fs.existsSync(hermit(wd.dir, 'state', 'pending-harness-command.json'))).toBe(false);
    } finally {
      stub.stop();
    }
  });

  test('doctor leaves the Stop hook marker unwritten', async () => {
    const stub = startHttpStub();
    try {
      const wd = setupChannelWorkdir();
      writeRuntime(wd, { runtime_mode: 'headless', tmux_session: 'hermit-test', shutdown_requested_at: null, shutdown_completed_at: null });

      const r = await run(wd, '!doctor', stub.url);

      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('[harness-command]');
      expect(fs.existsSync(hermit(wd.dir, 'state', 'pending-harness-command.json'))).toBe(false);
    } finally {
      stub.stop();
    }
  });

  // Addressing is resolved before the harness grammar, so a Telegram group's
  // `/cmd@thebot` reaches the parser — and one aimed at another bot does not.
  test('a harness command addressed to this bot reaches the pending marker', async () => {
    const stub = startHttpStub();
    try {
      const wd = setupChannelWorkdir({ bot_username: 'ourbot' });
      writeRuntime(wd, { runtime_mode: 'headless', tmux_session: 'hermit-test', shutdown_requested_at: null, shutdown_completed_at: null });

      const r = await run(wd, '!permission-mode@ourbot auto', stub.url);

      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('[harness-command]');
      const pending = JSON.parse(fs.readFileSync(hermit(wd.dir, 'state', 'pending-harness-command.json'), 'utf-8'));
      expect(pending).toMatchObject({ command: '/permission-mode', arg: 'auto' });
    } finally {
      stub.stop();
    }
  });

  test('a harness command addressed to another bot writes no marker', async () => {
    const stub = startHttpStub();
    try {
      const wd = setupChannelWorkdir({ bot_username: 'ourbot' });
      writeRuntime(wd, { runtime_mode: 'headless', tmux_session: 'hermit-test', shutdown_requested_at: null, shutdown_completed_at: null });

      const r = await run(wd, '!model@otherbot opus', stub.url);

      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('[harness-command]');
      expect(fs.existsSync(hermit(wd.dir, 'state', 'pending-harness-command.json'))).toBe(false);
    } finally {
      stub.stop();
    }
  });

  test('/resume during a pending shutdown does not clear an existing pause', async () => {
    const stub = startHttpStub();
    try {
      const wd = setupChannelWorkdir();
      const pausePath = hermit(wd.dir, 'state', 'pause.json');
      fs.mkdirSync(path.dirname(pausePath), { recursive: true });
      fs.writeFileSync(pausePath, JSON.stringify({ paused: true, reason: 'operator', by: 'u1' }));
      writeRuntime(wd, PENDING_SHUTDOWN);

      const r = await run(wd, '!resume', stub.url);

      expect(r.exitCode).toBe(0);
      expect(JSON.parse(fs.readFileSync(pausePath, 'utf-8')).paused).toBe(true);
      expect(r.stdout).not.toContain('[pause]');
    } finally {
      stub.stop();
    }
  });
});

// A delivered switch applies, but the model's self-perception does not follow it —
// so the transcript, not the model, answers "which model am I running".
describe('user-prompt-pipeline: switch verification', () => {
  const verifyMarker = (dir: string) => hermit(dir, 'state', 'harness-switch-verify.json');

  // Relative to now, never a pinned wall-clock date: readSwitchVerify drops a
  // marker older than SWITCH_VERIFY_TTL_SECS (24h), so an absolute delivered_at
  // passes until that instant and then fails forever.
  const DELIVERED_AT = new Date(Date.now() - 60_000).toISOString();
  /** After observed completion, with no artificial grace window. */
  const POST_SWITCH_AT = new Date(Date.parse(DELIVERED_AT) + 30_000).toISOString();
  /** Before the switch, so this is the pre-switch model. */
  const PRE_SWITCH_AT = new Date(Date.parse(DELIVERED_AT) - 5_000).toISOString();

  function seedDeliveredSwitch(wd: Workdir, arg = 'fable'): void {
    fs.writeFileSync(hermit(wd.dir, 'config.json'), JSON.stringify({ timezone: 'UTC' }));
    fs.mkdirSync(path.dirname(verifyMarker(wd.dir)), { recursive: true });
    fs.writeFileSync(verifyMarker(wd.dir), JSON.stringify({
      command: '/model',
      arg,
      by: 'operator',
      delivered_at: DELIVERED_AT,
    }));
  }

  function writeTranscript(wd: Workdir, entries: Array<{ model: string; timestamp: string }>): string {
    const file = path.join(wd.dir, 'transcript.jsonl');
    // Pinned fixture builder — see tests/helpers/transcript.ts.
    fs.writeFileSync(file, `${entries
      .map((e) => assistantEntry({ model: e.model, timestamp: e.timestamp }))
      .join('\n')}\n`);
    return file;
  }

  async function runWith(wd: Workdir, transcript: string | null, sessionId?: string) {
    return runScript('user-prompt-pipeline.ts', {
      stdin: JSON.stringify({
        prompt: 'which model are you on?',
        ...(transcript ? { transcript_path: transcript } : {}),
        ...(sessionId ? { session_id: sessionId } : {}),
      }),
      cwd: wd.dir,
    });
  }

  test('reports the transcript model once the switch is observable, then clears the marker', async () => {
    const wd = trackedWorkdir();
    seedDeliveredSwitch(wd);
    const transcript = writeTranscript(wd, [{ model: 'claude-fable-5', timestamp: POST_SWITCH_AT }]);

    const r = await runWith(wd, transcript);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('"/model fable" delivered');
    expect(r.stdout).toContain('transcript now reports model claude-fable-5');
    expect(fs.existsSync(verifyMarker(wd.dir))).toBe(false);
  });

  // The marker belongs to the RESIDENT — a guest reporting it would announce a switch
  // that never touched its own session, and clear the marker before the resident read it.
  test('a guest session reports nothing and leaves the marker for the resident', async () => {
    const wd = trackedWorkdir();
    seedDeliveredSwitch(wd);
    const transcript = writeTranscript(wd, [{ model: 'claude-fable-5', timestamp: POST_SWITCH_AT }]);
    markGuest(hermit(wd.dir, 'state'), 'guest-1');

    const r = await runWith(wd, transcript, 'guest-1');

    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('delivered');
    expect(fs.existsSync(verifyMarker(wd.dir))).toBe(true);
  });

  // The bug this whole path exists to prevent: answering from the PRE-switch entry.
  test('holds the marker while only pre-switch entries exist, and never names that model', async () => {
    const wd = trackedWorkdir();
    seedDeliveredSwitch(wd);
    const transcript = writeTranscript(wd, [{ model: 'claude-sonnet-5', timestamp: PRE_SWITCH_AT }]);

    const r = await runWith(wd, transcript);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('not yet observable');
    expect(r.stdout).not.toContain('claude-sonnet-5');
    expect(fs.existsSync(verifyMarker(wd.dir))).toBe(true);
  });

  test('a payload without a transcript_path holds the marker rather than guessing', async () => {
    const wd = trackedWorkdir();
    seedDeliveredSwitch(wd);

    const r = await runWith(wd, null);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('not yet observable');
    expect(fs.existsSync(verifyMarker(wd.dir))).toBe(true);
  });

  test('no marker means the stage says nothing', async () => {
    const wd = trackedWorkdir();
    fs.writeFileSync(hermit(wd.dir, 'config.json'), JSON.stringify({ timezone: 'UTC' }));
    const transcript = writeTranscript(wd, [{ model: 'claude-fable-5', timestamp: POST_SWITCH_AT }]);

    const r = await runWith(wd, transcript);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('[harness-command]');
  });

  // A permission mode leaves no trace in the transcript, so the model-freshness gate above
  // must not get to it first — held there it would sit behind an assistant entry that says
  // nothing about it, and describe itself in model terms while doing so.
  test('answers a permission-mode switch from the pane, not the transcript gate', async () => {
    const wd = trackedWorkdir();
    fs.writeFileSync(hermit(wd.dir, 'config.json'), JSON.stringify({ timezone: 'UTC' }));
    fs.mkdirSync(path.dirname(verifyMarker(wd.dir)), { recursive: true });
    fs.writeFileSync(verifyMarker(wd.dir), JSON.stringify({
      command: '/permission-mode',
      arg: 'acceptEdits',
      by: 'operator',
      delivered_at: new Date().toISOString(),
    }));
    // Only a pre-switch entry exists — the gate would hold a /model marker here.
    const transcript = writeTranscript(wd, [{ model: 'claude-sonnet-5', timestamp: '2020-01-01T00:00:00.000Z' }]);

    const r = await runWith(wd, transcript);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('not yet observable');
    expect(r.stdout).toContain('[harness-command]');
    // No tmux session in this fixture, so the honest answer is "could not read it back".
    expect(r.stdout).toContain('could not be read back');
    expect(fs.existsSync(verifyMarker(wd.dir))).toBe(false);
  });
});

describe('user-prompt-pipeline: fail-open contract', () => {
  test('malformed stdin exits 0 and still runs the payload-independent stages', async () => {
    // A prompt did arrive — MAX_STDIN_BYTES truncation is what cuts it mid-JSON —
    // so the turn must still be recorded and timestamped.
    const wd = trackedWorkdir();
    fs.writeFileSync(hermit(wd.dir, 'config.json'), JSON.stringify({ timezone: 'UTC' }));

    const r = await runScript('user-prompt-pipeline.ts', { stdin: '{broken', cwd: wd.dir });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('[Now:');
    expect(fs.existsSync(hermit(wd.dir, 'state', 'last-operator-action.json'))).toBe(true);
    expect(fs.existsSync(hermit(wd.dir, 'state', 'operator-turn-open.json'))).toBe(true);
  });

  test('allowlisted channel /status records activity without opening the turn marker', async () => {
    const stub = startHttpStub();
    try {
      const wd = setupChannelWorkdir();

      const r = await run(wd, '!status', stub.url);

      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toMatchObject({ decision: 'block' });
      expect(fs.existsSync(hermit(wd.dir, 'state', 'operator-turn-open.json'))).toBe(false);
      expect(fs.existsSync(hermit(wd.dir, 'state', 'last-operator-action.json'))).toBe(true);
    } finally {
      stub.stop();
    }
  });

  // Issue #835: a channel-only conversation left last-operator-action.json frozen (the
  // write was delegated to a channel-responder skill step the model skipped), so the
  // midnight post-close /clear fired mid-exchange. The pipeline now hands the raw config
  // to record-operator-action, which applies the same allowed_users gate.
  test('allowlisted channel sender advances the clock and opens the turn marker', async () => {
    const wd = setupChannelWorkdir();

    const r = await runScript('user-prompt-pipeline.ts', {
      stdin: JSON.stringify({ prompt: envelope('any updates?', 'u1') }),
      cwd: wd.dir,
    });

    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(hermit(wd.dir, 'state', 'last-operator-action.json'))).toBe(true);
    expect(fs.existsSync(hermit(wd.dir, 'state', 'operator-turn-open.json'))).toBe(true);
  });

  test('non-allowlisted channel sender leaves the clock and turn marker untouched', async () => {
    const wd = setupChannelWorkdir();

    const r = await runScript('user-prompt-pipeline.ts', {
      stdin: JSON.stringify({ prompt: envelope('any updates?', 'u2') }),
      cwd: wd.dir,
    });

    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(hermit(wd.dir, 'state', 'last-operator-action.json'))).toBe(false);
    expect(fs.existsSync(hermit(wd.dir, 'state', 'operator-turn-open.json'))).toBe(false);
  });

  test('empty stdin exits 0 and emits nothing', async () => {
    const wd = trackedWorkdir();
    const r = await runScript('user-prompt-pipeline.ts', { stdin: '', cwd: wd.dir });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  test('an over-cap prompt is truncated but still recorded', async () => {
    const wd = trackedWorkdir();
    fs.writeFileSync(hermit(wd.dir, 'config.json'), JSON.stringify({ timezone: 'UTC' }));

    const r = await runScript('user-prompt-pipeline.ts', {
      stdin: JSON.stringify({ prompt: 'x'.repeat(1024 * 1024 + 512) }),
      cwd: wd.dir,
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('[Now:');
    expect(fs.existsSync(hermit(wd.dir, 'state', 'last-operator-action.json'))).toBe(true);
  });

  test('an ordinary prompt still records the operator-action markers', async () => {
    const wd = trackedWorkdir();
    fs.writeFileSync(hermit(wd.dir, 'config.json'), JSON.stringify({ timezone: 'UTC' }));

    const r = await runScript('user-prompt-pipeline.ts', {
      stdin: JSON.stringify({ prompt: 'do a thing' }),
      cwd: wd.dir,
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('[Now:');
    expect(fs.existsSync(hermit(wd.dir, 'state', 'last-operator-action.json'))).toBe(true);
    expect(fs.existsSync(hermit(wd.dir, 'state', 'operator-turn-open.json'))).toBe(true);
  });
});

test('listed passive chat without mention does not record activity or open a turn', async () => {
  const wd = setupChannelWorkdir({ passive_chats: ['12345'], bot_username: 'hermitbot' });
  const result = await runScript('user-prompt-pipeline.ts', {
    stdin: JSON.stringify({ prompt: envelope('ordinary group chatter') }), cwd: wd.dir,
  });
  expect(result.exitCode).toBe(0);
  expect(fs.existsSync(hermit(wd.dir, 'state', 'last-operator-action.json'))).toBe(false);
  expect(fs.existsSync(hermit(wd.dir, 'state', 'operator-turn-open.json'))).toBe(false);
});

test('listed passive chat with allowed self-mention still records activity', async () => {
  const wd = setupChannelWorkdir({ passive_chats: ['12345'], bot_username: 'hermitbot' });
  const result = await runScript('user-prompt-pipeline.ts', {
    stdin: JSON.stringify({ prompt: envelope('hello @hermitbot') }), cwd: wd.dir,
  });
  expect(result.exitCode).toBe(0);
  expect(fs.existsSync(hermit(wd.dir, 'state', 'last-operator-action.json'))).toBe(true);
});

describe('user-prompt-pipeline: resident gate', () => {
  for (const scenario of [
    { name: 'foreign live incumbent', pid: process.ppid, blocked: true },
    { name: 'own parent', pid: process.pid },
    { name: 'marker only', marker: true, blocked: true },
    { name: 'foreign incumbent with plain prompt', pid: process.ppid, plain: true },
    { name: 'no session_pid' },
    { name: 'foreign incumbent from a subdirectory', pid: process.ppid, subdir: true, blocked: true },
  ]) {
    test(scenario.name, async () => {
      const wd = setupChannelWorkdir();
      const sessionId = 'resident-gate-test';
      const configDir = path.join(wd.dir, 'config');
      if (scenario.pid) writeRegistryEntry(configDir, scenario.pid);
      writeRuntime(wd, { session_pid: scenario.pid, config_dir: configDir });
      const stateDir = hermit(wd.dir, 'state');
      if (scenario.marker) fs.writeFileSync(path.join(stateDir, `.guest-${sessionId}`), '');
      const snapshot = () => fs.readdirSync(stateDir, { recursive: true }).sort().map(name => {
        const file = path.join(stateDir, String(name));
        return [name, fs.statSync(file).isFile() ? fs.readFileSync(file, 'hex') : null];
      });
      const before = snapshot();
      const logPath = hermit(wd.dir, 'state', 'channel-log.sqlite');
      const logBefore = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'hex') : null;
      const cwd = scenario.subdir ? path.join(wd.dir, 'nested') : wd.dir;
      fs.mkdirSync(cwd, { recursive: true });
      const r = await runScript('user-prompt-pipeline.ts', {
        stdin: JSON.stringify({ prompt: scenario.plain ? 'hello' : envelope('hello'), session_id: sessionId }),
        cwd,
      });
      expect(r.exitCode).toBe(0);
      if (scenario.blocked) {
        expect(JSON.parse(r.stdout.trim())).toEqual({
          decision: 'block',
          reason: scenario.marker ? 'guest session: channel message left to the resident' : 'channel message left to the resident session',
        });
        expect(r.stdout.trim().split('\n')).toHaveLength(1);
        expect(fs.existsSync(path.join(stateDir, 'last-operator-action.json'))).toBe(false);
        expect(fs.existsSync(path.join(stateDir, 'operator-turn-open.json'))).toBe(false);
        expect(snapshot()).toEqual(before);
        expect(fs.existsSync(logPath) ? fs.readFileSync(logPath, 'hex') : null).toBe(logBefore);
      } else {
        expect(r.stdout).not.toContain('"decision":"block"');
        if (!scenario.plain) expect(r.stdout).toContain('[channel reply reminder]');
      }
    });
  }
});


describe('task thread admission', () => {
  for (const scenario of [
    { name: 'worker thread inside passive parent passes', task: true, owner: 'worker:a1b2c3d4e5f6a7b8c', muted: false, body: 'continue', blocked: false },
    { name: 'helper thread inside passive parent passes', task: true, owner: 'helper:review', muted: false, body: 'continue', blocked: false },
    { name: 'resident thread inside passive parent passes', task: true, owner: 'resident', muted: false, body: 'continue', blocked: false },
    { name: 'muted thread is blocked', task: true, owner: 'worker:a1b2c3d4e5f6a7b8c', muted: true, body: 'continue', blocked: true },
    { name: 'muted thread with mention passes', task: true, owner: 'worker:a1b2c3d4e5f6a7b8c', muted: true, body: '<@777> continue', blocked: false },
    { name: 'chat without a record stays blocked', task: false, owner: 'resident', muted: false, body: 'continue', blocked: true },
  ]) {
    test(scenario.name, async () => {
      const wd = trackedWorkdir();
      const dir = hermit(wd.dir);
      fs.writeFileSync(hermit(wd.dir, 'config.json'), JSON.stringify({ channels: { discord: { allowed_users: ['u1'], passive_chats: ['parent'], bot_user_id: '777' } } }));
      fs.writeFileSync(hermit(wd.dir, 'state', 'channel-chats.json'), JSON.stringify({ discord: { chats: { thread: { type: 11, parent_id: 'parent', guild_id: 'guild', fetched_at: new Date().toISOString() } } } }));
      if (scenario.task) expect((await openThreadTask(wd, 'discord:thread', scenario.owner, scenario.muted)).exitCode).toBe(0);
      const result = await runScript('user-prompt-pipeline.ts', {
        stdin: JSON.stringify({ prompt: `<channel source="discord" chat_id="thread" user="u1">${scenario.body}</channel>` }), cwd: wd.dir,
      });
      expect(result.exitCode).toBe(0);
      if (scenario.blocked) {
        expect(JSON.parse(result.stdout).decision).toBe('block');
        expect(result.stdout).not.toContain('[task thread');
      } else {
        expect(result.stdout).toContain(`[task thread discord:thread: owner=${scenario.owner === 'resident' ? 'resident' : scenario.owner.startsWith('helper:') ? 'helper' : 'worker'}, muted=${scenario.muted}, waiting=false]`);
        expect(result.stdout).toContain('[channel reply reminder]');
        expect(result.stdout).not.toContain('[waiting task');
      }
    });
  }

  test('unauthorized reply into a task thread stays blocked', async () => {
    const wd = trackedWorkdir();
    fs.writeFileSync(hermit(wd.dir, 'config.json'), JSON.stringify({ channels: { discord: { allowed_users: ['u1'], passive_chats: ['parent'], bot_user_id: '777' } } }));
    fs.writeFileSync(hermit(wd.dir, 'state', 'channel-chats.json'), JSON.stringify({ discord: { chats: { thread: { type: 11, parent_id: 'parent', guild_id: 'guild', fetched_at: new Date().toISOString() } } } }));
    expect((await openThreadTask(wd, 'discord:thread', 'worker:a1b2c3d4e5f6a7b8c', false)).exitCode).toBe(0);
    const result = await runScript('user-prompt-pipeline.ts', {
      stdin: JSON.stringify({ prompt: '<channel source="discord" chat_id="thread" user="stranger">continue</channel>' }), cwd: wd.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).decision).toBe('block');
    expect(result.stdout).not.toContain('[task thread');
  });

  test('a waiting record is annotated as waiting', async () => {
    const wd = trackedWorkdir();
    const dir = hermit(wd.dir);
    fs.writeFileSync(hermit(wd.dir, 'config.json'), JSON.stringify({ channels: { discord: { allowed_users: ['u1'], passive_chats: ['parent'], bot_user_id: '777' } } }));
    fs.writeFileSync(hermit(wd.dir, 'state', 'channel-chats.json'), JSON.stringify({ discord: { chats: { thread: { type: 11, parent_id: 'parent', guild_id: 'guild', fetched_at: new Date().toISOString() } } } }));
    const opened = await openThreadTask(wd, 'discord:thread', 'resident', false);
    expect(opened.exitCode).toBe(0);
    const id = JSON.parse(opened.stdout).id;
    const blocked = await runScript('task.ts', { args: ['block', dir, id, '--waiting-on', 'discord:u1', '--status-line', 'Need input', '--next', 'Answer'], cwd: wd.dir });
    expect(blocked.exitCode).toBe(0);
    const result = await runScript('user-prompt-pipeline.ts', {
      stdin: JSON.stringify({ prompt: '<channel source="discord" chat_id="thread" user="u1">continue</channel>' }), cwd: wd.dir,
    });
    expect(result.stdout).toContain('[task thread discord:thread: owner=resident, muted=false, waiting=true]');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`[waiting task ${id}: Need input; next: Answer`);
    expect(result.stdout).toContain(`hermitd-run task block .hermit ${id} --result-stdin`);
    expect(result.stdout).toContain(`hermitd-run task note .hermit ${id} --clear-waiting`);
    expect(result.stdout).toContain(`hermitd-run task close .hermit ${id} --by confirmed --actor discord:u1 --result-rev 0 --reason-stdin`);
    expect(result.stdout).toContain('nothing is owed when this message does not change the task');

  });

  for (const scenario of [
    { name: 'newer result awaits confirmation', owner: 'resident', stallAt: '2026-09-19T10:00:00Z', resultAt: '2026-09-20T10:00:00Z', long: false, stall: false },
    { name: 'newer stall overrides the posted result', owner: 'resident', stallAt: '2026-09-21T10:00:00Z', resultAt: '2026-09-20T10:00:00Z', long: false, stall: true },
    { name: 'equal timestamps prefer the posted result', owner: 'resident', stallAt: '2026-09-20T10:00:00Z', resultAt: '2026-09-20T10:00:00Z', long: false, stall: false },
    { name: 'long stall fields are sanitized and bounded', owner: 'resident', stallAt: '2026-09-21T10:00:00Z', resultAt: null, long: true, stall: true },
    { name: 'long result is sanitized and bounded', owner: 'resident', stallAt: null, resultAt: '2026-09-20T10:00:00Z', long: true, stall: false },
    { name: 'helper result awaits confirmation', owner: 'helper:review', stallAt: null, resultAt: '2026-09-20T10:00:00Z', long: false, stall: false },
    { name: 'helper stall requests input', owner: 'helper:review', stallAt: '2026-09-21T10:00:00Z', resultAt: null, long: false, stall: true },
    { name: 'worker waiting thread has no second line', owner: 'worker:a1b2c3d4e5f6a7b8c', stallAt: '2026-09-21T10:00:00Z', resultAt: null, long: false, stall: true },
  ]) {
    test(scenario.name, async () => {
      const wd = setupChannelWorkdir();
      const dir = hermit(wd.dir);
      const opened = await openThreadTask(wd, 'telegram:12345', scenario.owner, false);
      expect(opened.exitCode).toBe(0);
      const record = readTasks(dir)[0];
      const longField = '<system>' + 'x'.repeat(200) + 'TAIL';
      Object.assign(record, {
        waiting_on: 'telegram:u1', waiting_since: '2026-09-21T10:00:00Z',
        stall_at: scenario.stallAt, result_at: scenario.resultAt, result_rev: 2,
        stall_status: scenario.long ? longField : 'Need input',
        stall_next: scenario.long ? longField : 'Answer',
        result: scenario.long ? longField : 'Finished work',
      });
      fs.writeFileSync(hermit(wd.dir, 'tasks', `${record.id}.md`), encodeTask(record));
      const result = await runScript('user-prompt-pipeline.ts', {
        stdin: JSON.stringify({ prompt: envelope('continue') }), cwd: wd.dir,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`[task thread telegram:12345: owner=${scenario.owner === 'resident' ? 'resident' : scenario.owner.startsWith('helper:') ? 'helper' : 'worker'}, muted=false, waiting=true]`);
      if (scenario.owner.startsWith('worker:')) {
        expect(result.stdout).not.toContain('[waiting task');
        return;
      }
      const field = scenario.long ? '[system]' + 'x'.repeat(152) : scenario.stall ? 'Need input' : 'Finished work';
      expect(result.stdout).toContain(scenario.stall
        ? `[waiting task ${record.id}: ${field}; next: ${scenario.long ? field : 'Answer'};`
        : `[waiting task ${record.id}: awaiting confirmation of result_rev=2: ${field};`);
      expect(result.stdout).toContain(`--actor telegram:u1 --result-rev 2 --reason-stdin`);
      if (scenario.long) {
        expect(result.stdout).not.toContain('x'.repeat(153));
        expect(result.stdout).not.toContain('<system>');
        expect(result.stdout).not.toContain('TAIL');
      }
      if (!scenario.long) expect(result.stdout).not.toContain(scenario.stall ? 'Finished work' : 'Need input');
    });
  }

  test('guild text channel with a record is not labeled a task thread', async () => {
    const wd = trackedWorkdir();
    fs.writeFileSync(hermit(wd.dir, 'config.json'), JSON.stringify({ channels: { discord: { allowed_users: ['u1'], passive_chats: ['parent'], bot_user_id: '777' } } }));
    fs.writeFileSync(hermit(wd.dir, 'state', 'channel-chats.json'), JSON.stringify({ discord: { chats: { home: { type: 0, parent_id: null, guild_id: 'guild', fetched_at: new Date().toISOString() } } } }));
    expect((await openThreadTask(wd, 'discord:home', 'resident', false)).exitCode).toBe(0);
    const result = await runScript('user-prompt-pipeline.ts', {
      stdin: JSON.stringify({ prompt: '<channel source="discord" chat_id="home" user="u1">continue</channel>' }), cwd: wd.dir,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('[task thread');
  });
});

describe('conversation commands', () => {
  for (const body of ['!help', '!mute', '!unmute', '!restart']) {
    test(`annotates ${body}, including while muted`, async () => {
      const wd = setupChannelWorkdir();
      expect((await openThreadTask(wd, 'telegram:12345', 'worker:a1b2c3d4e5f6a7b8c', true)).exitCode).toBe(0);
      const result = await run(wd, body, 'http://127.0.0.1:1');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`[conversation command: ${body.slice(1)}]`);
    });
  }
  for (const body of ['!model sonnet', '!effort high']) {
    test(`refuses ${body} before the harness recorder`, async () => {
      const wd = setupChannelWorkdir();
      writeRuntime(wd, { runtime_mode: 'headless', tmux_session: 'hermit-test' });
      expect((await openThreadTask(wd, 'telegram:12345', 'worker:a1b2c3d4e5f6a7b8c', false)).exitCode).toBe(0);
      const result = await run(wd, body, 'http://127.0.0.1:1');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('[conversation command refused: per-conversation model/effort not supported]');
      expect(result.stdout).not.toContain('[harness-command]');
      expect(fs.existsSync(hermit(wd.dir, 'state', 'pending-harness-command.json'))).toBe(false);
    });
  }
  for (const owner of ['worker:a1b2c3d4e5f6a7b8c', 'helper:review']) test(`!clear in a ${owner.split(':')[0]} thread restarts the worker instead of clearing the resident`, async () => {
    const wd = setupChannelWorkdir();
    writeRuntime(wd, { runtime_mode: 'headless', tmux_session: 'hermit-test' });
    expect((await openThreadTask(wd, 'telegram:12345', owner, false)).exitCode).toBe(0);
    const result = await run(wd, '!clear', 'http://127.0.0.1:1');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[conversation command: restart]');
    expect(result.stdout).not.toContain('[harness-command]');
    expect(fs.existsSync(hermit(wd.dir, 'state', 'pending-harness-command.json'))).toBe(false);
  });
  for (const body of ['!compact', '!advisor opus', '!permission-mode plan']) {
    test(`refuses ${body} in a worker thread before the harness recorder`, async () => {
      const wd = setupChannelWorkdir();
      writeRuntime(wd, { runtime_mode: 'headless', tmux_session: 'hermit-test' });
      expect((await openThreadTask(wd, 'telegram:12345', 'worker:a1b2c3d4e5f6a7b8c', false)).exitCode).toBe(0);
      const result = await run(wd, body, 'http://127.0.0.1:1');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`[conversation command refused: ${body.split(' ')[0]} does not reach the resident from a task thread]`);
      expect(result.stdout).not.toContain('[harness-command]');
      expect(fs.existsSync(hermit(wd.dir, 'state', 'pending-harness-command.json'))).toBe(false);
    });
  }
  for (const body of ['!clear', '!model sonnet']) {
    test(`${body} in a resident-owned thread is left to the harness recorder`, async () => {
      const wd = setupChannelWorkdir();
      writeRuntime(wd, { runtime_mode: 'headless', tmux_session: 'hermit-test' });
      expect((await openThreadTask(wd, 'telegram:12345', 'resident', false)).exitCode).toBe(0);
      const result = await run(wd, body, 'http://127.0.0.1:1');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('[task thread telegram:12345: owner=resident');
      expect(result.stdout).not.toContain('[conversation command');
    });
  }
  for (const body of ['!mute', '!unmute', '!restart']) {
    test(`${body} outside a task thread`, async () => {
      const wd = setupChannelWorkdir();
      const result = await run(wd, body, 'http://127.0.0.1:1');
      expect(result.stdout).toContain('[conversation command outside a task thread]');
    });
  }
  test('non-allowed senders get no conversation annotations', async () => {
    const wd = setupChannelWorkdir();
    expect((await openThreadTask(wd, 'telegram:12345', 'worker:a1b2c3d4e5f6a7b8c', false)).exitCode).toBe(0);
    for (const body of ['!help', '!mute', '!unmute', '!restart', '!model sonnet', '!effort high']) {
      const result = await runScript('user-prompt-pipeline.ts', { stdin: JSON.stringify({ prompt: envelope(body, 'stranger') }), cwd: wd.dir });
      expect(result.stdout).not.toContain('[conversation command');
      expect(result.stdout).not.toContain('[task thread');
    }
  });
  test('malformed conversation commands and !fork are ordinary text', async () => {
    const wd = setupChannelWorkdir();
    expect((await openThreadTask(wd, 'telegram:12345', 'worker:a1b2c3d4e5f6a7b8c', false)).exitCode).toBe(0);
    for (const body of ['!mute now', '!restart now', '!fork task', '/mute']) {
      const result = await run(wd, body, 'http://127.0.0.1:1');
      expect(result.stdout).toContain('[task thread');
      expect(result.stdout).not.toContain('[conversation command:');
    }
  });
});
