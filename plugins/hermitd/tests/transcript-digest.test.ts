// Tests for scripts/transcript-digest.ts — behavioral counters over recent CC
// session transcripts.
//
// Two styles (same split as cost-tracker.test.ts): subprocess contract tests run
// the whole script via runScript with --dir pointing at a synthetic projects dir;
// pure-logic tests import digestLines/readTailWindow/etc. directly (the script has
// no load-time side effects, so direct import is safe and deterministic).
//
// Fixture entry shapes mirror real CC transcripts (verified live, CC 2.1.214):
//   - turn boundary: user entry, string content, not a tool_result and not a skill
//     injection. Monitor HEARTBEAT_EVALUATE arrives without isMeta; CronCreate
//     "[hermit-routine:<id>]", channel envelopes, and peer posts arrive isMeta:true.
//     digestLines opens a turn on cc-compat's isTurnBoundary — the same predicate
//     turnPromptText walks back to (user && !isToolResult && !isSkillInjection) — then
//     classifySource decides whether that turn is a wake. CronCreate is a wake;
//     channel and peer are not.
//   - skill injection: isMeta:true with ARRAY content (592/600 live samples); the bare
//     string-content form is pre-2.1.202 and no longer emitted.
//   - rejection carrier: user tool_result with is_error:true + top-level toolDenialKind
//   - compact_boundary: {type:'system', subtype:'compact_boundary'}

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript } from './helpers/run';
import {
  parseArgs,
  pickTranscripts,
  readTailWindow,
  digestLines,
  isProductiveTool,
  isWakeSource,
} from '../scripts/transcript-digest';
import { transcriptDirFor } from '../scripts/lib/cc-compat';

const DAY_MS = 86_400_000;
const T0 = Date.now();
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();
const RECENT = () => iso(-3600_000); // 1h ago — safely inside a 7-day window

// ---------------------------------------------------------------------------
// Synthetic transcript builders
// ---------------------------------------------------------------------------

function triggerEntry(text: string, opts: { isMeta?: boolean; ts?: string } = {}): string {
  const e: any = { type: 'user', message: { role: 'user', content: text }, timestamp: opts.ts ?? RECENT() };
  if (opts.isMeta) e.isMeta = true;
  return JSON.stringify(e);
}

// A skill injection as CC actually writes it: isMeta:true with array content. That array
// shape is what isSkillInjection keys on (cc-compat.ts:496-499), so a string-content
// fixture is only excluded by the coarser isMeta guard and proves nothing about it.
function injectionEntry(text: string, ts?: string): string {
  return JSON.stringify({
    type: 'user',
    isMeta: true,
    message: { role: 'user', content: [{ type: 'text', text }] },
    timestamp: ts ?? RECENT(),
  });
}

function assistantToolUse(id: string, name: string, ts?: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] },
    timestamp: ts ?? RECENT(),
  });
}

function toolResultEntry(
  id: string,
  opts: { isError?: boolean; text?: string; denialKind?: string; ts?: string } = {},
): string {
  const block: any = { type: 'tool_result', tool_use_id: id, content: opts.text ?? 'ok' };
  if (opts.isError) block.is_error = true;
  const e: any = { type: 'user', message: { role: 'user', content: [block] }, timestamp: opts.ts ?? RECENT() };
  if (opts.denialKind) e.toolDenialKind = opts.denialKind;
  return JSON.stringify(e);
}

function compactEntry(ts?: string): string {
  return JSON.stringify({
    type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted',
    compactMetadata: { trigger: 'auto' }, timestamp: ts ?? RECENT(),
  });
}

// ---------------------------------------------------------------------------
// Filesystem layout
// ---------------------------------------------------------------------------

const tmpRoots: string[] = [];

function buildProjects(): { root: string; projDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-transcript-digest-'));
  tmpRoots.push(root);
  const projDir = path.join(root, 'projects', '-fake-proj');
  fs.mkdirSync(projDir, { recursive: true });
  return { root, projDir };
}

