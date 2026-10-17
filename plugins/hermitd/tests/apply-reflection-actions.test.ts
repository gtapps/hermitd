// apply-reflection-actions.ts is the transactional apply step for the reflect
// eval runner's resolution_actions batch. The contract under test: the WHOLE
// batch validates before ANY write (a single bad entry means zero writes), the
// frontmatter patch is line-level (body and unrelated frontmatter stay
// byte-identical), metrics append to state/proposal-metrics.jsonl, and frozen
// journals stay byte-identical. Exit code is 0 always.
//
// Usage: bun test tests/apply-reflection-actions.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript } from './helpers/run';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.hermit', ...p);
const proposalPath = (dir: string) => hermit(dir, 'proposals', 'PROP-042-some-slug-101010.md');
const shellPath = (dir: string) => hermit(dir, 'sessions', 'SHELL.md');
const metricsPath = (dir: string) => hermit(dir, 'state', 'proposal-metrics.jsonl');

const PROPOSAL_MD = `---
id: PROP-042
status: proposed
title: Route channel sends through the resolver
created: 2026-07-18T10:10:10+0000
tags: [reflect]
---

## Summary
The resolver should own channel target selection.

## Notes
- this body line must stay byte-identical
`;

const SHELL_MD = `# Active Session

## Task
ongoing work

## Findings
<!-- Anything unexpected found during work. -->

## Monitoring
- [12:00] tick
`;

interface Tmp { dir: string; cleanup(): void }

function makeDir(): Tmp {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-reflact-'));
  fs.mkdirSync(hermit(dir, 'proposals'), { recursive: true });
  fs.mkdirSync(hermit(dir, 'sessions'), { recursive: true });
  fs.mkdirSync(hermit(dir, 'state'), { recursive: true });
  fs.writeFileSync(proposalPath(dir), PROPOSAL_MD);
  fs.writeFileSync(shellPath(dir), SHELL_MD);
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function withTmp(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const t = makeDir();
    try { await fn(t.dir); } finally { t.cleanup(); }
  };
}

// The script pins its state dir to hermitDir(), which in a test would resolve
// to this repo's own `.hermit` rather than the scratch fixture.
// An absolute AGENT_DIR is the sanctioned override (see tests/helpers/run.ts).
async function apply(dir: string, input: unknown) {
  const r = await runScript('apply-reflection-actions.ts', {
    args: [hermit(dir)],
    env: { AGENT_DIR: hermit(dir) },
    stdin: typeof input === 'string' ? input : JSON.stringify(input),
  });
  const out = JSON.parse(r.stdout.trim());
  expect(r.exitCode).toBe('error' in out ? 1 : 0);
  return out;
}

const FINDINGS_LINE = '- [reflect] PROP-042 auto-resolved (shipped in #612)';

const AUTO_RESOLVE = {
  proposal_id: 'PROP-042',
  action: 'auto-resolve',
  frontmatter_patch: { status: 'resolved', resolved_date: '2026-07-20' },
  shell_findings_line: FINDINGS_LINE,
};

// The `resolved` row is built by the script from proposal_id, so there is no
// fixture string to compare against — assert the parsed fields instead.
function metricsRows(dir: string): any[] {
  return fs.readFileSync(metricsPath(dir), 'utf-8').trimEnd().split('\n').map(l => JSON.parse(l));
}

// Everything from the closing --- onward — the byte-identical region of a patch.
const bodyOf = (content: string) => content.slice(content.indexOf('\n---', 3));

