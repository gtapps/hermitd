// Contract tests for scripts/channel-send.ts + scripts/lib/channel-send.ts —
// the first script-owned (non-model) channel send. Exercised as a subprocess
// (the CLI wrapper) against a local HTTP stub standing in for the platform API
// (HERMIT_TELEGRAM_API_URL override), so no real bot token or network access
// is needed.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript, runPinnedScript, type RunOptions } from './helpers/run';
import { setupWorkdir, writeConfig, type Workdir } from './helpers/workdir';
import { startHttpStub } from './helpers/http-stub';
import { unconsolidated, dbExists } from '../scripts/lib/channel-log';
import { sendOperatorNotice, splitMessage, sendToChannel, sendToOwnedChat } from '../scripts/lib/channel-send';
import { channelHealthPath } from '../scripts/lib/channel-health';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.hermit', ...p);
const write = (p: string, content: string) => fs.writeFileSync(p, content);

// channel-send.ts pins its state dir to hermitDir(), so these tests need the
// sanctioned absolute-AGENT_DIR override that runPinnedScript already owns for
// this class of script. A call with no argv (the usage-error case) skips the pin
// — its arity check fires first. Tests that pass a deliberately foreign state
// dir call runScript directly, per that helper's own note.
function runChannelSend(opts: RunOptions = {}) {
  const { args = [], ...rest } = opts;
  // The state dir is the first POSITIONAL, not args[0]: parseArgs pulls
  // --tier/--notice out from anywhere in argv, so a flag-first call is legal and
  // would otherwise pin AGENT_DIR to "--tier" and fail with a confusing exit 2.
  const stateDir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--tier');
  return stateDir
    ? runPinnedScript('channel-send.ts', stateDir, args, rest)
    : runScript('channel-send.ts', opts);
}

function setupChannelWorkdir(telegramExtra: object = {}, topExtra: object = {}): Workdir {
  const wd = setupWorkdir();
  const stateDir = path.join(wd.dir, '.claude.local', 'channels', 'telegram');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=test-token\n');
  write(hermit(wd.dir, 'config.json'), JSON.stringify({
    ...topExtra,
    channels: { telegram: { enabled: true, default_chat_id: '12345', state_dir: '.claude.local/channels/telegram', ...telegramExtra } },
  }));
  return wd;
}