function writeTranscript(projDir: string, name: string, entries: string[], mtimeMs: number = T0 - 3600_000): string {
  const p = path.join(projDir, name);
  fs.writeFileSync(p, entries.join('\n') + '\n');
  const t = mtimeMs / 1000;
  fs.utimesSync(p, t, t);
  return p;
}

async function runDigest(
  projDir: string,
  extra: string[] = [],
): Promise<{ exitCode: number; json: any | null; stdout: string }> {
  const res = await runScript('transcript-digest.ts', { args: ['.hermit', '--dir', projDir, ...extra] });
  let json: any = null;
  try { json = JSON.parse(res.stdout.trim()); } catch { /* left null for bad-args cases */ }
  return { exitCode: res.exitCode, json, stdout: res.stdout };
}

afterAll(() => {
  for (const r of tmpRoots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch {} }
});

// ---------------------------------------------------------------------------
// Subprocess contract tests
// ---------------------------------------------------------------------------

describe('transcript-digest (subprocess)', () => {
  test('exact counts across two sessions', async () => {
    const { projDir } = buildProjects();
    // s1: productive heartbeat wake (Write) + a failing Bash + a compaction + an Agent dispatch
    writeTranscript(projDir, 's1.jsonl', [
      triggerEntry('HEARTBEAT_EVALUATE'),
      assistantToolUse('u1', 'Write'),
      assistantToolUse('u2', 'Bash'),
      toolResultEntry('u2', { isError: true, text: 'boom' }),
      assistantToolUse('u3', 'Agent'),
      compactEntry(),
    ], T0 - 2 * 3600_000);
    // s2: routine wake, only Bash (not productive), successful result
    writeTranscript(projDir, 's2.jsonl', [
      triggerEntry('ROUTINE_DUE [hermit-routine:daily-brief] fired'),
      assistantToolUse('u4', 'Bash'),
      toolResultEntry('u4', {}),
    ], T0 - 1 * 3600_000);

    const { exitCode, json } = await runDigest(projDir);
    expect(exitCode).toBe(0);
    expect(json.window.files).toBe(2);
    expect(json.partial).toBe(false);
    expect(json.counters).toEqual({
      tool_failures: { Bash: 1 },
      tool_rejections: {},
      wakes: 2,
      productive_wakes: 1,
      compaction_events: 1,
      subagent_dispatches: 1,
    });
    expect(json.window.from).not.toBeNull();
    expect(json.window.to).not.toBeNull();
  });

  test('--sessions caps to newest by mtime; old-mtime files excluded by --days', async () => {
    const { projDir } = buildProjects();
    writeTranscript(projDir, 'older.jsonl', [triggerEntry('HEARTBEAT_EVALUATE'), assistantToolUse('a1', 'Agent')], T0 - 2 * 3600_000);
    writeTranscript(projDir, 'newer.jsonl', [triggerEntry('HEARTBEAT_EVALUATE')], T0 - 1 * 3600_000);
    // stale file well outside any reasonable --days window
    writeTranscript(projDir, 'stale.jsonl', [triggerEntry('HEARTBEAT_EVALUATE'), assistantToolUse('s1', 'Agent')], T0 - 40 * DAY_MS);

    const capped = await runDigest(projDir, ['--sessions', '1']);
    expect(capped.json.window.files).toBe(1);       // only newest
    expect(capped.json.counters.subagent_dispatches).toBe(0); // older.jsonl's Agent not read

    const windowed = await runDigest(projDir); // default 7 days
    expect(windowed.json.window.files).toBe(2);      // older + newer, stale excluded
    expect(windowed.json.counters.subagent_dispatches).toBe(1); // only older.jsonl's Agent
  });

  test('subagent/memory subdirs and non-jsonl sidecars are ignored', async () => {
    const { projDir } = buildProjects();
    writeTranscript(projDir, 'main.jsonl', [triggerEntry('HEARTBEAT_EVALUATE'), assistantToolUse('m1', 'Agent')]);
    const baseline = await runDigest(projDir);

    // Add decoys that must not be scanned
    const subagents = path.join(projDir, 'deadbeef-0000-0000-0000-000000000000', 'subagents');
    fs.mkdirSync(subagents, { recursive: true });
    fs.writeFileSync(path.join(subagents, 'agent-x.jsonl'),
      [triggerEntry('HEARTBEAT_EVALUATE'), assistantToolUse('x1', 'Agent')].join('\n') + '\n');
    fs.mkdirSync(path.join(projDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(projDir, 'memory', 'MEMORY.md'), '# notes\n');
    fs.writeFileSync(path.join(projDir, 'notes.txt'), 'not a transcript\n');

    const withDecoys = await runDigest(projDir);
    expect(withDecoys.json.window.files).toBe(1);
    expect(withDecoys.json.counters).toEqual(baseline.json.counters);
  });

  test('malformed lines set partial:true without losing other counters', async () => {
    const { projDir } = buildProjects();
    writeTranscript(projDir, 's.jsonl', [
      triggerEntry('HEARTBEAT_EVALUATE'),
      '{not valid json',
      assistantToolUse('u1', 'Write'),
      'also }{ garbage',
    ]);
    const { json } = await runDigest(projDir);
    expect(json.partial).toBe(true);
    expect(json.counters.wakes).toBe(1);
    expect(json.counters.productive_wakes).toBe(1);
  });

  test('unreadable transcript is skipped, others still counted', async () => {
    const { projDir } = buildProjects();
    writeTranscript(projDir, 'ok.jsonl', [triggerEntry('HEARTBEAT_EVALUATE'), assistantToolUse('u1', 'Agent')]);
    const bad = writeTranscript(projDir, 'bad.jsonl', [triggerEntry('HEARTBEAT_EVALUATE')]);
    fs.chmodSync(bad, 0o000);
    try {
      const { json } = await runDigest(projDir);
      expect(json.window.skipped).toBe(1);
      expect(json.window.files).toBe(1);
      expect(json.counters.subagent_dispatches).toBe(1);
    } finally {
      fs.chmodSync(bad, 0o600);
    }
  });

  test('empty dir and nonexistent --dir both yield clean zeros, exit 0', async () => {
    const { projDir } = buildProjects();
    const empty = await runDigest(projDir);
    expect(empty.exitCode).toBe(0);
    expect(empty.json.window.files).toBe(0);
    expect(empty.json.window.from).toBeNull();
    expect(empty.json.window.to).toBeNull();
    expect(empty.json.counters.wakes).toBe(0);

    const missing = await runDigest(path.join(projDir, 'does-not-exist'));
    expect(missing.exitCode).toBe(0);
    expect(missing.json.window.files).toBe(0);
  });

  test('bad arguments exit non-zero', async () => {
    const { projDir } = buildProjects();
    for (const extra of [['--sessions', 'abc'], ['--days', '0'], ['--bogus'], ['extra-positional']]) {
      const res = await runDigest(projDir, extra);
      expect(res.exitCode).not.toBe(0);
    }
  });

  // Exercises the production path: no --dir, so the script must derive the
  // transcript dir from the hermit root (resolveHermitRoot) rather than a
  // cwd-relative path.resolve. AGENT_DIR anchors the hermit root and HOME
  // anchors os.homedir(), so transcriptDirFor lands on the seeded dir.
  // CLAUDE_CONFIG_DIR is blanked deliberately: runScript merges process.env, so a
  // maintainer running the suite with their own config dir set would otherwise send
  // the script somewhere the fixture never seeded.
  test('derives the transcript dir from the hermit root when --dir is omitted', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-td-home-'));
    tmpRoots.push(home);
    const projRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-td-proj-'));
    tmpRoots.push(projRoot);
    const hermitRoot = path.join(projRoot, '.hermit');
    const derivedDir = transcriptDirFor(projRoot, path.join(home, '.claude'));
    fs.mkdirSync(derivedDir, { recursive: true });
    fs.writeFileSync(path.join(derivedDir, 's.jsonl'),
      [triggerEntry('HEARTBEAT_EVALUATE'), assistantToolUse('u1', 'Agent')].join('\n') + '\n');

    const res = await runScript('transcript-digest.ts', {
      args: ['.hermit'],
      env: { HOME: home, CLAUDE_CONFIG_DIR: '', AGENT_DIR: hermitRoot },
    });
    const json = JSON.parse(res.stdout.trim());
    expect(res.exitCode).toBe(0);
    expect(json.window.files).toBe(1);
    expect(json.counters.subagent_dispatches).toBe(1);
  });

  // The regression the ~/.claude hardcode caused: a hermit with a custom config dir
  // had its transcripts read from a directory that does not exist, so cost tracking
  // silently reported an empty window. HOME points at a decoy holding a DIFFERENT
  // transcript — if the resolver falls back to it the counters give it away.
  test('reads transcripts from CLAUDE_CONFIG_DIR, not ~/.claude', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-td-home-'));
    tmpRoots.push(home);
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-td-cfg-'));
    tmpRoots.push(configDir);
    const projRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-td-proj-'));
    tmpRoots.push(projRoot);
    const hermitRoot = path.join(projRoot, '.hermit');

    const decoyDir = transcriptDirFor(projRoot, path.join(home, '.claude'));
    fs.mkdirSync(decoyDir, { recursive: true });
    fs.writeFileSync(path.join(decoyDir, 'decoy.jsonl'),
      [triggerEntry('HEARTBEAT_EVALUATE')].join('\n') + '\n');

    const realDir = transcriptDirFor(projRoot, configDir);
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 's.jsonl'),
      [triggerEntry('HEARTBEAT_EVALUATE'), assistantToolUse('u1', 'Agent')].join('\n') + '\n');

    const res = await runScript('transcript-digest.ts', {
      args: ['.hermit'],
      env: { HOME: home, CLAUDE_CONFIG_DIR: configDir, AGENT_DIR: hermitRoot },
    });
    const json = JSON.parse(res.stdout.trim());
    expect(res.exitCode).toBe(0);
    expect(json.window.files).toBe(1);
    expect(json.counters.subagent_dispatches).toBe(1); // the decoy has none
  });
});

