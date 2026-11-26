// Tests for scripts/cost-tracker.ts: collectSubagentUsage unit tests and
// subprocess test confirming per-subagent cost-log lines are emitted.
//
// collectSubagentUsage tests use a subprocess helper (collect-subagent-usage.ts) rather
// than an in-process import to avoid polluting the module cache — cost-tracker.ts
// initialises HERMIT_DIR at load time, and hooks.contract.test.ts imports the
// same module in-process from a different cwd.  A shared cache would cause
// cost tracking to read the wrong project state.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript, PLUGIN_ROOT, SCRIPTS_DIR } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';
import { triggerPrompt, assistantEntry as assistantEntryFull, assistantEntryFor as assistantEntry } from './helpers/transcript';

const HELPER = path.join(import.meta.dir, 'helpers', 'collect-subagent-usage.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTmpdir(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cost-tracker-'));
    try {
      await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  };
}

async function runCollect(lines: string[], billedIndex: number): Promise<any[]> {
  const proc = Bun.spawn({
    cmd: [process.execPath, HELPER],
    env: { ...process.env },
    stdin: Buffer.from(JSON.stringify({ lines, billedIndex })),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return JSON.parse(stdout.trim() || '[]');
}

// Build a toolUseResult transcript entry.
// CC uses a hybrid representation: both toolUseResult (the subagent summary) and
// message.content:[{type:'tool_result'}] (so isToolResult returns true and boundary
// scanning doesn't stop here).
function subagentEntry(resolvedModel: string | undefined, inputTokens: number, outputTokens: number): string {
  return JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'agent-1', content: 'done' }] },
    toolUseResult: {
      agentType: 'general-purpose',
      resolvedModel,
      usage: { input_tokens: inputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: outputTokens },
    },
  });
}

// ---------------------------------------------------------------------------
// Unit: collectSubagentUsage (via subprocess helper to avoid module-cache pollution)
// ---------------------------------------------------------------------------

describe('collectSubagentUsage', () => {
  test('collects a single subagent toolUseResult within the turn window', async () => {
    const lines = [
      triggerPrompt('[hermit-routine:demo] start'),          // 0 — turn boundary
      assistantEntry('claude-sonnet-4-6', 100, 50),         // 1
      subagentEntry('claude-haiku-4-5-20251001', 200, 80),  // 2
      assistantEntry('claude-sonnet-4-6', 10, 5),           // 3 — billedIndex
    ];
    const results = await runCollect(lines, 3);
    expect(results).toHaveLength(1);
    expect(results[0].model).toBe('claude-haiku-4-5-20251001');
    expect(results[0].inputTokens).toBe(200);
    expect(results[0].outputTokens).toBe(80);
    expect(results[0].agentType).toBe('general-purpose');
  });

  test('collects multiple subagent dispatches within the same turn', async () => {
    const lines = [
      triggerPrompt('HEARTBEAT_EVALUATE'),                   // 0 — turn boundary
      assistantEntry('claude-opus-4-8', 500, 200),          // 1
      subagentEntry('claude-haiku-4-5-20251001', 100, 40),  // 2
      subagentEntry('claude-haiku-4-5-20251001', 120, 50),  // 3
      assistantEntry('claude-opus-4-8', 10, 5),             // 4 — billedIndex
    ];
    const results = await runCollect(lines, 4);
    expect(results).toHaveLength(2);
    expect(results.every((r: any) => r.model === 'claude-haiku-4-5-20251001')).toBe(true);
  });

  test('does not cross the turn boundary into the prior turn', async () => {
    const lines = [
      triggerPrompt('prior turn'),                          // 0 — prior turn boundary
      subagentEntry('claude-haiku-4-5-20251001', 999, 999), // 1 — prior turn dispatch (must be excluded)
      assistantEntry('claude-sonnet-4-6', 10, 5),           // 2 — prior turn last entry
      triggerPrompt('[hermit-routine:demo] start'),          // 3 — current turn boundary
      assistantEntry('claude-sonnet-4-6', 50, 20),          // 4 — billedIndex
    ];
    const results = await runCollect(lines, 4);
    expect(results).toHaveLength(0);
  });

  test('returns empty array when no subagent dispatches in turn', async () => {
    const lines = [
      triggerPrompt('[hermit-routine:demo] start'),
      assistantEntry('claude-sonnet-4-6', 100, 50),
    ];
    const results = await runCollect(lines, 1);
    expect(results).toHaveLength(0);
  });

  test('ignores subagent entries with no usage', async () => {
    const lines = [
      triggerPrompt('hello'),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: '' }] }, toolUseResult: { agentType: 'general-purpose', resolvedModel: 'claude-haiku-4-5-20251001' } }),
      assistantEntry('claude-sonnet-4-6', 10, 5),
    ];
    const results = await runCollect(lines, 2);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Subprocess: cost-tracker emits per-subagent log lines
// ---------------------------------------------------------------------------