describe('channel-send CLI', () => {
  test('success: 2xx -> exit 0, request reaches the stub, out-log row written', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runChannelSend({
        args: [hermit(wd.dir), 'hello operator'],
        env: { HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.text).toBe('hello operator');
      expect(stub.requests[0].body.chat_id).toBe('12345');

      const rows = unconsolidated(hermit(wd.dir)).rows;
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({ source: 'telegram', chat_id: '12345', direction: 'out', text: 'hello operator' });
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('sends text over the telegram 4096-char limit as ordered parts and logs it whole', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const first = 'a'.repeat(3000);
      const second = 'b'.repeat(3000);
      const r = await runChannelSend({
        args: [hermit(wd.dir), '-'],
        stdin: `${first}\n\n${second}`,
        env: { HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).toBe(0);
      expect(stub.requests.map((q) => q.body.text)).toEqual([first, second]);
      const rows = unconsolidated(hermit(wd.dir)).rows;
      expect(rows.length).toBe(1);
      expect(rows[0].text).toBe(`${first}\n\n${second}`);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('reads the message from stdin when the text arg is "-"', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runChannelSend({
        args: [hermit(wd.dir), '-'],
        stdin: 'from stdin',
        env: { HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).toBe(0);
      expect(stub.requests[0].body.text).toBe('from stdin');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('whitespace-only stdin -> empty text, exit non-zero, no request sent', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runChannelSend({
        args: [hermit(wd.dir), '-'],
        stdin: '   \n  ',
        env: { HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).not.toBe(0);
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('non-2xx platform response -> exit non-zero, no out-log row', async () => {
    const stub = startHttpStub();
    stub.setStatus(400);
    const wd = setupChannelWorkdir();
    try {
      const r = await runChannelSend({
        args: [hermit(wd.dir), 'hello'],
        env: { HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).not.toBe(0);
      expect(dbExists(hermit(wd.dir))).toBe(false);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('dead listener -> exit non-zero with an error token', async () => {
    const wd = setupChannelWorkdir();
    try {
      const r = await runChannelSend({
        args: [hermit(wd.dir), 'hello'],
        env: { HERMIT_TELEGRAM_API_URL: 'http://127.0.0.1:1' },
      });
      expect(r.exitCode).not.toBe(0);
      expect(JSON.parse(r.stdout).error).toBeString();
    } finally {
      wd.cleanup();
    }
  });

  test('missing token file -> exit non-zero, missing_token reason', async () => {
    const wd = setupWorkdir();
    try {
      write(hermit(wd.dir, 'config.json'), JSON.stringify({
        channels: { telegram: { enabled: true, default_chat_id: '12345', state_dir: '.claude.local/channels/telegram' } },
      }));
      const r = await runChannelSend({ args: [hermit(wd.dir), 'hello'] });
      expect(r.exitCode).not.toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ error: 'missing_token' });
    } finally {
      wd.cleanup();
    }
  });

  test('no eligible channel -> exit non-zero, no_reachable_channel reason', async () => {
    const wd = setupWorkdir();
    try {
      write(hermit(wd.dir, 'config.json'), JSON.stringify({ channels: {} }));
      const r = await runChannelSend({ args: [hermit(wd.dir), 'hello'] });
      expect(r.exitCode).not.toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ error: 'no_reachable_channel' });
    } finally {
      wd.cleanup();
    }
  });

  test('unreadable config -> exit non-zero, config_read_failed reason', async () => {
    const wd = setupWorkdir();
    try {
      // No config.json written at all.
      const r = await runChannelSend({ args: [hermit(wd.dir), 'hello'] });
      expect(r.exitCode).not.toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ error: 'config_read_failed' });
    } finally {
      wd.cleanup();
    }
  });

  test('missing arguments -> usage error, exit non-zero', async () => {
    const r = await runChannelSend({ args: [] });
    expect(r.exitCode).not.toBe(0);
  });

  // The state-dir pin. `Bash(bun */scripts/channel-send.ts*)` pre-approves every
  // argument, so an unvalidated root let one allowed call send with *another*
  // project's bot token to *that* project's chat. Both modes pin separately —
  // covering each keeps a later edit from dropping one silently. The error is
  // "the caller got it wrong, nothing was sent", not a failed delivery.
  for (const [mode, tail] of [['--tier', ['hello']], ['--notice', ['--notice']]] as const) {
    test(`a foreign state dir is refused in ${mode} mode before anything is sent`, async () => {
      const stub = startHttpStub();
      const mine = setupChannelWorkdir();
      const theirs = setupChannelWorkdir();
      try {
        // runScript, not runChannelSend: the whole point is an argv state dir
        // that AGENT_DIR does not match, which the pinned wrapper would paper over.
        const r = await runScript('channel-send.ts', {
          args: [hermit(theirs.dir), ...tail],
          stdin: '{"client":"x"}',
          env: { AGENT_DIR: hermit(mine.dir), HERMIT_TELEGRAM_API_URL: stub.url },
        });
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toStartWith('{"error":"foreign_state_dir:');
        expect(stub.requests.length).toBe(0);
      } finally {
        stub.stop();
        mine.cleanup();
        theirs.cleanup();
      }
    });
  }

  // The production shape every caller actually uses — the watchdog passes a
  // relative '.hermit' resolved against its own cwd, and the skills
  // pass the same literal from the project root. The pin must not reject it.
  test('the literal .hermit from the project root passes the pin', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runChannelSend({
        args: ['.hermit', 'hello'],
        cwd: wd.dir,
        env: { AGENT_DIR: hermit(wd.dir), HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(1);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('--tier maintainer routes to maintainer_channel_id when configured', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      const r = await runChannelSend({
        args: [hermit(wd.dir), '--tier', 'maintainer', '-'],
        stdin: 'ops detail',
        env: { HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('99999');
      expect(stub.requests[0].body.text).toBe('ops detail');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('--tier maintainer reports no delivery when the configured chat is unreachable', async () => {
    const stub = startHttpStub();
    stub.setStatus(400);
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      const r = await runChannelSend({
        args: [hermit(wd.dir), '--tier', 'maintainer', 'unreachable notice'],
        env: { HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.stdout)).toEqual({ error: 'no_delivery' });
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('99999');
      expect(findings(wd)).toContain('unreachable notice');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('--tier maintainer keeps non-technical notices in Findings when no maintainer chat exists', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({}, { operator_profile: 'non-technical' });
    try {
      const r = await runChannelSend({
        args: [hermit(wd.dir), '--tier', 'maintainer', 'local notice'],
        env: { HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('OK');
      expect(stub.requests.length).toBe(0);
      expect(findings(wd)).toContain('local notice');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('--tier maintainer with no maintainer channel falls back to the primary chat', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runChannelSend({
        args: [hermit(wd.dir), '--tier', 'maintainer', 'ops detail'],
        env: { HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('12345'); // primary, byte-identical to today
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('--tier with an invalid value -> usage error, exit non-zero, no request', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runChannelSend({
        args: [hermit(wd.dir), '--tier', 'bogus', 'hi'],
        env: { HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).not.toBe(0);
      expect(r.stdout).toContain('invalid --tier value');
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });
});

// sendOperatorNotice — exercised in-process (its client/maintainer/sensitive
// routing and SendResult shape aren't reachable through the pass-through CLI).
// sendTelegram reads HERMIT_TELEGRAM_API_URL at call time, so pointing it at the
// stub for the duration of each call is enough; no real network is touched.
const withApi = async <T>(url: string, fn: () => Promise<T>): Promise<T> => {
  process.env.HERMIT_TELEGRAM_API_URL = url;
  try { return await fn(); } finally { delete process.env.HERMIT_TELEGRAM_API_URL; }
};
const findings = (wd: Workdir) => (fs.existsSync(hermit(wd.dir, 'state', 'watchdog-events.jsonl')) ? fs.readFileSync(hermit(wd.dir, 'state', 'watchdog-events.jsonl'), 'utf8') : '');

describe('sendOperatorNotice tiering', () => {


  test('fallback:primary + maintainer target hit: same token, route maintainer_channel', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      const res = await withApi(stub.url, () =>
        sendOperatorNotice(hermit(wd.dir), { maintainer: { text: 'MAINT', fallback: 'primary' } }));
      expect(res.maintainer).toMatchObject({ ok: true, route: 'maintainer_channel' });
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('99999');
      expect(stub.requests[0].path).toContain('bottest-token'); // same bot token as the client route
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('fallback:primary + non-technical + no maintainer channel -> primary chat', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({}, { operator_profile: 'non-technical' });
    try {
      const res = await withApi(stub.url, () =>
        sendOperatorNotice(hermit(wd.dir), { maintainer: { text: 'DOCTOR ALERT', fallback: 'primary' } }));
      expect(res.maintainer).toMatchObject({ ok: true, route: 'client', delivered: true });
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('12345');
      expect(stub.requests[0].body.text).toBe('DOCTOR ALERT');
      expect(findings(wd)).not.toContain('DOCTOR ALERT');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('non-technical + no maintainer channel: suppressed to Findings, no HTTP', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({}, { operator_profile: 'non-technical' });
    try {
      const res = await withApi(stub.url, () =>
        // fallback:'client' must be overridden by the non-technical profile.
        sendOperatorNotice(hermit(wd.dir), { maintainer: { text: 'SECRET DETAIL', fallback: 'client' } }));
      // Intended Findings home → delivered:true (no re-announce needed).
      expect(res.maintainer).toMatchObject({ ok: true, suppressed: true, route: 'findings', delivered: true });
      expect(stub.requests.length).toBe(0);
      expect(findings(wd)).toContain('SECRET DETAIL');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('Findings append fails when event log is unwritable -> ok:false', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({}, { operator_profile: 'non-technical' });
    fs.mkdirSync(hermit(wd.dir, 'state', 'watchdog-events.jsonl'));
    try {
      const res = await withApi(stub.url, () =>
        sendOperatorNotice(hermit(wd.dir), { maintainer: { text: 'X', fallback: 'findings' } }));
      expect(res.maintainer).toMatchObject({ ok: false, route: 'findings', suppressed: true, delivered: false });
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('fallback:primary + failed maintainer send -> Findings, never the client chat', async () => {
    const stub = startHttpStub();
    stub.setStatus(500);
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      const res = await withApi(stub.url, () =>
        sendOperatorNotice(hermit(wd.dir), { maintainer: { text: 'USD DETAIL', fallback: 'primary' } }));
      // Degraded fallback: configured maintainer channel unreachable → delivered:false.
      expect(res.maintainer).toMatchObject({ ok: true, route: 'findings', suppressed: true, delivered: false });
      // Only the failed 500 to the maintainer chat — never a spill to the primary.
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('99999');
      expect(stub.requests.some((r) => r.body.chat_id === '12345')).toBe(false);
      expect(findings(wd)).toContain('USD DETAIL');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  // Load-bearing for maintainer-tier notices: on an install with no maintainer
  // chat, a `--notice` maintainer payload falls back to the pinned home. This
  // routing is what puts the notice in that same chat.
  test('technical + no maintainer channel + fallback:client -> primary, route client, both legs merged', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const res = await withApi(stub.url, () =>
        sendOperatorNotice(hermit(wd.dir), { client: 'PLAIN', maintainer: { text: 'MAINT', fallback: 'client' } }));
      expect(res.maintainer).toMatchObject({ ok: true, route: 'client', delivered: true });
      expect(res.client).toMatchObject({ ok: true }); // both legs share one send
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('12345');
      expect(stub.requests[0].body.text).toBe('PLAIN\n\nMAINT');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('sensitive maintainer send writes no channel-log row', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      const res = await withApi(stub.url, () =>
        sendOperatorNotice(hermit(wd.dir), { maintainer: { text: 'SENSITIVE', fallback: 'client', sensitive: true } }));
      expect(res.maintainer).toMatchObject({ ok: true, route: 'maintainer_channel' });
      expect(stub.requests.length).toBe(1);
      expect(dbExists(hermit(wd.dir))).toBe(false); // no episodic-log row
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('maintainer send failure does not record platform health', async () => {
    const stub = startHttpStub();
    stub.setStatus(500);
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      await withApi(stub.url, () =>
        sendOperatorNotice(hermit(wd.dir), { maintainer: { text: 'MAINT', fallback: 'findings' } }));
      // recordChannelHealth is skipped for the maintainer leg, so a failure there
      // must not create/poison the platform-keyed health file.
      expect(fs.existsSync(channelHealthPath(hermit(wd.dir)))).toBe(false);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });
});

// --routine on the CLI: a subprocess per send, so each owns its API override
// under concurrent tests (an in-process env swap would leak across them).
describe('channel-send --notice --routine', () => {
  const readState = (wd: Workdir, name: string) =>
    (fs.existsSync(hermit(wd.dir, 'state', name)) ? fs.readFileSync(hermit(wd.dir, 'state', name), 'utf8') : '');
  const routines = (chat: string) => ({ routines: [{ id: 'weekly', schedule: '0 9 * * 1', skill: 'hermitd:brief', enabled: true, chat }] });
  const send = (wd: Workdir, payload: object, stub: { url: string }, routine?: string) =>
    runChannelSend({
      args: [hermit(wd.dir), '--notice', ...(routine ? ['--routine', routine] : [])],
      stdin: JSON.stringify(payload),
      env: { HERMIT_TELEGRAM_API_URL: stub.url },
    });

  test('--routine without --notice is a usage error', async () => {
    const wd = setupChannelWorkdir();
    try {
      const r = await runChannelSend({ args: [hermit(wd.dir), '--routine', 'weekly', 'hi'] });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain('--routine requires --notice');
    } finally {
      wd.cleanup();
    }
  });

  test('a tagged notice sends the client leg to the owning chat and keeps the maintainer leg home', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({}, routines('telegram:-100777'));
    try {
      const r = await send(wd, { client: 'PLAIN', maintainer: 'MAINT' }, stub, 'weekly');
      expect(r.exitCode).toBe(0);
      expect(stub.requests.map(q => [q.body.chat_id, q.body.text])).toEqual([['12345', 'MAINT'], ['-100777', 'PLAIN']]);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('an owning-chat send leaves the home route health alone', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({}, routines('telegram:-100777'));
    try {
      expect((await send(wd, { client: 'PLAIN' }, stub, 'weekly')).exitCode).toBe(0);
      expect(readState(wd, 'channel-health.json')).toBe('');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('an owning chat on a disabled channel sends nothing there', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({}, routines('discord:42'));
    try {
      const cfgPath = hermit(wd.dir, 'config.json');
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      cfg.channels.discord = { enabled: false };
      fs.writeFileSync(cfgPath, JSON.stringify(cfg));
      const r = await send(wd, { client: 'TEAM ONLY' }, stub, 'weekly');
      expect(JSON.parse(r.stdout).result.client).toMatchObject({ ok: false, error: 'channel_disabled' });
      expect(stub.requests.every(q => q.body.text !== 'TEAM ONLY')).toBe(true);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('an untagged notice, or a routine with no chat, goes home', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({}, routines('telegram:-100777'));
    try {
      expect((await send(wd, { client: 'A' }, stub)).exitCode).toBe(0);
      expect((await send(wd, { client: 'B' }, stub, 'other')).exitCode).toBe(0);
      expect(stub.requests.map(q => q.body.chat_id)).toEqual(['12345', '12345']);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('an unreachable owning chat keeps the content out of the home chat and tells the operator', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({}, routines('discord:42'));
    try {
      const r = await send(wd, { client: 'TEAM ONLY' }, stub, 'weekly');
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout).result.client).toMatchObject({ ok: false, undelivered_saved: true });
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('12345');
      expect(stub.requests[0].body.text).toContain('Routine weekly could not post to its chat discord:42');
      expect(stub.requests[0].body.text).not.toContain('TEAM ONLY');
      expect(readState(wd, 'watchdog-events.jsonl')).toContain('undelivered-client-notice');
      const event = JSON.parse(readState(wd, 'routine-metrics.jsonl').trim().split('\n').pop()!);
      expect(event).toMatchObject({ routine_id: 'weekly', event: 'chat-undelivered' });
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });
});

describe('channel-send --notice --watch', () => {
  const readState = (wd: Workdir, name: string) =>
    (fs.existsSync(hermit(wd.dir, 'state', name)) ? fs.readFileSync(hermit(wd.dir, 'state', name), 'utf8') : '');
  const watches = (chat: unknown) => {
    const wd = setupChannelWorkdir();
    write(hermit(wd.dir, 'state', 'monitors.runtime.json'), JSON.stringify({ monitors: [{ id: 'weekly', chat }] }));
    return wd;
  };
  const send = (wd: Workdir, payload: object, stub: { url: string }, watch?: string) =>
    runChannelSend({
      args: [hermit(wd.dir), '--notice', ...(watch ? ['--watch', watch] : [])],
      stdin: JSON.stringify(payload),
      env: { HERMIT_TELEGRAM_API_URL: stub.url },
    });

  test('--watch without --notice is a usage error', async () => {
    const wd = setupChannelWorkdir();
    try {
      const r = await runChannelSend({ args: [hermit(wd.dir), '--watch', 'weekly', 'hi'] });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain('--watch requires --notice');
    } finally {
      wd.cleanup();
    }
  });

  test('a tagged notice sends the client leg to the owning chat and keeps the maintainer leg home', async () => {
    const stub = startHttpStub();
    const wd = watches('telegram:-100777');
    try {
      const r = await send(wd, { client: 'PLAIN', maintainer: 'MAINT' }, stub, 'weekly');
      expect(r.exitCode).toBe(0);
      expect(stub.requests.map(q => [q.body.chat_id, q.body.text])).toEqual([['12345', 'MAINT'], ['-100777', 'PLAIN']]);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('a config watch takes its chat from config.json, so an edit applies without a restart', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      write(hermit(wd.dir, 'state', 'monitors.runtime.json'), JSON.stringify({ monitors: [{ id: 'weekly', source: 'config', chat: 'telegram:-100111' }] }));
      const cfgPath = hermit(wd.dir, 'config.json');
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      cfg.monitors = [{ id: 'weekly', chat: 'telegram:-100777' }];
      fs.writeFileSync(cfgPath, JSON.stringify(cfg));
      expect((await send(wd, { client: 'PLAIN' }, stub, 'weekly')).exitCode).toBe(0);
      expect(stub.requests.map(q => q.body.chat_id)).toEqual(['-100777']);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('a config watch without a chat goes home even when its registry entry has one', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      write(hermit(wd.dir, 'state', 'monitors.runtime.json'), JSON.stringify({ monitors: [{ id: 'weekly', source: 'config', chat: 'telegram:-100111' }] }));
      const cfgPath = hermit(wd.dir, 'config.json');
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      cfg.monitors = [{ id: 'weekly' }];
      fs.writeFileSync(cfgPath, JSON.stringify(cfg));
      expect((await send(wd, { client: 'PLAIN' }, stub, 'weekly')).exitCode).toBe(0);
      expect(stub.requests.map(q => q.body.chat_id)).toEqual(['12345']);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('an owning-chat send leaves the home route health alone', async () => {
    const stub = startHttpStub();
    const wd = watches('telegram:-100777');
    try {
      expect((await send(wd, { client: 'PLAIN' }, stub, 'weekly')).exitCode).toBe(0);
      expect(readState(wd, 'channel-health.json')).toBe('');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('an owning chat on a disabled channel sends nothing there', async () => {
    const stub = startHttpStub();
    const wd = watches('discord:42');
    try {
      const cfgPath = hermit(wd.dir, 'config.json');
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      cfg.channels.discord = { enabled: false };
      fs.writeFileSync(cfgPath, JSON.stringify(cfg));
      const r = await send(wd, { client: 'TEAM ONLY' }, stub, 'weekly');
      expect(JSON.parse(r.stdout).result.client).toMatchObject({ ok: false, error: 'channel_disabled' });
      expect(stub.requests.every(q => q.body.text !== 'TEAM ONLY')).toBe(true);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('an untagged notice, or an unknown watch, goes home', async () => {
    const stub = startHttpStub();
    const wd = watches('telegram:-100777');
    try {
      expect((await send(wd, { client: 'A' }, stub)).exitCode).toBe(0);
      expect((await send(wd, { client: 'B' }, stub, 'other')).exitCode).toBe(0);
      expect(stub.requests.map(q => q.body.chat_id)).toEqual(['12345', '12345']);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('an unreachable owning chat keeps the content out of the home chat and tells the operator', async () => {
    const stub = startHttpStub();
    const wd = watches('discord:42');
    try {
      const r = await send(wd, { client: 'TEAM ONLY' }, stub, 'weekly');
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout).result.client).toMatchObject({ ok: false, undelivered_saved: true });
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('12345');
      expect(stub.requests[0].body.text).toContain('Watch weekly could not post to its chat discord:42');
      expect(stub.requests[0].body.text).not.toContain('TEAM ONLY');
      expect(readState(wd, 'watchdog-events.jsonl')).toContain('undelivered-client-notice');
      expect(readState(wd, 'routine-metrics.jsonl')).toBe('');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });
});

describe('channel-send watch usage and fallback', () => {
  test('--routine and --watch are mutually exclusive', async () => {
    const r = await runChannelSend({ args: ['--notice', '--routine', 'weekly', '--watch', 'weather'] });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('mutually exclusive');
  });

  test.each([undefined, null, 'invalid', 42])('missing or invalid watch chat %p goes home', async (chat) => {
    const wd = setupChannelWorkdir();
    const stub = startHttpStub();
    try {
      write(hermit(wd.dir, 'state', 'monitors.runtime.json'), JSON.stringify({ monitors: [{ id: 'weather', chat }] }));
      const send = () => runChannelSend({
        args: [hermit(wd.dir), '--notice', '--watch', 'weather'],
        stdin: JSON.stringify({ client: 'HOME' }),
        env: { HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect((await send()).exitCode).toBe(0);
      fs.unlinkSync(hermit(wd.dir, 'state', 'monitors.runtime.json'));
      expect((await send()).exitCode).toBe(0);
      expect(stub.requests.map(q => q.body.chat_id)).toEqual(['12345', '12345']);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });
});

// channel-send.ts --notice — the model-facing proactive-notify CLI boundary.
// Drives the subprocess (not sendOperatorNotice in-process) so these tests also
// cover payload parsing/validation and the normalized
// {status,reason?,result} stdout contract, not just the routing sendOperatorNotice
// already owns (covered above).
describe('channel-send CLI --notice', () => {
  const findings = (wd: Workdir) => (fs.existsSync(hermit(wd.dir, 'state', 'watchdog-events.jsonl')) ? fs.readFileSync(hermit(wd.dir, 'state', 'watchdog-events.jsonl'), 'utf8') : '');
  const runNotice = (wd: Workdir, payload: object | string, stub: { url: string }) =>
    runChannelSend({
      args: [hermit(wd.dir), '--notice'],
      stdin: typeof payload === 'string' ? payload : JSON.stringify(payload),
      env: { HERMIT_TELEGRAM_API_URL: stub.url },
    });

  test('client only -> client chat receives it, exit 0, status delivered', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runNotice(wd, { client: 'plain notice' }, stub);
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.status).toBe('delivered');
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('12345');
      expect(stub.requests[0].body.text).toBe('plain notice');
      expect(findings(wd)).not.toContain('undelivered-client-notice');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('failed client send persists the original text and reports undelivered', async () => {
    const stub = startHttpStub();
    stub.setStatus(500);
    const wd = setupChannelWorkdir();
    const text = 'Please confirm\nthis exact client notice.';
    try {
      const result = await runNotice(wd, { client: text }, stub);
      expect(result.exitCode).toBe(0);
      const out = JSON.parse(result.stdout);
      expect(out.status).toBe('undelivered');
      expect(out.result.client.ok).toBe(false);
      expect(out.result.client.undelivered_saved).toBe(true);
      const events = findings(wd).trim().split('\n').map(line => JSON.parse(line));
      expect(events.filter(event => event.action === 'undelivered-client-notice')).toEqual([
        { ts: expect.any(String), action: 'undelivered-client-notice', reason: text },
      ]);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('failed client persistence is reported without changing delivery failure', async () => {
    const stub = startHttpStub();
    stub.setStatus(500);
    const wd = setupChannelWorkdir();
    fs.mkdirSync(hermit(wd.dir, 'state', 'watchdog-events.jsonl'));
    try {
      const result = await runNotice(wd, { client: 'Keep this text' }, stub);
      expect(result.exitCode).toBe(0);
      const out = JSON.parse(result.stdout);
      expect(out.status).toBe('undelivered');
      expect(out.result.client.undelivered_saved).toBe(false);
      expect(out.result.client.persistence_error).toBeString();
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('maintainer only, maintainer_channel_id set -> maintainer chat receives it, exit 0', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      const r = await runNotice(wd, { maintainer: 'ops detail' }, stub);
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.status).toBe('delivered');
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('99999');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('maintainer only, no maintainer chat, technical profile -> falls back to primary chat, exit 0', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runNotice(wd, { maintainer: 'ops detail' }, stub);
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.status).toBe('delivered');
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('12345');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('both legs, different chats -> both received, exit 0', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      const r = await runNotice(wd, { client: 'PLAIN', maintainer: 'FULL DETAIL' }, stub);
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.status).toBe('delivered');
      expect(stub.requests.length).toBe(2);
      const byChat = Object.fromEntries(stub.requests.map((req) => [req.body.chat_id, req.body.text]));
      expect(byChat['12345']).toBe('PLAIN');
      expect(byChat['99999']).toBe('FULL DETAIL');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('both legs, same chat -> one message containing both texts, exit 0', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ maintainer_channel_id: '12345' });
    try {
      const r = await runNotice(wd, { client: 'PLAIN', maintainer: 'FULL DETAIL' }, stub);
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.status).toBe('delivered');
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.text).toBe('PLAIN\n\nFULL DETAIL');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('non-technical, no maintainer chat -> maintainer text suppressed to Findings, status delivered, exit 0', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({}, { operator_profile: 'non-technical' });
    try {
      const r = await runNotice(wd, { maintainer: 'SECRET DETAIL' }, stub);
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.status).toBe('delivered');
      expect(stub.requests.length).toBe(0);
      expect(findings(wd)).toContain('SECRET DETAIL');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('fallback:primary, non-technical, no maintainer chat -> primary chat, exit 0', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({}, { operator_profile: 'non-technical' });
    try {
      const r = await runNotice(wd, { maintainer: 'DOCTOR ALERT', fallback: 'primary' }, stub);
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.status).toBe('delivered');
      expect(stub.requests.length).toBe(1);
      expect(stub.requests[0].body.chat_id).toBe('12345');
      expect(stub.requests[0].body.text).toBe('DOCTOR ALERT');
      expect(findings(wd)).not.toContain('DOCTOR ALERT');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('configured maintainer unreachable -> status degraded, Findings written', async () => {
    const stub = startHttpStub();
    stub.setStatus(500);
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      const r = await runNotice(wd, { maintainer: 'USD DETAIL' }, stub);
      const out = JSON.parse(r.stdout);
      expect(out.status).toBe('degraded');
      expect(r.exitCode).toBe(0);
      expect(findings(wd)).toContain('USD DETAIL');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('partial delivery (maintainer suppressed, client unreachable) -> undelivered, not success', async () => {
    const wd = setupWorkdir();
    write(hermit(wd.dir, 'config.json'), JSON.stringify({
      operator_profile: 'non-technical',
      channels: { telegram: { enabled: true } }, // enabled but unpaired: no default_chat_id
    }));
    try {
      const r = await runChannelSend({
        args: [hermit(wd.dir), '--notice'],
        stdin: JSON.stringify({ client: 'PLAIN', maintainer: 'DETAIL' }),
      });
      const out = JSON.parse(r.stdout);
      // The maintainer leg landed in its intended Findings home, but the client
      // leg reached nobody — reporting delivered here would drop it silently.
      expect(out.status).toBe('undelivered');
      expect(r.exitCode).toBe(0);
      expect(findings(wd)).toContain('DETAIL');
    } finally {
      wd.cleanup();
    }
  });

  test('no channel at all -> undelivered with no_reachable_channel, exit 0', async () => {
    const wd = setupWorkdir();
    write(hermit(wd.dir, 'config.json'), JSON.stringify({ channels: {} }));
    try {
      const r = await runChannelSend({
        args: [hermit(wd.dir), '--notice'],
        stdin: JSON.stringify({ client: 'hello' }),
      });
      expect(r.exitCode).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out).toMatchObject({ status: 'undelivered', reason: 'no_reachable_channel' });
    } finally {
      wd.cleanup();
    }
  });

  test('sensitive:true on the maintainer leg writes no channel-log row', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      const r = await runNotice(wd, { maintainer: 'SENSITIVE', sensitive: true }, stub);
      expect(r.exitCode).toBe(0);
      expect(dbExists(hermit(wd.dir))).toBe(false);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('malformed JSON on stdin -> exit 1, invalid_payload error', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runNotice(wd, 'not json', stub);
      expect(r.exitCode).toBe(1); // caller error, not a delivery failure
      expect(JSON.parse(r.stdout).error).toStartWith('invalid_payload:invalid JSON');
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('unknown field -> exit 1 usage error', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runNotice(wd, { maintainr: 'x' }, stub);
      expect(r.exitCode).toBe(1); // caller error, not a delivery failure
      expect(r.stdout).toContain('unknown field');
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('empty audience ({}) -> exit 1 usage error', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runNotice(wd, {}, stub);
      expect(r.exitCode).toBe(1); // caller error, not a delivery failure
      expect(r.stdout).toContain('at least one of client/maintainer is required');
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('bad fallback value -> exit 1 usage error', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runNotice(wd, { maintainer: 'x', fallback: 'nope' }, stub);
      expect(r.exitCode).toBe(1); // caller error, not a delivery failure
      expect(r.stdout).toContain('invalid fallback');
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('--notice and --tier together -> exit 1 usage error', async () => {
    const wd = setupChannelWorkdir();
    try {
      const r = await runChannelSend({
        args: [hermit(wd.dir), '--notice', '--tier', 'client'],
        stdin: JSON.stringify({ client: 'x' }),
      });
      expect(r.exitCode).toBe(1); // caller error, not a delivery failure
      expect(r.stdout).toContain('mutually exclusive');
    } finally {
      wd.cleanup();
    }
  });
});

describe('splitMessage', () => {
  test('keeps text within the limit as one part', () => {
    expect(splitMessage('short', 10)).toEqual(['short']);
    expect(splitMessage('', 10)).toEqual(['']);
  });

  test('prefers a blank line, then a line break, then a space, then a hard cut', () => {
    expect(splitMessage('aaa\n\nbb\ncc dd', 10)).toEqual(['aaa', 'bb\ncc dd']);
    expect(splitMessage('aaa\nbbb cc', 8)).toEqual(['aaa', 'bbb cc']);
    expect(splitMessage('aaa bbbbbb', 8)).toEqual(['aaa', 'bbbbbb']);
    expect(splitMessage('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  test('drops only the separator, keeping the next part\'s indentation', () => {
    expect(splitMessage('aaa\n  bb', 6)).toEqual(['aaa', '  bb']);
  });

  test('never cuts a surrogate pair in half', () => {
    const parts = splitMessage('abc😀def', 4);
    expect(parts).toEqual(['abc', '😀de', 'f']);
    expect(parts.join('')).toBe('abc😀def');
  });
});

describe('channel-send rate limits', () => {
  type Platform = 'discord' | 'telegram';
  interface Reply {
    status?: number;
    body?: any;
    header?: string;
    delayMs?: number;
    bodyDelayMs?: number;
    rawBody?: string;
    disconnect?: boolean;
  }

  async function exercise(
    platform: Platform, replies: Reply[], opts: { timeoutMs?: number; recordHealth?: boolean } = {}, text = 'rate-limited notice',
  ) {
    const wd = setupWorkdir();
    const stateDir = path.join(wd.dir, '.claude.local', 'channels', platform);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.env'), `${platform.toUpperCase()}_BOT_TOKEN=test-token\n`);
    write(hermit(wd.dir, 'config.json'), JSON.stringify({
      channels: { [platform]: { enabled: true, default_chat_id: '12345', state_dir: stateDir } },
    }));
    const requests: { at: number; body: any }[] = [];
    const responseTimes: number[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const index = requests.length;
        requests.push({ at: performance.now(), body: await req.json() });
        const reply = replies[index] ?? {};
        if (reply.disconnect) server.stop(true);
        if (reply.delayMs) await Bun.sleep(reply.delayMs);
        responseTimes.push(performance.now());
        const body = reply.rawBody ?? JSON.stringify(reply.body ?? { ok: true });
        const headers = reply.header === undefined ? {} : { 'Retry-After': reply.header };
        if (reply.bodyDelayMs) {
          return new Response(new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode(body.slice(0, 1)));
              await Bun.sleep(reply.bodyDelayMs!);
              controller.enqueue(new TextEncoder().encode(body.slice(1)));
              controller.close();
            },
          }), { status: reply.status ?? 200, headers });
        }
        return new Response(body, { status: reply.status ?? 200, headers });
      },
    });
    try {
      // Each subprocess owns its API override, including under concurrent tests.
      const modulePath = path.resolve(import.meta.dir, '../scripts/lib/channel-send.ts');
      const proc = Bun.spawn([process.execPath, '-e', `
        import { sendToChannel } from ${JSON.stringify(modulePath)};
        const started = performance.now();
        const result = await sendToChannel(${JSON.stringify(hermit(wd.dir))}, ${JSON.stringify(text)}, ${JSON.stringify(opts)});
        console.log(JSON.stringify({ result, elapsed: performance.now() - started }));
      `], {
        env: { ...process.env, [`HERMIT_${platform.toUpperCase()}_API_URL`]: `http://127.0.0.1:${server.port}` },
        stdout: 'pipe', stderr: 'pipe',
      });
      const [output, error, exitCode] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
      expect(error).toBe('');
      expect(exitCode).toBe(0);
      const { result, elapsed } = JSON.parse(output);
      const healthFile = channelHealthPath(hermit(wd.dir));
      const health = fs.existsSync(healthFile) ? JSON.parse(fs.readFileSync(healthFile, 'utf8'))[platform] : undefined;
      return { result, elapsed, requests, responseTimes, health, rows: unconsolidated(hermit(wd.dir)).rows };
    } finally {
      server.stop(true);
      wd.cleanup();
    }
  }

  function limited(platform: Platform, delay: any = 0.04): Reply {
    return { status: 429, body: {
      message: 'rate limited', description: 'rate limited',
      ...(platform === 'discord' ? { retry_after: delay } : { parameters: { retry_after: delay } }),
    } };
  }

  for (const platform of ['discord', 'telegram'] as const) {
    test(`${platform}: waits, retries once, logs once, and records final success`, async () => {
      const r = await exercise(platform, [limited(platform), {}]);
      expect(r.result).toEqual({ ok: true, status: 200 });
      expect(r.requests).toHaveLength(2);
      expect(r.requests[1].at - r.responseTimes[0]).toBeGreaterThanOrEqual(40);
      expect(r.requests[1].body).toEqual(r.requests[0].body);
      expect(r.health.consecutive_failures).toBe(0);
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0].text).toBe('rate-limited notice');
    });

    test(`${platform}: repeated 429 records one failure and returns the final error`, async () => {
      const second = limited(platform);
      second.body.message = second.body.description = 'still limited';
      const r = await exercise(platform, [limited(platform), second]);
      expect(r.result).toEqual({ ok: false, status: 429, error: 'still limited' });
      expect(r.requests).toHaveLength(2);
      expect(r.health.consecutive_failures).toBe(1);
      expect(r.rows).toHaveLength(0);
    });

    for (const delay of [null, -1, '0.01', 'invalid', 100, 1e308]) {
      test(`${platform}: does not retry invalid or excessive delay ${delay}`, async () => {
        const r = await exercise(platform, [limited(platform, delay)]);
        expect(r.result.status).toBe(429);
        expect(r.requests).toHaveLength(1);
      });
    }

    test(`${platform}: transport failure does not retry`, async () => {
      const r = await exercise(platform, [{ disconnect: true }]);
      expect(r.result.ok).toBe(false);
      expect(r.result.status).toBeUndefined();
      expect(r.requests).toHaveLength(1);
      expect(r.health.consecutive_failures).toBe(1);
    });

    test(`${platform}: malformed JSON does not retry without a valid header`, async () => {
      const r = await exercise(platform, [{ status: 429, rawBody: '{' }]);
      expect(r.result).toEqual({ ok: false, status: 429, error: `${platform}_http_429` });
      expect(r.requests).toHaveLength(1);
    });

    test(`${platform}: missing metadata does not retry`, async () => {
      const r = await exercise(platform, [{ status: 429, body: {} }]);
      expect(r.result).toEqual({ ok: false, status: 429, error: `${platform}_http_429` });
      expect(r.requests).toHaveLength(1);
    });

    for (const status of [400, 401, 403, 500, 503]) {
      test(`${platform}: ${status} does not retry even with retry metadata`, async () => {
        const r = await exercise(platform, [{ ...limited(platform), status }]);
        expect(r.result.status).toBe(status);
        expect(r.requests).toHaveLength(1);
      });
    }

    // Decided by Retry-After against the wait budget, never by a server sleep timed
    // close to the client deadline — those are two clocks, and under a loaded
    // `--parallel` run the sleep overshoots and aborts the attempt first.
    test(`${platform}: a Retry-After past the latency-reduced budget returns the 429 instead of waiting`, async () => {
      const r = await exercise(platform, [{ ...limited(platform, 5), delayMs: 50 }], { timeoutMs: 4000 });
      expect(r.result.status).toBe(429);
      expect(r.requests).toHaveLength(1);
      // Returned on the spot rather than sleeping out the rest of the budget.
      expect(r.elapsed).toBeLessThan(3000);
    }, 20000);

    // A shared deadline ends near 3000 ms; a fresh retry budget would end past 4500 ms.
    test(`${platform}: retry shares the original timeout`, async () => {
      const r = await exercise(platform, [{ ...limited(platform, 1), delayMs: 500 }, { delayMs: 10_000 }], { timeoutMs: 3000 });
      expect(r.result).toEqual({ ok: false, error: 'request timeout' });
      expect(r.requests).toHaveLength(2);
      // The second attempt inherits the first attempt's deadline instead of a fresh one.
      expect(r.elapsed).toBeLessThan(4000);
      expect(r.rows).toHaveLength(0);
    }, 20000);

    test(`${platform}: stalled error body respects the timeout without retrying`, async () => {
      const r = await exercise(platform, [{ ...limited(platform), bodyDelayMs: 6000 }], { timeoutMs: 2000 });
      expect(r.result).toEqual({ ok: false, error: 'request timeout' });
      expect(r.requests).toHaveLength(1);
      // Aborted by the timeout, not released by the body finishing.
      expect(r.elapsed).toBeLessThan(5000);
    }, 20000);

    test(`${platform}: retried maintainer failure does not write platform health`, async () => {
      const r = await exercise(platform, [limited(platform), limited(platform)], { recordHealth: false });
      expect(r.requests).toHaveLength(2);
      expect(r.result.ok).toBe(false);
      expect(r.health).toBeUndefined();
    });
  }

  for (const [header, body, waitMs] of [
    ['0.04', {}, 40],
    ['0.08', { retry_after: 0.02 }, 80],
    ['0.01', { retry_after: 0.08 }, 80],
    ['bad', { retry_after: 0.04 }, 40],
    ['0.0001', {}, 1],
    ['0', {}, 0],
  ] as const) {
    test(`discord: header ${header} and body ${JSON.stringify(body)} wait at least ${waitMs}ms`, async () => {
      const r = await exercise('discord', [{ status: 429, header, body }, {}]);
      expect(r.result.ok).toBe(true);
      expect(r.requests).toHaveLength(2);
      expect(r.requests[1].at - r.responseTimes[0]).toBeGreaterThanOrEqual(waitMs);
    });
  }

  for (const header of ['', ' ', '-1', 'Infinity', 'invalid']) {
    test(`discord: invalid header ${JSON.stringify(header)} alone does not retry`, async () => {
      const r = await exercise('discord', [{ status: 429, header }]);
      expect(r.result.status).toBe(429);
      expect(r.requests).toHaveLength(1);
    });
  }

  test('discord: sends a long notice as ordered parts and logs it once', async () => {
    const text = `${'a'.repeat(1500)}\n\n${'b'.repeat(1500)}`;
    const r = await exercise('discord', [], {}, text);
    expect(r.result).toEqual({ ok: true, status: 200 });
    expect(r.requests.map((q) => q.body.content)).toEqual(['a'.repeat(1500), 'b'.repeat(1500)]);
    expect(r.rows.map((row: any) => row.text)).toEqual([text]);
  });

  test('discord: stops at the first failed part and logs nothing', async () => {
    const text = ['a', 'b', 'c'].map((c) => c.repeat(1500)).join('\n\n');
    const r = await exercise('discord', [{}, { status: 500, body: { message: 'boom' } }], {}, text);
    expect(r.result).toEqual({ ok: false, status: 500, error: 'boom', partial: true });
    expect(r.requests).toHaveLength(2);
    expect(r.rows).toHaveLength(0);
    expect(r.health.consecutive_failures).toBe(1);
  });
});


test('project send script receives text and only its declared environment', async () => {
  const wd = setupWorkdir();
  process.env.HERMIT_SEND_LEAK_PROBE = '1';
  try {
    write(path.join(wd.dir, 'send.sh'), '#!/bin/sh\ncat > text.out\nenv > env.out\n');
    fs.chmodSync(path.join(wd.dir, 'send.sh'), 0o755);
    const config = { channels: { custom: { send_script: 'send.sh', state_dir: 'custom-state' } } };
    const result = await sendToChannel(hermit(wd.dir), 'hello script', { config, target: { id: 'custom', chat_id: 'C1', thread: 'T1' } });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(wd.dir, 'text.out'), 'utf8')).toBe('hello script');
    const env = Object.fromEntries(fs.readFileSync(path.join(wd.dir, 'env.out'), 'utf8').trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
    expect(env.HERMIT_CHAT_ID).toBe('C1');
    expect(env.HERMIT_THREAD_ID).toBe('T1');
    expect(env.CHANNEL_STATE_DIR).toBe(path.join(wd.dir, 'custom-state'));
    expect(env.HERMIT_SEND_LEAK_PROBE).toBeUndefined();
    // PWD, OLDPWD, SHLVL and _ are set by /bin/sh itself (bash on macOS, dash on Linux/WSL), not passed in.
    const shellSet = ['PWD', 'OLDPWD', 'SHLVL', '_'];
    expect(Object.keys(env).filter(key => ![...shellSet, 'PATH', 'HERMIT_DIR', 'HERMIT_CHAT_ID', 'HERMIT_THREAD_ID', 'CHANNEL_STATE_DIR'].includes(key))).toEqual([]);
    expect(unconsolidated(hermit(wd.dir)).rows[0]).toMatchObject({ source: 'custom', direction: 'out' });
  } finally { delete process.env.HERMIT_SEND_LEAK_PROBE; wd.cleanup(); }
});

test('unsendable configured primary stays on its route', async () => {
  const stub = startHttpStub();
  const wd = setupWorkdir();
  try {
    const config = { channels: { primary: 'custom', custom: { default_chat_id: 'C1' }, discord: { default_chat_id: 'D1' } } };
    expect(await sendToChannel(hermit(wd.dir), 'private', { config })).toEqual({ ok: false, error: 'no_send_path' });
    expect(stub.requests).toHaveLength(0);
    expect(await sendToChannel(hermit(wd.dir), 'private', { config, target: { id: 'unknown', chat_id: 'X' } })).toEqual({ ok: false, error: 'unsupported_platform' });
  } finally { stub.stop(); wd.cleanup(); }
});

describe('notice relay on a channel without a send path', () => {
  const readState = (wd: Workdir, name: string) => {
    const p = hermit(wd.dir, 'state', name);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  };
  // Telegram keeps its token from setupChannelWorkdir so a maintainer leg can still send.
  const setup = (primary: string, top: object = {}) => {
    const wd = setupChannelWorkdir();
    writeConfig(wd.dir, { ...top, channels: {
      primary,
      custom: { default_chat_id: 'C1' },
      telegram: { enabled: true, default_chat_id: '12345', state_dir: '.claude.local/channels/telegram' },
    } });
    return wd;
  };
  const run = (wd: Workdir, payload: object, stub: { url: string }, routine?: string) =>
    runChannelSend({
      args: [hermit(wd.dir), '--notice', ...(routine ? ['--routine', routine] : [])],
      stdin: JSON.stringify(payload),
      env: { HERMIT_TELEGRAM_API_URL: stub.url },
    });

  test('a client notice returns relay with its chat and saves nothing as undelivered', async () => {
    const stub = startHttpStub();
    const wd = setup('custom');
    try {
      const out = JSON.parse((await run(wd, { client: 'PLAIN' }, stub)).stdout);
      expect(out.status).toBe('relay');
      expect(out.relay).toEqual({ channel: 'custom', chat_id: 'C1' });
      expect(out.result.client).toBeUndefined();
      expect(stub.requests).toHaveLength(0);
      expect(readState(wd, 'watchdog-events.jsonl')).not.toContain('undelivered-client-notice');
    } finally { stub.stop(); wd.cleanup(); }
  });

  test('a routine relays to its owning chat while maintainer detail still goes out', async () => {
    const stub = startHttpStub();
    const wd = setup('telegram', { routines: [{ id: 'weekly', schedule: '0 9 * * 1', skill: 'hermitd:brief', enabled: true, chat: 'custom:C9' }] });
    try {
      const out = JSON.parse((await run(wd, { client: 'PLAIN', maintainer: 'MAINT' }, stub, 'weekly')).stdout);
      expect(out.status).toBe('relay');
      expect(out.relay).toEqual({ channel: 'custom', chat_id: 'C9' });
      expect(stub.requests.map(q => q.body.text)).toEqual(['MAINT']);
      expect(readState(wd, 'routine-metrics.jsonl')).not.toContain('chat-undelivered');
    } finally { stub.stop(); wd.cleanup(); }
  });

  test('a script caller without relay keeps the undelivered path', async () => {
    const wd = setup('custom');
    try {
      const out = await sendOperatorNotice(hermit(wd.dir), { client: 'PLAIN' });
      expect(out.client).toMatchObject({ ok: false, error: 'no_send_path', undelivered_saved: true });
      expect(out.relay).toBeUndefined();
    } finally { wd.cleanup(); }
  });
});

describe('merged notice results and logging', () => {
  for (const configured of [false, true]) {
    test(`merged sensitive notice, maintainer configured=${configured}`, async () => {
      const wd = setupChannelWorkdir(configured ? { maintainer_channel_id: '12345' } : {});
      const stub = startHttpStub();
      try {
        const out = await withApi(stub.url, () => sendOperatorNotice(hermit(wd.dir), {
          client: 'CLIENT', maintainer: { text: 'TECHNICAL', fallback: 'client', sensitive: true },
        }));
        expect(out.client).toMatchObject({ ok: true });
        expect(out.maintainer).toMatchObject({ ok: true, delivered: true, route: configured ? 'maintainer_channel' : 'client' });
        expect(stub.requests.map(r => r.body.text)).toEqual(['CLIENT\n\nTECHNICAL']);
        if (configured) {
          expect(dbExists(hermit(wd.dir))).toBe(false);
          expect(fs.existsSync(channelHealthPath(hermit(wd.dir)))).toBe(false);
        } else {
          expect(unconsolidated(hermit(wd.dir)).rows.map(r => r.text)).toEqual(['CLIENT\n\nTECHNICAL']);
          expect(fs.existsSync(channelHealthPath(hermit(wd.dir)))).toBe(true);
        }
      } finally { stub.stop(); wd.cleanup(); }
    });

    test(`merged failure preserves both legs, maintainer configured=${configured}`, async () => {
      const wd = setupChannelWorkdir(configured ? { maintainer_channel_id: '12345' } : {});
      const stub = startHttpStub();
      stub.setStatus(500);
      try {
        const out = await withApi(stub.url, () => sendOperatorNotice(hermit(wd.dir), {
          client: 'CLIENT', maintainer: { text: 'TECHNICAL', fallback: 'client' },
        }));
        expect(stub.requests.map(r => r.body.text)).toEqual(['CLIENT\n\nTECHNICAL']);
        expect(out.client).toMatchObject({ ok: false, undelivered_saved: true });
        expect(out.maintainer).toMatchObject(configured
          ? { ok: true, delivered: false, route: 'findings' }
          : { ok: false, delivered: false, route: 'client' });
        expect(findings(wd)).toContain('CLIENT');
        if (configured) expect(findings(wd)).toContain('TECHNICAL');
      } finally { stub.stop(); wd.cleanup(); }
    });
  }
});

describe('owned Discord thread delivery', () => {
  const cases = [
    { name: 'unknown channel', code: 10003, parent: true },
    { name: 'archived thread', code: 50083, parent: true },
    { name: 'locked thread', code: 160005, parent: true },
    { name: 'announcement thread', code: 160005, type: 10, parentType: 5, parent: true },
    { name: 'rate limit', code: 0, status: 429 },
    { name: 'server failure', code: 0, status: 503 },
    { name: 'timeout', timeout: true },
    { name: 'other rejection', code: 50001, status: 400 },
    { name: 'partial send', code: 10003, partial: true },
    { name: 'private thread', code: 10003, type: 12 },
    { name: 'forum parent', code: 10003, parentType: 15 },
    { name: 'missing metadata', code: 10003, missing: true },
    { name: 'disabled channel', code: 10003, disabled: true },
    { name: 'parent rejects too', code: 10003, parentFails: true },
    { name: 'plain send has no fallback', code: 10003, plain: true },
  ];
  for (const item of cases) test.serial(item.name, async () => {
    const c = item as typeof item & {
      code?: number; status?: number; type?: number; parentType?: number;
      timeout?: boolean; partial?: boolean; missing?: boolean; disabled?: boolean;
      parentFails?: boolean; plain?: boolean; parent?: boolean;
    };
    const wd = setupWorkdir();
    const dir = hermit(wd.dir);
    const state = path.join(wd.dir, 'discord');
    fs.mkdirSync(state);
    fs.writeFileSync(path.join(state, '.env'), 'DISCORD_BOT_TOKEN=test-token\n');
    const config = { channels: { discord: { enabled: !c.disabled, state_dir: state } } };
    write(path.join(dir, 'config.json'), JSON.stringify(config));
    const posts: { route: string; content: string }[] = [];
    const server = Bun.serve({ port: 0, async fetch(req) {
      const route = new URL(req.url).pathname;
      if (req.method === 'GET') {
        if (c.missing) return Response.json({ code: 10003 }, { status: 404 });
        return Response.json(route === '/channels/THREAD'
          ? { type: c.type ?? 11, parent_id: 'PARENT' }
          : { type: c.parentType ?? 0 });
      }
      posts.push({ route, content: (await req.json() as any).content });
      if (route === '/channels/PARENT/messages') return Response.json({ code: c.parentFails ? 50001 : 0 }, { status: c.parentFails ? 403 : 200 });
      if (c.timeout) return new Promise<Response>(() => {});
      if (c.partial && posts.length === 1) return Response.json({ id: 'accepted' });
      return Response.json({ code: c.code, message: 'rejected' }, { status: c.status ?? 404 });
    } });
    const previous = process.env.HERMIT_DISCORD_API_URL;
    process.env.HERMIT_DISCORD_API_URL = server.url.toString().replace(/\/$/, '');
    const text = c.partial ? 'a'.repeat(2100) : 'CLIENT';
    // Only the hanging server needs a short budget; the others must answer within theirs.
    const timeoutMs = c.timeout ? 50 : 5000;
    try {
      const result = c.plain
        ? await sendToChannel(dir, text, { target: { id: 'discord', chat_id: 'THREAD' }, timeoutMs })
        : await sendToOwnedChat(dir, 'discord:THREAD', text, { timeoutMs });
      expect(result.ok).toBe(!!c.parent);
      if (!c.plain) expect(result.route).toBe(c.parent || c.parentFails ? 'parent' : 'chat');
      const parentPosts = posts.filter(p => p.route === '/channels/PARENT/messages');
      expect(parentPosts).toHaveLength(c.parent || c.parentFails ? 1 : 0);
      if (parentPosts.length) expect(parentPosts[0].content).toBe('(the original thread is no longer reachable)\nCLIENT');
      if (c.partial) expect(result.partial).toBe(true);
      if (!c.parent && !c.parentFails && !c.disabled && !c.timeout) expect(result.platform_code).toBe(c.code);
      expect(fs.existsSync(channelHealthPath(dir))).toBe(!!c.plain);
    } finally {
      if (previous === undefined) delete process.env.HERMIT_DISCORD_API_URL;
      else process.env.HERMIT_DISCORD_API_URL = previous;
      server.stop(true); wd.cleanup();
    }
  });

  for (const owner of ['routine', 'watch'] as const) {
    for (const merged of [false, true]) test.serial(`${owner}, merged=${merged}: parent gets client text only`, async () => {
      const wd = setupWorkdir();
      const dir = hermit(wd.dir);
      const state = path.join(wd.dir, 'discord');
      fs.mkdirSync(state);
      fs.writeFileSync(path.join(state, '.env'), 'DISCORD_BOT_TOKEN=test-token\n');
      write(path.join(dir, 'config.json'), JSON.stringify({
        channels: { discord: { state_dir: state, default_chat_id: 'HOME', maintainer_channel_id: merged ? 'THREAD' : 'HOME' } },
        routines: [{ id: 'weekly', chat: 'discord:THREAD' }],
        monitors: [{ id: 'weekly', chat: 'discord:THREAD' }],
      }));
      const posts: { route: string; text: string }[] = [];
      const server = Bun.serve({ port: 0, async fetch(req) {
        const route = new URL(req.url).pathname;
        if (req.method === 'GET') return Response.json(route === '/channels/THREAD' ? { type: 11, parent_id: 'PARENT' } : { type: 0 });
        posts.push({ route, text: (await req.json() as any).content });
        return route === '/channels/THREAD/messages'
          ? Response.json({ code: 10003, message: 'gone' }, { status: 404 }) : Response.json({ id: 'sent' });
      } });
      const previous = process.env.HERMIT_DISCORD_API_URL;
      process.env.HERMIT_DISCORD_API_URL = server.url.toString().replace(/\/$/, '');
      try {
        const out = await sendOperatorNotice(dir, {
          [owner]: 'weekly', client: 'CLIENT', maintainer: { text: 'TECHNICAL', fallback: 'client', sensitive: true },
        });
        expect(out.client).toMatchObject({ ok: true, route: 'parent' });
        expect(posts.filter(p => p.route === '/channels/PARENT/messages').map(p => p.text)).toEqual(['(the original thread is no longer reachable)\nCLIENT']);
        expect(posts).toHaveLength(merged ? 2 : 3);
        expect(findings(wd)).not.toContain('undelivered-client-notice');
        expect(findings(wd)).not.toContain('could not post');
        if (merged) {
          expect(out.maintainer).toMatchObject({ delivered: false, route: 'findings' });
          expect(posts[0].text).toBe('CLIENT\n\nTECHNICAL');
        }
        if (owner === 'routine') expect(fs.readFileSync(path.join(dir, 'state/routine-metrics.jsonl'), 'utf8')).toContain('chat-undelivered');
        const rows = unconsolidated(dir).rows;
        expect(rows.some(r => r.chat_id === 'PARENT' && r.text.includes('CLIENT'))).toBe(true);
        expect(rows.some(r => r.text.includes('TECHNICAL'))).toBe(false);
      } finally {
        if (previous === undefined) delete process.env.HERMIT_DISCORD_API_URL;
        else process.env.HERMIT_DISCORD_API_URL = previous;
        server.stop(true); wd.cleanup();
      }
    });
  }
});