// ---------------------------------------------------------------------------
// Pure-logic unit tests
// ---------------------------------------------------------------------------

// Everything timestamped inside the window; cutoff far in the past.
const OPEN = 0;

function wakesOf(lines: string[]): number {
  return digestLines(lines, OPEN).wakes;
}

describe('digestLines — wake classification (trigger entry only)', () => {
  test('Monitor task-notification HEARTBEAT_EVALUATE is a wake', () => {
    expect(wakesOf([triggerEntry('<task-notification>\n<event>HEARTBEAT_EVALUATE</event>\n</task-notification>')])).toBe(1);
  });
  // A manually typed slash command is operator activity, not a scheduler wake —
  // isWakeSource is defined as "a non-operator scheduler prompt". It also never had the
  // shape this fixture used: live transcripts carry `<command-name>/hermitd:heartbeat`
  // with the subcommand in a separate `<command-args>`, so the old containment rule matched
  // this synthetic string and nothing real.
  test('command-wrapped manual heartbeat run is NOT a wake', () => {
    expect(wakesOf([triggerEntry('<command-message>hermitd:heartbeat</command-message>\n<command-name>/hermitd:heartbeat</command-name>\n<command-args>run</command-args>')])).toBe(0);
  });
  // Live CronCreate routine prompts are isMeta:true. The boundary predicate still
  // opens a turn; classifySource then counts it as a wake.
  test('CronCreate routine prompt is a wake (#939)', () => {
    expect(wakesOf([triggerEntry('[hermit-routine:hermitd:heartbeat-restart]\nRun: bun /p/scripts/routines.ts arm anchor', { isMeta: true })])).toBe(1);
  });
  test('ROUTINE_DUE marker is a wake', () => {
    expect(wakesOf([triggerEntry('ROUTINE_DUE [hermit-routine:daily-brief] due now')])).toBe(1);
  });
  // isMeta:true live. The envelope now opens a turn; classifySource still does not
  // count it as a wake.
  test('inbound channel prompt is NOT a wake', () => {
    expect(wakesOf([triggerEntry('<channel source="plugin:discord:discord" user="u">hi</channel>', { isMeta: true })])).toBe(0);
  });
  test('inbound peer prompt is NOT a wake', () => {
    expect(wakesOf([triggerEntry('Another Claude session sent a message:\n<cross-session-message from="x">hi</cross-session-message>', { isMeta: true })])).toBe(0);
  });
  test('plain operator prompt is NOT a wake', () => {
    expect(wakesOf([triggerEntry('please refactor the parser')])).toBe(0);
  });
  test('a marker echoed in tool output does not make a plain turn a wake', () => {
    expect(wakesOf([
      triggerEntry('grep the logs'),
      assistantToolUse('u1', 'Bash'),
      toolResultEntry('u1', { text: 'match: HEARTBEAT_EVALUATE seen in file' }),
    ])).toBe(0);
  });
  test('isMeta skill-injection before the Write does not split the wake turn', () => {
    const d = digestLines([
      triggerEntry('HEARTBEAT_EVALUATE'),
      injectionEntry('Base directory for this skill: /x'),
      assistantToolUse('u1', 'Write'),
    ], OPEN);
    expect(d.wakes).toBe(1);
    expect(d.productiveWakes).toBe(1);
  });
  test('channel envelope after a heartbeat does not credit the Write to the wake', () => {
    const d = digestLines([
      triggerEntry('HEARTBEAT_EVALUATE'),
      triggerEntry('<channel source="plugin:discord:discord" user="u">hi</channel>', { isMeta: true }),
      assistantToolUse('u1', 'Write'),
    ], OPEN);
    expect(d.wakes).toBe(1);
    expect(d.productiveWakes).toBe(0);
  });
});

