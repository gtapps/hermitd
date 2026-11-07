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
import { writePtMessages } from './helpers/pt-messages';
import { decodeTask, encodeTask, mutateTask } from '../scripts/lib/tasks';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.hermit', ...p);
const write = (p: string, content: string) => fs.writeFileSync(p, content);

function seedDecisions(wd: Workdir, entries: any[]): void {
  for (const entry of entries) {
    if (entry.status !== 'pending') continue;
    mutateTask(hermit(wd.dir), 'open', undefined, { requester: 'agent', title: entry.question ?? entry.id ?? entry.key ?? 'Question', done: 'Answered',
      ...(entry.chat ? { conversation: entry.chat } : {}), ...(entry.key ? { 'dedupe-key': entry.key } : {}),
      'waiting-on': 'admin', decision: JSON.stringify({ purpose: 'input', authority: 'admin', generation: 1 }),
    }, '');
  }
}

function envelope(body: string, user = 'u1', chatId = '12345'): string {
  return `<channel source="telegram" chat_id="${chatId}" user="${user}">${body}</channel>`;
}

function payload(body: string, user = 'u1'): string {
  return JSON.stringify({ prompt: envelope(body, user) });
}

// A runnable resident record is the current work the status reply reports.
async function openTask(wd: Workdir, title: string, owner = 'resident', conversation = 'telegram:12345'): Promise<string> {
  const dir = hermit(wd.dir);
  const r = await runScript('task.ts', {
    cwd: wd.dir,
    env: { AGENT_DIR: dir },
    args: ['open', dir, '--owner', owner, '--title', title, '--requester', 'telegram:u1', '--done', 'Result verified', '--conversation', conversation],
  });
  expect(r.exitCode).toBe(0);
  const opened = JSON.parse(r.stdout);
  expect(opened.id).toMatch(/^T-/);
  return opened.id;
}

async function taskCommand(wd: Workdir, verb: string, id: string, args: string[], stdin = '') {
  const dir = hermit(wd.dir);
  const r = await runScript('task.ts', {
    cwd: wd.dir, env: { AGENT_DIR: dir }, args: [verb, dir, id, ...args], stdin,
  });
  expect(r.exitCode).toBe(0);
  expect(JSON.parse(r.stdout).status).not.toBe('refused');
}

