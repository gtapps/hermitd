// Contract tests for the deterministic send-then-block status responder —
// scripts/lib/prompt-stages/channel-status-responder.ts, driven through the
// single UserPromptSubmit process, scripts/user-prompt-pipeline.ts. Exercised
// as a subprocess against a local HTTP stub (HERMIT_TELEGRAM_API_URL override)
// standing in for the platform.
//
// Covers the probe-verified constraints this hook rests on: exact-match gate
// (near-misses fall through), allowed_users enforcement, and send-then-block
// (only emit {"decision":"block"} after a confirmed send; a failed send must
// never leave both a blocked prompt and a silent operator).
//
// Pipeline note: a block prints the decision JSON alone, while a fall-through
// carries the other stages' context (a `[Now: …]` line, the channel reply
// reminder). "No block, no send" is therefore asserted as the absence of the
// `[status]` marker rather than as empty stdout.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { startHttpStub } from './helpers/http-stub';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.hermit', ...p);
const write = (p: string, content: string) => fs.writeFileSync(p, content);

function envelope(body: string, user = 'u1', chatId = '12345'): string {
  return `<channel source="telegram" chat_id="${chatId}" user="${user}">${body}</channel>`;
}

function payload(body: string, user = 'u1'): string {
  return JSON.stringify({ prompt: envelope(body, user) });
}

// A runnable resident record is the current work the status reply reports.
async function openTask(wd: Workdir, title: string) {
  const dir = hermit(wd.dir);
  const r = await runScript('task.ts', {
    cwd: wd.dir,
    env: { AGENT_DIR: dir },
    args: ['open', dir, '--owner', 'resident', '--title', title, '--requester', 'telegram:u1', '--done', 'Result verified'],
  });
  expect(r.exitCode).toBe(0);
}

function setupChannelWorkdir(configExtra: object = {}): Workdir {
  const wd = setupWorkdir();
  const stateDir = path.join(wd.dir, '.claude.local', 'channels', 'telegram');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=test-token\n');
  write(hermit(wd.dir, 'config.json'), JSON.stringify({
    timezone: 'UTC',
    channels: { telegram: { enabled: true, default_chat_id: '12345', allowed_users: ['u1'], state_dir: '.claude.local/channels/telegram' } },
    ...configExtra,
  }));
  return wd;
}

async function run(wd: Workdir, body: string, stubUrl: string, user = 'u1') {
  return runScript('user-prompt-pipeline.ts', {
    stdin: payload(body, user),
    cwd: wd.dir,
    env: { HERMIT_TELEGRAM_API_URL: stubUrl },
  });
}

