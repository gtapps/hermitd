import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { readExecution, passesExecutionBoundary } from '../scripts/lib/tasks';
import { procStartOf, localPidDomain } from './helpers/registry-fixture';
import { taskFixture } from './helpers/tasks';

test('registry is advisory for unknown execution and gates busy residents', () => {
  const f = taskFixture();
  try {
    const configDir = path.join(f.dir, 'registry');
    fs.mkdirSync(path.join(configDir, 'sessions'), { recursive: true });
    f.put('state/runtime.json', { cc_session_id: 'resident', session_pid: process.pid, config_dir: configDir });
    fs.writeFileSync(path.join(configDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, procStart: procStartOf(process.pid), pidDomain: localPidDomain(), status: 'waiting', statusUpdatedAt: Date.now(), waitingFor: 'permission prompt' }));
    expect(readExecution(f.dir).registry).toBeUndefined();
    expect(readExecution(f.dir, { registryFallback: true })).toMatchObject({ state: 'unknown', registry: 'waiting', waiting_for: 'permission prompt', display: 'execution: unknown (registry: waiting, permission prompt, live process)' });
    f.put('state/execution.json', { state: 'idle', at: new Date(Date.now() - 61000).toISOString(), cc_session_id: 'resident' });
    expect(passesExecutionBoundary(f.dir)).toEqual({ ok: false, reason: 'registry-busy' });
  } finally { f.cleanup(); }
});