describe('cost-tracker subagent log lines', () => {
  // Minimal hermit dir structure cost-tracker needs:
  //   <dir>/.claude/cost-log.jsonl     (written by cost-tracker)
  //   <dir>/.hermit/state/runtime.json
  let dir: string;
  let transcriptPath: string;
  let logPath: string;
  let out = '';

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cost-tracker-sub-'));

    // Claude dir for the cost-log
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    logPath = path.join(dir, '.claude', 'cost-log.jsonl');

    // Hermit state dir
    const stateDir = path.join(dir, '.hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ cc_session_id: 'test-session' }));

    // Transcript: routine trigger → assistant call → subagent dispatch → final assistant
    const transcriptLines = [
      triggerPrompt('[hermit-routine:demo] start\nlog-routine-event.sh demo started'),
      assistantEntry('claude-sonnet-4-6', 500, 100),
      subagentEntry('claude-haiku-4-5-20251001', 1000, 400),
      assistantEntry('claude-sonnet-4-6', 10, 5),
    ];
    transcriptPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, transcriptLines.join('\n') + '\n');

    const stdin = JSON.stringify({ session_id: 'test-session', transcript_path: transcriptPath });
    const r = await runScript('cost-tracker.ts', { stdin, cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
    out = r.stdout + r.stderr;
  });

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true });
  });

  test('cost-tracker: cost-log.jsonl is written', () => {
    expect(fs.existsSync(logPath)).toBe(true);
  });

  test('cost tracking creates no retired cache or lifecycle row field', () => {
    expect(fs.existsSync(path.join(dir, '.hermit', 'sessions', '.status.json'))).toBe(false);
    const rows = fs.readFileSync(logPath, 'utf-8').trim().split('\n').map(line => JSON.parse(line));
    for (const row of rows) expect('session_id' in row).toBe(false);
  });

  test('cost-tracker: cost-log.jsonl has exactly 2 lines (main + subagent)', () => {
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  test('cost-tracker: first line is the main turn entry (no subagent field)', () => {
    const [firstLine] = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(firstLine);
    expect(entry.subagent).toBeFalsy();
    expect(entry.source).toBe('routine:demo');
    expect(entry.model).toBe('claude-sonnet-4-6');
    expect(entry.cost_by_type).toEqual({
      input: expect.any(Number),
      cache_write: expect.any(Number),
      cache_read: expect.any(Number),
      output: expect.any(Number),
    });
  });

  test('cost-tracker: second line is the subagent entry at haiku', () => {
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(lines[1]);
    expect(entry.subagent).toBe(true);
    expect(entry.model).toBe('claude-haiku-4-5-20251001');
    expect(entry.agent_type).toBe('general-purpose');
    expect(entry.api_calls).toBe(0);
    expect(entry.model_resolved).toBe(true); // resolvedModel was present
  });

  test('cost-tracker: main entry carries max_prompt_tokens; subagent entry does not', () => {
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const mainEntry = JSON.parse(lines[0]);
    const subEntry = JSON.parse(lines[1]);
    expect(typeof mainEntry.max_prompt_tokens).toBe('number');
    expect(subEntry.max_prompt_tokens).toBeUndefined();
  });

  test('cost-tracker: subagent entry inherits the dispatching source', () => {
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const subEntry = JSON.parse(lines[1]);
    expect(subEntry.source).toBe('routine:demo');
  });

  test('cost-tracker: subagent entry has correct token counts', () => {
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const subEntry = JSON.parse(lines[1]);
    expect(subEntry.total_tokens).toBeGreaterThan(0);
    expect(subEntry.input_tokens).toBe(1000);
    expect(subEntry.output_tokens).toBe(400);
  });

  test('cost-tracker: stderr summary produced (exit 0)', () => {
    expect(out.length).toBeGreaterThan(0);
  });
});

// A subagent dispatch whose tool_result carries no resolvedModel must still be
// logged (tokens stay visible), but flagged model_resolved:false so the sonnet
// default is auditable rather than a silent mis-bill.
describe('cost-tracker subagent with no resolvedModel', () => {
  let dir: string;
  let logPath: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cost-tracker-nomodel-'));
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    logPath = path.join(dir, '.claude', 'cost-log.jsonl');
    const stateDir = path.join(dir, '.hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ cc_session_id: 'test-session' }));

    const transcriptLines = [
      triggerPrompt('[hermit-routine:demo] start'),
      assistantEntry('claude-sonnet-4-6', 500, 100),
      subagentEntry(undefined, 1000, 400), // resolvedModel absent → model_resolved:false
      assistantEntry('claude-sonnet-4-6', 10, 5),
    ];
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, transcriptLines.join('\n') + '\n');

    const stdin = JSON.stringify({ session_id: 'test-session', transcript_path: transcriptPath });
    await runScript('cost-tracker.ts', { stdin, cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
  });

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true });
  });

  test('cost-tracker: missing resolvedModel is logged with model_resolved:false at sonnet default', () => {
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const subEntry = JSON.parse(lines[1]);
    expect(subEntry.subagent).toBe(true);
    expect(subEntry.model_resolved).toBe(false);
    expect(subEntry.model).toBe('');
    expect(subEntry.input_tokens).toBe(1000);
  });
});

// Regression for #572: a turn whose real triggering prompt falls outside the 512KB
// tail window must not inherit a stale/echoed marker still inside that window.
// Since the 8MB re-read landed, this fixture resolves on the retry: the real prompt is
// found rather than assumed, and it is a plain operator message, so 'other' still holds.
// The truncated-window path itself is pinned in this file's `cost-tracker
// scanTurnInTail` block, which reaches it with a small tailBytes.
describe('cost-tracker: oversized turn with boundary outside the tail window', () => {
  let dir: string;
  let logPath: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cost-tracker-oversized-'));
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    logPath = path.join(dir, '.claude', 'cost-log.jsonl');
    const stateDir = path.join(dir, '.hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ cc_session_id: 'test-session' }));

    // The REAL trigger for this turn — a plain operator prompt, no routine marker.
    // Followed by >512KB of filler tool_use/tool_result pairs so this line falls
    // before the tail window's read-from offset. One filler entry near the end
    // (inside the window) echoes a stale routine marker in its tool_result content
    // — simulating a leftover `log-routine-event.sh doctor started` string from an
    // unrelated earlier fire, or output surfaced by this very turn's own tooling.
    const transcriptLines: string[] = [
      triggerPrompt('Investigate the failing upgrade run and apply the fix.'),
    ];
    const filler = 'x'.repeat(2000);
    for (let i = 0; i < 300; i++) {
      transcriptLines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: {} }] } }));
      transcriptLines.push(JSON.stringify({ type: 'user', message: { content: [{ tool_use_id: `t${i}`, type: 'tool_result', content: filler }] } }));
    }
    // Stale marker, planted a few entries before the end — well within the 512KB tail.
    transcriptLines.push(JSON.stringify({ type: 'user', message: { content: [{ tool_use_id: 'stale', type: 'tool_result', content: 'log-routine-event.sh doctor started' }] } }));
    transcriptLines.push(assistantEntry('claude-sonnet-4-6', 5000, 2000));

    const transcriptPath = path.join(dir, 'transcript.jsonl');
    const content = transcriptLines.join('\n') + '\n';
    expect(Buffer.byteLength(content, 'utf-8')).toBeGreaterThan(524288); // sanity: exceeds TAIL_BYTES
    fs.writeFileSync(transcriptPath, content);

    const stdin = JSON.stringify({ session_id: 'test-session', transcript_path: transcriptPath });
    await runScript('cost-tracker.ts', { stdin, cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
  });

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true });
  });

  test('cost-tracker: logs source as "other", not the stale in-window marker', () => {
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(lines[0]);
    expect(entry.source).toBe('other');
  });
});