describe('channel-status-responder', () => {
  test('exact "!status" + allowed sender -> send-then-block', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      await openTask(wd, 'writing the plan');
      const r = await run(wd, '!status', stub.url);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toMatchObject({ decision: 'block' });
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.text).toContain('writing the plan');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('routes the reply to the chat it was asked on (group id), not default_chat_id', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      // Asked in a Telegram group: chat_id is the group id, distinct from default_chat_id (12345).
      const groupPayload = JSON.stringify({ prompt: envelope('!status', 'u1', '-1001234567890') });
      const r = await runScript('user-prompt-pipeline.ts', {
        stdin: groupPayload,
        cwd: wd.dir,
        env: { HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toMatchObject({ decision: 'block' });
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('-1001234567890');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('case-insensitive and surrounding whitespace still match exactly', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await run(wd, '  !STATUS  ', stub.url);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toMatchObject({ decision: 'block' });
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  // The cutover: the word that used to answer deterministically now reaches the
  // model like any other message.
  test('bare "status" falls through to the model (no block, no send)', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await run(wd, 'status', stub.url);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('[status]');
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('"!status@ourbot" is answered; "!status@otherbot" is not ours', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({
      channels: {
        telegram: {
          enabled: true, default_chat_id: '12345', allowed_users: ['u1'],
          state_dir: '.claude.local/channels/telegram', bot_username: 'ourbot',
        },
      },
    });
    try {
      const mine = await run(wd, '!status@ourbot', stub.url);
      expect(JSON.parse(mine.stdout.trim())).toMatchObject({ decision: 'block' });

      const sent = stub.requests.length;
      const theirs = await run(wd, '!status@otherbot', stub.url);
      expect(theirs.exitCode).toBe(0);
      expect(theirs.stdout).not.toContain('[status]');
      expect(stub.requests.length).toBe(sent);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('near-miss body falls through to the model (no block, no send)', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await run(wd, 'what is the status of the task you are working on?', stub.url);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('[status]');
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('unauthorized sender -> no block, no send', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await run(wd, '!status', stub.url, 'not-allowed');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('[status]');
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  // #10b: a failed deterministic send no longer falls through to a blind model turn —
  // it injects the composed status via stdout (probe-verified to reach the model) for
  // the model to relay verbatim, and does NOT block.
  test('failed send -> injects composed status for the model to relay (not a blind fallthrough)', async () => {
    const wd = setupChannelWorkdir();
    try {
      const r = await run(wd, '!status', 'http://127.0.0.1:1'); // dead listener -> send fails
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('"decision":"block"'); // not blocked — model turn proceeds
      expect(r.stdout).toContain('[status]');               // relay instruction emitted
      expect(r.stdout).toContain('reply tool');             // tells the model to relay
      expect(r.stdout).toContain('All quiet');              // carries the composed status text
    } finally {
      wd.cleanup();
    }
  });

  test('non-channel prompt -> no-op', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runScript('user-prompt-pipeline.ts', {
        stdin: JSON.stringify({ prompt: '!status' }),
        cwd: wd.dir,
        env: { HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('[status]');
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('empty stdin -> fail open, exit 0', async () => {
    const r = await runScript('user-prompt-pipeline.ts', { stdin: '' });
    expect(r.exitCode).toBe(0);
  });

  test('reply never leaks internal vocabulary (internal IDs)', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      await openTask(wd, 'PROP-020 implementation');
      await run(wd, '!status', stub.url);
      const sent = stub.requests[0].body.text as string;
      expect(sent).not.toMatch(/S-\d{3}/);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('paused session -> reply mentions the pause', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      fs.mkdirSync(hermit(wd.dir, 'state'), { recursive: true });
      write(hermit(wd.dir, 'state', 'pause.json'), JSON.stringify({
        paused: true, paused_until: null, reason: 'operator', by: 'test', ts: new Date().toISOString(),
      }));
      const r = await run(wd, '!status', stub.url);
      expect(r.exitCode).toBe(0);
      expect(stub.requests[0].body.text).toContain('Paused');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('pending micro-proposal -> reply names the reply hint', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      write(hermit(wd.dir, 'state', 'micro-proposals.json'), JSON.stringify({
        pending: [{ id: 'MP-20260705-0', status: 'pending', tier: 1, question: 'ok?' }],
      }));
      await run(wd, '!status', stub.url);
      expect(stub.requests[0].body.text).toContain('MP-20260705-0');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('over-budget -> reply names the cap', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ budget: { daily_usd: 5, weekly_usd: null, monthly_usd: null, action: 'alert' } });
    try {
      await run(wd, '!status', stub.url);
      expect(stub.requests[0].body.text).toContain('$5.00 cap');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('empty/fresh state -> "all quiet" fallback', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      await run(wd, '!status', stub.url);
      expect(stub.requests[0].body.text).toContain('All quiet');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  // #10a: an accepted-but-untrusted sender (no allowlist configured, message from a
  // chat that isn't the operator DM) gets a coarse reply — never spend, task, or IDs.
  test('untrusted sender (no allowlist, non-DM chat) -> redacted coarse status', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({
      channels: { telegram: { enabled: true, default_chat_id: '12345', state_dir: '.claude.local/channels/telegram' } },
      budget: { daily_usd: 5, weekly_usd: null, monthly_usd: null, action: 'alert' },
    });
    try {
      fs.mkdirSync(hermit(wd.dir, 'state'), { recursive: true });
      await openTask(wd, 'secret-migration');
      write(hermit(wd.dir, 'state', 'micro-proposals.json'), JSON.stringify({ pending: [{ id: 'MP-20260705-0', status: 'pending', tier: 1, question: 'ok?' }] }));

      const stranger = JSON.stringify({ prompt: '<channel source="telegram" chat_id="999" user="stranger">!status</channel>' });
      const r = await runScript('user-prompt-pipeline.ts', { stdin: stranger, cwd: wd.dir, env: { HERMIT_TELEGRAM_API_URL: stub.url } });
      expect(r.exitCode).toBe(0);
      const text = stub.requests[0].body.text;
      expect(text).not.toContain('secret-migration'); // task text withheld
      expect(text).not.toContain('$5.00');             // budget figure withheld
      expect(text).not.toContain('MP-20260705-0');     // approval id withheld
      expect(text).toContain('Working');               // coarse state only
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  // ---- pt-PT localization (config.language: "português") ----
  // The exact-English assertions above stay untouched; these cover the same
  // reply shapes composed through the pt-PT StatusMessages table.
  describe('pt-PT localization', () => {
    test('working line', async () => {
      const stub = startHttpStub();
      const wd = setupChannelWorkdir({ language: 'português' });
      try {
        await openTask(wd, 'o plano');
        await run(wd, '!status', stub.url);
        expect(stub.requests[0].body.text).toContain('A trabalhar em o plano.');
      } finally {
        stub.stop();
        wd.cleanup();
      }
    });

    test('paused line', async () => {
      const stub = startHttpStub();
      const wd = setupChannelWorkdir({ language: 'português' });
      try {
        fs.mkdirSync(hermit(wd.dir, 'state'), { recursive: true });
        write(hermit(wd.dir, 'state', 'pause.json'), JSON.stringify({
          paused: true, paused_until: null, reason: 'operator', by: 'test', ts: new Date().toISOString(),
        }));
        await run(wd, '!status', stub.url);
        expect(stub.requests[0].body.text).toContain('Em pausa (o seu pedido) até que a retome.');
      } finally {
        stub.stop();
        wd.cleanup();
      }
    });

    test('all-quiet fallback', async () => {
      const stub = startHttpStub();
      const wd = setupChannelWorkdir({ language: 'português' });
      try {
        await run(wd, '!status', stub.url);
        expect(stub.requests[0].body.text).toContain('Tudo calmo — nada em curso, nada à espera.');
      } finally {
        stub.stop();
        wd.cleanup();
      }
    });

    test('redacted coarse state for an untrusted sender', async () => {
      const stub = startHttpStub();
      const wd = setupChannelWorkdir({
        language: 'português',
        channels: { telegram: { enabled: true, default_chat_id: '12345', state_dir: '.claude.local/channels/telegram' } },
      });
      try {
        await openTask(wd, 'segredo');
        const stranger = JSON.stringify({ prompt: '<channel source="telegram" chat_id="999" user="stranger">!status</channel>' });
        const r = await runScript('user-prompt-pipeline.ts', { stdin: stranger, cwd: wd.dir, env: { HERMIT_TELEGRAM_API_URL: stub.url } });
        expect(r.exitCode).toBe(0);
        const text = stub.requests[0].body.text as string;
        expect(text).not.toContain('segredo'); // task text withheld
        expect(text).toContain('A trabalhar.'); // coarse pt-PT state only
      } finally {
        stub.stop();
        wd.cleanup();
      }
    });
  });

  // #634 regression: the harness injects a plugin-qualified source
  // (`plugin:telegram:telegram`), but config keys channels by the bare server
  // name. Without normalization, both the allowed_users gate and the outbound
  // send target miss — the stub would receive zero requests.
  test('plugin-qualified source resolves the allowlist gate and the send target', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      await openTask(wd, 'writing the plan');
      const qualified = JSON.stringify({ prompt: '<channel source="plugin:telegram:telegram" chat_id="12345" user="u1">!status</channel>' });
      const r = await runScript('user-prompt-pipeline.ts', { stdin: qualified, cwd: wd.dir, env: { HERMIT_TELEGRAM_API_URL: stub.url } });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toMatchObject({ decision: 'block' });
      // A raw qualified target.id would miss lib/channel-send's SENDERS lookup entirely (zero requests).
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('12345');
      expect(stub.requests[0].body.text).toContain('writing the plan');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });
});


test('mapped threaded status is sent through the project script in the asking thread', async () => {
  const wd = setupWorkdir();
  try {
    write(path.join(wd.dir, 'send.sh'), '#!/bin/sh\ncat > status.out\nprintf "%s" "$HERMIT_THREAD_ID" > thread.out\n');
    fs.chmodSync(path.join(wd.dir, 'send.sh'), 0o755);
    write(hermit(wd.dir, 'config.json'), JSON.stringify({ channels: { custom: {
      send_script: 'send.sh', allowed_users: ['U1'], attributes: { chat_id: 'channel_id', thread_id: 'thread_ts' },
    } } }));
    const result = await runScript('user-prompt-pipeline.ts', {
      cwd: wd.dir, env: { AGENT_DIR: hermit(wd.dir) },
      stdin: JSON.stringify({ prompt: '<channel source="custom" channel_id="C1" user_id="U1" thread_ts="T1">!status</channel>' }),
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).decision).toBe('block');
    expect(fs.readFileSync(path.join(wd.dir, 'thread.out'), 'utf8')).toBe('T1');
    expect(fs.readFileSync(path.join(wd.dir, 'status.out'), 'utf8').length).toBeGreaterThan(0);
  } finally { wd.cleanup(); }
});
