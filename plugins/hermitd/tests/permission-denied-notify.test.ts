// Contract tests for scripts/permission-denied-notify.ts, the PermissionDenied
// hook that records maintainer-tier diagnostics on a managed unattended session.
// Exercised as a subprocess (stdin in, exit code + stub requests out), the same
// boundary Claude Code sees. This hook cannot block and never emits
// hookSpecificOutput.retry; every case exits 0.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { startHttpStub } from './helpers/http-stub';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.hermit', ...p);
const write = (p: string, content: string) => fs.writeFileSync(p, content);
// The technical assembly (tool + reason) lands maintainer-tier and routes by
// the general tiered-disclosure policy: maintainer chat when configured,
// primary chat on a `technical` profile without one, watchdog event log on a
// `non-technical` profile or whenever no channel is reachable (setupWorkdir
// seeds a `## Findings` section).
const readFindings = (dir: string) => (fs.existsSync(hermit(dir, 'state', 'watchdog-events.jsonl')) ? fs.readFileSync(hermit(dir, 'state', 'watchdog-events.jsonl'), 'utf8') : '');
const findingsLines = (dir: string) => readFindings(dir).split('\n').filter(Boolean);
const alertsFile = (dir: string) => hermit(dir, 'state', 'permission-denied-alerts.json');
const readAlerts = (dir: string) => JSON.parse(fs.readFileSync(alertsFile(dir), 'utf8'));
const writeAlerts = (dir: string, alerts: object) => {
  fs.mkdirSync(path.dirname(alertsFile(dir)), { recursive: true });
  write(alertsFile(dir), JSON.stringify(alerts));
};
const logFile = (dir: string) => hermit(dir, 'state', 'permission-denied-events.jsonl');
const readLog = (dir: string): any[] =>
  fs.readFileSync(logFile(dir), 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
const daysAgoIso = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const minutesAgoIso = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000).toISOString();

function setupChannelWorkdir(telegramExtra: object = {}, configExtra: object = {}): Workdir {
  const wd = setupWorkdir();
  const stateDir = path.join(wd.dir, '.claude.local', 'channels', 'telegram');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=test-token\n');
  write(hermit(wd.dir, 'config.json'), JSON.stringify({
    always_on: true,
    ...configExtra,
    channels: {
      primary: 'telegram',
      telegram: { enabled: true, default_chat_id: '12345', allowed_users: ['u1'], state_dir: '.claude.local/channels/telegram', ...telegramExtra },
    },
  }));
  return wd;
}

// A client-facing install: the technical leg must never reach the client chat.
const setupClientWorkdir = (telegramExtra: object = {}) =>
  setupChannelWorkdir(telegramExtra, { operator_profile: 'non-technical' });

// Age the dedup state so the next denial of the same tool opens a fresh window.
function expireDedupWindow(dir: string): void {
  const alerts = readAlerts(dir);
  const past = minutesAgoIso(31);
  for (const k of Object.keys(alerts)) alerts[k].at = past;
  writeAlerts(dir, alerts);
}

// Mirrors Claude Code's PermissionDenied stdin payload. The fixed classifier
// reason is normally present, while synthetic and older payloads may omit it.
const DENIAL_PAYLOAD = {
  hook_event_name: 'PermissionDenied',
  permission_mode: 'auto',
  tool_name: 'Bash',
  tool_input: { command: 'bun scripts/apply-settings.ts .claude/settings.local.json artifact-allow' },
  reason: 'Blocked by classifier',
};

const run = (payload: object, dir: string, stubUrl: string, env: Record<string, string> = {}) =>
  runScript('permission-denied-notify.ts', {
    stdin: JSON.stringify(payload),
    cwd: dir,
    env: { HERMIT_MANAGED: '1', HERMIT_TELEGRAM_API_URL: stubUrl, ...env },
  });

