// Regression: skill-correction inner-loop — prose-pin + ledger behavioral tests.
//
// Guards observation capture and
// the graduation routing (reflect step 3b `skill-correction:*` branch),
// and the single moderate-signal Skill Improvement route.
//
// Usage: bun test tests/skill-correction-ledger.test.ts   (from the plugin root)

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript, runPinnedScript, PLUGIN_ROOT } from './helpers/run';
import { todayYMD } from '../scripts/lib/time';

const read = (...p: string[]) => fs.readFileSync(path.join(PLUGIN_ROOT, ...p), 'utf-8');

// reflect's skill-correction routing detail lives in branches.md (the
// rare-branch procedures file); assert against the combined surface.
const reflect        = read('skills', 'reflect', 'SKILL.md') + '\n' + read('skills', 'reflect', 'branches.md');
const proposalAct    = read('skills', 'proposal-act', 'SKILL.md') + '\n' + read('skills', 'proposal-act', 'branches.md');
const channelResponder = read('skills', 'channel-responder', 'reference.md');
const noBriefRouting = reflect.slice(
  reflect.indexOf('## `skill-correction:*` routing'),
  reflect.indexOf('## `skill-preference:*` routing'),
);

// ── 2. observations ledger: observations.ts behavioral test ─────────────────

// Empirically confirmed (bun 1.3.14 & 1.4.0): describe.serial does not reliably force
// sequential execution of its own child tests under --concurrent — only
// per-test .serial marking does. So each test below is marked individually.
describe('observations.ts: skill-correction row round-trip', () => {
  let workdir: string;
  let stateDir: string;
  let ledger: string;

  // Rows group by local date, with the existing session_id key retained.
  const zones = ['Etc/GMT+12', 'Pacific/Kiritimati'];
  const setDateZone = (timezone: string) =>
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ timezone }));

  // observations.ts pins its state-dir argv to hermitDir(); an absolute
  // AGENT_DIR is the sanctioned override that points it at this fixture.
  const observe = () =>
    runPinnedScript('observations.ts', stateDir, ['observe', stateDir, 'skill-correction', '--origin=own-work'], {
      stdin: 'skill-correction:my-skill',
    });

  beforeAll(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-skill-corr-'));
    stateDir = path.join(workdir, '.hermit');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    ledger = path.join(stateDir, 'state', 'observations.jsonl');
  });

  afterAll(() => {
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch {}
  });

  test.serial('observations.ts: skill-correction row appended and parseable', async () => {
    setDateZone(zones[0]);
    const r = await observe();
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('OK');

    const lines = fs.readFileSync(ledger, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.pattern).toBe('skill-correction:my-skill');
    expect(parsed.source).toBe('skill-correction');
    expect(parsed.origin).toBe('own-work');
    expect(parsed.session_id).toBe(todayYMD(zones[0]));
  });

  test.serial('observations.ts: two distinct-date rows group by pattern in prune', async () => {
    // append a second row for the same pattern under a different local date
    setDateZone(zones[1]);
    await observe();

    const lines = fs.readFileSync(ledger, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    // Both rows have the same pattern — grouping by pattern gives distinct local dates in session_id
    const parsed = lines.map((l) => JSON.parse(l));
    const sessions = new Set(parsed.filter((r) => r.pattern === 'skill-correction:my-skill').map((r) => r.session_id));
    expect(sessions.size).toBe(2);
  });

  // Depends on both prior append tests having run (shared workdir ledger has 2 rows).
  test.serial('prune-observations: skill-correction rows survive (both dates fresh)', async () => {
    const r = await runScript('prune-observations.ts', { args: [stateDir] });
    expect(r.exitCode).toBe(0);
    // both rows are fresh — neither should be pruned
    expect(JSON.parse(r.stdout)).toEqual({ pruned: 0, kept: 2 });
    const after = fs.readFileSync(ledger, 'utf-8');
    expect(after).toContain('skill-correction:my-skill');
    expect(after).toContain(todayYMD(zones[0]));
    expect(after).toContain(todayYMD(zones[1]));
  });
});

// ── 3. reflect: skill-correction graduation routing prose pins ──────────────

describe('reflect: skill-correction:* graduation routing', () => {
  test('reflect: skill-correction routing block present in step 3b', () => {
    expect(reflect).toContain('skill-correction:*` routing');
  });

  test('reflect: corrections recover cited session lessons without brief lookup', () => {
    expect(noBriefRouting).toContain("each session listed in the graduated ledger rows' `session_id` fields");
    expect(noBriefRouting).not.toContain('procedure-brief');
  });

  test('reflect: no brief path always produces a moderate Skill Improvement without an anchor', () => {
    expect(noBriefRouting).toContain('Build a Tier 2 candidate with a `## Skill Improvement` section listing the component name and those corrected behaviors');
    expect(noBriefRouting).toContain('state `moderate signal` as the confidence note');
    expect(noBriefRouting).not.toContain('source_artifact:');
  });

  test('reflect: the no-brief branch does not classify the name, it defers to accept', () => {
    // An override does not shadow the plugin skill it overrides: both appear in the
    // available-skills list (probed), so a name-class test here could never separate them,
    // and a list absent after a compaction made the answer recalled-not-verified. The class
    // is resolved once at accept, against the filesystem and list as they are then.
    expect(noBriefRouting).toContain("resolved once at accept by `proposal-act`'s falsification gate and step (e)");
    expect(noBriefRouting).not.toContain('installed plugin skill');
    expect(noBriefRouting).not.toContain('Neither applies');
  });

  test('reflect: correction carries the observations artifact for judge validation', () => {
    expect(noBriefRouting).toContain('Artifact: state/observations.jsonl');
  });

  test('reflect: Component Health Skills bullet references ledger graduation as backing', () => {
    expect(reflect).toContain('skill-correction:*` ledger graduation in step 3b');
  });

  test('reflect: Component Health subject reflection-judge is not a candidate', () => {
    expect(reflect).toContain('This flag is audit-only');
    expect(reflect).toContain('to the Progress Log line and nothing else');
  });
});

// ── 3b. channel-responder: correction → ledger row prose pins ───────────────

describe('channel-responder: resolved correction routes to ledger row', () => {
  test('channel-responder: resolved corrections append instead of a Findings line', () => {
    expect(channelResponder).toContain('Resolved corrections → observations ledger, not Findings');
  });

  test('channel-responder: appends through observations.ts with the skill-correction source', () => {
    expect(channelResponder).toContain('`observations-observe` (Commands) with arguments `skill-correction');
  });

  test('channel-responder: label is skill-correction:<canonical-name> on its own heredoc line', () => {
    expect(channelResponder).toMatch(/^\s*skill-correction:<canonical-name>$/m);
  });

  test('channel-responder: origin flag is sender-derived', () => {
    expect(channelResponder).toContain('--origin=<own-work|external-content>');
  });

  test('channel-responder: unresolved corrections fall back to the Findings line', () => {
    expect(channelResponder).toContain('do not guess a `<name>`');
  });
});

test('proposal-act: Skill Improvement reads no procedure brief', () => {
  expect(proposalAct).not.toContain('Parse the `source_artifact:` line from the `## Skill Improvement` body');
  expect(proposalAct).not.toContain('read the brief');
});
