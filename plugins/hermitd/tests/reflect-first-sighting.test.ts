// reflect-first-sighting.test.ts
//
// Tests for the three changes that fix reflection input-starvation:
//   1. Drift capture in reflect-precheck.ts (writes startup-drift rows to observations.jsonl)
//   2. Freshness RUN gate (flips EMPTY→RUN when ledger has rows newer than last_run_at)
//   3. graduation_min_sessions config key (lowers graduation threshold; origin aggregation)
//
// Also tests the observations_fresh phase key documentation and triage/proposal-create
// exception for state/observations.jsonl artifact candidates.
//
// Usage: bun test tests/reflect-first-sighting.test.ts   (from the plugin root)

import { afterAll, describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, SCRIPTS_DIR, runScript, runPinnedScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-fst-');
const { freshDir: freshSpike, cleanup: cleanupSpike } = freshDirFactory('hermit-spike-');
afterAll(() => { cleanup(); cleanupSpike(); });

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpHermit(overrides: {
  runtimeJson?: Record<string, unknown>;
  lastRunAt?: string | null;
  observations?: string[];
} = {}): string {
  const dir = freshDir();

  // Minimal state directory
  const stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'compiled'), { recursive: true });


  // reflection-state.json — recent behavior cursor keeps the weekly `behavior`
  // phase quiet for tests that aren't exercising it (the behavior-phase suite
  // overwrites this file with its own cursor).
  const reflState: Record<string, unknown> = { counters: {}, last_behavior_digest_at: new Date().toISOString() };
  if (overrides.lastRunAt !== undefined) {
    (reflState.counters as Record<string, unknown>).last_run_at = overrides.lastRunAt;
  }
  fs.writeFileSync(path.join(stateDir, 'reflection-state.json'), JSON.stringify(reflState), 'utf-8');

  // runtime.json
  const runtime = overrides.runtimeJson ?? {};
  fs.writeFileSync(path.join(stateDir, 'runtime.json'), JSON.stringify(runtime), 'utf-8');

  // config.json
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ timezone: 'UTC' }), 'utf-8');

  // observations.jsonl
  const obsContent = overrides.observations?.length
    ? overrides.observations.join('\n') + '\n'
    : '';
  fs.writeFileSync(path.join(stateDir, 'observations.jsonl'), obsContent, 'utf-8');

  return dir;
}