// A record parked on a question to `who`.
async function waitOn(wd: Workdir, title: string, who: string): Promise<string> {
  const id = await openTask(wd, title);
  await taskCommand(wd, 'block', id, ['--waiting-on', who, '--status-line', 'Need answer', '--next', 'Reply']);
  return id;
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
  test('Rui sees only his asking chat; Ana sees no admin waits or approvals', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ channels: { telegram: {
      enabled: true, default_chat_id: '12345', allowed_users: ['rui', 'ana'], state_dir: '.claude.local/channels/telegram',
    } } });
    try {
      const report = await openTask(wd, 'DM report', 'resident', 'telegram:12345');
      await taskCommand(wd, 'block', report, ['--waiting-on', 'telegram:rui', '--status-line', 'Review', '--next', 'Reply']);
      const question = await openTask(wd, 'Loja question', 'resident', 'telegram:loja');
      await taskCommand(wd, 'block', question, ['--waiting-on', 'operator', '--status-line', 'Answer', '--next', 'Reply']);
      seedDecisions(wd, [
        { id: 'MP-watch', status: 'pending', chat: 'telegram:loja' },
      ]);
      for (const [user, chat] of [['rui', '12345'], ['rui', 'loja'], ['ana', 'loja']]) {
        const r = await runScript('user-prompt-pipeline.ts', { cwd: wd.dir, env: { HERMIT_TELEGRAM_API_URL: stub.url },
          stdin: JSON.stringify({ prompt: envelope('!status', user, chat) }) });
        expect(r.exitCode).toBe(0);
      }
      expect(stub.requests[0].body.text).toContain('DM report');
      expect(stub.requests[0].body.text).not.toContain('Loja');
      expect(stub.requests[0].body.text).not.toContain('1 waiting on admin.');
      expect(stub.requests[1].body.text).toContain('Loja question');
      expect(stub.requests[1].body.text).toContain('1 waiting on admin.');
      expect(stub.requests[1].body.text).not.toContain('DM report');
      expect(stub.requests[2].body.text).toBe('All quiet — nothing in progress, nothing waiting.');
    } finally { stub.stop(); wd.cleanup(); }
  });

  test('next routine is scoped to the chat with unbound routines only at home', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ routines: [
      { id: 'home-only', schedule: '0 8 * * *' },
      { id: 'elsewhere', schedule: '0 9 * * *', chat: 'telegram:elsewhere' },
    ] });
    try {
      await run(wd, '!status', stub.url);
      expect(stub.requests[0].body.text).toContain('home-only');
      expect(stub.requests[0].body.text).not.toContain('elsewhere');
      await runScript('user-prompt-pipeline.ts', { cwd: wd.dir, env: { HERMIT_TELEGRAM_API_URL: stub.url },
        stdin: JSON.stringify({ prompt: envelope('!status', 'u1', 'loja') }) });
      expect(stub.requests[1].body.text).not.toContain('Next routine');
    } finally { stub.stop(); wd.cleanup(); }
  });

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

  test.each(['helper:report', 'worker:a5670124e38fb50cb'])('a record owned by %s counts as work in progress', async owner => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      await openTask(wd, 'Delegated draft', owner);
      await run(wd, '!status', stub.url);
      const text = stub.requests[0].body.text as string;
      expect(text).toMatch(/Working on Delegated draft \(opened \d+ seconds? ago\)\./);
      expect(text).not.toContain('All quiet');
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
      seedDecisions(wd, [{ id: 'MP-20260705-0', status: 'pending', tier: 1, question: 'ok?' }]);
      await run(wd, '!status', stub.url);
      expect(stub.requests[0].body.text).toContain('1 waiting on admin.');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('waiting results and questions are scoped to the requester and omit cleared waits', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const result = await openTask(wd, 'Draft report', 'helper:report');
      await taskCommand(wd, 'block', result, ['--result-stdin'], 'Ready for review');
      await waitOn(wd, 'Book venue', 'telegram:u1');
      await waitOn(wd, 'Someone else', 'telegram:u2');
      const cleared = await waitOn(wd, 'Cleared wait', 'telegram:u1');
      await taskCommand(wd, 'note', cleared, ['--clear-waiting']);

      await run(wd, '!status', stub.url);
      const text = stub.requests[0].body.text as string;
      const block = text.slice(text.indexOf('Waiting on you:'));
      expect(block).toContain('• Draft report: confirm the result (');
      expect(block).toContain('• Book venue: answer the question (');
      expect(block).not.toContain('Someone else');
      expect(block).not.toContain('Cleared wait');
      expect(block).not.toMatch(/T-\d/);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('orders waits by their relevant timestamp and uses locale relative time', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      await waitOn(wd, 'Newer question', 'telegram:u1');
      const older = await openTask(wd, 'Older result');
      await taskCommand(wd, 'block', older, ['--result-stdin'], 'Ready');
      const file = hermit(wd.dir, 'tasks', `${older}.md`);
      const record = decodeTask(fs.readFileSync(file, 'utf8'));
      record.result_at = new Date(Date.now() - 3 * 3600000).toISOString();
      fs.writeFileSync(file, encodeTask(record));

      await run(wd, '!status', stub.url);
      const text = stub.requests[0].body.text as string;
      expect(text).toContain('Older result: confirm the result (3 hours ago)');
      expect(text.indexOf('Older result')).toBeLessThan(text.indexOf('Newer question'));
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('a question raised after a result is listed as the question', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const id = await openTask(wd, 'Draft report');
      await taskCommand(wd, 'block', id, ['--result-stdin'], 'Ready');
      const file = hermit(wd.dir, 'tasks', `${id}.md`);
      const record = decodeTask(fs.readFileSync(file, 'utf8'));
      record.result_at = new Date(Date.now() - 3 * 3600000).toISOString();
      fs.writeFileSync(file, encodeTask(record));
      await taskCommand(wd, 'block', id, ['--waiting-on', 'telegram:u1', '--status-line', 'Need answer', '--next', 'Reply']);

      await run(wd, '!status', stub.url);
      const text = stub.requests[0].body.text as string;
      expect(text).toContain('• Draft report: answer the question (');
      expect(text).not.toContain('confirm the result');
      expect(text).not.toContain('hours ago');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('status names this chat work instead of a runnable agent-wide decision', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const dir = hermit(wd.dir);
      const decision = mutateTask(dir, 'open', undefined, { requester: 'agent', kind: 'proposal', title: 'Global proposal', done: 'Done' }, '') as { id: string };
      expect(mutateTask(dir, 'answer', decision.id, { chat: 'telegram:12345', user: 'u1', reply: 'yes' }, '')).toMatchObject({ status: 'match' });
      await openTask(wd, 'Chat assignment');
      await run(wd, '!status', stub.url);
      const text = stub.requests[0].body.text as string;
      expect(text).toContain('Chat assignment');
      expect(text).not.toContain('Global proposal');
    } finally { stub.stop(); wd.cleanup(); }
  });

  test('counts only approvals for this chat, treating chat-less entries as home', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      seedDecisions(wd, [
        { id: 'MP-home', status: 'pending' },
        { id: 'MP-other', status: 'pending', chat: 'telegram:999' },
        { id: 'MP-resolved', status: 'resolved', chat: 'telegram:12345' },
      ]);
      await run(wd, '!status', stub.url);
      const text = stub.requests[0].body.text as string;
      expect(text).toContain('• 1 waiting on admin.');
      expect(text).not.toContain('MP-other');
      expect(text).not.toContain('2 approvals');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('chat-less approvals count in any chat when no home chat resolves', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({
      channels: { telegram: { enabled: true, allowed_users: ['u1'], state_dir: '.claude.local/channels/telegram' } },
    });
    try {
      seedDecisions(wd, [
        { id: 'MP-legacy', status: 'pending' },
      ]);
      await run(wd, '!status', stub.url);
      expect(stub.requests[0].body.text as string).toContain('• 1 waiting on admin.');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('limits the block to five items and counts hidden approvals', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      for (let i = 0; i < 7; i++) await waitOn(wd, `Item ${i}`, 'telegram:u1');
      await run(wd, '!status', stub.url);
      const lines = (stub.requests[0].body.text as string).split('\n');
      expect(lines.filter(line => line.startsWith('• '))).toHaveLength(5);
      expect(lines.at(-1)).toBe('+2 more');
      expect(lines.join('\n')).not.toMatch(/T-\d/);

      seedDecisions(wd, [
        { id: 'MP-home', status: 'pending' },
      ]);
      await run(wd, '!status', stub.url);
      const withApproval = (stub.requests[1].body.text as string).split('\n');
      expect(withApproval.filter(line => line.startsWith('• '))).toHaveLength(5);
      expect(withApproval.at(-1)).toBe('+3 more');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('trusted home chat without a sender sees only operator waits', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({
      channels: { telegram: { enabled: true, default_chat_id: '12345', state_dir: '.claude.local/channels/telegram' } },
    });
    try {
      await waitOn(wd, 'Operator wait', 'operator');
      const sender = await openTask(wd, 'Personal wait');
      await taskCommand(wd, 'block', sender, ['--result-stdin'], 'Ready');
      const r = await runScript('user-prompt-pipeline.ts', {
        cwd: wd.dir, env: { HERMIT_TELEGRAM_API_URL: stub.url },
        stdin: JSON.stringify({ prompt: '<channel source="telegram" chat_id="12345">!status</channel>' }),
      });
      expect(r.exitCode).toBe(0);
      const text = stub.requests[0].body.text as string;
      expect(text).toContain('Operator wait: answer the question');
      expect(text).not.toContain('Personal wait');
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
      seedDecisions(wd, [{ id: 'MP-20260705-0', status: 'pending', tier: 1, question: 'ok?' }]);

      const stranger = JSON.stringify({ prompt: '<channel source="telegram" chat_id="999" user="stranger">!status</channel>' });
      const r = await runScript('user-prompt-pipeline.ts', { stdin: stranger, cwd: wd.dir, env: { HERMIT_TELEGRAM_API_URL: stub.url } });
      expect(r.exitCode).toBe(0);
      const text = stub.requests[0].body.text;
      expect(text).not.toContain('secret-migration'); // task text withheld
      expect(text).not.toContain('$5.00');             // budget figure withheld
      expect(text).not.toContain('1 waiting on admin.');     // approval id withheld
      expect(text).toBe('Working.');                   // coarse state only
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  // ---- pt-PT localization (config.language: "português") ----
  // The exact-English assertions above stay untouched; these cover the same
  // reply shapes read from a Portuguese state/messages.json.
  describe('pt-PT localization', () => {
    test('waiting header and result confirmation', async () => {
      const stub = startHttpStub();
      const wd = setupChannelWorkdir({ language: 'português' });
      try {
        writePtMessages(hermit(wd.dir), 'português');
        const id = await openTask(wd, 'Relatório');
        await taskCommand(wd, 'block', id, ['--result-stdin'], 'Pronto');
        await run(wd, '!status', stub.url);
        const text = stub.requests[0].body.text as string;
        expect(text).toContain('À sua espera:\n• Relatório: confirme o resultado (');
        expect(text).toMatch(/há \d+ segundos?\)/);
      } finally {
        stub.stop();
        wd.cleanup();
      }
    });

    test('working line', async () => {
      const stub = startHttpStub();
      const wd = setupChannelWorkdir({ language: 'português' });
      try {
        writePtMessages(hermit(wd.dir), 'português');
        await openTask(wd, 'o plano');
        await run(wd, '!status', stub.url);
        expect(stub.requests[0].body.text).toMatch(/A trabalhar em o plano \(aberta há \d+ segundos?\)\./);
      } finally {
        stub.stop();
        wd.cleanup();
      }
    });

    test('paused line', async () => {
      const stub = startHttpStub();
      const wd = setupChannelWorkdir({ language: 'português' });
      try {
        writePtMessages(hermit(wd.dir), 'português');
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
        writePtMessages(hermit(wd.dir), 'português');
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
        writePtMessages(hermit(wd.dir), 'português');
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
    await openTask(wd, 'Other thread work', 'resident', 'custom:C1~T2');
    await openTask(wd, 'This thread work', 'resident', 'custom:C1~T1');
    const result = await runScript('user-prompt-pipeline.ts', {
      cwd: wd.dir, env: { AGENT_DIR: hermit(wd.dir) },
      stdin: JSON.stringify({ prompt: '<channel source="custom" channel_id="C1" user_id="U1" thread_ts="T1">!status</channel>' }),
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).decision).toBe('block');
    expect(fs.readFileSync(path.join(wd.dir, 'thread.out'), 'utf8')).toBe('T1');
    expect(fs.readFileSync(path.join(wd.dir, 'status.out'), 'utf8')).toContain('This thread work');
    expect(fs.readFileSync(path.join(wd.dir, 'status.out'), 'utf8')).not.toContain('Other thread work');
  } finally { wd.cleanup(); }
});

describe('!scheduled', () => {
  test('lists this chat and home unbound entries, states, intervals, and checks while paused', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ timezone: 'Europe/Lisbon', routines: [
      { id: 'daily', schedule: '15 9 * * *', enabled: true },
      { id: 'disabled', schedule: '0 12 * * 1', enabled: false, chat: 'telegram:12345' },
      { id: 'other-routine', schedule: '0 8 * * *', chat: 'telegram:other' },
    ], monitors: [
      { id: 'disk', description: 'Disk usage', command: 'watch-poll disk --every 2m -- df -h', enabled: true },
      { id: 'deploy', description: 'Deploy finishes', command: 'watch-poll deploy -- bin/deploy', enabled: false, chat: 'telegram:12345' },
      { id: 'off', description: 'Disabled watch', command: 'watch-poll off -- echo off', enabled: false, chat: 'telegram:12345' },
      { id: 'flagged', description: 'Flag in check', command: 'watch-poll flagged -- "tool --every 2h"', enabled: true },
      { id: 'stream', description: 'Log errors', command: 'tail -f app.log', enabled: true },
      { id: 'other-watch', description: 'Other chat', command: 'watch-poll other -- secret', chat: 'telegram:other' },
    ] });
    try {
      write(hermit(wd.dir, 'state', 'pause.json'), JSON.stringify({ paused: true, reason: 'operator' }));
      seedDecisions(wd, [
        { status: 'pending', key: 'watch-enable:deploy', chat: 'telegram:12345' },
        { status: 'pending', key: 'watch-enable:off', chat: 'telegram:other' },
      ]);
      write(hermit(wd.dir, 'state', 'monitors.runtime.json'), JSON.stringify({ monitors: [{ id: 'temporary' }] }));
      const r = await run(wd, '!scheduled', stub.url);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout).decision).toBe('block');
      const text = stub.requests[0].body.text as string;
      expect(text).toContain('daily: 09:15 (Europe/Lisbon); on');
      expect(text).toContain('disabled: 0 12 * * 1 (Europe/Lisbon); off');
      expect(text).toContain('flagged: Flag in check; every 5m; on; check: "tool --every 2h"');
      expect(text).toContain('stream: Log errors; on; command: tail -f app.log');
      expect(text).toContain('disk: Disk usage; every 2m; on; check: df -h');
      expect(text).toContain("deploy: Deploy finishes; every 5m; waiting for an admin's yes; check: bin/deploy");
      expect(text).toContain('off: Disabled watch; every 5m; off; check: echo off');
      expect(text).not.toMatch(/other-routine|other-watch|temporary/);
      await runScript('user-prompt-pipeline.ts', { cwd: wd.dir, env: { HERMIT_TELEGRAM_API_URL: stub.url },
        stdin: JSON.stringify({ prompt: envelope('!scheduled', 'u1', 'other') }) });
      const other = stub.requests[1].body.text as string;
      expect(other).toContain('other-routine');
      expect(other).toContain('other-watch');
      expect(other).not.toMatch(/daily:|disk:|deploy:/);
    } finally { stub.stop(); wd.cleanup(); }
  });

  test('caps rows at ten and check text at 200 characters', async () => {
    const stub = startHttpStub();
    const check = 'x'.repeat(220);
    const wd = setupChannelWorkdir({
      routines: [{ id: 'daily', schedule: '0 8 * * *' }],
      monitors: Array.from({ length: 11 }, (_, i) => ({ id: `watch-${i}`, description: 'Check', command: `watch-poll watch-${i} -- ${check}` })),
    });
    try {
      await run(wd, '!scheduled', stub.url);
      const text = stub.requests[0].body.text as string;
      expect(text.split('\n').filter(line => line.startsWith('• '))).toHaveLength(10);
      expect(text.split('\n').at(-1)).toBe('+2 more');
      expect(text).toContain('check: ' + 'x'.repeat(200));
      expect(text).not.toContain('x'.repeat(201));
    } finally { stub.stop(); wd.cleanup(); }
  });

  test('an admitted untrusted sender gets only this chat count', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({
      channels: { telegram: { enabled: true, default_chat_id: '12345', state_dir: '.claude.local/channels/telegram' } },
      monitors: [{ id: 'secret', description: 'Private check', command: 'watch-poll secret -- hidden', chat: 'telegram:group' },
        { id: 'home-only', command: 'watch-poll home-only -- hidden' }],
    });
    try {
      await runScript('user-prompt-pipeline.ts', { cwd: wd.dir, env: { HERMIT_TELEGRAM_API_URL: stub.url },
        stdin: JSON.stringify({ prompt: envelope('!scheduled', 'member', 'group') }) });
      expect(stub.requests[0].body.text).toBe('Scheduled in this chat: 1.');
    } finally { stub.stop(); wd.cleanup(); }
  });

  test('unbound entries are hidden when no home resolves', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({
      channels: { telegram: { enabled: true, allowed_users: ['u1'], state_dir: '.claude.local/channels/telegram' } },
      monitors: [{ id: 'unbound', command: 'watch-poll unbound -- hidden' }],
    });
    try {
      await run(wd, '!scheduled', stub.url);
      expect(stub.requests[0].body.text).toBe('Nothing scheduled in this chat.');
    } finally { stub.stop(); wd.cleanup(); }
  });

  test('translates empty and watch replies into European Portuguese', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ language: 'português' });
    try {
      writePtMessages(hermit(wd.dir), 'português');
      await run(wd, '!scheduled', stub.url);
      expect(stub.requests[0].body.text).toBe('Nada agendado nesta conversa.');
      const config = JSON.parse(fs.readFileSync(hermit(wd.dir, 'config.json'), 'utf8'));
      config.monitors = [{ id: 'deploy', description: 'Fim do deploy', enabled: false, command: 'watch-poll deploy -- bin/deploy' }];
      write(hermit(wd.dir, 'config.json'), JSON.stringify(config));
      seedDecisions(wd, [
        { status: 'pending', key: 'watch-enable:deploy', chat: 'telegram:12345' },
      ]);
      await run(wd, '!scheduled', stub.url);
      expect(stub.requests[1].body.text).toContain('a cada 5m; à espera do sim de um administrador; verificação: bin/deploy');
    } finally { stub.stop(); wd.cleanup(); }
  });

  test('rejects arguments and unadmitted senders and relays failed delivery', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      await run(wd, '!scheduled extra', stub.url);
      await run(wd, '!scheduled', stub.url, 'not-allowed');
      expect(stub.requests).toHaveLength(0);
      const failed = await run(wd, '!scheduled', 'http://127.0.0.1:1');
      expect(failed.stdout).toContain('[scheduled]');
      expect(failed.stdout).toContain('Nothing scheduled in this chat.');
      expect(failed.stdout).not.toContain('"decision":"block"');
    } finally { stub.stop(); wd.cleanup(); }
  });

  test('a thread lists its whole chat\'s standing work and approvals', async () => {
    const wd = setupWorkdir();
    try {
      write(path.join(wd.dir, 'send.sh'), '#!/bin/sh\ncat >> replies.out\n');
      fs.chmodSync(path.join(wd.dir, 'send.sh'), 0o755);
      write(hermit(wd.dir, 'config.json'), JSON.stringify({
        channels: { custom: { send_script: 'send.sh', allowed_users: ['U1'], attributes: { chat_id: 'channel_id', thread_id: 'thread_ts' } } },
        routines: [{ id: 'thread-routine', schedule: '0 8 * * *', chat: 'custom:C1~T1' },
          { id: 'chat-routine', schedule: '0 9 * * *', chat: 'custom:C1' },
          { id: 'other-chat-routine', schedule: '0 10 * * *', chat: 'custom:C2' }],
        monitors: [{ id: 'chat-watch', description: 'deploy', enabled: true, chat: 'custom:C1',
          command: '.hermit/bin/hermitd-run watch-poll chat-watch -- curl -s example.test' }],
      }));
      seedDecisions(wd, [
        { id: 'MP-1', status: 'pending', key: 'watch-enable:x', question: 'q?' }]);
      for (const command of ['!scheduled', '!status']) {
        const r = await runScript('user-prompt-pipeline.ts', { cwd: wd.dir, env: { AGENT_DIR: hermit(wd.dir) },
          stdin: JSON.stringify({ prompt: `<channel source="custom" channel_id="C1" user_id="U1" thread_ts="T1">${command}</channel>` }) });
        expect(JSON.parse(r.stdout).decision).toBe('block');
      }
      const text = fs.readFileSync(path.join(wd.dir, 'replies.out'), 'utf8');
      expect(text).toContain('thread-routine');
      expect(text).toContain('chat-routine');
      expect(text).toContain('chat-watch');
      expect(text).not.toContain('other-chat-routine');
      expect(text).toContain('1 waiting on admin.');
    } finally { wd.cleanup(); }
  });
});
