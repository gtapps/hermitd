// Tests for cost-tracker's re-billing guards: a Stop hook that reads a transcript
// mid-flush must never bill an OLDER turn again under a fresh timestamp. Measured live:
// a pre-compaction turn re-billed hours later, whose dead 173k context then drove a
// watchdog compaction of a context 47k under the threshold.
//
// Subprocess-driven (like cost-tracker.test.ts) — cost-tracker.ts resolves HERMIT_DIR at
// load time, so an in-process import would bind the wrong cwd.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript, PLUGIN_ROOT } from './helpers/run';
import { triggerPrompt, assistantEntry as entry } from './helpers/transcript';
import { writeRegistryEntry } from './helpers/registry-fixture';

const assistantEntry = (timestamp: string, cacheRead: number, cacheWrite = 0, outputTokens = 50): string =>
  entry({ timestamp, cacheRead, cacheWrite, outputTokens });

function compactBoundary(timestamp: string, preTokens: number, postTokens: number): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    timestamp,
    content: 'Conversation compacted',
    compactMetadata: { trigger: 'manual', preTokens, postTokens },
  });
}

type Case = {
  /** Write the transcript; `trailingPartial` appends a half-flushed record. */
  writeTranscript(lines: string[], opts?: { trailingPartial?: boolean }): void;
  /** Seed the cost log with pre-existing rows. */
  seedCostLog(rows: any[]): void;
  /** Append rows to the cost log, as another session's Stop hook would. */
  appendCostLog(rows: any[]): void;
  /** Run one Stop-hook invocation of cost-tracker. */
  run(opts?: { env?: Record<string, string>; sessionId?: string }): Promise<void>;
  /** Main (non-subagent) cost-log rows written so far. */
  mainRows(): any[];
  /** Merge fields into the seeded runtime.json. */
  seedRuntime(patch: Record<string, unknown>): void;
  /** runtime.json as it stands. */
  readRuntime(): any;
  /** A validated registry entry for `pid` under a fixture config dir, which is returned. */
  seedRegistry(pid: number): string;
  /** Mark `sessionId` a guest, as startup-context's residency verdict would. */
  markGuest(sessionId: string): void;
};

