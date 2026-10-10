import { test, expect } from 'bun:test';
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
