// Contract tests for the deterministic shutdown gate —
// scripts/lib/prompt-stages/shutdown-gate.ts, driven through the single
// UserPromptSubmit process, scripts/user-prompt-pipeline.ts. Exercised as a
// subprocess against a local HTTP stub (HERMIT_TELEGRAM_API_URL) standing in
// for the platform, mirroring the channel-status-responder tests.
//
// Pipeline note: a block prints the decision JSON alone; a pass-through still
// carries the earlier stages' context (`[Now: …]`, the reply reminder), so
// "pass through" is asserted as the absence of the `[shutdown]` marker.

import { afterAll, describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { startHttpStub } from './helpers/http-stub';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.hermit', ...p);

const workdirs: Workdir[] = [];
afterAll(() => {
  for (const wd of workdirs.splice(0)) wd.cleanup();
});

function envelope(body: string, user = 'u1', chatId = '12345'): string {
  return `<channel source="telegram" chat_id="${chatId}" user="${user}">${body}</channel>`;
}

function setupChannelWorkdir(): Workdir {
  const wd = setupWorkdir();
  workdirs.push(wd);
  const stateDir = path.join(wd.dir, '.claude.local', 'channels', 'telegram');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=test-token\n');
  fs.writeFileSync(hermit(wd.dir, 'config.json'), JSON.stringify({
    timezone: 'UTC',
    channels: { telegram: { enabled: true, default_chat_id: '12345', allowed_users: ['u1'], state_dir: '.claude.local/channels/telegram' } },
  }));
  return wd;
}

function writeRuntime(wd: Workdir, patch: Record<string, unknown>): void {
  const p = hermit(wd.dir, 'state', 'runtime.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ version: 1, ...patch }));
}

const PENDING = { shutdown_requested_at: '2026-07-24T09:00:00+0000', shutdown_completed_at: null };

async function run(wd: Workdir, prompt: string, stubUrl: string) {
  return runScript('user-prompt-pipeline.ts', {
    stdin: JSON.stringify({ prompt }),
    cwd: wd.dir,
    env: { HERMIT_TELEGRAM_API_URL: stubUrl },
  });
}

describe('shutdown-gate', () => {
  test('pending shutdown + channel + allowed sender + send ok → block', async () => {
    const stub = startHttpStub();
    try {
      const wd = setupChannelWorkdir();
      writeRuntime(wd, PENDING);
      const r = await run(wd, envelope('do something'), stub.url);
      expect(JSON.parse(r.stdout.trim())).toMatchObject({ decision: 'block' });
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.text.toLowerCase()).toContain('shutting down');
    } finally {
      stub.stop();
    }
  });

  test('no pending shutdown → pass through (no block, no send)', async () => {
    const stub = startHttpStub();
    try {
      const wd = setupChannelWorkdir();
      writeRuntime(wd, { shutdown_requested_at: null, shutdown_completed_at: null });
      const r = await run(wd, envelope('do something'), stub.url);
      expect(r.stdout).not.toContain('[shutdown]');
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
    }
  });

  test('already-completed shutdown → not pending → pass through', async () => {
    const stub = startHttpStub();
    try {
      const wd = setupChannelWorkdir();
      writeRuntime(wd, { shutdown_requested_at: '2026-07-24T09:00:00+0000', shutdown_completed_at: '2026-07-24T09:01:00+0000' });
      const r = await run(wd, envelope('do something'), stub.url);
      expect(r.stdout).not.toContain('[shutdown]');
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
    }
  });

  test('non-channel prompt → pass through even during shutdown', async () => {
    const stub = startHttpStub();
    try {
      const wd = setupChannelWorkdir();
      writeRuntime(wd, PENDING);
      const r = await run(wd, 'just a normal operator prompt', stub.url);
      expect(r.stdout).not.toContain('[shutdown]');
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
    }
  });

  test('unauthorized sender → no block, no send', async () => {
    const stub = startHttpStub();
    try {
      const wd = setupChannelWorkdir();
      writeRuntime(wd, PENDING);
      const r = await run(wd, envelope('do something', 'intruder'), stub.url);
      expect(r.stdout).not.toContain('[shutdown]');
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
    }
  });

  test('send failure → fallback instruction, no block', async () => {
    const wd = setupChannelWorkdir();
    writeRuntime(wd, PENDING);
    // Unreachable stub URL forces the send to fail.
    const r = await run(wd, envelope('do something'), 'http://127.0.0.1:1');
    expect(r.stdout).not.toContain('"decision":"block"');
    expect(r.stdout.toLowerCase()).toContain('shutdown is in progress');
  });

  test('malformed stdin → exit 0, no relay and no block', async () => {
    // The payload-independent stages still run (that is what emits `[Now:`), but
    // with no parseable envelope the gate has no chat to answer on, so it stays
    // silent rather than relaying into the void.
    const wd = setupChannelWorkdir();
    writeRuntime(wd, PENDING);
    const r = await runScript('user-prompt-pipeline.ts', { stdin: 'not json', cwd: wd.dir, env: {} });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('"decision":"block"');
    expect(r.stdout.toLowerCase()).not.toContain('shutdown is in progress');
  });
});
