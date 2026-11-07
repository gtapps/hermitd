import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeTask, type Task } from '../../plugins/hermitd/scripts/lib/tasks';

const roots: string[] = [];
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true }); });
const repo = path.resolve(import.meta.dir, '../..');
const copies = ['.claude', '.agents'].map(dir => path.join(repo, dir, 'skills/stale-proposals/scripts/collect-evidence.ts'));

function collect(script: string, hermitDir: string, out: string) {
  const run = Bun.spawnSync(['bun', script, '--hermit-dir', hermitDir, '--out', out], { cwd: repo, env: { ...process.env, AGENT_DIR: hermitDir }, stdout: 'pipe', stderr: 'pipe' });
  return { code: run.exitCode, out: run.stdout.toString().trim(), err: run.stderr.toString().trim() };
}

const nulls = ['closed_at', 'closed_by', 'closed_actor', 'closed_reason', 'requester_name', 'origin_message_id', 'approver', 'due', 'conversation', 'card_chat_id', 'card_message_id', 'waiting_on', 'waiting_since', 'result', 'result_at', 'stall_at', 'stall_status', 'stall_next', 'dedupe_key', 'check', 'last_worker', 'kind', 'decision', 'approved_rev', 'approved_by', 'source', 'category'];
function proposalTask(overrides: Partial<Task>): string {
  const record = {
    ...Object.fromEntries(nulls.map(key => [key, null])),
    id: 'T-20261104-000000', type: 'task', title: 'Example', created: '2026-11-04T00:00:00.000Z', opened_at: '2026-11-04T00:00:00.000Z',
    summary: 'Example', audience: 'operator', status: 'open', requester: 'agent', handle: 'example', owner: 'resident', tags: ['x'],
    claims: [], result_rev: 0, muted: false, delegated: false, kind: 'proposal',
    decision: JSON.stringify({ purpose: 'consent', authority: 'admin', generation: 1 }), waiting_on: 'admin', waiting_since: '2026-11-04T00:00:00.000Z',
    body: '## Progress\n\n## Decisions\n\n## Outcome\n\n## Proposal\n## Problem\n\nSomething that needs changing and is described at enough length to excerpt.\n',
    ...overrides,
  } as Task;
  return encodeTask(record);
}

for (const script of copies) {
  test(`${path.relative(repo, script)}: a missing tasks folder is an error naming the path`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-proposals-')); roots.push(root);
    const result = collect(script, root, path.join(root, 'bundle.md'));
    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toContain(path.join(root, 'tasks'));
    expect(result.err).toContain('--hermit-dir');
  });

  test(`${path.relative(repo, script)}: unmigrated proposal files are an error naming the migrate verb`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-proposals-')); roots.push(root);
    fs.mkdirSync(path.join(root, 'tasks'));
    fs.mkdirSync(path.join(root, 'proposals'));
    fs.writeFileSync(path.join(root, 'proposals/PROP-900-example.md'), '---\nid: PROP-900\n---\n');
    const result = collect(script, root, path.join(root, 'bundle.md'));
    expect(result.code).toBe(1);
    expect(result.err).toContain('proposal.ts migrate');
  });

  test(`${path.relative(repo, script)}: an open proposal task yields a bundle with its task id and a task section`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-proposals-')); roots.push(root);
    fs.mkdirSync(path.join(root, 'tasks'));
    fs.writeFileSync(path.join(root, 'tasks/T-20261104-000000.md'), proposalTask({ dedupe_key: 'proposal:PROP-900' }));
    fs.writeFileSync(path.join(root, 'tasks/T-20261105-000000.md'), proposalTask({ id: 'T-20261105-000000', handle: 'second', title: 'Closed one', status: 'closed', closed_at: '2026-11-06T00:00:00.000Z', closed_by: 'cancelled', closed_actor: 'operator', closed_reason: 'Consent declined: no', waiting_on: null, waiting_since: null }));
    const bundle = path.join(root, 'bundle.md');
    const result = collect(script, root, bundle);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/^OK\|.*\|1\|\d+\|\d+\|2026-11-04\|0$/);
    const text = fs.readFileSync(bundle, 'utf8');
    expect(text).toContain('### PROP-900 — Example');
    expect(text).toContain('task: T-20261104-000000 | status: proposed');
    expect(text).toContain('## Closed task records naming a PROP (0)');
  });
}