function readObservations(hermitDir: string): Array<Record<string, unknown>> {
  const p = path.join(hermitDir, 'state', 'observations.jsonl');
  try {
    const content = fs.readFileSync(p, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

async function runPrecheck(hermitDir: string): Promise<string> {
  const result = await runPinnedScript('reflect-precheck.ts', hermitDir, [hermitDir, PLUGIN_ROOT]);
  return result.stdout.trim();
}

// ── Section 1: Drift capture ──────────────────────────────────────────────────

describe('reflect-precheck: drift capture', () => {
  test('precheck writes startup-drift row when unknown top-level dir exists', async () => {
    const hermitDir = makeTmpHermit({ lastRunAt: null });
    try {
      // Create an unknown top-level dir to trigger storage drift
      fs.mkdirSync(path.join(hermitDir, 'reports'));
      fs.writeFileSync(path.join(hermitDir, 'reports', 'foo.md'), '# test', 'utf-8');

      await runPrecheck(hermitDir);

      const rows = readObservations(hermitDir);
      const driftRow = rows.find(r => typeof r.pattern === 'string' && r.pattern.startsWith('storage-drift:'));
      expect(driftRow).toBeDefined();
      expect(driftRow?.source).toBe('startup-drift');
      expect(driftRow?.origin).toBe('own-work');
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('precheck drift row has required fields (ts, pattern, session_id, source, origin)', async () => {
    const hermitDir = makeTmpHermit({ lastRunAt: null });
    try {
      fs.mkdirSync(path.join(hermitDir, 'audits'));

      await runPrecheck(hermitDir);

      const rows = readObservations(hermitDir);
      const driftRow = rows.find(r => typeof r.pattern === 'string' && r.pattern.startsWith('storage-drift:'));
      expect(driftRow).toBeDefined();
      expect(typeof driftRow?.ts).toBe('string');
      expect(typeof driftRow?.pattern).toBe('string');
      expect(typeof driftRow?.session_id).toBe('string');
      expect(driftRow?.source).toBe('startup-drift');
      expect(driftRow?.origin).toBe('own-work');
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('session_id is the local date when runtime has no lifecycle label', async () => {
    const hermitDir = makeTmpHermit({ lastRunAt: null });
    try {
      fs.mkdirSync(path.join(hermitDir, 'reports'));

      await runPrecheck(hermitDir);

      const rows = readObservations(hermitDir);
      const driftRow = rows.find(r => typeof r.pattern === 'string' && r.pattern.startsWith('storage-drift:'));
      expect(driftRow?.session_id).toBe(new Date().toISOString().slice(0, 10));
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('session_id is the local date when runtime.json is absent', async () => {
    const hermitDir = makeTmpHermit({ lastRunAt: null });
    try {
      // Remove runtime.json
      fs.unlinkSync(path.join(hermitDir, 'state', 'runtime.json'));
      fs.mkdirSync(path.join(hermitDir, 'reports'));

      await runPrecheck(hermitDir);

      const rows = readObservations(hermitDir);
      const driftRow = rows.find(r => typeof r.pattern === 'string' && r.pattern.startsWith('storage-drift:'));
      expect(driftRow?.session_id).toBe(new Date().toISOString().slice(0, 10));
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('session_id ignores frozen reports and uses the local date', async () => {
    const hermitDir = makeTmpHermit({ lastRunAt: null });
    try {
      fs.writeFileSync(path.join(hermitDir, 'sessions', 'S-010-REPORT.md'), '# S-010\n');
      fs.mkdirSync(path.join(hermitDir, 'reports'));

      await runPrecheck(hermitDir);

      const rows = readObservations(hermitDir);
      const driftRow = rows.find(r => typeof r.pattern === 'string' && r.pattern.startsWith('storage-drift:'));
      expect(driftRow?.session_id).toBe(new Date().toISOString().slice(0, 10));
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('dedup by pattern: same session does not write duplicate rows', async () => {
    const hermitDir = makeTmpHermit({ lastRunAt: null });
    try {
      fs.mkdirSync(path.join(hermitDir, 'reports'));

      // Run twice
      await runPrecheck(hermitDir);
      await runPrecheck(hermitDir);

      const rows = readObservations(hermitDir).filter(r =>
        typeof r.pattern === 'string' && r.pattern === 'storage-drift:reports'
      );
      expect(rows.length).toBe(1);
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('dedup by pattern: a different session does NOT write a duplicate drift row', async () => {
    const hermitDir = makeTmpHermit({ lastRunAt: null });
    try {
      fs.mkdirSync(path.join(hermitDir, 'reports'));

      // First run: session_id = "S-001"
      const runtime1 = { cc_session_id: 'first' };
      fs.writeFileSync(path.join(hermitDir, 'state', 'runtime.json'), JSON.stringify(runtime1), 'utf-8');
      await runPrecheck(hermitDir);

      // Second run: session_id = "S-002" (different session). Drift is structural, so the
      // standing pattern is not re-written — otherwise it would flip reflect to RUN every session.
      const runtime2 = { cc_session_id: 'second' };
      fs.writeFileSync(path.join(hermitDir, 'state', 'runtime.json'), JSON.stringify(runtime2), 'utf-8');
      await runPrecheck(hermitDir);

      const rows = readObservations(hermitDir).filter(r =>
        typeof r.pattern === 'string' && r.pattern === 'storage-drift:reports'
      );
      expect(rows.length).toBe(1);
      expect(rows[0].session_id).toBe(new Date().toISOString().slice(0, 10));
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('storage-drift slug preserves the full subpath under raw/', async () => {
    const hermitDir = makeTmpHermit({ lastRunAt: null });
    try {
      fs.mkdirSync(path.join(hermitDir, 'raw', 'sub'), { recursive: true });

      await runPrecheck(hermitDir);

      const rows = readObservations(hermitDir);
      const driftRow = rows.find(r => typeof r.pattern === 'string' && r.pattern.startsWith('storage-drift:raw'));
      expect(driftRow?.pattern).toBe('storage-drift:raw/sub');
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('precheck writes a schema-drift row for an undeclared compiled type', async () => {
    const hermitDir = makeTmpHermit({ lastRunAt: null });
    try {
      fs.writeFileSync(path.join(hermitDir, 'knowledge-schema.md'),
        '## Work Products\n\n- guide:\n- design:\n', 'utf-8');
      fs.writeFileSync(path.join(hermitDir, 'compiled', 'note.md'),
        '---\ntitle: x\ntype: spike\ncreated: 2026-01-01T00:00:00Z\n---\n# x\n', 'utf-8');

      await runPrecheck(hermitDir);

      const rows = readObservations(hermitDir);
      const driftRow = rows.find(r => r.pattern === 'schema-drift:spike');
      expect(driftRow).toBeDefined();
      expect(driftRow?.source).toBe('startup-drift');
      expect(driftRow?.origin).toBe('own-work');
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('precheck is fail-open: exits 0 even when hermitDir is missing', async () => {
    // Pinned to the SAME nonexistent path via AGENT_DIR, so this exercises the
    // script's own fail-open handling of a state dir that doesn't exist on
    // disk yet — not the state-dir pin's foreign-root refusal (a genuinely
    // foreign root is asserted separately below).
    const result = await runPinnedScript('reflect-precheck.ts', '/nonexistent/dir', ['/nonexistent/dir', PLUGIN_ROOT]);
    expect(result.exitCode).toBe(0);
  });

  test('a foreign state-dir argv is refused (exit 1, foreign_state_dir)', async () => {
    const result = await runScript('reflect-precheck.ts', { args: ['/nonexistent/dir', PLUGIN_ROOT] });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toStartWith('{"error":"foreign_state_dir:');
  });

  test('no drift written when hermit dirs are clean', async () => {
    const hermitDir = makeTmpHermit({ lastRunAt: null });
    try {
      await runPrecheck(hermitDir);

      const rows = readObservations(hermitDir).filter(r =>
        typeof r.pattern === 'string' && r.pattern.startsWith('storage-drift:')
      );
      expect(rows.length).toBe(0);
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });
});

// ── Section 2: Freshness RUN gate ────────────────────────────────────────────

describe('reflect-precheck: freshness RUN gate', () => {
  test('EMPTY when ledger is empty and no other phases', async () => {
    const hermitDir = makeTmpHermit({
      lastRunAt: new Date(Date.now() - 60_000).toISOString(),
      observations: [],
    });
    try {
      const verdict = await runPrecheck(hermitDir);
      expect(verdict).toBe('{"status":"empty"}');
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('run with observations_fresh when ledger has row newer than last_run_at', async () => {
    const lastRunAt = new Date(Date.now() - 3600_000).toISOString(); // 1h ago
    const freshTs = new Date().toISOString();

    const hermitDir = makeTmpHermit({
      lastRunAt,
      observations: [JSON.stringify({ ts: freshTs, pattern: 'test', session_id: 'S-001', source: 'reflect-noticed', origin: 'own-work' })],
    });
    try {
      const verdict = await runPrecheck(hermitDir);
      expect(JSON.parse(verdict).status).toBe('run');
      const phases = JSON.parse(verdict).phases;
      expect(phases.observations_fresh).toBe(true);
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('EMPTY when all ledger rows are older than last_run_at', async () => {
    const oldTs = new Date(Date.now() - 7200_000).toISOString(); // 2h ago
    const lastRunAt = new Date(Date.now() - 3600_000).toISOString(); // 1h ago

    const hermitDir = makeTmpHermit({
      lastRunAt,
      observations: [JSON.stringify({ ts: oldTs, pattern: 'test', session_id: 'S-001', source: 'reflect-noticed', origin: 'own-work' })],
    });
    try {
      const verdict = await runPrecheck(hermitDir);
      expect(verdict).toBe('{"status":"empty"}');
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('null last_run_at → RUN when any ledger row exists', async () => {
    const hermitDir = makeTmpHermit({
      lastRunAt: null,
      observations: [JSON.stringify({ ts: new Date(Date.now() - 86400_000).toISOString(), pattern: 'old', session_id: 'S-001', source: 'startup-drift', origin: 'own-work' })],
    });
    try {
      const verdict = await runPrecheck(hermitDir);
      expect(JSON.parse(verdict).status).toBe('run');
      const phases = JSON.parse(verdict).phases;
      expect(phases.observations_fresh).toBe(true);
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('EMPTY when the only fresh row is skill-preference-applied telemetry', async () => {
    const lastRunAt = new Date(Date.now() - 3600_000).toISOString(); // 1h ago
    const freshTs = new Date().toISOString();

    const hermitDir = makeTmpHermit({
      lastRunAt,
      observations: [JSON.stringify({ ts: freshTs, pattern: 'skill-preference:task-report', session_id: 'S-001', source: 'skill-preference-applied', origin: 'own-work' })],
    });
    try {
      const verdict = await runPrecheck(hermitDir);
      expect(verdict).toBe('{"status":"empty"}');
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('pending skill-preference rows still trigger observations_fresh', async () => {
    const lastRunAt = new Date(Date.now() - 3600_000).toISOString(); // 1h ago
    const freshTs = new Date().toISOString();

    const hermitDir = makeTmpHermit({
      lastRunAt,
      observations: [JSON.stringify({ ts: freshTs, pattern: 'skill-preference:weekly-digest', session_id: 'S-001', source: 'skill-preference', origin: 'own-work' })],
    });
    try {
      const verdict = await runPrecheck(hermitDir);
      expect(JSON.parse(verdict).status).toBe('run');
      const phases = JSON.parse(verdict).phases;
      expect(phases.observations_fresh).toBe(true);
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });

  test('startup-drift rows written in same run trigger observations_fresh on that run', async () => {
    // Fresh hermit with an unknown dir — precheck writes drift rows AND triggers freshness
    const hermitDir = makeTmpHermit({ lastRunAt: null });
    try {
      fs.mkdirSync(path.join(hermitDir, 'reports'));

      const verdict = await runPrecheck(hermitDir);
      // Should be RUN (either from observations_fresh or other phases)
      expect(JSON.parse(verdict).status).toBe('run');
    } finally {
      fs.rmSync(hermitDir, { recursive: true, force: true });
    }
  });
});

// ── Section 3: observations_fresh phase key documentation ───────────────────

describe('reflect SKILL.md: observations_fresh phase key', () => {
  const reflectSkill = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'reflect', 'SKILL.md'), 'utf-8');

  test('SKILL.md documents the observations_fresh phase key', () => {
    expect(reflectSkill).toContain('observations_fresh');
  });

  test('SKILL.md explains what observations_fresh triggers', () => {
    expect(reflectSkill).toContain('observations_fresh');
    // step 3b should run when observations_fresh is in phases
    expect(reflectSkill).toContain('step 3b');
  });
});

// ── Section 4: graduation_min_sessions config wiring ────────────────────────

describe('graduation_min_sessions: config wiring', () => {
  test('config.json.template has reflection.graduation_min_sessions: 1', () => {
    const template = JSON.parse(
      fs.readFileSync(path.join(PLUGIN_ROOT, 'state-templates', 'config.json.template'), 'utf-8')
    );
    expect(template.reflection).toBeDefined();
    expect(template.reflection.graduation_min_sessions).toBe(1);
  });

  test('DEFAULT_CONFIG in hermitd-start.ts has reflection.graduation_min_sessions: 1', async () => {
    // Read the actual module — use Bun dynamic import to avoid full startup
    const content = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'hermitd-start.ts'), 'utf-8');
    expect(content).toContain('graduation_min_sessions: 1');
    expect(content).toContain('reflection:');
  });

  test('docs/config-reference.md documents graduation_min_sessions', () => {
    const ref = fs.readFileSync(path.join(PLUGIN_ROOT, 'docs', 'config-reference.md'), 'utf-8');
    expect(ref).toContain('graduation_min_sessions');
    expect(ref).toContain('reflection');
  });

  test('validate-config.ts validates reflection.graduation_min_sessions as positive integer', () => {
    const validateContent = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'validate-config.ts'), 'utf-8');
    expect(validateContent).toContain('graduation_min_sessions');
    expect(validateContent).toContain('positive integer');
  });
});

// ── Section 5: step 3b origin aggregation ───────────────────────────────────

// The aggregation itself is `observations.ts graduate`'s, pinned in
// tests/observations-graduate.test.ts. What SKILL.md still owes is carrying the
// verb's answer into the candidate rather than re-deriving one.
describe('reflect SKILL.md: step 3b origin aggregation', () => {
  const reflectSkill = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'reflect', 'SKILL.md'), 'utf-8');

  test('SKILL.md takes the graduation set from the verb', () => {
    expect(reflectSkill).toContain('observations.ts graduate');
    expect(reflectSkill).toContain('"origin": "own-work"|"external-content"');
  });

  test('SKILL.md carries origin into Evidence Origin on graduation', () => {
    expect(reflectSkill).toContain('Evidence Origin: <origin>');
  });
});

// ── Section 6: triage and proposal-create artifact exception ────────────────

describe('triage + proposal-create: observations.jsonl artifact exception', () => {
  const triage = fs.readFileSync(path.join(PLUGIN_ROOT, 'agents', 'proposal-triage.md'), 'utf-8');
  const proposalCreate = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'proposal-create', 'SKILL.md'), 'utf-8');

  test('proposal-triage: observations.jsonl artifact satisfies condition 1', () => {
    expect(triage).toContain('state/observations.jsonl');
    // Should not require efficiency/cost-class only
    expect(triage).toContain('any artifact-cited candidate, had recurrence established upstream');
  });

  test('proposal-create: observations.jsonl artifact satisfies condition 1', () => {
    expect(proposalCreate).toContain('state/observations.jsonl');
    // The judge verifies the ledger; do not re-check here
    expect(proposalCreate).toContain('re-establish it here only for `archived-session` candidates');
  });
});

// ── Section 7: reflect-noticed origin field ──────────────────────────────────

describe('reflect SKILL.md: reflect-noticed with origin field', () => {
  const reflectSkill = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'reflect', 'SKILL.md'), 'utf-8');

  test('SKILL.md documents reflect-noticed source value with origin field', () => {
    expect(reflectSkill).toContain('"source":"reflect-noticed"');
  });

  test('SKILL.md documents external-content origin for reflect-noticed', () => {
    expect(reflectSkill).toContain('"origin":"external-content"');
  });

  test('SKILL.md documents own-work origin for reflect-noticed', () => {
    expect(reflectSkill).toContain('"origin":"own-work"');
  });
});

// ── Section 8: reflection-judge §1.4 config-agnostic verification ───────────

describe('reflection-judge: §1.4 config-agnostic ledger verification', () => {
  const judge = fs.readFileSync(path.join(PLUGIN_ROOT, 'agents', 'reflection-judge.md'), 'utf-8');

  test('judge verifies against cited Sessions list, not hardcoded threshold', () => {
    // Should reference the Sessions: list from the candidate (backtick-colon form)
    expect(judge).toContain("cited `Sessions:`");
    // Should NOT still say "≥2 distinct session_ids" with a hardcoded count
    expect(judge).not.toContain('≥2 entries whose `pattern`');
  });

  test('judge is config-agnostic (does not re-count threshold)', () => {
    expect(judge).toContain('config-agnostic');
  });

  test('judge skips §1 when Artifact cites observations.jsonl', () => {
    expect(judge).toContain('Skip §§ 0.5, 1, and 1.6');
    expect(judge).toContain('`state/observations.jsonl`');
  });

  test('judge §1.4 greps the ledger instead of Reading it whole', () => {
    expect(judge).toContain('Never `Read` the ledger whole');
    expect(judge).toContain('head_limit: 200');
    expect(judge).not.toContain('Glob and Read `.hermit/state/observations.jsonl`');
  });
});

// ── Section: behavior phase (transcript-digest weekly cadence) ─────────────────

describe('reflect-precheck: behavior phase', () => {
  // Write reflection-state.json with a recent last_run_at (suppresses the compute
  // phase's null-lastRunAt trigger) plus an explicit top-level behavior cursor, so
  // the `behavior` phase is the deciding one.
  function withBehaviorCursor(cursor: string | undefined): string {
    const dir = makeTmpHermit();
    const now = new Date().toISOString();
    const state: Record<string, unknown> = { counters: { last_run_at: now } };
    if (cursor !== undefined) state.last_behavior_digest_at = cursor;
    fs.writeFileSync(path.join(dir, 'state', 'reflection-state.json'), JSON.stringify(state), 'utf-8');
    return dir;
  }

  function daysAgo(n: number): string {
    return new Date(Date.now() - n * 86_400_000).toISOString();
  }

  test('fires when the behavior cursor is unset (first run)', async () => {
    const verdict = await runPrecheck(withBehaviorCursor(undefined));
    expect(JSON.parse(verdict).status).toBe('run');
    expect(JSON.parse(verdict).phases.behavior).toBe(true);
  });

  test('fires when the behavior cursor is older than 7 days', async () => {
    const verdict = await runPrecheck(withBehaviorCursor(daysAgo(10)));
    expect(JSON.parse(verdict).status).toBe('run');
    expect(JSON.parse(verdict).phases.behavior).toBe(true);
  });

  test('does not fire when the behavior cursor is within 7 days', async () => {
    const verdict = await runPrecheck(withBehaviorCursor(daysAgo(2)));
    // Other phases stay quiet (recent last_run_at, no proposals/costs/observations),
    // so this collapses to EMPTY; behavior must not be present either way.
    if (JSON.parse(verdict).status === 'run') {
      expect(JSON.parse(verdict).phases.behavior).toBeUndefined();
    } else {
      expect(verdict).toBe('{"status":"empty"}');
    }
  });
});

// ── cost-spike rows are written by the precheck, and deduped by day ──────────
//
// The row used to be formatted in reflect's prose from a number the precheck had
// already computed and thrown away — a round trip that, across the live fleet,
// never once produced a row. It is now written here.
//
// The dedup label is the load-bearing detail: a label carrying the amount would slip
// past the exact-pattern dedup the moment a late row or an index rebuild moved the
// figure, writing a second row for the same day. The label is date-scoped and the
// figures ride as fields instead.
//
// The measured day is YESTERDAY. The shipped schedule fires at 09:00, so today's
// bucket is a fraction of a day and could only beat a full-day median when a spike
// happens to be front-loaded before the routine runs.

describe('reflect-precheck: cost-spike observation', () => {
  // checkCostSpike reads state/cost-index.json (whole-day totals), not the raw
  // cost log — so the fixture writes the index directly. A quiet baseline day is $2
  // here, not $1: the median floor rejects anything below $1, and a baseline sitting
  // exactly on the floor would make every threshold case read as a floor case.
  // `dayTotal` is yesterday's bucket, the figure under test.
  function makeSpikeProject(dayTotal: number, priorDayCosts: number[] = [2, 2, 2]): string {
    const project = freshSpike();
    const hermitDir = path.join(project, '.hermit');
    const stateDir = path.join(hermitDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.join(hermitDir, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });

    fs.writeFileSync(path.join(stateDir, 'reflection-state.json'),
      JSON.stringify({ counters: {}, last_behavior_digest_at: new Date().toISOString() }), 'utf-8');
    fs.writeFileSync(path.join(stateDir, 'runtime.json'),
      JSON.stringify({ cc_session_id: 'resident' }), 'utf-8');
    fs.writeFileSync(path.join(hermitDir, 'config.json'), JSON.stringify({ timezone: 'UTC' }), 'utf-8');
    fs.writeFileSync(path.join(stateDir, 'observations.jsonl'), '', 'utf-8');

    writeCostIndex(hermitDir, dayTotal, priorDayCosts);
    return hermitDir;
  }

  // `todayCost` seeds today's partial bucket — it must never influence the verdict.
  function writeCostIndex(hermitDir: string, dayTotal: number, priorDayCosts: number[], todayCost = 0): void {
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    const by_date: Record<string, { cost: number; tokens: number; session_ids: string[] }> = {
      [day(0)]: { cost: todayCost, tokens: 0, session_ids: [] },
      [day(1)]: { cost: dayTotal, tokens: 0, session_ids: [] },
    };
    // Days -2 and older are the baseline; index 0 is the oldest.
    priorDayCosts.forEach((cost, i) => {
      by_date[day(priorDayCosts.length + 1 - i)] = { cost, tokens: 0, session_ids: [] };
    });
    fs.writeFileSync(path.join(hermitDir, 'state', 'cost-index.json'), JSON.stringify({
      version: 4, by_task: {}, byte_offset: 0, total_cost_usd: 0, total_tokens: 0, total_sessions: 0,
      last_session_id: null, by_source: {}, by_date, by_week: {}, by_month: {},
      skipped_corrupt_lines: 0, updated_at: new Date().toISOString(),
    }), 'utf-8');
  }

  const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  test('writes one date-scoped row carrying the figures as fields', async () => {
    const hermitDir = makeSpikeProject(10);
    const r = await runPinnedScript('reflect-precheck.ts', hermitDir, [hermitDir, PLUGIN_ROOT]);
    expect(r.exitCode).toBe(0);

    const spikes = readObservations(hermitDir).filter(o => o.source === 'cost-spike');
    expect(spikes).toHaveLength(1);
    expect(spikes[0].pattern).toBe(`cost-spike:${yesterday()}`);
    expect(spikes[0].day_total).toBe(10);
    expect(spikes[0].median_7d).toBe(2);
    expect(spikes[0].session_id).toBe(new Date().toISOString().slice(0, 10));
    // A measurement has no provenance — the constructor rejects `origin` on this source.
    expect(spikes[0].origin).toBeUndefined();
  });

  test('a second run the same day with a restated total still writes only one row', async () => {
    const hermitDir = makeSpikeProject(10);
    await runPinnedScript('reflect-precheck.ts', hermitDir, [hermitDir, PLUGIN_ROOT]);

    // A late row or an index rebuild moves yesterday's total 10 → 25. Under a
    // value-bearing label this would be a brand-new pattern and a second row; under
    // the date-scoped label the dedup holds.
    writeCostIndex(hermitDir, 25, [2, 2, 2]);
    await runPinnedScript('reflect-precheck.ts', hermitDir, [hermitDir, PLUGIN_ROOT]);

    const spikes = readObservations(hermitDir).filter(o => o.source === 'cost-spike');
    expect(spikes).toHaveLength(1);
    expect(spikes[0].day_total).toBe(10); // the first run's figures, not re-stamped
  });

  // The reason the measured day moved off `today`: at the shipped 09:00 schedule a
  // partial bucket cannot clear 2x a full-day median, so a real spike went unseen all
  // day and then aged into the baseline. Today's bucket now plays no part at all.
  test("today's partial total plays no part in the verdict", async () => {
    // Yesterday quiet, today already huge → nothing to report yet. Today becomes
    // yesterday on the next run, which is when it is judged.
    const hermitDir = makeSpikeProject(2);
    writeCostIndex(hermitDir, 2, [2, 2, 2], 500);
    await runPinnedScript('reflect-precheck.ts', hermitDir, [hermitDir, PLUGIN_ROOT]);
    expect(readObservations(hermitDir).filter(o => o.source === 'cost-spike')).toHaveLength(0);
  });

  // A fresh hatch's first days are near zero, so without a floor any normal working
  // day is trivially 2x them and week one produces a spurious reflect run.
  test('no row when the baseline is below the floor', async () => {
    const hermitDir = makeSpikeProject(1.5, [0.2, 0.2, 0.2]);
    await runPinnedScript('reflect-precheck.ts', hermitDir, [hermitDir, PLUGIN_ROOT]);
    expect(readObservations(hermitDir).filter(o => o.source === 'cost-spike')).toHaveLength(0);
  });

  // A whole-day total stays above the baseline for the rest of the day, so the
  // measurement alone can't gate the phase: it would emit a cost_spike run on every
  // tick until midnight, each one an LLM run whose cost_spike step has nothing to read
  // (the row is already written). The phase is gated on the row's absence instead.
  test('a spike day costs exactly one RUN, not one per tick', async () => {
    const hermitDir = makeSpikeProject(10);
    // last_run_at recent + no session reports → `compute` and `observations_fresh` stay
    // quiet, so cost_spike is the only phase that can force a RUN.
    const bumpLastRun = () => fs.writeFileSync(
      path.join(hermitDir, 'state', 'reflection-state.json'),
      JSON.stringify({
        counters: { last_run_at: new Date().toISOString() },
        last_behavior_digest_at: new Date().toISOString(),
      }), 'utf-8');

    bumpLastRun();
    const first = await runPinnedScript('reflect-precheck.ts', hermitDir, [hermitDir, PLUGIN_ROOT]);
    expect(JSON.parse(first.stdout).phases.cost_spike).toBe(true);

    bumpLastRun();
    const second = await runPinnedScript('reflect-precheck.ts', hermitDir, [hermitDir, PLUGIN_ROOT]);
    expect(second.stdout.trim()).toBe('{"status":"empty"}');
  });

  test('no row when the measured day is not a spike', async () => {
    const hermitDir = makeSpikeProject(2);
    await runPinnedScript('reflect-precheck.ts', hermitDir, [hermitDir, PLUGIN_ROOT]);
    expect(readObservations(hermitDir).filter(o => o.source === 'cost-spike')).toHaveLength(0);
  });

  // Whole-day totals mean entry count plays no part in detection: a spike fires the
  // same whether the day behind each total was 1 entry or 400.
  test('fires on a busy-install spike regardless of entry count', async () => {
    const hermitDir = makeSpikeProject(1266.72, [100, 100, 100, 100]);
    await runPinnedScript('reflect-precheck.ts', hermitDir, [hermitDir, PLUGIN_ROOT]);

    const spikes = readObservations(hermitDir).filter(o => o.source === 'cost-spike');
    expect(spikes).toHaveLength(1);
    expect(spikes[0].day_total).toBe(1266.72);
    expect(spikes[0].median_7d).toBe(100);
  });

  test('no row when fewer than 3 complete prior days exist', async () => {
    const hermitDir = makeSpikeProject(100, [2, 2]);
    await runPinnedScript('reflect-precheck.ts', hermitDir, [hermitDir, PLUGIN_ROOT]);
    expect(readObservations(hermitDir).filter(o => o.source === 'cost-spike')).toHaveLength(0);
  });
});