// Per-test hermit dir — a module-level one leaks between tests, and cost-tracker's
// subprocess spawns against it while the next test's cleanup is racing.
function withCase(fn: (c: Case) => Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-rebilling-'));
    const logPath = path.join(dir, '.claude', 'cost-log.jsonl');
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    try {
      fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
      const stateDir = path.join(dir, '.hermit', 'state');
      const runtimeJson = path.join(stateDir, 'runtime.json');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(runtimeJson,
        JSON.stringify({ cc_session_id: 'test-session' }));
      const readRuntime = () => JSON.parse(fs.readFileSync(runtimeJson, 'utf-8'));

      await fn({
        seedRuntime(patch) {
          fs.writeFileSync(runtimeJson, JSON.stringify({ ...readRuntime(), ...patch }));
        },
        readRuntime,
        seedRegistry(pid) {
          const configDir = path.join(dir, 'cc-config');
          writeRegistryEntry(configDir, pid, { cwd: dir });
          return configDir;
        },
        markGuest(sessionId) {
          fs.writeFileSync(path.join(stateDir, `.guest-${sessionId}`), new Date().toISOString() + '\n');
        },
        writeTranscript(lines, opts = {}) {
          let body = lines.join('\n') + '\n';
          if (opts.trailingPartial) body += '{"type":"assistant","message":{"usage":{"input_';
          fs.writeFileSync(transcriptPath, body);
        },
        seedCostLog(rows) {
          fs.writeFileSync(logPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
        },
        appendCostLog(rows) {
          fs.appendFileSync(logPath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
        },
        async run(opts = {}) {
          const stdin = JSON.stringify({ session_id: opts.sessionId ?? 'test-session', transcript_path: transcriptPath });
          // HERMIT_MANAGED blanked by default: a `bun test` run from inside a managed
          // hermit pane carries it, which would make every case exercise the resident
          // restamp path below.
          await runScript('cost-tracker.ts', {
            stdin,
            cwd: dir,
            env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, HERMIT_MANAGED: '', ...(opts.env ?? {}) },
          });
        },
        mainRows() {
          if (!fs.existsSync(logPath)) return [];
          return fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean)
            .map(l => JSON.parse(l)).filter(r => r.subagent !== true);
        },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe('cost-tracker: transcript-not-ready guards', () => {
  test('a half-written trailing record bills nothing', withCase(async c => {
    c.writeTranscript([
      triggerPrompt('older turn'),
      assistantEntry('2026-08-02T11:32:06.830Z', 173_240),
    ], { trailingPartial: true });

    await c.run();

    expect(c.mainRows()).toHaveLength(0);
  }));

  test('a compaction boundary newer than the last usage bills nothing', withCase(async c => {
    c.writeTranscript([
      triggerPrompt('pre-compaction turn'),
      assistantEntry('2026-08-02T11:32:06.830Z', 173_240),
      compactBoundary('2026-08-02T12:31:54.377Z', 173_921, 30_000),
    ]);

    await c.run();

    expect(c.mainRows()).toHaveLength(0);
  }));

  test('a queued next-turn prompt after the billed turn still bills once', withCase(async c => {
    c.writeTranscript([
      triggerPrompt('turn one'),
      assistantEntry('2026-08-02T19:30:31.797Z', 29_313, 73_918),
      triggerPrompt('queued follow-up, not answered yet'),
    ]);

    await c.run();

    expect(c.mainRows()).toHaveLength(1);
  }));
});

describe('cost-tracker: duplicate-turn guard', () => {
  test('re-running against an unchanged transcript does not bill twice', withCase(async c => {
    c.writeTranscript([
      triggerPrompt('turn one'),
      assistantEntry('2026-08-02T19:30:31.797Z', 29_313, 73_918),
    ]);

    await c.run();
    await c.run();

    expect(c.mainRows()).toHaveLength(1);
  }));

  test('a newly appended turn bills again', withCase(async c => {
    c.writeTranscript([
      triggerPrompt('turn one'),
      assistantEntry('2026-08-02T19:30:31.797Z', 29_313, 73_918),
    ]);
    await c.run();

    c.writeTranscript([
      triggerPrompt('turn one'),
      assistantEntry('2026-08-02T19:30:31.797Z', 29_313, 73_918),
      triggerPrompt('turn two'),
      assistantEntry('2026-08-02T19:45:00.000Z', 103_298),
    ]);
    await c.run();

    const rows = c.mainRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].observed_at).toBe('2026-08-02T19:45:00.000Z');
  }));

  // Harness identity keeps a guest's newer row from swallowing the resident's turn.
  test('another session\'s newer row does not suppress this session\'s turn', withCase(async c => {
    c.seedCostLog([{
      timestamp: '2026-08-02T20:00:00.000Z',
      observed_at: '2026-08-02T20:00:00.000Z',
      cc_session_id: 'cc-guest-xyz',
      guest: true,
      source: 'other', model: 'sonnet',
      input_tokens: 12, cache_write_tokens: 0, cache_read_tokens: 250_000,
      output_tokens: 10, total_tokens: 250_022, api_calls: 1,
      max_prompt_tokens: 250_012, estimated_cost_usd: 0.2,
    }]);

    c.writeTranscript([
      triggerPrompt('resident turn, observed before the guest wrote'),
      assistantEntry('2026-08-02T19:00:00.000Z', 103_298),
    ]);
    await c.run();

    const rows = c.mainRows();
    expect(rows).toHaveLength(2);
    expect(rows[1].cc_session_id).toBe('test-session');
  }));

  // The other half of the same interleaving: this session bills a turn, a guest appends a
  // NEWER row, then this session's Stop hook is retried for the same turn. Matching the
  // newest row folder-wide would find the guest's and fail the session comparison, taking
  // the guard out of play and double-billing the turn under a fresh timestamp.
  test('a guest row appended between a turn and its retry does not defeat the guard', withCase(async c => {
    c.writeTranscript([
      triggerPrompt('resident turn'),
      assistantEntry('2026-08-02T19:00:00.000Z', 103_298),
    ]);
    await c.run();
    expect(c.mainRows()).toHaveLength(1);

    c.appendCostLog([{
      timestamp: '2026-08-02T20:00:00.000Z',
      observed_at: '2026-08-02T20:00:00.000Z',
      cc_session_id: 'cc-guest-xyz',
      guest: true,
      source: 'other', model: 'sonnet',
      input_tokens: 12, cache_write_tokens: 0, cache_read_tokens: 250_000,
      output_tokens: 10, total_tokens: 250_022, api_calls: 1,
      max_prompt_tokens: 250_012, estimated_cost_usd: 0.2,
    }]);

    await c.run(); // same transcript, same turn — a retried Stop

    expect(c.mainRows().filter(r => r.cc_session_id === 'test-session')).toHaveLength(1);
  }));

  test('a legacy last row without observed_at never blocks the next bill', withCase(async c => {
    // Shaped like the row that caused the live incident: a re-billed pre-compaction turn.
    c.seedCostLog([{
      timestamp: '2026-08-02T19:30:31.923Z',
      source: 'other',
      model: 'sonnet',
      input_tokens: 12,
      cache_write_tokens: 3106,
      cache_read_tokens: 1_035_114,
      output_tokens: 1913,
      total_tokens: 1_040_145,
      api_calls: 6,
      max_prompt_tokens: 173_831,
      estimated_cost_usd: 0.35,
    }]);

    c.writeTranscript([
      triggerPrompt('first turn after upgrade'),
      assistantEntry('2026-08-02T19:00:00.000Z', 103_298),
    ]);
    await c.run();

    expect(c.mainRows()).toHaveLength(2);
  }));
});

describe('cost-tracker: billing boundaries', () => {
  const previousTimestamp = '2026-08-02T19:00:00.000Z';
  const callX = assistantEntry(previousTimestamp, 9_000);
  const callA = assistantEntry('2026-08-02T19:10:00.000Z', 100, 10, 5);
  const callB = assistantEntry('2026-08-02T19:20:00.000Z', 200, 20, 7);
  const previousRow = { cc_session_id: 'test-session', observed_at: previousTimestamp };
  const summedUsage = {
    input_tokens: 4,
    cache_write_tokens: 30,
    cache_read_tokens: 300,
    output_tokens: 12,
    total_tokens: 346,
    api_calls: 2,
  };

  test('a first turn bills calls before and after a skill body', withCase(async c => {
    c.writeTranscript([
      triggerPrompt('load a skill'),
      callA,
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_skill', content: 'ok' }] } }),
      JSON.stringify({
        type: 'user', isMeta: true, turnCompanion: true,
        message: { content: [{ type: 'text', text: 'Base directory for this skill: /plugins/hermitd/skills/hermit-routines' }] },
      }),
      callB,
    ]);

    await c.run();

    const rows = c.mainRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject(summedUsage);
  }));

  for (const [name, content] of [
    ['channel envelope', '<channel source="discord">incoming message</channel>'],
    ['cross-session message', 'Another Claude session sent a message: incoming message'],
  ]) {
    test(`a mid-turn ${name} does not cut off unbilled calls`, withCase(async c => {
      c.seedCostLog([previousRow]);
      c.writeTranscript([
        triggerPrompt('previous turn'),
        callX,
        triggerPrompt('current turn'),
        callA,
        JSON.stringify({ type: 'user', isMeta: true, message: { content } }),
        callB,
      ]);

      await c.run();

      const rows = c.mainRows();
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject(summedUsage);
    }));
  }

  test('a skipped Stop is recovered once by the next Stop', withCase(async c => {
    c.seedCostLog([previousRow]);
    c.writeTranscript([
      triggerPrompt('previous turn'),
      callX,
      triggerPrompt('turn with a skipped Stop'),
      callA,
      triggerPrompt('next turn'),
      callB,
    ]);

    await c.run();

    const rows = c.mainRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject(summedUsage);

    await c.run();

    expect(c.mainRows()).toHaveLength(2);
  }));

  test('a first turn opened by an isMeta routine wake retains its source', withCase(async c => {
    c.writeTranscript([
      JSON.stringify({ type: 'user', isMeta: true, message: { content: '[hermit-routine:demo] Run: bun scripts/routines.ts run demo' } }),
      callA,
      callB,
    ]);

    await c.run();

    const rows = c.mainRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ...summedUsage, source: 'routine:demo' });
  }));
});