describe('apply-reflection-actions: happy paths', () => {
  test('auto-resolve patches frontmatter and metrics, preserving frozen journal', withTmp(async (dir) => {
    const result = await apply(dir, { resolution_actions: [AUTO_RESOLVE] });
    expect(result.error).toBeUndefined();
    expect(result.applied).toEqual({ auto_resolve: 1, nudge: 0, skip: 0 });
    expect(result.errors).toBeUndefined();

    const after = fs.readFileSync(proposalPath(dir), 'utf-8');
    // status: replaced in place; resolved_date: inserted before the closing ---.
    expect(after).toMatch(/^status: resolved$/m);
    expect(after).not.toMatch(/^status: proposed$/m);
    const fmBlock = after.slice(0, after.indexOf('\n---', 3));
    expect(fmBlock).toContain('resolved_date: 2026-07-20');
    // Unrelated frontmatter and the entire body are byte-identical.
    expect(fmBlock).toContain('id: PROP-042');
    expect(fmBlock).toContain('title: Route channel sends through the resolver');
    expect(fmBlock).toContain('created: 2026-07-18T10:10:10+0000');
    expect(bodyOf(after)).toBe(bodyOf(PROPOSAL_MD));

    const rows = metricsRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'resolved', proposal_id: 'PROP-042' });

    expect(fs.readFileSync(shellPath(dir), 'utf-8')).toBe(SHELL_MD);
  }));

  test('nudge preserves proposal, metrics and frozen journal', withTmp(async (dir) => {
    const result = await apply(dir, {
      resolution_actions: [{
        proposal_id: 'PROP-042', action: 'nudge',
        shell_findings_line: '- [reflect] PROP-042 nudged: 3 sessions stale',
      }],
    });
    expect(result.error).toBeUndefined();
    expect(result.applied).toEqual({ auto_resolve: 0, nudge: 1, skip: 0 });
    expect(fs.readFileSync(proposalPath(dir), 'utf-8')).toBe(PROPOSAL_MD);
    expect(fs.existsSync(metricsPath(dir))).toBe(false);
    expect(fs.readFileSync(shellPath(dir), 'utf-8')).not.toContain('PROP-042 nudged');
  }));

  test('skip writes nothing at all', withTmp(async (dir) => {
    const result = await apply(dir, {
      resolution_actions: [{ proposal_id: 'PROP-042', action: 'skip' }],
    });
    expect(result.error).toBeUndefined();
    expect(result.applied).toEqual({ auto_resolve: 0, nudge: 0, skip: 1 });
    expect(fs.readFileSync(proposalPath(dir), 'utf-8')).toBe(PROPOSAL_MD);
    expect(fs.readFileSync(shellPath(dir), 'utf-8')).toBe(SHELL_MD);
    expect(fs.existsSync(metricsPath(dir))).toBe(false);
  }));

  test('mixed batch [auto-resolve, nudge, skip] counts each bucket', withTmp(async (dir) => {
    const result = await apply(dir, {
      resolution_actions: [
        AUTO_RESOLVE,
        { proposal_id: 'PROP-042', action: 'nudge', shell_findings_line: '- [reflect] PROP-042 nudged' },
        { proposal_id: 'PROP-042', action: 'skip' },
      ],
    });
    expect(result.error).toBeUndefined();
    expect(result.applied).toEqual({ auto_resolve: 1, nudge: 1, skip: 1 });
  }));

  test('empty resolution_actions → ok with all-zero counts', withTmp(async (dir) => {
    const result = await apply(dir, { resolution_actions: [] });
    expect(result.error).toBeUndefined();
    expect(result.applied).toEqual({ auto_resolve: 0, nudge: 0, skip: 0 });
  }));
});

