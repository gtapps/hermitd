import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript, runProposal } from './helpers/run';
import { withDir } from './helpers/workdir';
import { decodeTask, encodeTask } from '../scripts/lib/tasks';
const stateArg = (dir: string) => path.join(dir, '.hermit');
const out = (result: { stdout: string }) => JSON.parse(result.stdout);
function seedState(dir: string, opts: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(stateArg(dir), 'config.json'), JSON.stringify({ routines: [], ...opts }));
}
function metricsLines(dir: string): any[] {
  const file = path.join(stateArg(dir), 'state', 'proposal-metrics.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
const stdin = 'Title: Repair config\nSource: reflect\nTags: ["config"]\n---\nFirst paragraph.\n\nSecond paragraph.\n';

test('CLI create prints one task receipt with metadata and dedupes replay', withDir(async dir => {
  seedState(dir);
  const result = await runProposal(stateArg(dir), ['create'], { stdin });
  expect(result.exitCode).toBe(0); expect(result.stderr).toBe('');
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  const receipt = out(result);
  expect(receipt).toMatchObject({ created: true }); expect(Object.keys(receipt)).toEqual(['id', 'handle', 'created']);
  const record = decodeTask(fs.readFileSync(path.join(stateArg(dir), 'tasks', receipt.id + '.md'), 'utf8'));
  expect(record.source).toBe('reflect');
  expect(record.body).toContain('First paragraph.\n\nSecond paragraph.\n');
  expect(out(await runProposal(stateArg(dir), ['create'], { stdin }))).toEqual({ ...receipt, created: false });
  expect(metricsLines(dir)).toHaveLength(1);
}));

for (const verb of ['patch', 'resolve', 'resolve-id', 'queue-micro', 'micro', 'index', 'list', 'success-signal']) test(`retired verb ${verb} is rejected`, withDir(async dir => {
  seedState(dir);
  const result = await runProposal(stateArg(dir), [verb]);
  expect(result.exitCode).toBe(1); expect(out(result)).toEqual({ error: 'unknown_verb' });
}));

test('anchor writes a digest and does not build an index', withDir(async dir => {
  seedState(dir);
  const result = await runProposal(stateArg(dir), ['anchor']);
  expect(result.exitCode).toBe(0);
  expect(Object.keys(out(result))).toEqual(['root', 'memory_dir']);
  expect(out(result).root).toBe(stateArg(dir));
  expect(JSON.parse(fs.readFileSync(path.join(stateArg(dir), 'state/proposal-digest.json'), 'utf8'))).toEqual({ proposals: [], total: 0, omitted: 0 });
  expect(fs.existsSync(path.join(stateArg(dir), 'state', 'proposals-index.json'))).toBe(false);
}));

test('foreign state roots are refused for readers and writers', withDir(async dir => {
  seedState(dir);
  for (const verb of ['create', 'anchor', 'gate', 'metrics']) {
    const result = await runScript('proposal.ts', { cwd: dir, env: { AGENT_DIR: stateArg(dir) }, args: [verb, '/foreign/hermit'], stdin });
    expect(result.exitCode).toBe(1);
    expect(out(result)).toEqual({ error: `foreign_state_dir:${stateArg(dir)}` });
  }
}));

test('metrics keeps the empty-ledger output and optional state root', withDir(async dir => {
  seedState(dir);
  const result = await runScript('proposal.ts', { cwd: dir, args: ['metrics'] });
  expect(result.exitCode).toBe(0); expect(out(result)).toEqual({ status: 'none', reason: 'no_metrics' });
}));

test('triage duplicate accepts a task handle', withDir(async dir => {
  seedState(dir);
  const result = await runProposal(stateArg(dir), ['gate', '--gate', 'triage', '--caller', 'reflect'], { stdin: 'Title: Repair\nVerdict: DUPLICATE: Repair — T-20261106-120000: already pending\n' });
  expect(result.exitCode).toBe(0); expect(out(result)).toEqual({ status: 'duplicate', id: 'T-20261106-120000' });
}));

describe('proposal.ts event', () => {
  function event(dir: string, ...args: string[]) {
    return runProposal(stateArg(dir), ['event', ...args]);
  }

  for (const action of ['accept', 'defer', 'dismiss']) {
    test(`responded --action=${action} writes one row`, withDir(async (dir) => {
      seedState(dir);
      const r = await event(dir, 'responded', '--id=T-20261106-120000', `--action=${action}`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('OK');
      const lines = metricsLines(dir);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ type: 'responded', proposal_id: 'T-20261106-120000', action });
      expect(lines[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }));
  }

  test('resolved writes {ts,type,proposal_id} and nothing else', withDir(async (dir) => {
    seedState(dir);
    const r = await event(dir, 'resolved', '--id=PROP-007');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('OK');
    const lines = metricsLines(dir);
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0])).toEqual(['ts', 'type', 'proposal_id']);
    expect(lines[0]).toMatchObject({ type: 'resolved', proposal_id: 'PROP-007' });
  }));

  test('the ledger is created lazily on first write', withDir(async (dir) => {
    seedState(dir);
    const ledger = path.join(stateArg(dir), 'state', 'proposal-metrics.jsonl');
    expect(fs.existsSync(ledger)).toBe(false);
    await event(dir, 'resolved', '--id=PROP-001');
    expect(fs.existsSync(ledger)).toBe(true);
  }));

  const errorCases: Array<[string, string[], string]> = [
    ['missing --id', ['responded', '--action=accept'], 'missing_id'],
    ['bad --action', ['responded', '--id=T-20261106-120000', '--action=maybe'], 'invalid_action:maybe'],
    ['--action on resolved', ['resolved', '--id=T-20261106-120000', '--action=accept'], 'action_not_allowed:resolved'],
    ['unknown event type', ['archived', '--id=T-20261106-120000'], 'unknown_event_type:archived'],
  ];
  for (const [label, args, expected] of errorCases) {
    test(`${label} -> ${expected}, exit 1, zero writes`, withDir(async (dir) => {
      seedState(dir);
      const r = await event(dir, ...args);
      expect(r.exitCode).toBe(1);
      expect(out(r)).toEqual({ error: expected });
      expect(metricsLines(dir)).toHaveLength(0);
    }));
  }
});