// Regression: when the model re-invokes a skill whose instructions are already in
// context, CC (2.1.202+) writes a companion user entry instead of a second copy of the
// skill body. That companion carries STRING content, so the array-content discriminator
// alone let it end the prompt walk and the turn billed to 'other'. Measured on live
// transcripts: a weekly-review fire and a pipeline-digest co-fire, both mis-attributed
// while their real ROUTINE_DUE prompt sat a few entries further back.
describe('cost-tracker: a skill companion entry never ends the prompt walk', () => {
  const { freshDir, cleanup } = freshDirFactory('hermit-cost-tracker-companion-');

  // Verbatim companion shapes from live CC transcripts. `turnCompanion` is the field
  // that separates every skill-scaffolding entry from a real prompt; `isMeta` alone does
  // not, because routine wakes and channel envelopes are isMeta strings too.
  const reinvocation = JSON.stringify({
    type: 'user', isMeta: true, turnCompanion: true, sourceToolUseID: 'toolu_companion',
    message: { content: '(Re-invocation of /hermitd:hermit-routines \u2014 the skill instructions were previously loaded; the arguments or dynamic output below are new.)' },
  });
  const alreadyLoaded = JSON.stringify({
    type: 'user', isMeta: true, turnCompanion: true, sourceToolUseID: 'toolu_companion',
    message: { content: 'Skill /hermitd:heartbeat is already loaded above; instructions unchanged. Arguments: run' },
  });
  const skillBody = JSON.stringify({
    type: 'user', isMeta: true, turnCompanion: true,
    message: { content: [{ type: 'text', text: 'Base directory for this skill: /plugins/hermitd/skills/hermit-routines' }] },
  });

  async function sourceFor(entries: string[]): Promise<string> {
    const dir = freshDir();
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const stateDir = path.join(dir, '.hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ cc_session_id: 'test-session' }));

    const transcriptPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, [...entries, assistantEntry('claude-sonnet-4-6', 5000, 2000)].join('\n') + '\n');

    const stdin = JSON.stringify({ session_id: 'test-session', transcript_path: transcriptPath });
    await runScript('cost-tracker.ts', { stdin, cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
    const [firstLine] = fs.readFileSync(path.join(dir, '.claude', 'cost-log.jsonl'), 'utf-8').trim().split('\n');
    return JSON.parse(firstLine).source;
  }

  afterAll(cleanup);

  test('cost-tracker: a re-invocation companion does not shadow the routine wake behind it', async () => {
    const source = await sourceFor([
      triggerPrompt('<task-notification> <summary>Monitor event: "routine-monitor"</summary> <event>ROUTINE_DUE [hermit-routine:demo]</event> </task-notification>'),
      assistantEntry('claude-sonnet-4-6', 100, 20),
      reinvocation,
      skillBody,
    ]);
    expect(source).toBe('routine:demo');
  });

  test('cost-tracker: an already-loaded companion does not shadow the heartbeat wake behind it', async () => {
    const source = await sourceFor([
      triggerPrompt('HEARTBEAT_EVALUATE'),
      assistantEntry('claude-sonnet-4-6', 100, 20),
      alreadyLoaded,
    ]);
    expect(source).toBe('heartbeat');
  });

  // The other half of the contract: a routine wake IS an isMeta string entry, so the
  // predicate must key on turnCompanion, never on isMeta alone.
  test('cost-tracker: an isMeta prompt without a companion marker still classifies', async () => {
    const source = await sourceFor([
      JSON.stringify({ type: 'user', isMeta: true, message: { content: '[hermit-routine:demo] Run: bun scripts/routines.ts run demo' } }),
    ]);
    expect(source).toBe('routine:demo');
  });
});

// A long routine run (evolve, weekly-scan, weekly-review) writes more transcript in one
// turn than the 512KB tail holds, so its ROUTINE_DUE prompt sits outside the window: the
// turn billed to 'other' and its token sum started mid-turn. One re-read at the cap
// recovers both. Observed on fleet hermits, where those runs are the expensive ones.
describe('cost-tracker: 600KB single-turn transcript (boundary outside the 512KB tail)', () => {
  let dir: string;
  let logPath: string;
  const CALLS = 301; // 300 filler calls + the final billed entry

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cost-tracker-600kb-'));
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    logPath = path.join(dir, '.claude', 'cost-log.jsonl');
    const stateDir = path.join(dir, '.hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ cc_session_id: 'test-session' }));

    // The turn's only prompt, followed by >512KB of billed calls and their tool_results.
    // No stale marker anywhere: the ONLY classifiable text is the wake at the very top,
    // so a source of 'routine:demo' proves the walk reached it.
    const transcriptLines: string[] = [
      triggerPrompt('<task-notification> <summary>Monitor event: "routine-monitor"</summary> <event>ROUTINE_DUE [hermit-routine:demo]</event> </task-notification>'),
    ];
    const filler = 'x'.repeat(2000);
    for (let i = 0; i < CALLS - 1; i++) {
      transcriptLines.push(assistantEntry('claude-sonnet-4-6', 10, 5));
      transcriptLines.push(JSON.stringify({ type: 'user', message: { content: [{ tool_use_id: `t${i}`, type: 'tool_result', content: filler }] } }));
    }
    transcriptLines.push(assistantEntry('claude-sonnet-4-6', 5000, 2000));

    const transcriptPath = path.join(dir, 'transcript.jsonl');
    const content = transcriptLines.join('\n') + '\n';
    expect(Buffer.byteLength(content, 'utf-8')).toBeGreaterThan(524288); // sanity: exceeds TAIL_BYTES
    fs.writeFileSync(transcriptPath, content);

    const stdin = JSON.stringify({ session_id: 'test-session', transcript_path: transcriptPath });
    await runScript('cost-tracker.ts', { stdin, cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
  });

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true });
  });

  test('cost-tracker: 600KB turn is attributed to its routine, not "other"', () => {
    const [firstLine] = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(JSON.parse(firstLine).source).toBe('routine:demo');
  });

  test('cost-tracker: 600KB turn sums every call, not just the ones inside the 512KB tail', () => {
    const [firstLine] = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(JSON.parse(firstLine).api_calls).toBe(CALLS);
  });
});

// max_prompt_tokens is the real context-size signal watchdog's hygiene thresholds
// key on (a multi-call turn's summed input_tokens is a multiple of its actual
// context, not the context itself) — the largest single API call in the turn.
describe('cost-tracker: max_prompt_tokens (real context size vs per-turn sum)', () => {
  let dir: string;
  let logPath: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cost-tracker-maxprompt-'));
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    logPath = path.join(dir, '.claude', 'cost-log.jsonl');
    const stateDir = path.join(dir, '.hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ cc_session_id: 'test-session' }));

    // Three API calls in one turn: 100k, 300k (the largest), 50k (billedIndex).
    // Summed, the turn logs 450k prompt tokens; the real context peak was 300k.
    const transcriptLines = [
      triggerPrompt('[hermit-routine:demo] start'),
      assistantEntry('claude-sonnet-4-6', 100000, 50),
      assistantEntry('claude-sonnet-4-6', 300000, 60),
      assistantEntry('claude-sonnet-4-6', 50000, 5),
    ];
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, transcriptLines.join('\n') + '\n');

    const stdin = JSON.stringify({ session_id: 'test-session', transcript_path: transcriptPath });
    await runScript('cost-tracker.ts', { stdin, cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
  });

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true });
  });

  test('main entry carries max_prompt_tokens equal to the single largest call, not the sum', () => {
    const [firstLine] = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(firstLine);
    expect(entry.input_tokens).toBe(450000); // the pre-existing per-turn sum, unchanged
    expect(entry.max_prompt_tokens).toBe(300000); // the real context-size signal
    expect(entry.api_calls).toBe(3);
  });
});