describe('digestLines — rejection vs failure', () => {
  test('toolDenialKind user-rejected counts as rejection, not failure', () => {
    const d = digestLines([
      assistantToolUse('r1', 'Bash'),
      toolResultEntry('r1', { isError: true, denialKind: 'user-rejected', text: 'rejected' }),
    ], OPEN);
    expect(d.rejections).toEqual({ 'user-rejected': 1 });
    expect(d.failures).toEqual({});
  });
  test('legacy phrase "doesn\'t want to proceed" maps to user-rejected', () => {
    const d = digestLines([
      toolResultEntry('r2', { isError: true, text: "The user doesn't want to proceed with this tool use." }),
    ], OPEN);
    expect(d.rejections).toEqual({ 'user-rejected': 1 });
    expect(d.failures).toEqual({});
  });
  test('automode-blocked (field) is a rejection, not a Bash failure', () => {
    const d = digestLines([
      assistantToolUse('r3', 'Bash'),
      toolResultEntry('r3', { isError: true, denialKind: 'automode-blocked', text: 'denied' }),
    ], OPEN);
    expect(d.rejections).toEqual({ 'automode-blocked': 1 });
    expect(d.failures).toEqual({});
  });
  test('legacy phrase "Permission for this action was denied" maps to automode-blocked', () => {
    const d = digestLines([
      toolResultEntry('r3b', { isError: true, text: 'Permission for this action was denied by the auto-mode classifier.' }),
    ], OPEN);
    expect(d.rejections).toEqual({ 'automode-blocked': 1 });
  });
  test('genuine tool error keyed by tool name', () => {
    const d = digestLines([
      assistantToolUse('r4', 'Bash'),
      toolResultEntry('r4', { isError: true, text: 'bash: foo: command not found' }),
    ], OPEN);
    expect(d.failures).toEqual({ Bash: 1 });
    expect(d.rejections).toEqual({});
  });
  test('error with unmapped tool_use_id keyed as unknown', () => {
    const d = digestLines([toolResultEntry('never-seen', { isError: true, text: 'orphan error' })], OPEN);
    expect(d.failures).toEqual({ unknown: 1 });
  });
  test('a rejection and a genuine failure in one parallel batch both count', () => {
    // One carrier entry holds two is_error tool_results: one legacy-phrase
    // rejection, one real Bash error. The rejection must not swallow the failure.
    const d = digestLines([
      assistantToolUse('m1', 'Read'),
      assistantToolUse('m2', 'Bash'),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'm1', is_error: true, content: "The user doesn't want to proceed with this tool use." },
          { type: 'tool_result', tool_use_id: 'm2', is_error: true, content: 'bash: foo: command not found' },
        ] },
        timestamp: RECENT(),
      }),
    ], OPEN);
    expect(d.rejections).toEqual({ 'user-rejected': 1 });
    expect(d.failures).toEqual({ Bash: 1 });
  });
  test('a successful tool_result that merely quotes a denial phrase is not a rejection', () => {
    // is_error is absent, so the drift-prone phrase-sniff must not fire — the
    // hermit greps its own transcripts/source, where these phrases appear.
    const d = digestLines([
      assistantToolUse('q1', 'Bash'),
      toolResultEntry('q1', { text: 'grep hit: Permission for this action was denied' }),
    ], OPEN);
    expect(d.rejections).toEqual({});
    expect(d.failures).toEqual({});
  });
});