describe('proposal.ts routine', () => {
  function readConfig(dir: string): any {
    return JSON.parse(fs.readFileSync(path.join(stateArg(dir), 'config.json'), 'utf-8'));
  }

  test('appends to routines array, other config keys byte-preserved', withDir(async (dir) => {
    seedState(dir, { timezone: 'UTC', routines: [{ id: 'existing', schedule: '0 0 * * *', skill: 'x', enabled: true }] });
    const r = await runProposal(stateArg(dir), ['routine'], { stdin: JSON.stringify({ id: 'new-routine', schedule: '0 8 * * *', skill: 'brief', enabled: true }) });
    expect(out(r)).toEqual({ status: 'added', id: 'new-routine' });
    const cfg = readConfig(dir);
    expect(cfg.timezone).toBe('UTC');
    expect(cfg.routines).toHaveLength(2);
    expect(cfg.routines.find((x: any) => x.id === 'new-routine')).toBeTruthy();
  }));

  test('duplicate id replaces entry, status updated', withDir(async (dir) => {
    seedState(dir, { routines: [{ id: 'r1', schedule: '0 0 * * *', skill: 'old', enabled: false }] });
    const r = await runProposal(stateArg(dir), ['routine'], { stdin: JSON.stringify({ id: 'r1', schedule: '0 9 * * *', skill: 'new', enabled: true }) });
    expect(out(r)).toEqual({ status: 'updated', id: 'r1' });
    const cfg = readConfig(dir);
    expect(cfg.routines).toHaveLength(1);
    expect(cfg.routines[0].skill).toBe('new');
  }));

  test('invalid JSON / missing field -> error, config untouched', withDir(async (dir) => {
    seedState(dir);
    const before = fs.readFileSync(path.join(stateArg(dir), 'config.json'), 'utf-8');

    const r1 = await runProposal(stateArg(dir), ['routine'], { stdin: 'not json' });
    expect(r1.exitCode).toBe(1);
    expect(out(r1)).toEqual({ error: 'invalid_json' });

    const r2 = await runProposal(stateArg(dir), ['routine'], { stdin: JSON.stringify({ schedule: '0 0 * * *', skill: 'x', enabled: true }) });
    expect(out(r2)).toEqual({ error: 'missing_field:id' });

    expect(fs.readFileSync(path.join(stateArg(dir), 'config.json'), 'utf-8')).toBe(before);
  }));
});


test('anchor bounds the digest to the latest 50 proposals', withDir(async dir => {
  seedState(dir);
  const receipt = out(await runProposal(stateArg(dir), ['create'], { stdin }));
  const file = path.join(stateArg(dir), 'tasks', receipt.id + '.md');
  const record = decodeTask(fs.readFileSync(file, 'utf8'));
  fs.unlinkSync(file);
  for (let index = 0; index < 51; index++) {
    const id = 'T-20261101-1200' + String(index).padStart(2, '0');
    fs.writeFileSync(path.join(stateArg(dir), 'tasks', id + '.md'), encodeTask({ ...record, id }));
  }
  expect((await runProposal(stateArg(dir), ['anchor'])).exitCode).toBe(0);
  const digest = JSON.parse(fs.readFileSync(path.join(stateArg(dir), 'state/proposal-digest.json'), 'utf8'));
  expect(digest.total).toBe(51);
  expect(digest.omitted).toBe(1);
  expect(digest.proposals).toHaveLength(50);
  expect(digest.proposals[0].id).toBe('T-20261101-120001');
}));

test('inventory failure removes a stale digest', withDir(async dir => {
  seedState(dir);
  await runProposal(stateArg(dir), ['anchor']);
  fs.mkdirSync(path.join(stateArg(dir), 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(stateArg(dir), 'tasks', 'broken.md'), 'invalid');
  const result = await runProposal(stateArg(dir), ['anchor']);
  expect(out(result)).toEqual({ error: 'inventory_read_failed' });
  expect(fs.existsSync(path.join(stateArg(dir), 'state/proposal-digest.json'))).toBe(false);
}));