// Streamed chunks of one request share a requestId; they must bill once, at the max
// of each token field, not once per transcript entry.
describe('cost-tracker: same requestId billed once', () => {
  let dir: string;
  let logPath: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-cost-tracker-reqid-'));
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    logPath = path.join(dir, '.claude', 'cost-log.jsonl');
    const stateDir = path.join(dir, '.hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify({ cc_session_id: 'test-session' }));

    const transcriptLines = [
      triggerPrompt('[hermit-routine:demo] start'),
      assistantEntryFull({ model: 'claude-sonnet-4-6', requestId: 'req_same', inputTokens: 100, outputTokens: 10 }),
      assistantEntryFull({ model: 'claude-sonnet-4-6', requestId: 'req_same', inputTokens: 100, outputTokens: 20 }),
      assistantEntryFull({ model: 'claude-sonnet-4-6', requestId: 'req_same', inputTokens: 100, outputTokens: 30 }),
    ];
    const transcriptPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, transcriptLines.join('\n') + '\n');

    const stdin = JSON.stringify({ session_id: 'test-session', transcript_path: transcriptPath });
    await runScript('cost-tracker.ts', { stdin, cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT } });
  });

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true });
  });

  test('three streamed entries of one requestId bill as api_calls: 1', () => {
    const [firstLine] = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const entry = JSON.parse(firstLine);
    expect(entry.api_calls).toBe(1);
    expect(entry.output_tokens).toBe(30);
    expect(entry.input_tokens).toBe(100);
  });
});