describe('cost-tracker: context signal', () => {
  test('the row carries observed_at and the newest call prompt size', withCase(async c => {
    c.writeTranscript([
      triggerPrompt('turn one'),
      assistantEntry('2026-08-02T19:30:31.797Z', 29_313, 73_918),
    ]);

    await c.run();

    const [row] = c.mainRows();
    expect(row.observed_at).toBe('2026-08-02T19:30:31.797Z');
    expect(row.last_call_prompt_tokens).toBe(29_313 + 73_918 + 2);
  }));

  test('a turn spanning a compaction bills every call but reports only the newest context', withCase(async c => {
    c.writeTranscript([
      triggerPrompt('long turn that compacts mid-flight'),
      assistantEntry('2026-08-02T19:00:00.000Z', 170_000),
      compactBoundary('2026-08-02T19:10:00.000Z', 173_921, 30_000),
      assistantEntry('2026-08-02T19:20:00.000Z', 30_000),
    ]);

    await c.run();

    const [row] = c.mainRows();
    expect(row.api_calls).toBe(2);                       // billing still covers both calls
    expect(row.max_prompt_tokens).toBe(170_002);         // turn peak — the dead context
    expect(row.last_call_prompt_tokens).toBe(30_002);    // what the hygiene tiers must see
  }));
});

