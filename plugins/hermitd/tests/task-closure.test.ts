import { it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { taskFixture, taskLib } from './helpers/tasks';

for (const revision of [undefined, '0']) it(`confirmed rejects stale revision with result=true, revision=${revision}`, async () => { const f = taskFixture(); try { const { id } = await f.open(); await f.ok('block', [id, '--result-stdin'], 'Ready'); const r = await f.run('close', [id, '--by', 'confirmed', '--actor', 'discord:u1', ...(revision === undefined ? [] : ['--result-rev', revision]), '--reason-stdin'], 'ok'); expect(r.exitCode).toBe(2); expect(r.stderr).toContain('stale-result'); } finally { f.cleanup(); } });
it('confirms a record with no posted result', async () => { const f = taskFixture(); try { const { id } = await f.open(); await f.ok('block', [id, '--waiting-on', 'discord:u1', '--status-line', 'Waiting for purchase', '--next', 'Confirm purchase']); expect(await f.ok('close', [id, '--by', 'confirmed', '--actor', 'discord:u1', '--reason-stdin'], 'I bought them myself')).toMatchObject({ closed_by: 'confirmed' }); const lib = await taskLib(); const record = lib.decodeTask(f.text(id)); expect(record.closed_by).toBe('confirmed'); expect(record.closed_reason).toContain('I bought them myself'); } finally { f.cleanup(); } });
it('confirmed rejects a stale revision after the definition of done cleared the result', async () => { const f = taskFixture(); try { const { id } = await f.open(); await f.ok('block', [id, '--result-stdin'], 'Ready'); await f.ok('note', [id, '--done', 'New definition', '--actor', 'discord:u1']); const r = await f.run('close', [id, '--by', 'confirmed', '--actor', 'discord:u1', '--result-rev', '1', '--reason-stdin'], 'ok'); expect(r.exitCode).toBe(2); expect(r.stderr).toContain('stale-result'); expect(await f.ok('close', [id, '--by', 'confirmed', '--actor', 'discord:u1', '--result-rev', '2', '--reason-stdin'], 'I did it myself')).toMatchObject({ closed_by: 'confirmed' }); } finally { f.cleanup(); } });
it('confirmed requires a reason with no posted result', async () => { const f = taskFixture(); try { const { id } = await f.open(); const r = await f.run('close', [id, '--by', 'confirmed', '--actor', 'discord:u1', '--reason-stdin']); expect(r.exitCode).toBe(2); expect(r.stderr).toContain('empty-reason'); } finally { f.cleanup(); } });
it('confirmed honors a named approver with no posted result', async () => { const f = taskFixture(); try { const { id } = await f.open(['--approver', 'discord:u2']); const r = await f.run('close', [id, '--by', 'confirmed', '--actor', 'discord:u1', '--reason-stdin'], 'I bought them myself'); expect(r.exitCode).toBe(2); expect(r.stderr).toContain('approver-required'); } finally { f.cleanup(); } });
it('confirmed requires an actor', async () => { const f = taskFixture(); try { const { id } = await f.open(); await f.ok('block', [id, '--result-stdin'], 'Ready'); expect((await f.run('close', [id, '--by', 'confirmed', '--result-rev', '1'], 'ok')).exitCode).toBe(2); } finally { f.cleanup(); } });
it('honors named approver but otherwise permits shared human control', async () => { const f = taskFixture(); try { const { id } = await f.open(['--approver', 'discord:u2']); await f.ok('block', [id, '--result-stdin'], 'Ready'); expect((await f.run('close', [id, '--by', 'confirmed', '--actor', 'discord:u1', '--result-rev', '1', '--reason-stdin'], 'ok')).stderr).toContain('approver-required'); expect(await f.ok('close', [id, '--by', 'confirmed', '--actor', 'discord:u2', '--result-rev', '1', '--reason-stdin'], 'ok')).toMatchObject({ closed_by: 'confirmed' }); } finally { f.cleanup(); } });
for (const state of ['held', 'pending', 'broken']) it(`check requires a linked held claim: ${state}`, async () => { const f = taskFixture(); try { fs.writeFileSync(path.join(f.dir, 'state/hypotheses.jsonl'), JSON.stringify({ id: 'claim-1', state, claim: 'Outcome', created_at: new Date().toISOString() }) + '\n'); const { id } = await f.open(['--claim', 'claim-1']); const r = await f.run('close', [id, '--by', 'check', '--actor', 'hermit', '--claim', 'claim-1']); expect(r.exitCode).toBe(state === 'held' ? 0 : 2); if (state !== 'held') expect(r.stderr).toContain('check-needs-evidence'); } finally { f.cleanup(); } });
it('check finds a held claim beyond the ten most recently settled claims', async () => { const f = taskFixture(); try { const now = new Date().toISOString(); const rows = [{ id: 'claim-old', state: 'held', claim: 'Outcome', created_at: now }, ...Array.from({ length: 11 }, (_, i) => ({ id: `claim-${i}`, state: 'broken', claim: 'Other', created_at: now }))]; fs.writeFileSync(path.join(f.dir, 'state/hypotheses.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n'); const { id } = await f.open(['--claim', 'claim-old']); expect(await f.ok('close', [id, '--by', 'check', '--actor', 'hermit', '--claim', 'claim-old'])).toMatchObject({ closed_by: 'check' }); } finally { f.cleanup(); } });
it('duty evidence only closes its matching dedupe key', async () => { const f = taskFixture(); try { const { id } = await f.open(['--dedupe-key', 'duty:heartbeat:item']); expect((await f.run('close', [id, '--by', 'check', '--actor', 'duty:other'])).stderr).toContain('check-needs-evidence'); expect(await f.ok('close', [id, '--by', 'check', '--actor', 'duty:heartbeat'])).toMatchObject({ closed_by: 'check' }); } finally { f.cleanup(); } });
it('cancel requires reason and records actor', async () => { const f = taskFixture(); try { const { id } = await f.open(); expect((await f.run('cancel', [id, '--actor', 'discord:u2', '--reason-stdin'])).stderr).toContain('empty-reason'); await f.ok('cancel', [id, '--actor', 'discord:u2', '--reason-stdin'], 'No longer needed'); const lib = await taskLib(); expect(lib.decodeTask(f.text(id))).toMatchObject({ closed_by: 'cancelled', closed_actor: 'discord:u2', closed_reason: 'No longer needed' }); } finally { f.cleanup(); } });
for (const verb of ['close', 'cancel']) it(`replayed ${verb} leaves closed record unchanged`, async () => { const f = taskFixture(); try { const { id } = await f.open(); await f.ok('cancel', [id, '--actor', 'discord:u1', '--reason-stdin'], 'Stop'); const before = f.text(id); expect((await f.run(verb, [id, '--actor', 'discord:u1', ...(verb === 'close' ? ['--by', 'confirmed'] : ['--reason-stdin'])], 'Stop')).stderr).toContain('not-open'); expect(f.text(id)).toBe(before); } finally { f.cleanup(); } });
it('only close and cancel produce closed status across every verb', async () => { const f = taskFixture(); try { const { id } = await f.open(); const lib = await taskLib(); for (const [verb, args, input] of [['note', [id], 'Progress'], ['block', [id, '--result-stdin'], 'Ready'], ['list', [], ''], ['standup', [], '']] as [string, string[], string][]) { await f.ok(verb, args, input); expect(lib.decodeTask(f.text(id)).status).toBe('open'); } expect((await f.run('close', [id, '--by', 'auto', '--actor', 'hermit'])).stderr).toContain('invalid-closed-by'); } finally { f.cleanup(); } });
it('passing check leaves an approver record open', async () => {
  const f = taskFixture();
  try {
    const { id } = await f.open(['--check', 'true', '--approver', 'discord:u2']);
    const lib = await taskLib();
    expect(lib.mutateTask(f.dir, 'check-result', id, { 'result-rev': '0', exit: '0', 'output-stdin': true }, 'proof')).toMatchObject({ closed_by: null });
    const record = lib.decodeTask(f.text(id));
    expect(record.status).toBe('open');
    expect(record.closed_by).toBeNull();
    expect(f.text(id)).toContain('check passed; approver confirmation still required');
    // The passed check is cleared, so the daily run stops re-executing it every wake.
    expect(record.check).toBeNull();
    expect((await f.ok('list', ['--with-check'])).rows).toEqual([]);
  } finally { f.cleanup(); }
});
it('check close with a held claim rejects a named approver', async () => {
  const f = taskFixture();
  try {
    fs.writeFileSync(path.join(f.dir, 'state/hypotheses.jsonl'), JSON.stringify({ id: 'claim-1', state: 'held', claim: 'Outcome', created_at: new Date().toISOString() }) + '\n');
    const { id } = await f.open(['--claim', 'claim-1', '--approver', 'discord:u2']);
    const r = await f.run('close', [id, '--by', 'check', '--actor', 'hermit', '--claim', 'claim-1']);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('approver-required');
    const lib = await taskLib();
    expect(lib.decodeTask(f.text(id)).status).toBe('open');
  } finally { f.cleanup(); }
});
it('check close with duty evidence rejects a named approver', async () => {
  const f = taskFixture();
  try {
    const { id } = await f.open(['--dedupe-key', 'duty:heartbeat:item', '--approver', 'discord:u2']);
    expect((await f.run('close', [id, '--by', 'check', '--actor', 'duty:heartbeat'])).stderr).toContain('approver-required');
  } finally { f.cleanup(); }
});
it('check-result closes only on zero and refuses a closed record', async () => {
  const f = taskFixture();
  try {
    const { id } = await f.open(['--check', 'true']);
    const lib = await taskLib();
    const result = (exit: string, output: string) => lib.mutateTask(f.dir, 'check-result', id, { 'result-rev': '0', exit, 'output-stdin': true }, output);
    result('1', 'not yet');
    expect(lib.decodeTask(f.text(id)).closed_by).toBeNull();
    result('0', 'verified');
    expect(lib.decodeTask(f.text(id))).toMatchObject({ status: 'closed', closed_by: 'check', closed_reason: 'check:exit-0: verified', result: null });
    const closed = f.text(id);
    expect(() => result('0', 'again')).toThrow('stale-check');
    expect(f.text(id)).toBe(closed);
  } finally { f.cleanup(); }
});
it('check close keeps a posted result and leaves an empty output out of the reason', async () => {
  const f = taskFixture();
  try {
    const lib = await taskLib();
    const posted = (await f.open(['--check', 'true'])).id;
    await f.ok('block', [posted, '--result-stdin'], 'PR opened');
    lib.mutateTask(f.dir, 'check-result', posted, { 'result-rev': '1', exit: '0', 'output-stdin': true }, 'MERGED by ci');
    expect(lib.decodeTask(f.text(posted))).toMatchObject({ closed_by: 'check', result: 'PR opened', closed_reason: 'check:exit-0: MERGED by ci' });
    const silent = (await f.open(['--check', 'true'])).id;
    lib.mutateTask(f.dir, 'check-result', silent, { 'result-rev': '0', exit: '0', 'output-stdin': true }, '');
    expect(lib.decodeTask(f.text(silent))).toMatchObject({ closed_by: 'check', result: null, closed_reason: 'check:exit-0' });
    const long = (await f.open(['--check', 'true'])).id;
    lib.mutateTask(f.dir, 'check-result', long, { 'result-rev': '0', exit: '0', 'output-stdin': true }, 'x'.repeat(300));
    expect(lib.decodeTask(f.text(long)).closed_reason).toBe('check:exit-0: ' + 'x'.repeat(200));
    expect(f.text(long)).toContain('x'.repeat(300));
  } finally { f.cleanup(); }
});