describe('digestLines — orphan prefix and entry-level cutoff', () => {
  test('window opening mid-turn: prefix failures count, prefix creates no wake', () => {
    const d = digestLines([
      assistantToolUse('o1', 'Bash'),                                   // orphan prefix
      toolResultEntry('o1', { isError: true, text: 'HEARTBEAT_EVALUATE echoed here' }),
      triggerEntry('HEARTBEAT_EVALUATE'),                               // first real trigger
      assistantToolUse('o2', 'Write'),
    ], OPEN);
    expect(d.wakes).toBe(1);
    expect(d.productiveWakes).toBe(1);
    expect(d.failures).toEqual({ Bash: 1 });
  });

  test('entries older than the D-day cutoff are excluded, from never predates cutoff', () => {
    const cutoffMs = T0 - 7 * DAY_MS;
    const d = digestLines([
      triggerEntry('HEARTBEAT_EVALUATE', { ts: iso(-40 * DAY_MS) }),   // out of window
      assistantToolUse('x1', 'Write', iso(-40 * DAY_MS)),
      triggerEntry('HEARTBEAT_EVALUATE', { ts: iso(-3600_000) }),      // in window
      assistantToolUse('x2', 'Bash', iso(-3600_000)),
    ], cutoffMs);
    expect(d.wakes).toBe(1);            // only the recent wake
    expect(d.productiveWakes).toBe(0);  // recent turn had only Bash
    expect(Date.parse(d.from as string)).toBeGreaterThanOrEqual(cutoffMs);
  });
});