// The resident's identity on runtime.json is what the watchdog's hygiene tiers judge
// context by. SessionStart is its primary writer, but that only fires on
// start/resume/compact/clear — a hermit already running when this version lands would
// otherwise stay unstamped, and both tiers inert, until its next restart. The Stop hook
// re-asserts it on the resident's own turns, under the same incumbency rule the
// SessionStart stamp uses (startup-context.ts stampSessionEnv).
describe('cost-tracker: resident identity stamp', () => {
  const oneTurn = (c: Case) => c.writeTranscript([
    triggerPrompt('a resident turn'),
    assistantEntry('2026-08-02T19:30:31.797Z', 40_000),
  ]);

  test('the resident\'s own turn stamps a missing session id', withCase(async c => {
    oneTurn(c);

    await c.run({ env: { HERMIT_MANAGED: '1' }, sessionId: 'cc-resident-abc' });

    expect(c.readRuntime().cc_session_id).toBe('cc-resident-abc');
  }));

  test('a stamp left by a session the resident launched is replaced', withCase(async c => {
    c.seedRuntime({ cc_session_id: 'cc-dead-child' });
    oneTurn(c);

    await c.run({ env: { HERMIT_MANAGED: '1' }, sessionId: 'cc-resident-abc' });

    expect(c.readRuntime().cc_session_id).toBe('cc-resident-abc');
  }));

  test('a live incumbent at another pid blocks the stamp', withCase(async c => {
    // runScript spawns the hook directly, so its ppid is this test process; process.ppid
    // is therefore a live pid that is NOT the hook's parent — the nested-session shape.
    const configDir = c.seedRegistry(process.ppid);
    c.seedRuntime({ config_dir: configDir, session_pid: process.ppid, cc_session_id: 'cc-resident-abc' });
    oneTurn(c);

    await c.run({ env: { HERMIT_MANAGED: '1' }, sessionId: 'cc-nested' });

    expect(c.readRuntime().cc_session_id).toBe('cc-resident-abc');
  }));

  test('an unmanaged session never stamps', withCase(async c => {
    c.seedRuntime({ cc_session_id: 'cc-resident-abc' });
    oneTurn(c);

    await c.run({ sessionId: 'cc-attended-xyz' });

    expect(c.readRuntime().cc_session_id).toBe('cc-resident-abc');
  }));

  test('a guest never stamps', withCase(async c => {
    c.seedRuntime({ cc_session_id: 'cc-resident-abc' });
    c.markGuest('cc-guest-xyz');
    oneTurn(c);

    await c.run({ env: { HERMIT_MANAGED: '1' }, sessionId: 'cc-guest-xyz' });

    expect(c.readRuntime().cc_session_id).toBe('cc-resident-abc');
  }));

  // updated_at is doctor's stale-session tripwire. Refreshing it on a turn (not a
  // lifecycle transition) would hide a wedged session, which is why this writes through
  // cost-tracker's own partial writer rather than lib/runtime's updateRuntimeField.
  test('stamping does not refresh updated_at', withCase(async c => {
    c.seedRuntime({ updated_at: '2020-01-01T00:00:00.000Z' });
    oneTurn(c);

    await c.run({ env: { HERMIT_MANAGED: '1' }, sessionId: 'cc-resident-abc' });

    const runtime = c.readRuntime();
    expect(runtime.cc_session_id).toBe('cc-resident-abc');
    expect(runtime.updated_at).toBe('2020-01-01T00:00:00.000Z');
  }));
});
