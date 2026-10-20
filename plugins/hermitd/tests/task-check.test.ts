import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { readFrontmatter } from '../scripts/lib/frontmatter';
import { taskFixture } from './helpers/tasks';
import { runScript } from './helpers/run';
import { decodeTask, mutateTask } from '../scripts/lib/tasks';

test('stored command closes by check and failing checks keep the task open', async () => {
  const f = taskFixture();
  try {
    for (const code of [1, 0]) {
      const { id } = await f.open(['--check', `printf proof; exit ${code}`]);
      const result = await runScript('task-check.ts', { cwd: f.dir + '/..', env: { AGENT_DIR: f.dir }, args: [id] });
      expect(result.exitCode).toBe(0);
      const record = decodeTask(f.text(id));
      expect(record.closed_by).toBe(code === 0 ? 'check' : null);
      expect(record.body).toContain('proof');
    }
  } finally { f.cleanup(); }
});

test('changing a check, its definition or status refuses the old snapshot', async () => {
  const f = taskFixture();
  try {
    const { id } = await f.open(['--check', 'true']);
    const snapshot = await f.ok('check-snapshot', [id]);
    await f.ok('note', [id, '--check', 'false']);
    expect(() => mutateTask(f.dir, 'check-result', id, { 'result-rev': String(snapshot.result_rev), exit: '0', 'output-stdin': true }, 'proof')).toThrow('stale_check');
    await f.ok('note', [id, '--check', 'clear']);
    expect((await f.ok('list', ['--with-check'])).rows).toEqual([]);
    const { id: redefined } = await f.open(['--check', 'true']);
    await f.ok('note', [redefined, '--done', 'New definition', '--actor', 'discord:u1']);
    expect(decodeTask(f.text(redefined)).check).toBeNull();
    expect((await f.ok('list', ['--with-check'])).rows).toEqual([]);
    const { id: replaced } = await f.open(['--check', 'true']);
    await f.ok('note', [replaced, '--done', 'New definition', '--actor', 'discord:u1', '--check', 'false']);
    expect(decodeTask(f.text(replaced)).check).toBe('false');
    expect((await f.ok('list', ['--with-check'])).rows.map((row: { id: string }) => row.id)).toEqual([replaced]);
  } finally { f.cleanup(); }
});

test('task.ts exposes no check-result verb, so only a real check run closes by check', async () => {
  const f = taskFixture();
  try {
    const { id } = await f.open(['--check', 'false']);
    const r = await f.run('check-result', [id, '--result-rev', '0', '--exit', '0', '--output-stdin'], 'proof');
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: 'invalid_verb' });
    expect(decodeTask(f.text(id)).status).toBe('open');
  } finally { f.cleanup(); }
});

test('a finishing record closes by check once its outcome is observed', async () => {
  const f = taskFixture();
  try {
    const { id } = await f.open();
    await f.ok('block', [id, '--result-stdin'], 'Approved, waiting for the merge');
    await f.ok('note', [id, '--check', 'printf merged', '--clear-waiting']);
    expect((await f.ok('list', ['--id', id])).rows[0].listing).toEqual(['finishing']);
    const result = await runScript('task-check.ts', { cwd: f.dir + '/..', env: { AGENT_DIR: f.dir }, args: [id] });
    expect(result.exitCode).toBe(0);
    expect(decodeTask(f.text(id)).closed_by).toBe('check');
  } finally { f.cleanup(); }
});