describe('apply-reflection-actions: transactionality (invalid batch = zero writes)', () => {
  test('one bogus entry poisons the whole batch — the valid auto-resolve writes nothing', withTmp(async (dir) => {
    const result = await apply(dir, {
      resolution_actions: [AUTO_RESOLVE, { proposal_id: 'PROP-042', action: 'bogus' }],
    });
    expect(result.error).toBe('invalid_action:1:unknown_action');
    expect(fs.readFileSync(proposalPath(dir), 'utf-8')).toBe(PROPOSAL_MD);
    expect(fs.existsSync(metricsPath(dir))).toBe(false);
    expect(fs.readFileSync(shellPath(dir), 'utf-8')).toBe(SHELL_MD);
  }));

  test('auto-resolve with frontmatter_patch: null → error, nothing written', withTmp(async (dir) => {
    const result = await apply(dir, {
      resolution_actions: [{ ...AUTO_RESOLVE, frontmatter_patch: null }],
    });
    expect(result.error).toBe('invalid_action:0:missing_frontmatter_patch');
    expect(fs.readFileSync(proposalPath(dir), 'utf-8')).toBe(PROPOSAL_MD);
    expect(fs.existsSync(metricsPath(dir))).toBe(false);
  }));

  // Stale-runner guard: a runner still emitting the removed field is rejected
  // outright rather than having its row silently dropped.
  test('a non-null metrics_event is rejected → error, nothing written', withTmp(async (dir) => {
    const result = await apply(dir, {
      resolution_actions: [{ ...AUTO_RESOLVE, metrics_event: '{"type":"resolved"}' }],
    });
    expect(result.error).toBe('invalid_action:0:metrics_event_rejected');
    expect(fs.readFileSync(proposalPath(dir), 'utf-8')).toBe(PROPOSAL_MD);
    expect(fs.existsSync(metricsPath(dir))).toBe(false);
  }));

  test('metrics_event: null is still accepted (field simply absent)', withTmp(async (dir) => {
    const result = await apply(dir, {
      resolution_actions: [{ ...AUTO_RESOLVE, metrics_event: null }],
    });
    expect(result.error).toBeUndefined();
    expect(result.applied).toEqual({ auto_resolve: 1, nudge: 0, skip: 0 });
  }));

  test('proposal_id with no matching file (PROP-999) → error', withTmp(async (dir) => {
    const result = await apply(dir, {
      resolution_actions: [{ ...AUTO_RESOLVE, proposal_id: 'PROP-999' }],
    });
    expect(result.error).toBe('invalid_action:0:no_such_proposal');
  }));

  test('malformed proposal_id shape (PROP-x) → error', withTmp(async (dir) => {
    const result = await apply(dir, {
      resolution_actions: [{ ...AUTO_RESOLVE, proposal_id: 'PROP-x' }],
    });
    expect(result.error).toBe('invalid_action:0:bad_proposal_id');
  }));

  test('malformed stdin → invalid_json, exit 1', withTmp(async (dir) => {
    const result = await apply(dir, 'not json');
    expect(result.error).toBe('invalid_json');
  }));
});

describe('apply-reflection-actions: edges', () => {
  test('prefix boundary: PROP-1 patches only PROP-1-*.md, never PROP-12-*.md', withTmp(async (dir) => {
    const mk = (id: string) => `---\nid: ${id}\nstatus: proposed\n---\n\nbody of ${id}\n`;
    const p1 = hermit(dir, 'proposals', 'PROP-1-a-000000.md');
    const p12 = hermit(dir, 'proposals', 'PROP-12-b-000000.md');
    fs.writeFileSync(p1, mk('PROP-1'));
    fs.writeFileSync(p12, mk('PROP-12'));
    const result = await apply(dir, {
      resolution_actions: [{
        proposal_id: 'PROP-1', action: 'auto-resolve',
        frontmatter_patch: { status: 'resolved' },
      }],
    });
    expect(result.error).toBeUndefined();
    expect(fs.readFileSync(p1, 'utf-8')).toMatch(/^status: resolved$/m);
    expect(fs.readFileSync(p12, 'utf-8')).toBe(mk('PROP-12'));
  }));

  // The ledger is line-delimited and every reader parses it line by line inside a
  // bare catch, so a row spilling over more than one physical line would be dropped
  // silently rather than erroring.
  test('auto-resolve writes exactly one well-formed resolved line', withTmp(async (dir) => {
    const result = await apply(dir, { resolution_actions: [AUTO_RESOLVE] });
    expect(result.error).toBeUndefined();
    expect(result.errors).toBeUndefined();

    const written = fs.readFileSync(metricsPath(dir), 'utf-8');
    expect(written.endsWith('\n')).toBe(true);
    expect(written.trimEnd().split('\n')).toHaveLength(1);

    const row = JSON.parse(written);
    expect(Object.keys(row)).toEqual(['ts', 'type', 'proposal_id']);
    expect(row.type).toBe('resolved');
    expect(row.proposal_id).toBe('PROP-042');
    expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  }));

  // Repeated results must never alter the frozen journal.
  test('repeated applies leave the frozen journal byte-identical', withTmp(async (dir) => {
    await apply(dir, { resolution_actions: [AUTO_RESOLVE] });
    const once = fs.readFileSync(shellPath(dir), 'utf-8');
    expect(once).toBe(SHELL_MD);
    // Stable across repeated runs — neither collapsing nor accumulating blank lines.
    await apply(dir, {
      resolution_actions: [{ ...AUTO_RESOLVE, shell_findings_line: '- [reflect] second line' }],
    });
    const twice = fs.readFileSync(shellPath(dir), 'utf-8');
    expect(twice).toBe(SHELL_MD);
  }));

  // patchFrontmatter is exported and the apply pass re-reads from disk, so the
  // validation pass is not a sufficient guarantee. Without the terminator guard,
  // slice(4, -1) absorbs the body into the frontmatter and discards it.
  test('proposal with no closing frontmatter delimiter is rejected, file untouched', withTmp(async (dir) => {
    const truncated = '---\nid: PROP-042\nstatus: proposed\n\nbody with no terminator\n';
    fs.writeFileSync(proposalPath(dir), truncated);
    const result = await apply(dir, { resolution_actions: [AUTO_RESOLVE] });
    expect(result.error).toBe('invalid_action:0:frontmatter_unparseable');
    expect(fs.readFileSync(proposalPath(dir), 'utf-8')).toBe(truncated);
  }));

  // Same exposure proposal.ts had: the sealed grant covers every argument, so
  // an unvalidated root let one pre-approved call resolve another project's
  // proposals. Verified reachable before the guard landed.
  test('refuses a state dir belonging to another project, writing nothing', withTmp(async (mine) => {
    const t = makeDir();
    try {
      const victim = t.dir;
      const before = fs.readFileSync(proposalPath(victim), 'utf-8');
      const r = await runScript('apply-reflection-actions.ts', {
        args: [hermit(victim)],
        env: { AGENT_DIR: hermit(mine) },
        stdin: JSON.stringify({ resolution_actions: [AUTO_RESOLVE] }),
      });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toStartWith('{"error":"foreign_state_dir:');
      expect(fs.readFileSync(proposalPath(victim), 'utf-8')).toBe(before);
    } finally {
      t.cleanup();
    }
  }));
});