describe('permission-denied-notify', () => {
  // The stock install: one technical operator, one chat, no maintainer chat.
  // This is the only tier the routing change moves, and it is the tier the
  // hook exists for — a client leg would be wrong here, silence equally so.
  test('technical profile without a maintainer chat reaches the primary chat', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0].body.chat_id).toBe('12345');
      expect(stub.requests[0].body.text).toContain('Auto-mode denied: Bash');
      expect(stub.requests[0].body.text).toContain('Blocked by classifier');
      expect(stub.requests[0].body.text).not.toContain('apply-settings.ts');
      expect(findingsLines(wd.dir)).toHaveLength(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('non-technical profile without a maintainer chat stays fail-closed to Findings', async () => {
    const stub = startHttpStub();
    const wd = setupClientWorkdir();
    try {
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(0);
      const findings = readFindings(wd.dir);
      expect(findings).toContain('Auto-mode denied: Bash');
      expect(findings).toContain('Blocked by classifier');
      expect(findings).not.toContain('apply-settings.ts');
      expect(findingsLines(wd.dir)).toHaveLength(1);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('configured maintainer receives one diagnostic and the client receives none', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0].body.chat_id).toBe('99999');
      expect(stub.requests[0].body.text).toContain('Auto-mode denied: Bash');
      expect(stub.requests[0].body.text).toContain('Blocked by classifier');
      expect(stub.requests[0].body.text).not.toContain('apply-settings.ts');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('includes the classifier reason when the payload carries one', async () => {
    const stub = startHttpStub();
    const wd = setupClientWorkdir();
    try {
      const r = await run({ ...DENIAL_PAYLOAD, reason: '[Self-Modification] blocked' }, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(readFindings(wd.dir)).toContain('Self-Modification');
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  // A long reason must not eat the trailing "what to do about it" guidance.
  test('an overlong reason is capped before the tail', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await run({ ...DENIAL_PAYLOAD, tool_name: `mcp__${'a'.repeat(80)}`, reason: 'x'.repeat(400) }, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0].body.text).toEndWith('If it was intended, tell the agent in chat.');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('payload without reason still records exactly one diagnostic', async () => {
    const stub = startHttpStub();
    const wd = setupClientWorkdir();
    try {
      const r = await run({ ...DENIAL_PAYLOAD, reason: undefined }, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(0);
      expect(readFindings(wd.dir)).toContain('Auto-mode denied: Bash');
      expect(findingsLines(wd.dir)).toHaveLength(1);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('credential-shaped tool input reaches neither HTTP bodies nor Findings', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999' });
    try {
      const command = 'curl -H "Authorization: Bearer test-secret-token" https://example.invalid';
      const r = await run({ ...DENIAL_PAYLOAD, tool_input: { command } }, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(stub.requests).toHaveLength(1);
      expect(JSON.stringify(stub.requests)).not.toContain('test-secret-token');
      expect(readFindings(wd.dir)).not.toContain('test-secret-token');
      const ledger = fs.readFileSync(logFile(wd.dir), 'utf8');
      expect(ledger).not.toContain('test-secret-token');
      expect(ledger).not.toContain('example.invalid');
      expect(readLog(wd.dir)).toEqual([
        { ts: expect.any(String), tool: 'Bash', prog: 'curl' },
      ]);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('stdout is always empty (never emits hookSpecificOutput)', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(r.stdout.trim()).toBe('');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('HERMIT_MANAGED absent — attended session, no request', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url, { HERMIT_MANAGED: '' });
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('HERMIT_DENY_NOTIFY=off — escape hatch, no request', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url, { HERMIT_DENY_NOTIFY: 'off' });
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('always_on: false — no request', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      write(hermit(wd.dir, 'config.json'), JSON.stringify({
        always_on: false,
        channels: { primary: 'telegram', telegram: { enabled: true, default_chat_id: '12345', state_dir: '.claude.local/channels/telegram' } },
      }));
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  // Channel reachability gates the POST, never the record. A terminal-managed
  // hermit with no channel at all, and one whose bot token just got revoked,
  // both still leave a trail — startup-context.ts injects the last Findings
  // lines at the next session boot, which is the only way either operator
  // learns this happened.
  test('no eligible channel — recorded to Findings, no request', async () => {
    const stub = startHttpStub();
    const wd = setupWorkdir();
    try {
      write(hermit(wd.dir, 'config.json'), JSON.stringify({ always_on: true, channels: {} }));
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(0);
      expect(readFindings(wd.dir)).toContain('Auto-mode denied: Bash');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('channel likely down — recorded to Findings, no request into a dead channel', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      fs.mkdirSync(hermit(wd.dir, 'state'), { recursive: true });
      write(hermit(wd.dir, 'state', 'channel-health.json'), JSON.stringify({ telegram: { last_success_at: null, consecutive_failures: 3 } }));
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(0);
      expect(readFindings(wd.dir)).toContain('Auto-mode denied: Bash');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  // Maintainer-eligible but not client-eligible: `resolve()` returns null while
  // `resolveMaintainerTarget()` succeeds. Eligibility must follow the tier the
  // diagnostic actually targets, or this install gets nothing.
  test('maintainer configured with no proactive client target still sends', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir({ maintainer_channel_id: '99999', default_chat_id: undefined });
    try {
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0].body.chat_id).toBe('99999');
      expect(stub.requests[0].body.text).toContain('Auto-mode denied: Bash');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  // The motivating incident: four denials of the same tool in nine minutes. The
  // old tool+input key made those four separate keys, so the window collapsed
  // nothing and the operator got four messages.
  test('dedup: a burst of distinct commands on one tool sends once', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      for (const command of ['a', 'b', 'c', 'd']) {
        const r = await run({ ...DENIAL_PAYLOAD, tool_input: { command } }, wd.dir, stub.url);
        expect(r.exitCode).toBe(0);
      }
      expect(stub.requests).toHaveLength(1);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  // What the burst cost the operator has to survive the collapse, or "one wall"
  // and "twelve walls" become the same message. It can only ride out on the
  // next window — a burst's size isn't known when the window opens.
  test('dedup: the next window reports how many denials were suppressed', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      for (const command of ['a', 'b', 'c', 'd']) {
        await run({ ...DENIAL_PAYLOAD, tool_input: { command } }, wd.dir, stub.url);
      }
      expect(stub.requests[0].body.text).not.toContain('more in the previous');
      expireDedupWindow(wd.dir);
      await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(stub.requests).toHaveLength(2);
      expect(stub.requests[1].body.text).toContain('(+3 more in the previous 30 min)');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('dedup: a different tool opens its own window', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      await run({ tool_name: 'Edit', tool_input: { file_path: '/tmp/x' }, reason: 'different' }, wd.dir, stub.url);
      expect(stub.requests).toHaveLength(2);
      expect(stub.requests[0].body.text).toContain('Auto-mode denied: Bash');
      expect(stub.requests[1].body.text).toContain('Auto-mode denied: Edit');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  // Long MCP tool names share the `mcp__<server>__` prefix, so a plain
  // truncation would collapse two distinct tools into one dedup window.
  test('dedup: two long tool names sharing a prefix do not share a window', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const prefix = `mcp__${'server'.repeat(9)}__`;
      await run({ ...DENIAL_PAYLOAD, tool_name: `${prefix}read` }, wd.dir, stub.url);
      await run({ ...DENIAL_PAYLOAD, tool_name: `${prefix}write` }, wd.dir, stub.url);
      expect(stub.requests).toHaveLength(2);
      expect(stub.requests[0].body.text).not.toBe(stub.requests[1].body.text);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('log: four bun denials in one window write four lines and send once', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const command = 'bun /x/scripts/heartbeat.ts precheck';
      for (let i = 0; i < 4; i++) {
        const r = await run({ ...DENIAL_PAYLOAD, tool_input: { command } }, wd.dir, stub.url);
        expect(r.exitCode).toBe(0);
      }
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0].body.text).toContain('Auto-mode denied: Bash');
      expect(stub.requests[0].body.text).toContain('Blocked by classifier');
      expect(stub.requests[0].body.text).not.toContain('heartbeat');
      expect(stub.requests[0].body.text).not.toContain('more in the previous');
      // Dedup suppresses the message, never the record — this is the whole point
      // of splitting the two.
      const rows = readLog(wd.dir);
      expect(rows).toHaveLength(4);
      expect(rows.every(r => r.tool === 'Bash' && r.prog === 'bun')).toBe(true);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('log: TOKEN=abc curl records env-prefixed, not the assignment or curl', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const command = 'TOKEN=abc curl https://example.invalid/secret';
      const r = await run({ ...DENIAL_PAYLOAD, tool_input: { command } }, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      const ledger = fs.readFileSync(logFile(wd.dir), 'utf8');
      expect(ledger).not.toContain('abc');
      expect(ledger).not.toContain('curl');
      expect(ledger).not.toContain('example.invalid');
      expect(readLog(wd.dir)[0].prog).toBe('env-prefixed');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('log: /usr/bin/python3 heredoc records python3, nothing after the first word', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const command = '/usr/bin/python3 - <<EOF\nprint("secret-payload")\nEOF';
      const r = await run({ ...DENIAL_PAYLOAD, tool_input: { command } }, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      const ledger = fs.readFileSync(logFile(wd.dir), 'utf8');
      expect(ledger).not.toContain('secret-payload');
      expect(ledger).not.toContain('<<EOF');
      expect(readLog(wd.dir)[0].prog).toBe('python3');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('log: a non-Bash tool records no prog key', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await run({ tool_name: 'Edit', tool_input: { file_path: '/tmp/x' }, reason: 'different' }, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(readLog(wd.dir)).toEqual([{ ts: expect.any(String), tool: 'Edit' }]);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('log: the ledger is created 0600, not at the process umask', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(fs.statSync(logFile(wd.dir)).mode & 0o777).toBe(0o600);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('log: rows past the 14-day retention are trimmed on the next denial', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const fresh = daysAgoIso(1);
      fs.mkdirSync(path.dirname(logFile(wd.dir)), { recursive: true });
      write(logFile(wd.dir),
        JSON.stringify({ ts: daysAgoIso(20), tool: 'Bash', prog: 'old' }) + '\n' +
        JSON.stringify({ ts: fresh, tool: 'Read' }) + '\n');
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      const rows = readLog(wd.dir);
      expect(rows.map(x => x.prog ?? x.tool)).toEqual(['Read', 'bun']);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('log: a fresh head skips the rewrite, so a malformed row survives verbatim', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      fs.mkdirSync(path.dirname(logFile(wd.dir)), { recursive: true });
      write(logFile(wd.dir),
        JSON.stringify({ ts: daysAgoIso(1), tool: 'Read' }) + '\n' + '{torn\n');
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(fs.readFileSync(logFile(wd.dir), 'utf8')).toContain('{torn');
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('log: concurrent hook processes each record their denial', async () => {
    // The reason this design replaced the aggregated digest. Claude Code does not
    // serialise hook invocations, so parallel tool calls in one turn spawn
    // overlapping processes; an append-only record survives that, a
    // read-modify-write digest silently loses counts.
    //
    // Deliberately asserts nothing about the send count: under a genuine
    // simultaneous race the dedup latch may open more than once, and pinning it
    // to 1 would encode a flake.
    const wd = setupChannelWorkdir();
    try {
      const script = path.resolve(import.meta.dir, '..', 'scripts', 'permission-denied-notify.ts');
      const procs = Array.from({ length: 8 }, () =>
        Bun.spawn({
          cmd: [process.execPath, script],
          stdin: Buffer.from(JSON.stringify(DENIAL_PAYLOAD)),
          cwd: wd.dir,
          env: { ...process.env, HERMIT_MANAGED: '1' },
          stdout: 'ignore',
          stderr: 'ignore',
        }));
      await Promise.all(procs.map(p => p.exited));
      const rows = readLog(wd.dir);
      expect(rows).toHaveLength(8);
      expect(rows.every(r => r.tool === 'Bash')).toBe(true);
    } finally {
      wd.cleanup();
    }
  }, 20000);

  test('dedup: an entry older than 24h is pruned from the alerts file', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      writeAlerts(wd.dir, { Edit: { at: daysAgoIso(2), suppressed: 0 } });
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      const alerts = readAlerts(wd.dir);
      expect(alerts.Edit).toBeUndefined();
      expect(alerts.Bash).toBeDefined();
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('dedup: a pre-#855 entry (no at) is dropped by readAlerts', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const hash = '0fb7d655de0335c2572cebcfcab45df66bc32206fe4f957ada64952d57ee04ea';
      writeAlerts(wd.dir, { [hash]: '2026-08-26T20:21:19+0100' });
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      const alerts = readAlerts(wd.dir);
      expect(alerts[hash]).toBeUndefined();
      expect(alerts.Bash).toBeDefined();
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('dedup: a stray history object from the pre-log build is dropped on the next write', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      writeAlerts(wd.dir, {
        Bash: {
          at: minutesAgoIso(31),
          suppressed: 0,
          history: { since: daysAgoIso(2), total: 99, burst_max: 5, programs: { bun: 99 } },
        },
      });
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(readAlerts(wd.dir).Bash.history).toBeUndefined();
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('malformed stdin — exit 0, no request', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runScript('permission-denied-notify.ts', {
        stdin: '{broken',
        cwd: wd.dir,
        env: { HERMIT_MANAGED: '1', HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('empty stdin — exit 0, no request', async () => {
    const stub = startHttpStub();
    const wd = setupChannelWorkdir();
    try {
      const r = await runScript('permission-denied-notify.ts', {
        stdin: '',
        cwd: wd.dir,
        env: { HERMIT_MANAGED: '1', HERMIT_TELEGRAM_API_URL: stub.url },
      });
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });

  test('missing config.json — fail-open, no request, exit 0', async () => {
    const stub = startHttpStub();
    const wd = setupWorkdir();
    try {
      const r = await run(DENIAL_PAYLOAD, wd.dir, stub.url);
      expect(r.exitCode).toBe(0);
      expect(stub.requests.length).toBe(0);
    } finally {
      stub.stop();
      wd.cleanup();
    }
  });
});