for (const scenario of [
  { status: 'accepted', key: 'proposal:PROP-014', check: 'true', resolves: true },
  { status: 'proposed', key: 'proposal:PROP-014', check: 'true', resolves: true },
  { status: 'accepted', key: 'proposal:PROP-014', check: 'false', resolves: false },
  { status: 'accepted', key: 'helper:PROP-014', check: 'true', resolves: false },
  { status: 'accepted', key: null, check: 'true', resolves: false },
  { status: 'resolved', key: 'proposal:PROP-014', check: 'true', resolves: false },
  { status: 'deferred', key: 'proposal:PROP-014', check: 'true', resolves: false },
  { status: 'accepted', key: 'proposal:PROP-999', check: 'true', resolves: false },
]) {
  test(`proposal resolution: ${scenario.status}, ${scenario.key}, check ${scenario.check}`, async () => {
    const f = taskFixture();
    try {
      const proposal = path.join(f.dir, 'proposals', 'PROP-014-test.md');
      fs.mkdirSync(path.dirname(proposal), { recursive: true });
      const original = `---\ntitle: Test proposal\nstatus: ${scenario.status}\n---\n\n## Operator Decision\n`;
      fs.writeFileSync(proposal, original);
      const { id } = await f.open(['--check', scenario.check,
        ...(scenario.key ? ['--dedupe-key', scenario.key] : [])]);
      const result = await runScript('task-check.ts', { cwd: f.dir + '/..', env: { AGENT_DIR: f.dir }, args: [id] });
      expect(result.exitCode).toBe(0);
      const digest = JSON.parse(result.stdout);
      expect(digest.proposal_resolve_error).toBeUndefined();
      expect(decodeTask(f.text(id)).closed_by).toBe(scenario.check === 'true' ? 'check' : null);
      const metrics = path.join(f.dir, 'state', 'proposal-metrics.jsonl');
      if (scenario.resolves) {
        expect(digest.proposal_resolved).toBe('PROP-014');
        const fm = readFrontmatter(proposal)!;
        expect(fm.status).toBe('resolved');
        expect(fm.resolved_date).toBeTruthy();
        const record = decodeTask(f.text(id));
        expect(fs.readFileSync(proposal, 'utf8')).toContain(`record ${id} closed by its check: ${record.closed_reason}.`);
        const rows = fs.readFileSync(metrics, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(rows.at(-1)).toMatchObject({ type: 'resolved', proposal_id: 'PROP-014' });
        expect(fs.existsSync(path.join(f.dir, 'state', 'compact-requested.json'))).toBe(true);
        if (scenario.status === 'proposed') {
          expect(fm.accepted_date).toBeTruthy();
          expect(fm.responded).toBe('true');
          expect(rows).toHaveLength(2);
          expect(rows[0]).toMatchObject({ type: 'responded', proposal_id: 'PROP-014', action: 'accept' });
        } else {
          expect(rows).toHaveLength(1);
        }
      } else {
        expect(digest.proposal_resolved).toBeUndefined();
        expect(fs.readFileSync(proposal, 'utf8')).toBe(original);
        expect(fs.existsSync(metrics)).toBe(false);
      }
    } finally { f.cleanup(); }
  });
}

test('a proposal patch failure is reported without failing the task close', async () => {
  const f = taskFixture();
  try {
    const proposal = path.join(f.dir, 'proposals', 'PROP-014.md');
    fs.mkdirSync(path.dirname(proposal), { recursive: true });
    const original = '---\nstatus: accepted\n---\nNo decision section.\n';
    fs.writeFileSync(proposal, original);
    const { id } = await f.open(['--check', 'true', '--dedupe-key', 'proposal:PROP-014']);
    const result = await runScript('task-check.ts', { cwd: f.dir + '/..', env: { AGENT_DIR: f.dir }, args: [id] });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ closed_by: 'check', proposal_resolve_error: 'no_operator_decision_section' });
    expect(fs.readFileSync(proposal, 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(f.dir, 'state', 'proposal-metrics.jsonl'))).toBe(false);
    expect(decodeTask(f.text(id)).closed_by).toBe('check');
  } finally { f.cleanup(); }
});

test('a held later claim closing a proposal record by check resolves the proposal', async () => {
  const f = taskFixture();
  try {
    const proposal = path.join(f.dir, 'proposals', 'PROP-014-test.md');
    fs.mkdirSync(path.dirname(proposal), { recursive: true });
    fs.writeFileSync(proposal, '---\ntitle: Test proposal\nstatus: accepted\n---\n\n## Operator Decision\n');
    fs.writeFileSync(path.join(f.dir, 'state', 'hypotheses.jsonl'), JSON.stringify({ id: 'pr-merged', state: 'held' }) + '\n');
    const { id } = await f.open(['--dedupe-key', 'proposal:PROP-014', '--claim', 'pr-merged']);
    expect(await f.ok('close', [id, '--by', 'check', '--actor', 'hermit', '--claim', 'pr-merged']))
      .toMatchObject({ closed_by: 'check', proposal_resolved: 'PROP-014' });
    expect(readFrontmatter(proposal)!.status).toBe('resolved');
    expect(fs.readFileSync(proposal, 'utf8')).toContain(`record ${id} closed by its check: later:pr-merged:held.`);
  } finally { f.cleanup(); }
});