// Reflect auto-resolves through its own frontmatter write rather than
// proposal.ts's patch verb, so it needs the same reconciliation: an ask parked
// on a proposal reflect just resolved is a question nobody can still answer.
describe('apply-reflection-actions: pending-ask reconciliation', () => {
  const microPath = (dir: string) => hermit(dir, 'state', 'micro-proposals.json');

  function seedAsk(dir: string, entry: Record<string, any>): void {
    fs.writeFileSync(microPath(dir), JSON.stringify({
      pending: [{
        id: 'MP-1', tier: 1, status: 'pending', follow_up_count: 0, ts: '2026-07-19T09:00:00Z',
        question: 'Suggestion #1 accepted — how should it be implemented?', ...entry,
      }],
    }, null, 2) + '\n');
  }
  const pending = (dir: string) => JSON.parse(fs.readFileSync(microPath(dir), 'utf-8')).pending;

  test('auto-resolve retires the ask linked to that proposal', withTmp(async (dir) => {
    seedAsk(dir, { proposal_id: 'PROP-042' });
    const result = await apply(dir, { resolution_actions: [AUTO_RESOLVE] });

    expect(result.error).toBeUndefined();
    expect(result.applied.auto_resolve).toBe(1);
    expect(result.errors).toBeUndefined();
    expect(pending(dir)).toHaveLength(0);
    expect(metricsRows(dir).filter(r => r.action === 'moot')).toHaveLength(1);
  }));

  test('an ask for a different proposal is left alone', withTmp(async (dir) => {
    seedAsk(dir, { proposal_id: 'PROP-999' });
    const result = await apply(dir, { resolution_actions: [AUTO_RESOLVE] });

    expect(result.error).toBeUndefined();
    expect(pending(dir)).toHaveLength(1);
  }));

  // The proposal really was resolved — the reconciliation miss is reported
  // without unmarking the write that already landed.
  test('a corrupt queue reports in errors without failing the resolve', withTmp(async (dir) => {
    fs.writeFileSync(microPath(dir), '{"pending": [ ,] }\n');
    const result = await apply(dir, { resolution_actions: [AUTO_RESOLVE] });

    expect(result.applied.auto_resolve).toBe(1);
    expect(result.errors.join(' ')).toContain('reconciliation');
    expect(fs.readFileSync(proposalPath(dir), 'utf-8')).toMatch(/^status: resolved$/m);
  }));
});