describe('cost-tracker classifySource / resolveTurnSource', () => {
  // cost-tracker.ts freezes CWD-relative state paths at import time (see the
  // chdir-guarded import in hooks.contract.test.ts). classifySource and
  // resolveTurnSource are pure and never touch those paths, but a plain
  // import here would populate the shared module cache before
  // hooks.contract.test.ts's workdir-pinned import runs, breaking its
  // getCumulativeCost tests. The
  // query-string specifier forces a separate module instance so the two test
  // files never share cost-tracker state.
  let classifySource: typeof import('../scripts/cost-tracker').classifySource;
  let resolveTurnSource: typeof import('../scripts/cost-tracker').resolveTurnSource;

  beforeAll(async () => {
    const mod = (await import(
      '../scripts/cost-tracker' + '?scripts-test-pure-fns' // concat keeps tsc from resolving the query path
    )) as typeof import('../scripts/cost-tracker');
    ({ classifySource, resolveTurnSource } = mod);
  });

  test('cost-tracker: exports classifySource and resolveTurnSource', () => {
    expect(typeof classifySource).toBe('function');
    expect(typeof resolveTurnSource).toBe('function');
  });

  // Real delivery shapes. A wake reaches the classifier as one of three frames; a sentinel
  // sitting anywhere else in a prompt is prose an operator (or a compaction summary) wrote,
  // and must never be billed as a wake. The Monitor envelope below is a verbatim copy of the
  // live shape (heartbeat-monitor.sh / lib/routines/due.ts emit into it).
  const envelope = (event: string) =>
    `<task-notification>\n<task-id>b0u6x5fhf</task-id>\n<summary>Monitor event: "heartbeat-monitor"</summary>\n<event>${event}</event>\nIf this event is something the user would act on now, send a PushNotification.\n</task-notification>`;

  // classifySource: heartbeat marker — only as the delivered sentinel line
  test('cost-tracker: classifySource(bare HEARTBEAT_EVALUATE) = heartbeat', () => {
    expect(classifySource('HEARTBEAT_EVALUATE')).toBe('heartbeat');
  });
  test('cost-tracker: classifySource(Monitor envelope HEARTBEAT_EVALUATE) = heartbeat', () => {
    expect(classifySource(envelope('HEARTBEAT_EVALUATE'))).toBe('heartbeat');
  });
  test('cost-tracker: classifySource(HEARTBEAT_EVALUATE mid-prose) = other', () => {
    expect(classifySource('some prefix HEARTBEAT_EVALUATE rest')).toBe('other');
  });
  // The manual slash command arrives as a <command-message>/<command-args> frame, never as
  // this literal, so the old containment rule only ever matched operators discussing it.
  test('cost-tracker: classifySource(heartbeat run literal) = other', () => {
    expect(classifySource('/hermitd:heartbeat run')).toBe('other');
  });

  for (const id of ['sample', 'a.B_9-z', 'x'.repeat(100), '<id>', '*']) {
    for (const event of [`WATCH_EVENT [hermit-watch:${id}] (Watch) line`, `WATCH_MONITOR_ERROR: ${id} exit code 1`]) {
      test(`cost-tracker: classifySource watch sentinel ${event}`, () => {
        const expected = ['<id>', '*'].includes(id) ? 'other' : `watch:${id.slice(0, 64)}`;
        expect(classifySource(event)).toBe(expected);
        expect(classifySource(envelope(event))).toBe(expected);
        expect(classifySource(`why did ${event}`)).toBe('other');
      });
    }
  }

  test('cost-tracker: namespaced routine markers retain the full id', () => {
    for (const event of ['ROUTINE_DUE [hermit-routine:a:b]', '[hermit-routine:a:b] Run: /example']) {
      expect(classifySource(event)).toBe('routine:a:b');
      expect(classifySource(envelope(event))).toBe('routine:a:b');
    }
    expect(classifySource('ROUTINE_DUE [hermit-routine:a:b] [hermit-routine:a:c]')).toBe('routine:multi');
    expect(classifySource('ROUTINE_DUE [hermit-routine:a:b] [hermit-routine:a:b]')).toBe('routine:a:b');
  });

  // classifySource: routine marker — CronCreate delivers it as the prompt's first line
  test('cost-tracker: classifySource([hermit-routine:daily]) = routine:daily', () => {
    expect(classifySource('[hermit-routine:daily]')).toBe('routine:daily');
  });
  test('cost-tracker: classifySource(CronCreate prompt) = routine:<id>', () => {
    expect(classifySource('[hermit-routine:hermitd:heartbeat-restart]\nRun: bun /p/scripts/routines.ts arm anchor'))
      .toBe('routine:hermitd:heartbeat-restart');
  });
  test('cost-tracker: classifySource([hermit-routine:x] mid-prose) = other', () => {
    expect(classifySource('text [hermit-routine:cortex-refresh] more text')).toBe('other');
  });

  // classifySource: monitor co-fire → routine:multi (ROUTINE_DUE line naming ≥2 distinct ids)
  test('cost-tracker: classifySource(ROUTINE_DUE with 2 ids) = routine:multi', () => {
    expect(classifySource('ROUTINE_DUE [hermit-routine:weekly-review] [hermit-routine:doctor]')).toBe('routine:multi');
  });
  test('cost-tracker: classifySource(ROUTINE_DUE with 1 id) = routine:<id>', () => {
    expect(classifySource('ROUTINE_DUE [hermit-routine:reflect]')).toBe('routine:reflect');
  });
  test('cost-tracker: classifySource(envelope ROUTINE_DUE with 1 id) = routine:<id>', () => {
    expect(classifySource(envelope('ROUTINE_DUE [hermit-routine:reflect]'))).toBe('routine:reflect');
  });
  test('cost-tracker: classifySource(envelope ROUTINE_DUE with 2 ids) = routine:multi', () => {
    expect(classifySource(envelope('ROUTINE_DUE [hermit-routine:weekly-review] [hermit-routine:doctor]')))
      .toBe('routine:multi');
  });
  // Trailing prose after the ids is part of the delivered line and must not break the match.
  test('cost-tracker: classifySource(ROUTINE_DUE with trailing text) = routine:<id>', () => {
    expect(classifySource('ROUTINE_DUE [hermit-routine:daily-brief] fired')).toBe('routine:daily-brief');
  });
  // Anchoring guard: a heartbeat turn whose tool output surfaces multiple [hermit-routine:*]
  // markers (hermitd:heartbeat-restart's re-arm CronDelete output) is not a delivered sentinel line
  // at all — neither heartbeat nor routine:multi.
  test('cost-tracker: classifySource(heartbeat + stray routine markers, no ROUTINE_DUE) = other', () => {
    expect(classifySource('HEARTBEAT_EVALUATE — CronDelete [hermit-routine:reflect] [hermit-routine:doctor]')).toBe('other');
  });
  test('cost-tracker: classifySource(2 stray markers, no ROUTINE_DUE line) = other', () => {
    expect(classifySource('load done: CronDelete [hermit-routine:reflect] [hermit-routine:doctor]')).toBe('other');
  });

  // Negatives drawn from the live transcripts that motivated the anchoring: a long operator
  // prompt naming the sentinel deep in its text, a subagent completion whose <result> quotes
  // it (no <event> body), and the retired log-event prose fallback.
  test('cost-tracker: classifySource(long prompt naming sentinel mid-text) = other', () => {
    const long = `${'x'.repeat(1200)} HEARTBEAT_EVALUATE ${'y'.repeat(4000)}`;
    expect(classifySource(long)).toBe('other');
  });
  test('cost-tracker: classifySource(subagent completion quoting sentinel) = other', () => {
    const done = '<task-notification>\n<task-id>a8e283fde</task-id>\n<tool-use-id>toolu_01RH</tool-use-id>\n<status>completed</status>\n<result>ran HEARTBEAT_EVALUATE for [hermit-routine:reflect]</result>\n</task-notification>';
    expect(classifySource(done)).toBe('other');
  });
  test('cost-tracker: classifySource(log-routine-event prose) = other', () => {
    expect(classifySource('ran log-routine-event.sh has fired')).toBe('other');
  });
  test('cost-tracker: classifySource(routines.ts log-event prose) = other', () => {
    expect(classifySource('then routines.ts log-event which errored')).toBe('other');
  });

  // classifySource: no marker → other
  test('cost-tracker: classifySource(no marker) = other', () => {
    expect(classifySource('just a normal operator message')).toBe('other');
  });
  test('cost-tracker: classifySource(empty) = other', () => {
    expect(classifySource('')).toBe('other');
  });

  // classifySource: skill-template noise must NOT match (false-positive guard)
  // These strings appear as tool_result content when routines register
  test('cost-tracker: classifySource rejects [hermit-routine:*] (template glob)', () => {
    expect(classifySource('[hermit-routine:*]')).toBe('other');
  });
  test('cost-tracker: classifySource rejects [hermit-routine:<id>] (template placeholder)', () => {
    expect(classifySource('[hermit-routine:<id>]')).toBe('other');
  });

  // classifySource: unsanitized id with disallowed chars yields other (not a partial match)
  test('cost-tracker: classifySource rejects id with pipe/newline', () => {
    expect(classifySource('[hermit-routine:foo|bar]')).toBe('other');
  });

  // classifySource: id length-capped at 64 chars
  test('cost-tracker: classifySource caps id at 64 chars', () => {
    const r = classifySource(`[hermit-routine:${'a'.repeat(80)}]`);
    expect(r.startsWith('routine:')).toBe(true);
    expect(r.slice('routine:'.length).length).toBe(64);
  });

  // classifySource: channel marker — real on-wire shape is plugin-qualified
  // (e.g. `plugin:discord:discord`), not a bare channel name. Verified live
  // against production transcripts (2026-07-09 gtapps-node-1 probe).
  test('cost-tracker: classifySource(<channel source="plugin:discord:discord">) = channel:discord', () => {
    expect(classifySource('<channel source="plugin:discord:discord" chat_id="123">hi</channel>')).toBe('channel:discord');
  });
  test('cost-tracker: classifySource(<channel source="plugin:voice:voice">) = channel:voice', () => {
    expect(classifySource('<channel source="plugin:voice:voice" chat_id="456">hi</channel>')).toBe('channel:voice');
  });
  test('cost-tracker: classifySource(<channel source="telegram">) = channel:telegram (bare form)', () => {
    expect(classifySource('<channel source="telegram" chat_id="789">hi</channel>')).toBe('channel:telegram');
  });

  // classifySource: peer messages from another local Claude Code session.
  // The frames are the harness's own: a raw socket post renders as "Another
  // Claude session sent a message:", a named peer as "Message from @<name>".
  test('cost-tracker: classifySource(Another Claude session sent a message) = peer', () => {
    expect(classifySource('Another Claude session sent a message:\nfinished the migration')).toBe('peer');
  });
  test('cost-tracker: classifySource(Message from @name) = peer', () => {
    expect(classifySource('Message from @scout: build is green')).toBe('peer');
  });
  // The watchdog's own wedge wake arrives inside the SAME peer frame. It is a
  // heartbeat, and the earlier matcher must keep it — otherwise every socket
  // nudge is double-counted as peer traffic.
  test('cost-tracker: classifySource(peer frame carrying HEARTBEAT_EVALUATE) = heartbeat', () => {
    expect(classifySource('Another Claude session sent a message:\nHEARTBEAT_EVALUATE')).toBe('heartbeat');
  });
  // The live frame wraps the posted body in <cross-session-message …> and appends a
  // trailer, so the sentinel is never the whole remainder. Copied from a real transcript.
  test('cost-tracker: classifySource(live wedge-wake frame) = heartbeat', () => {
    const frame = 'Another Claude session sent a message:\n<cross-session-message from="uds:/run/user/1000/cc-socks/4112470.sock" from-name="watchdog" from-mode="prompting">\nHEARTBEAT_EVALUATE\n</cross-session-message>\n\nThis came from another Claude session.';
    expect(classifySource(frame)).toBe('heartbeat');
  });
  test('cost-tracker: classifySource(live peer frame with prose body) = peer', () => {
    const frame = 'Another Claude session sent a message:\n<cross-session-message from="uds:/run/user/1000/cc-socks/4112470.sock" from-name="scout" from-mode="prompting">\nGUEST_REPORT: ran the tests, all green.\n</cross-session-message>\n\nThis came from another Claude session.';
    expect(classifySource(frame)).toBe('peer');
  });
  test('cost-tracker: classifySource(peer frame carrying ROUTINE_DUE) = routine:<id>', () => {
    expect(classifySource('Another Claude session sent a message:\nROUTINE_DUE [hermit-routine:daily-brief]'))
      .toBe('routine:daily-brief');
  });
  // Channel and peer are frame-anchored too, for the same reason the sentinels are.
  // Both shapes below were counted in this machine's stored transcripts: 2 compaction
  // summaries quoting a channel envelope, and 5 subagent completions whose <result>
  // quoted a peer frame. Billing the latter 'peer' also suppresses the dispatch hop,
  // which only fires on 'other'.
  test('cost-tracker: classifySource(compaction summary quoting a channel envelope) = other', () => {
    const summary = 'This session is being continued from a previous conversation that ran out of context.\n\nSummary:\nThe operator replied over <channel source="plugin:discord:discord" chat_id="1">…</channel> and asked for a brief.';
    expect(classifySource(summary)).toBe('other');
  });
  test('cost-tracker: classifySource(subagent completion quoting a peer frame) = other', () => {
    const done = '<task-notification>\n<task-id>a1637f2a1</task-id>\n<status>completed</status>\n<result>Handled the note that arrived as "Another Claude session sent a message:" earlier today.</result>\n</task-notification>';
    expect(classifySource(done)).toBe('other');
  });
  test('cost-tracker: classifySource(prose naming a peer frame mid-text) = other', () => {
    expect(classifySource('Earlier a "Message from @scout" showed up; why was it billed as peer?')).toBe('other');
  });

  // classifySource: channel source charset guard — placeholder/glob noise → other
  test('cost-tracker: classifySource rejects <channel source="*">', () => {
    expect(classifySource('<channel source="*" chat_id="1">hi</channel>')).toBe('other');
  });
  test('cost-tracker: classifySource rejects <channel source="<id>">', () => {
    expect(classifySource('<channel source="<id>" chat_id="1">hi</channel>')).toBe('other');
  });

  // classifySource: channel kind length-capped at 64 chars, same as routine ids.
  // Cap applies to the normalized bare server name (the captured kind).
  test('cost-tracker: classifySource caps channel kind at 64 chars', () => {
    const r = classifySource(`<channel source="plugin:x:${'a'.repeat(80)}" chat_id="1">hi</channel>`);
    expect(r.startsWith('channel:')).toBe(true);
    expect(r.slice('channel:'.length).length).toBe(64);
  });

  // classifySource: a source that doesn't normalize to a clean bare server name
  // (trailing colon, or a malformed 3+-segment shape) → other, not a `channel:…`
  // garbage bucket — same fail-closed stance normalizeChannelSource takes.
  test('cost-tracker: classifySource rejects trailing-colon source (empty kind)', () => {
    expect(classifySource('<channel source="plugin:" chat_id="1">hi</channel>')).toBe('other');
  });
  test('cost-tracker: classifySource rejects unrecognized 3+-segment source', () => {
    expect(classifySource('<channel source="plugin:a:b:c" chat_id="1">hi</channel>')).toBe('other');
  });

  // resolveTurnSource: backward scan finds the routine marker past a tool_result
  // Simulates: user([hermit-routine:daily]) → assistant(tool_use) → user(tool_result) → assistant(usage)
  test('cost-tracker: resolveTurnSource finds routine past tool_result', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: '[hermit-routine:daily] Read runtime.json. Invoke /reflect.' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ tool_use_id: 't1', type: 'tool_result', content: 'ok' }] } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50 } } }),
    ];
    expect(resolveTurnSource(lines, 3).source).toBe('routine:daily');
  });

  // THE INCIDENT: a routine id appearing in this turn's own TOOL OUTPUT must not capture
  // the turn. hermitd:heartbeat-restart's re-arm lists crons, so its CronDelete/CronList output
  // names concrete routine ids — that is how $3-7 hermitd:heartbeat-restart turns were billed to
  // routine:doctor on the live fleet. Classification reads the delivered prompt only.
  test('cost-tracker: routine id in a tool_result does not capture the turn', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'What is the weather?' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ tool_use_id: 't1', type: 'tool_result', content: 'deleted cron [hermit-routine:doctor]' }] } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50 } } }),
    ];
    expect(resolveTurnSource(lines, 3).source).toBe('other');
  });

  // A routine prompt shadowed by a skill-body injection. CC writes those as isMeta user
  // entries with ARRAY content; real prompts (routine markers, channel envelopes) are
  // isMeta too but carry STRING content, so only the array-content ones are skipped.
  test('cost-tracker: resolveTurnSource sees past a skill-body injection to the routine prompt', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: '[hermit-routine:weekly-review] Invoke /weekly-review.' } }),
      JSON.stringify({ type: 'user', isMeta: true, message: { content: [{ type: 'text', text: 'Base directory for this skill: /plugins/hermitd/skills/weekly-review' }] } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50 } } }),
    ];
    expect(resolveTurnSource(lines, 2).source).toBe('routine:weekly-review');
  });

  // An isMeta entry with STRING content IS a real delivered prompt — the live shape of a
  // routine wake. Skipping it (as a bare `isMeta !== true` guard would) loses the
  // attribution entirely.
  test('cost-tracker: an isMeta string-content routine prompt still classifies', () => {
    const lines = [
      JSON.stringify({ type: 'user', isMeta: true, message: { content: '[hermit-routine:morning] First run: log-routine-event.sh morning started' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50 } } }),
    ];
    expect(resolveTurnSource(lines, 1).source).toBe('routine:morning');
  });

  // Dispatch hop: a subagent-completion notification carries no marker of its own, but the
  // ingestion turn is cost caused by whatever dispatched the agent — resolve it through the
  // tool-use/task id back to the dispatching turn's prompt.
  test('cost-tracker: subagent-completion turn inherits the dispatching routine', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: '[hermit-routine:daily-review] Invoke /weekly-review.' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_abc', name: 'Agent', input: {} }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ tool_use_id: 'toolu_abc', type: 'tool_result', content: 'dispatched' }] } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 5 } } }),
      JSON.stringify({ type: 'user', message: { content: '<task-notification> <task-id>a22f60f</task-id> <tool-use-id>toolu_abc</tool-use-id> <status>completed</status> <summary>Agent "daily-review routine" came to rest</summary> </task-notification>' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50 } } }),
    ];
    const resolved = resolveTurnSource(lines, 5);
    expect(resolved.source).toBe('routine:daily-review');
    // Flagged as borrowed from the dispatch, not this turn's own prompt — the cost row
    // carries source_inherited so $/run doesn't count this second turn as a second fire.
    expect(resolved.inherited).toBe(true);
  });

  // One agent can notify more than once, so the id appears on several earlier lines. The hop
  // must land on the DISPATCH, not on the nearest line that merely contains the id — an earlier
  // notification is itself a real user entry, so turnPromptText stops there and yields 'other'.
  test('cost-tracker: a repeat completion notification does not shadow the dispatch', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: '[hermit-routine:daily-review] Invoke /weekly-review.' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_abc', name: 'Agent', input: {} }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ tool_use_id: 'toolu_abc', type: 'tool_result', content: 'dispatched' }] } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 5 } } }),
      JSON.stringify({ type: 'user', message: { content: '<task-notification> <task-id>a22f60f</task-id> <tool-use-id>toolu_abc</tool-use-id> <status>completed</status> </task-notification>' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 40, output_tokens: 20 } } }),
      JSON.stringify({ type: 'user', message: { content: '<task-notification> <task-id>a22f60f</task-id> <tool-use-id>toolu_abc</tool-use-id> <status>completed</status> </task-notification>' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50 } } }),
    ];
    const resolved = resolveTurnSource(lines, 7);
    expect(resolved.source).toBe('routine:daily-review');
    expect(resolved.inherited).toBe(true);
  });

  // The hop must not invent attribution: an operator-dispatched agent's completion stays 'other'.
  test('cost-tracker: completion of an operator-dispatched agent stays other', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'Please research this for me.' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_xyz', name: 'Agent', input: {} }] } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 5 } } }),
      JSON.stringify({ type: 'user', message: { content: '<task-notification> <task-id>b99</task-id> <tool-use-id>toolu_xyz</tool-use-id> <status>completed</status> </task-notification>' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50 } } }),
    ];
    const resolved = resolveTurnSource(lines, 4);
    expect(resolved.source).toBe('other');
    expect(resolved.inherited).toBe(true); // hop fired, but it resolved to a real 'other' prompt
  });

  // Turn-boundary isolation: a routine from a PREVIOUS turn can't bleed into this one.
  test('cost-tracker: resolveTurnSource respects turn boundary', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: '[hermit-routine:old-routine] prior turn' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 50, output_tokens: 20 } } }),
      JSON.stringify({ type: 'user', message: { content: 'operator message with no marker' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50 } } }),
    ];
    expect(resolveTurnSource(lines, 3).source).not.toBe('routine:old-routine');
  });

  // Reaches the prompt past an intermediate tool-calling assistant that ITSELF carries
  // usage — the realistic transcript shape (every API round-trip is billed).
  test('cost-tracker: resolveTurnSource passes intermediate billed assistant', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: '[hermit-routine:reflect] Invoke /reflect.' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 80, output_tokens: 30 }, content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: {} }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ tool_use_id: 't1', type: 'tool_result', content: 'ok' }] } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: 'text', text: 'done' }] } }),
    ];
    const { source, boundaryFound } = resolveTurnSource(lines, 3);
    expect(source).toBe('routine:reflect');
    expect(boundaryFound).toBe(true);
  });

  // Integration: an inbound-channel turn (envelope as the triggering prompt, matching the
  // verbatim shape confirmed live on production transcripts) classifies as channel:discord.
  test('cost-tracker: channel-triggered turn classifies as channel:discord end-to-end', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: '<channel source="plugin:discord:discord" chat_id="123" message_id="456" user="op" ts="2026-07-09T10:00:00Z">hi</channel>' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ tool_use_id: 't1', type: 'tool_result', content: 'ok' }] } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50 } } }),
    ];
    expect(resolveTurnSource(lines, 3).source).toBe('channel:discord');
  });

  // boundaryFound: false when the scan runs off the start of `lines` without hitting the
  // triggering user prompt — simulates a truncated tail window whose turn boundary lies
  // outside the buffer. This is the signal readLastTurnUsage() uses to force 'other'.
  test('cost-tracker: resolveTurnSource boundaryFound is false when the prompt is missing from lines', () => {
    const lines = [
      // No triggering user entry at all — everything here is tool-calling/billed assistant
      // steps, as if the window were truncated before the real turn start.
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 80, output_tokens: 30 }, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ tool_use_id: 't1', type: 'tool_result', content: 'ok' }] } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50 } } }),
    ];
    expect(resolveTurnSource(lines, 2).boundaryFound).toBe(false);
  });

  test('cost-tracker: resolveTurnSource boundaryFound is true when the triggering prompt is present', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: '[hermit-routine:daily] fire' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50 } } }),
    ];
    expect(resolveTurnSource(lines, 1).boundaryFound).toBe(true);
  });
});

