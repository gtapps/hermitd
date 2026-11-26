import { describe, test, expect, spyOn, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { verbCreate, verbRoutine, grabHeader, parseStringArray, proposalDigest } from '../scripts/proposal';
import { decodeTask, mutateTask } from '../scripts/lib/tasks';
import { withDir, setupWorkdir, type Workdir, hermit, write } from './helpers/workdir';
import os from 'node:os';
import { runProposal } from './helpers/run';

function seed(dir: string): string {
  const base = path.join(dir, '.hermit');
  fs.writeFileSync(path.join(base, 'config.json'), '{}');
  return base;
}
const body = '## Context\nEvidence.\n\n## Proposed Solution\nChange it.\n';
const input = (title = 'Ship the thing') => `Title: ${title}\nSource: auto-detected\nCategory: improvement\nTags: ["architecture"]\n---\n${body}`;

describe('task-backed proposal creation', () => {
  test('one receipt, complete metadata, verbatim proposal, and replay-safe created metrics', withDir(async dir => {
    const base = seed(dir);
    const receipt = verbCreate(base, input());
    expect(Object.keys(receipt)).toEqual(['id', 'handle', 'created']);
    expect(receipt.created).toBe(true);
    expect(receipt.id).toMatch(/^T-\d{8}-\d{6}(-[a-z0-9])?$/);
    const record = decodeTask(fs.readFileSync(path.join(base, 'tasks', receipt.id + '.md'), 'utf8'));
    expect(record).toMatchObject({ requester: 'agent', kind: 'proposal', approver: null, source: 'auto-detected', category: 'improvement', tags: '["architecture"]', waiting_on: 'admin', dedupe_key: 'proposal:ship-thing' });
    expect(record.body).toContain('## Proposal\n' + body);
    expect(JSON.parse(record.decision!)).toEqual({ purpose: 'consent', authority: 'admin', generation: 1 });
    expect(verbCreate(base, input())).toEqual({ ...receipt, created: false });
    const rows = fs.readFileSync(path.join(base, 'state', 'proposal-metrics.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'created', proposal_id: receipt.id, source: record.source, category: record.category, tags: ['architecture'] });
    expect(fs.existsSync(path.join(base, 'proposals'))).toBe(false);
  }));
  test('custom resume and dedupe key survive open and cancelled replays', withDir(async dir => {
    const base = seed(dir);
    const resume = '/hermitd:make-me-proactive apply';
    const headers = `Resume: ${resume}\nDedupe-Key: proactive:supplier-price\n`;
    const receipt = verbCreate(base, headers + input('Supplier price'));
    const record = decodeTask(fs.readFileSync(path.join(base, 'tasks', receipt.id + '.md'), 'utf8'));
    expect(record.dedupe_key).toBe('proactive:supplier-price');
    expect(JSON.parse(record.decision!)).toEqual({ purpose: 'consent', authority: 'admin', generation: 1, resume });
    const replay = () => verbCreate(base, headers + input('Renamed supplier price'));
    expect(replay()).toEqual({ ...receipt, created: false });
    mutateTask(base, 'answer', receipt.id, { local: true, reply: 'no' }, '');
    expect(decodeTask(fs.readFileSync(path.join(base, 'tasks', receipt.id + '.md'), 'utf8')).closed_by).toBe('cancelled');
    expect(replay()).toEqual({ ...receipt, created: false });
  }));

  test('Self-Eval-Key takes precedence over Dedupe-Key', withDir(async dir => {
    const base = seed(dir);
    const receipt = verbCreate(base, 'Self-Eval-Key: sample\nDedupe-Key: proactive:supplier-price\n' + input());
    const record = decodeTask(fs.readFileSync(path.join(base, 'tasks', receipt.id + '.md'), 'utf8'));
    expect(record.dedupe_key).toBe('self-eval:sample');
  }));

  test.each([
    ['Title: x\nbody', 'missing_separator'],
    ['Title: x\n---\n ', 'empty_body'],
    ['Source: manual\n---\nx', 'missing_title'],
    ['Title: x\nCategory: other\n---\nx', 'invalid_category:improvement|routine|capability|constraint|bug'],
    ['Title: x\nTags: [1]\n---\nx', 'invalid_tags'],
    ['Title: x\nRelated-Sessions: {}\n---\nx', 'invalid_related_sessions'],
  ])('invalid input writes nothing: %s', (stdin, error) => withDir(async dir => {
    const base = seed(dir);
    expect(verbCreate(base, stdin)).toEqual({ error });
    expect(fs.existsSync(path.join(base, 'tasks'))).toBe(false);
    expect(fs.existsSync(path.join(base, 'state', 'proposal-metrics.jsonl'))).toBe(false);
  })());
  test('metrics failure warns without losing or duplicating the task', withDir(async dir => {
    const base = seed(dir);
    fs.mkdirSync(path.join(base, 'state', 'proposal-metrics.jsonl'));
    const receipt = verbCreate(base, input());
    expect(receipt.warnings).toEqual(['metrics_append_failed']);
    expect(decodeTask(fs.readFileSync(path.join(base, 'tasks', receipt.id + '.md'), 'utf8')).kind).toBe('proposal');
    expect(receipt.created).toBe(true);
    expect(verbCreate(base, input())).toEqual({ id: receipt.id, handle: receipt.handle, created: false });
  }));
  test('a failed record write never appends a created event', withDir(async dir => {
    const base = seed(dir);
    fs.writeFileSync(path.join(base, 'tasks'), 'blocked');
    expect(verbCreate(base, input()).error).toBeTruthy();
    expect(fs.existsSync(path.join(base, 'state', 'proposal-metrics.jsonl'))).toBe(false);
  }));
});

describe('proposal inventory digest', () => {
  test('includes open, cancelled and completed records and bounds its output', withDir(async dir => {
    const base = seed(dir);
    const first = verbCreate(base, input('Open'));
    const second = verbCreate(base, input('Dismissed'));
    const third = verbCreate(base, input('Completed'));
    fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify({ channels: { discord: { operators: ['admin'] } } }));
    mutateTask(base, 'answer', second.id, { chat: 'discord:home', user: 'admin', reply: 'no' }, '');
    mutateTask(base, 'answer', third.id, { chat: 'discord:home', user: 'admin', reply: 'yes' }, '');
    mutateTask(base, 'close', third.id, { by: 'confirmed', chat: 'discord:home', user: 'admin', 'reason-stdin': true }, 'Done');
    proposalDigest(base);
    const digest = JSON.parse(fs.readFileSync(path.join(base, 'state', 'proposal-digest.json'), 'utf8'));
    expect(digest.proposals.map((record: any) => record.id)).toContain(first.id);
    expect(digest.proposals.find((record: any) => record.id === second.id).closed_by).toBe('cancelled');
    expect(digest.proposals.find((record: any) => record.id === third.id).closed_by).toBe('confirmed');
    expect(digest.total).toBe(3);
  }));
  test('unreadable inventory never becomes an empty digest', withDir(async dir => {
    const base = seed(dir); verbCreate(base, input());
    const read = fs.readdirSync;
    const spy = spyOn(fs, 'readdirSync').mockImplementation(((directory: any, options: any) => {
      if (String(directory) === path.join(base, 'tasks')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return read(directory, options);
    }) as typeof fs.readdirSync);
    try { expect(proposalDigest(base)).toEqual({ error: 'inventory_read_failed' }); }
    finally { spy.mockRestore(); }
  }));
});

describe('the remaining write verbs', () => {
  test('routine upserts by id', withDir(async (dir) => {
    const base = seed(dir);
    const entry = { id: 'daily-brief', schedule: '0 8 * * *', skill: 'brief', enabled: true };

    expect(verbRoutine(base, JSON.stringify(entry))).toEqual({ status: 'added', id: 'daily-brief' });
    expect(verbRoutine(base, JSON.stringify({ ...entry, enabled: false }))).toEqual({ status: 'updated', id: 'daily-brief' });

    const config = JSON.parse(fs.readFileSync(path.join(base, 'config.json'), 'utf-8'));
    expect(config.routines).toHaveLength(1);
    expect(config.routines[0].enabled).toBe(false);
  }));

  test.each([
    ['malformed JSON', 'not json', { error: 'invalid_json' }],
    ['a JSON array', '[]', { error: 'invalid_json' }],
    ['a missing field', '{"id":"x","schedule":"* * * * *","skill":"brief"}', { error: 'missing_field:enabled' }],
    ['a blank id', '{"id":"","schedule":"* * * * *","skill":"brief","enabled":true}', { error: 'missing_field:id' }],
  ])('routine rejects %s', (_name, stdin, expected) => withDir(async (dir) => {
    expect(verbRoutine(seed(dir), stdin as string)).toEqual(expected);
  })());
});


test('header parsing preserves validation distinctions', () => {
  expect(grabHeader('Title: x\nNotTitle: y', 'Title')).toBe('x');
  expect(parseStringArray(null)).toEqual([]);
  expect(parseStringArray('["x"]')).toEqual(['x']);
  expect(parseStringArray('[1]')).toBeNull();
});

describe('proposal gate', () => {
  async function gate(dir: string, opts: { gate: 'triage' | 'judge'; caller?: string; evidenceSource?: string; tags?: string[] }, title: string, verdict: string) {
    const args = ['gate', '--gate', opts.gate, '--caller', opts.caller ?? 'reflect'];
    if (opts.evidenceSource) args.push('--evidence-source', opts.evidenceSource);
    if (opts.tags) args.push('--tags', JSON.stringify(opts.tags));
    const r = await runProposal(hermit(dir), args, { stdin: `Title: ${title}\nVerdict: ${verdict}\n` });
    const out = JSON.parse(r.stdout);
    expect(r.exitCode).toBe('error' in out ? 1 : 0);
    return out;
  }
  function ledgerLines(dir: string): any[] {
    const p = hermit(dir, 'state', 'proposal-metrics.jsonl');
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  }

  test('gate (triage CREATE -> create + triage-verdict event)', withDir(async (dir) => {
    const out = await gate(dir, { gate: 'triage', caller: 'proposal-create', evidenceSource: 'capability-brainstorm', tags: ['capability-brainstorm'] }, 'Foo', 'CREATE: Foo');
    expect(out).toEqual({ status: 'create' });
    const lines = ledgerLines(dir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: 'triage-verdict', verdict: 'CREATE', caller: 'proposal-create', evidence_source: 'capability-brainstorm', tags: ['capability-brainstorm'] });
  }));

  test('gate (triage SUPPRESS -> suppress with code)', withDir(async (dir) => {
    const out = await gate(dir, { gate: 'triage' }, 'Foo', 'SUPPRESS: Foo — weak-recurrence: one-off ("excerpt")');
    expect(out).toEqual({ status: 'suppress', code: 'weak-recurrence' });
    expect(ledgerLines(dir)[0]).toMatchObject({ type: 'triage-verdict', verdict: 'SUPPRESS' });
  }));

  test('gate (triage DUPLICATE -> duplicate with PROP-ID)', withDir(async (dir) => {
    const out = await gate(dir, { gate: 'triage' }, 'Foo', 'DUPLICATE: Foo — PROP-019: same problem');
    expect(out).toEqual({ status: 'duplicate', id: 'PROP-019' });
    expect(ledgerLines(dir)[0]).toMatchObject({ type: 'triage-verdict', verdict: 'DUPLICATE' });
  }));

  test('gate (triage SUPPRESS with the reason dropped -> suppress with code)', withDir(async (dir) => {
    const out = await gate(dir, { gate: 'triage' }, 'Foo', 'SUPPRESS: Foo — weak-consequence');
    expect(out).toEqual({ status: 'suppress', code: 'weak-consequence' });
    expect(ledgerLines(dir)[0]).toMatchObject({ type: 'triage-verdict', verdict: 'SUPPRESS' });
  }));

  test('gate (triage SUPPRESS with only the excerpt kept -> suppress with code)', withDir(async (dir) => {
    const out = await gate(dir, { gate: 'triage' }, 'Foo', 'SUPPRESS: Foo — weak-consequence ("one-off")');
    expect(out).toEqual({ status: 'suppress', code: 'weak-consequence' });
  }));

  test('gate (triage SUPPRESS ending in title words, no code -> gate-failed)', withDir(async (dir) => {
    const out = await gate(dir, { gate: 'triage' }, 'Cache layer — eviction', 'SUPPRESS: Cache layer — eviction');
    expect(out).toEqual({ status: 'gate_failed' });
    expect(ledgerLines(dir)[0]).toMatchObject({ type: 'gate-failed', agent: 'proposal-triage' });
  }));

  test('gate (triage DUPLICATE with the reason dropped -> duplicate with PROP-ID)', withDir(async (dir) => {
    const out = await gate(dir, { gate: 'triage' }, 'Foo', 'DUPLICATE: Foo — PROP-019-cache-103612');
    expect(out).toEqual({ status: 'duplicate', id: 'PROP-019-cache-103612' });
    expect(ledgerLines(dir)[0]).toMatchObject({ type: 'triage-verdict', verdict: 'DUPLICATE' });
  }));

  test('gate (triage DUPLICATE with a PROP-ID in the title -> the verdict PROP-ID wins)', withDir(async (dir) => {
    const out = await gate(dir, { gate: 'triage' }, 'Fix — PROP-012 regression', 'DUPLICATE: Fix — PROP-012 regression — PROP-019');
    expect(out).toEqual({ status: 'duplicate', id: 'PROP-019' });
  }));

  test('gate (triage garbled verdict -> gate-failed + gate-failed event)', withDir(async (dir) => {
    const out = await gate(dir, { gate: 'triage' }, 'Foo', 'garbled nonsense');
    expect(out).toEqual({ status: 'gate_failed' });
    expect(ledgerLines(dir)[0]).toMatchObject({ type: 'gate-failed', agent: 'proposal-triage', title: 'Foo', verdict: 'garbled nonsense' });
  }));

  test('gate (triage GATE_BLIND -> gate-failed, blind line kept in the gate-failed event)', withDir(async (dir) => {
    const out = await gate(dir, { gate: 'triage' }, 'Foo', 'GATE_BLIND: Foo — missing Anchor: line');
    expect(out).toEqual({ status: 'gate_failed' });
    expect(ledgerLines(dir)[0]).toMatchObject({ type: 'gate-failed', verdict: 'GATE_BLIND: Foo — missing Anchor: line' });
  }));

  test('gate (gate-failed event caps the stored verdict at 200 chars)', withDir(async (dir) => {
    await gate(dir, { gate: 'triage' }, 'Foo', 'x'.repeat(500));
    expect(ledgerLines(dir)[0].verdict).toBe('x'.repeat(200));
  }));

  test('gate (judge ACCEPT -> accept, no ledger event)', withDir(async (dir) => {
    const out = await gate(dir, { gate: 'judge' }, 'Bar', 'ACCEPT: Bar');
    expect(out).toEqual({ status: 'accept' });
    expect(ledgerLines(dir)).toHaveLength(0);
  }));

  test('gate (judge ACCEPT with source tag)', withDir(async (dir) => {
    expect(await gate(dir, { gate: 'judge' }, 'Bar', 'ACCEPT (current-session): Bar')).toEqual({ status: 'accept' });
  }));

  test('gate (judge DOWNGRADE -> downgrade with tier)', withDir(async (dir) => {
    const out = await gate(dir, { gate: 'judge' }, 'Bar', 'DOWNGRADE:2: Bar — weak-recurrence');
    expect(out).toEqual({ status: 'downgrade', tier: 2 });
  }));

  test('gate (judge DOWNGRADE quarantine — tier passes through as-is)', withDir(async (dir) => {
    const out = await gate(dir, { gate: 'judge' }, 'Bar', 'DOWNGRADE:3 (current-session): Bar — quarantine: external origin');
    expect(out).toEqual({ status: 'downgrade', tier: 3 });
  }));

  test('gate (judge SUPPRESS -> suppress with code, no ledger event)', withDir(async (dir) => {
    const out = await gate(dir, { gate: 'judge' }, 'Bar', 'SUPPRESS: Bar — no-sessions: no cross-session evidence cited');
    expect(out).toEqual({ status: 'suppress', code: 'no-sessions' });
    expect(ledgerLines(dir)).toHaveLength(0);
  }));

  test('gate (judge SUPPRESS with the reason dropped -> suppress with code)', withDir(async (dir) => {
    const out = await gate(dir, { gate: 'judge' }, 'Bar', 'SUPPRESS (current-session): Bar — no-evidence');
    expect(out).toEqual({ status: 'suppress', code: 'no-evidence' });
  }));

  test('gate (judge SUPPRESS with the reason dropped and the capped suffix -> suppress with code)', withDir(async (dir) => {
    const out = await gate(dir, { gate: 'judge' }, 'Bar', 'SUPPRESS: Bar — no-evidence (evidence-capped)');
    expect(out).toEqual({ status: 'suppress', code: 'no-evidence' });
  }));

  test('gate (judge SUPPRESS ending in title words, no code -> gate-failed)', withDir(async (dir) => {
    const out = await gate(dir, { gate: 'judge' }, 'Retry storm — backoff', 'SUPPRESS: Retry storm — backoff');
    expect(out).toEqual({ status: 'gate_failed' });
    expect(ledgerLines(dir)[0]).toMatchObject({ type: 'gate-failed', agent: 'reflection-judge' });
  }));

  test('gate (judge empty verdict -> gate-failed + gate-failed event tagged reflection-judge)', withDir(async (dir) => {
    const out = await gate(dir, { gate: 'judge' }, 'Bar', '');
    expect(out).toEqual({ status: 'gate_failed' });
    expect(ledgerLines(dir)[0]).toMatchObject({ type: 'gate-failed', agent: 'reflection-judge', title: 'Bar', verdict: '' });
  }));

  test('gate (judge GATE_BLIND -> gate-failed, blind line kept in the gate-failed event)', withDir(async (dir) => {
    const out = await gate(dir, { gate: 'judge' }, 'Bar', 'GATE_BLIND: Bar — missing Anchor: line');
    expect(out).toEqual({ status: 'gate_failed' });
    expect(ledgerLines(dir)[0]).toMatchObject({ type: 'gate-failed', agent: 'reflection-judge', verdict: 'GATE_BLIND: Bar — missing Anchor: line' });
  }));

  test('gate (invalid --gate value -> gate-failed)', withDir(async (dir) => {
    const out = await gate(dir, { gate: 'bogus' as any }, 'Foo', 'CREATE: Foo');
    expect(out).toEqual({ status: 'gate_failed' });
  }));

  test('gate (missing state/ subdir does not crash — creates it before appending)', async () => {
    // Regression: appendJsonlLine's fs.appendFileSync throws ENOENT if state/ doesn't
    // exist yet, which would crash a recognized verdict instead of routing it.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'record-gate-nodir-'));
    try {
      const r = await runProposal(dir, ['gate', '--gate', 'triage', '--caller', 'test'], { stdin: 'Title: Foo\nVerdict: CREATE: Foo\n' });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ status: 'create' });
      const line = JSON.parse(fs.readFileSync(path.join(dir, 'state', 'proposal-metrics.jsonl'), 'utf-8').trim());
      expect(line).toMatchObject({ type: 'triage-verdict', verdict: 'CREATE' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('proposal metrics', () => {
  const runReport = async (dir: string, ...extra: string[]) => {
    const r = await runProposal(hermit(dir), ['metrics', ...extra]);
    expect(r.exitCode).toBe(0);
    return JSON.parse(r.stdout);
  };
  const metricsFile = (dir: string) => hermit(dir, 'state', 'proposal-metrics.jsonl');

  // Missing / empty file — fails open
  test('metrics (missing file exits 0)', withDir(async (dir) => {
    expect(await runReport(dir)).toEqual({ status: 'none', reason: 'no_metrics' });
  }));

  test('metrics (empty file exits 0)', withDir(async (dir) => {
    write(metricsFile(dir), '');
    expect(await runReport(dir, '--source=reflect')).toEqual({ status: 'none', reason: 'no_metrics' });
  }));

  // Insufficient sample (<8)
  test('metrics --source (insufficient_data, n<8)', withDir(async (dir) => {
    // 3 triage-verdicts from brainstorm + 2 created tagged brainstorm, 1 accepted
    write(metricsFile(dir), [
      '{"ts":"2026-01-01T00:00:00Z","type":"triage-verdict","verdict":"CREATE","caller":"proposal-create","evidence_source":"capability-brainstorm","tags":["capability-brainstorm"]}',
      '{"ts":"2026-01-01T00:01:00Z","type":"triage-verdict","verdict":"SUPPRESS","caller":"proposal-create","evidence_source":"capability-brainstorm","tags":["capability-brainstorm"]}',
      '{"ts":"2026-01-01T00:02:00Z","type":"triage-verdict","verdict":"SUPPRESS","caller":"proposal-create","evidence_source":"capability-brainstorm","tags":["capability-brainstorm"]}',
      '{"ts":"2026-01-01T01:00:00Z","type":"created","proposal_id":"PROP-001","source":"auto-detected","category":"capability","tags":["capability-brainstorm"]}',
      '{"ts":"2026-01-01T02:00:00Z","type":"created","proposal_id":"PROP-002","source":"auto-detected","category":"capability","tags":["capability-brainstorm"]}',
      '{"ts":"2026-01-01T03:00:00Z","type":"responded","proposal_id":"PROP-001","action":"accept"}',
      '',
    ].join('\n'));
    expect(await runReport(dir, '--source=capability-brainstorm')).toEqual({
      source: 'capability_brainstorm',
      status: 'insufficient_data',
      sample: 3,
      min_sample: 8,
      triage_survival_pct: 33,
      triage_created: 1,
      triage_total: 3,
      kill_survival_pct: 25,
      acceptance_pct: 50,
      accepted: 1,
      created: 2,
      kill_acceptance_pct: 30,
    });
  }));

  // Full sample (>=8) — correct rates and kill verdict
  // 10 triage-verdicts: 4 CREATE, 6 SUPPRESS → survival 40%
  // 4 created tagged, 1 accepted → acceptance 25% → kill (acceptance < 30%)
  describe('full sample', () => {
    let wd: Workdir;
    let out: any;

    beforeAll(async () => {
      wd = setupWorkdir();
      const lines: string[] = [];
      for (let i = 1; i <= 4; i++) {
        lines.push(`{"ts":"2026-01-01T00:0${i}Z","type":"triage-verdict","verdict":"CREATE","caller":"proposal-create","evidence_source":"capability-brainstorm","tags":["capability-brainstorm"]}`);
      }
      for (let i = 5; i <= 10; i++) {
        lines.push(`{"ts":"2026-01-01T00:0${i}Z","type":"triage-verdict","verdict":"SUPPRESS","caller":"proposal-create","evidence_source":"capability-brainstorm","tags":["capability-brainstorm"]}`);
      }
      for (let i = 1; i <= 4; i++) {
        lines.push(`{"ts":"2026-01-01T01:0${i}Z","type":"created","proposal_id":"PROP-00${i}","source":"auto-detected","category":"capability","tags":["capability-brainstorm"]}`);
      }
      lines.push('{"ts":"2026-01-01T02:00:00Z","type":"responded","proposal_id":"PROP-001","action":"accept"}');
      write(metricsFile(wd.dir), lines.join('\n') + '\n');
      out = await runReport(wd.dir, '--source=capability-brainstorm');
    });
    afterAll(() => wd.cleanup());

    test('metrics --source (survival 40%)', () => {
      expect(out).toMatchObject({ triage_survival_pct: 40, triage_created: 4, triage_total: 10, sample: 10 });
    });
    test('metrics --source (acceptance 25%)', () => {
      expect(out).toMatchObject({ acceptance_pct: 25, accepted: 1, created: 4 });
    });
    test('metrics --source (kill verdict)', () => {
      expect(out.status).toBe('kill');
      expect(out.kill_reasons).toEqual(['acceptance']);
    });
  });

  // Default mode — every segment appears as an object
  describe('segments mode', () => {
    let wd: Workdir;
    let out: any;

    beforeAll(async () => {
      wd = setupWorkdir();
      write(metricsFile(wd.dir), [
        '{"ts":"2026-01-01T00:01:00Z","type":"triage-verdict","verdict":"CREATE","caller":"reflect"}',
        '{"ts":"2026-01-01T00:02:00Z","type":"triage-verdict","verdict":"SUPPRESS","caller":"reflect"}',
        '{"ts":"2026-01-01T01:00:00Z","type":"created","proposal_id":"PROP-R1","source":"auto-detected","category":"improvement","tags":[]}',
        '{"ts":"2026-01-01T02:00:00Z","type":"responded","proposal_id":"PROP-R1","action":"accept"}',
        '',
      ].join('\n'));
      out = await runReport(wd.dir);
    });
    afterAll(() => wd.cleanup());

    test('metrics segments (every source, snake_case)', () => {
      expect(out.segments.map((s: any) => s.source)).toEqual(['reflect', 'capability_brainstorm', 'scheduled_check']);
    });
    test('metrics segments (reflect rates)', () => {
      expect(out.segments[0]).toMatchObject({ status: 'insufficient_data', triage_survival_pct: 50, acceptance_pct: 100, accepted: 1, created: 1 });
    });
    test('metrics segments (zero denominators are null)', () => {
      expect(out.segments[1]).toMatchObject({ triage_survival_pct: null, acceptance_pct: null, sample: 0 });
    });
    test('metrics segments (scheduled-check omits the acceptance keys)', () => {
      const sched = out.segments[2];
      for (const key of ['acceptance_pct', 'accepted', 'created', 'kill_acceptance_pct']) expect(sched).not.toHaveProperty(key);
      expect(sched).not.toHaveProperty('kill_reasons');
    });
  });

  // Malformed line is skipped; valid events still counted
  test('metrics (malformed line skipped)', withDir(async (dir) => {
    write(metricsFile(dir), [
      'this is not json at all',
      '{"ts":"2026-01-01T00:01:00Z","type":"triage-verdict","verdict":"CREATE","caller":"reflect"}',
      '',
    ].join('\n'));
    expect((await runReport(dir)).segments[0]).toMatchObject({ triage_created: 1, triage_total: 1 });
  }));

  // --source with an unknown key is an error at exit 1
  test('metrics (unknown --source key)', withDir(async (dir) => {
    write(metricsFile(dir),
      '{"ts":"2026-01-01T00:01:00Z","type":"triage-verdict","verdict":"CREATE","caller":"reflect"}\n');
    const r = await runProposal(hermit(dir), ['metrics', '--source=nonexistent']);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: 'unknown_source:nonexistent' });
  }));

  test('metrics (unreadable file is metrics_failed at exit 1)', withDir(async (dir) => {
    fs.mkdirSync(metricsFile(dir), { recursive: true });
    const r = await runProposal(hermit(dir), ['metrics']);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: 'metrics_failed' });
  }));
});