describe('readTailWindow', () => {
  test('tiny tail drops the partial first line and reports truncated', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-tailwin-'));
    tmpRoots.push(root);
    const f = path.join(root, 't.jsonl');
    const lines = Array.from({ length: 6 }, (_, i) => `{"line":${i},"pad":"xxxxxxxxxxxxxxxxxxxx"}`);
    fs.writeFileSync(f, lines.join('\n') + '\n');

    const full = readTailWindow(f);
    expect(full).not.toBeNull();
    expect(full!.truncated).toBe(false);
    expect(full!.lines.filter(Boolean).length).toBe(6);

    const tiny = readTailWindow(f, 100);
    expect(tiny).not.toBeNull();
    expect(tiny!.truncated).toBe(true);
    expect(tiny!.lines.filter(Boolean).length).toBeLessThan(6);
  });

  test('returns null on unreadable file', () => {
    expect(readTailWindow('/no/such/transcript.jsonl')).toBeNull();
  });
});

describe('helpers', () => {
  test('isProductiveTool includes edit tools and mcp reply, excludes Bash/Read and the withdrawn task tools', () => {
    for (const t of ['Write', 'Edit', 'NotebookEdit', 'mcp__plugin_x__reply']) {
      expect(isProductiveTool(t)).toBe(true);
    }
    for (const t of ['Bash', 'Read', 'Grep', 'Agent', 'TaskCreate', 'TaskUpdate']) {
      expect(isProductiveTool(t)).toBe(false);
    }
  });

  test('isWakeSource: heartbeat and routine are wakes, channel/other are not', () => {
    expect(isWakeSource('heartbeat')).toBe(true);
    expect(isWakeSource('routine:daily-brief')).toBe(true);
    expect(isWakeSource('routine:multi')).toBe(true);
    expect(isWakeSource('channel:discord')).toBe(false);
    expect(isWakeSource('other')).toBe(false);
  });

  test('parseArgs: valid, defaults, and rejections', () => {
    expect(parseArgs(['.cch'])).toEqual({ stateDir: '.cch', days: 7, sessions: 10, dir: undefined, record: false });
    expect(parseArgs(['.cch', '--days', '30', '--sessions', '40', '--dir', '/x']))
      .toEqual({ stateDir: '.cch', days: 30, sessions: 40, dir: '/x', record: false });
    // Recording is opt-in: the digest stays a pure read unless asked, so an ad-hoc
    // or debugging invocation never leaves an observation row behind.
    expect(parseArgs(['.cch', '--record-observation']))
      .toEqual({ stateDir: '.cch', days: 7, sessions: 10, dir: undefined, record: true });
    expect(parseArgs([])).toBeNull();                       // no positional
    expect(parseArgs(['.cch', 'extra'])).toBeNull();        // two positionals
    expect(parseArgs(['.cch', '--days', 'x'])).toBeNull();  // non-numeric
    expect(parseArgs(['.cch', '--sessions', '0'])).toBeNull(); // non-positive
    expect(parseArgs(['.cch', '--bogus'])).toBeNull();      // unknown flag
  });
});

