import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { costLogPath } from '../scripts/lib/cc-compat';
import { passesExecutionBoundary } from '../scripts/lib/tasks';
import { taskFixture } from './helpers/tasks';

test('execution boundary checks identity, idle age, workers and token floor', async () => {
  const f = taskFixture();
  try {
    expect(passesExecutionBoundary(f.dir)).toEqual({ ok: false, reason: 'execution-not-idle' });
    const execution = { state: 'idle', at: new Date(Date.now() - 61000).toISOString(), cc_session_id: 'resident' };
    f.put('state/execution.json', execution);
    expect(passesExecutionBoundary(f.dir)).toEqual({ ok: false, reason: 'stale-identity' });
    f.put('state/runtime.json', { cc_session_id: 'resident' });
    f.put('state/execution.json', { ...execution, at: new Date().toISOString() });
    expect(passesExecutionBoundary(f.dir)).toEqual({ ok: false, reason: 'idle-too-fresh' });
    f.put('state/execution.json', execution);
    const { id } = await f.open(['--owner', 'worker:a3b2c3d4e5f6a7b8c']);
    expect(passesExecutionBoundary(f.dir)).toEqual({ ok: false, reason: 'worker-running' });
    await f.ok('cancel', [id, '--actor', 'discord:u1', '--reason-stdin'], 'Cancelled');
    expect(passesExecutionBoundary(f.dir, { minTokens: 20000 })).toEqual({ ok: false, reason: 'under-token-floor' });
    await f.open(['--owner', 'helper:review']);
    expect(passesExecutionBoundary(f.dir)).toEqual({ ok: true });
  } finally { f.cleanup(); }
});

test('token floor ignores a cost row observed before the last context reset', () => {
  const f = taskFixture();
  try {
    const now = Date.now();
    f.put('state/execution.json', { state: 'idle', at: new Date(now - 61000).toISOString(), cc_session_id: 'resident' });
    f.put('state/runtime.json', { cc_session_id: 'resident', last_context_reset_at: new Date(now - 30000).toISOString() });
    const log = costLogPath(f.dir);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, JSON.stringify({ cc_session_id: 'resident', max_prompt_tokens: 150000, observed_at: new Date(now - 90000).toISOString() }) + '\n');
    expect(passesExecutionBoundary(f.dir, { minTokens: 20000 })).toEqual({ ok: false, reason: 'under-token-floor' });
    fs.writeFileSync(log, JSON.stringify({ cc_session_id: 'resident', max_prompt_tokens: 150000, observed_at: new Date(now - 10000).toISOString() }) + '\n');
    expect(passesExecutionBoundary(f.dir, { minTokens: 20000 })).toEqual({ ok: true });
  } finally { f.cleanup(); }
});