// -------------------------------------------------------
// cost-tracker: scanTurnInTail window contract (in-process)
// -------------------------------------------------------

// `boundaryMissed` is what asks readLastTurnUsage for the wider re-read, so it needs a
// window narrow enough to miss the boundary AND one wide enough to find it. Pinned at a
// small tailBytes rather than end-to-end: any fixture small enough to write in a test is
// under the 8MB retry cap, so the e2e path only ever exercises the found-it side.
describe('cost-tracker scanTurnInTail', () => {
  // Same query-string module instance rationale as the resolveTurnSource block above.
  let scanTurnInTail: typeof import('../scripts/cost-tracker').scanTurnInTail;
  let transcript: string;
  let dir: string;

  beforeAll(async () => {
    const mod = (await import(
      '../scripts/cost-tracker' + '?scripts-test-scanTurnInTail'
    )) as typeof import('../scripts/cost-tracker');
    ({ scanTurnInTail } = mod);

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-scan-turn-'));
    transcript = path.join(dir, 'transcript.jsonl');
    // One turn: a routine wake, then enough filler to push that wake outside a 4KB
    // window while still fitting comfortably inside a 1MB one.
    const filler = 'x'.repeat(500);
    const lines = [JSON.stringify({ type: 'user', message: { content: '[hermit-routine:demo] fire' } })];
    for (let i = 0; i < 40; i++) {
      lines.push(assistantEntryFull({ inputTokens: 10, outputTokens: 5 }));
      lines.push(JSON.stringify({ type: 'user', message: { content: [{ tool_use_id: `t${i}`, type: 'tool_result', content: filler }] } }));
    }
    lines.push(assistantEntryFull({ inputTokens: 100, outputTokens: 50 }));
    fs.writeFileSync(transcript, lines.join('\n') + '\n');
  });

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('cost-tracker: a window missing the turn boundary downgrades to other and flags the miss', () => {
    const turn = scanTurnInTail(transcript, 4096);
    expect(turn.source).toBe('other');
    expect(turn.boundaryMissed).toBe(true);
  });

  test('cost-tracker: a window reaching the turn boundary keeps the resolved source', () => {
    const turn = scanTurnInTail(transcript, 1024 * 1024);
    expect(turn.source).toBe('routine:demo');
    expect(turn.boundaryMissed).toBe(false);
  });
});