describe('transcriptDirFor', () => {
  test('non-alphanumeric characters (including dots) map to dashes', () => {
    expect(transcriptDirFor('/home/user/proj', '/HOME/.claude')).toBe('/HOME/.claude/projects/-home-user-proj');
    expect(transcriptDirFor('/home/user/.claude/jobs/x', '/HOME/.claude'))
      .toBe('/HOME/.claude/projects/-home-user--claude-jobs-x');
  });

  // The override is the CONFIG dir, not HOME: a hermit whose CLAUDE_CONFIG_DIR points
  // somewhere other than ~/.claude keeps its transcripts there, and the old
  // os.homedir()/.claude hardcode read a directory that does not exist.
  test('the override is the config dir, with no .claude segment appended', () => {
    expect(transcriptDirFor('/home/user/proj', '/srv/cfg')).toBe('/srv/cfg/projects/-home-user-proj');
  });
});

describe('pickTranscripts', () => {
  test('filters by extension, mtime window, and caps by count newest-first', () => {
    const { projDir } = buildProjects();
    writeTranscript(projDir, 'a.jsonl', ['{}'], T0 - 1 * 3600_000);
    writeTranscript(projDir, 'b.jsonl', ['{}'], T0 - 2 * 3600_000);
    writeTranscript(projDir, 'old.jsonl', ['{}'], T0 - 40 * DAY_MS);
    fs.writeFileSync(path.join(projDir, 'note.txt'), 'x');

    const within = pickTranscripts(projDir, 7, 10, T0);
    expect(within.map(p => path.basename(p))).toEqual(['a.jsonl', 'b.jsonl']); // newest first, old + txt excluded

    const capped = pickTranscripts(projDir, 7, 1, T0);
    expect(capped.map(p => path.basename(p))).toEqual(['a.jsonl']);
  });
});