// -------------------------------------------------------
// cost-tracker: sumTurnUsage unit tests (in-process)
// -------------------------------------------------------

describe('cost-tracker sumTurnUsage', () => {
  let sumTurnUsage: typeof import('../scripts/cost-tracker').sumTurnUsage;

  beforeAll(async () => {
    const mod = (await import(
      '../scripts/cost-tracker' + '?scripts-test-sumTurnUsage'
    )) as typeof import('../scripts/cost-tracker');
    ({ sumTurnUsage } = mod);
  });

  test('cost-tracker: sumTurnUsage exported', () => {
    expect(typeof sumTurnUsage).toBe('function');
  });

  // Single-call turn — baseline: result equals what the old code returned
  test('cost-tracker: sumTurnUsage single billed entry', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'hello' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, model: 'claude-sonnet-4-6' } }),
    ];
    const r = sumTurnUsage(lines, 1);
    expect(r.inputTokens).toBe(100);
    expect(r.outputTokens).toBe(50);
    expect(r.apiCalls).toBe(1);
    expect(r.model).toBe('claude-sonnet-4-6');
  });

  // Three-call turn — distinct requestIds bill three times
  test('cost-tracker: sumTurnUsage sums three billed entries in one turn', () => {
    const lines = [
      // Prior turn (must NOT be included)
      JSON.stringify({ type: 'user', message: { content: 'prior turn prompt' } }),
      JSON.stringify({ type: 'assistant', requestId: 'req_prior', message: { usage: { input_tokens: 999, output_tokens: 999 } } }),
      // Current turn
      JSON.stringify({ type: 'user', message: { content: '[hermit-routine:reflect] go' } }),
      JSON.stringify({ type: 'assistant', requestId: 'req_1', message: { usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ tool_use_id: 't1', type: 'tool_result', content: 'ok' }] } }),
      JSON.stringify({ type: 'assistant', requestId: 'req_2', message: { usage: { input_tokens: 200, output_tokens: 20 }, content: [{ type: 'tool_use', id: 't2', name: 'Write', input: {} }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ tool_use_id: 't2', type: 'tool_result', content: 'written' }] } }),
      JSON.stringify({ type: 'assistant', requestId: 'req_3', message: { usage: { input_tokens: 300, output_tokens: 30, cache_read_input_tokens: 150 }, model: 'claude-sonnet-4-6' } }),
    ];
    const billedIndex = lines.length - 1; // last assistant entry
    const r = sumTurnUsage(lines, billedIndex);
    expect(r.apiCalls).toBe(3);
    expect(r.inputTokens).toBe(100 + 200 + 300);
    expect(r.outputTokens).toBe(10 + 20 + 30);
    expect(r.cacheReadTokens).toBe(150);
    // Prior turn's 999 tokens must not bleed in
    expect(r.inputTokens).not.toBeGreaterThanOrEqual(999);
  });

  // Id-less entries have no request key, so they still sum as one bill each.
  test('cost-tracker: sumTurnUsage sums three id-less billed entries in one turn', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'go' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 100, output_tokens: 10 } } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 200, output_tokens: 20 } } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 300, output_tokens: 30 } } }),
    ];
    const r = sumTurnUsage(lines, 3);
    expect(r.apiCalls).toBe(3);
    expect(r.inputTokens).toBe(600);
    expect(r.outputTokens).toBe(60);
  });

  test('cost-tracker: sumTurnUsage folds three streamed entries of one requestId', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'go' } }),
      JSON.stringify({ type: 'assistant', requestId: 'req_same', message: { usage: { input_tokens: 100, output_tokens: 10 } } }),
      JSON.stringify({ type: 'assistant', requestId: 'req_same', message: { usage: { input_tokens: 100, output_tokens: 20 } } }),
      JSON.stringify({ type: 'assistant', requestId: 'req_same', message: { usage: { input_tokens: 100, output_tokens: 30 } } }),
    ];
    const r = sumTurnUsage(lines, 3);
    expect(r.apiCalls).toBe(1);
    expect(r.inputTokens).toBe(100);
    expect(r.outputTokens).toBe(30);
  });

  // Boundary respected: prior turn's billed entries are excluded
  test('cost-tracker: sumTurnUsage stops at turn boundary (prior-turn tokens excluded)', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'turn 1 prompt' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 500, output_tokens: 500 } } }),
      JSON.stringify({ type: 'user', message: { content: 'turn 2 prompt' } }),
      JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10, output_tokens: 5 } } }),
    ];
    const r = sumTurnUsage(lines, 3);
    expect(r.apiCalls).toBe(1);
    expect(r.inputTokens).toBe(10);
  });
});
