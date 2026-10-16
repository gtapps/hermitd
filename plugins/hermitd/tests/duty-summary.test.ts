import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { taskFixture } from './helpers/tasks';
import { dutySummary } from '../scripts/lib/duty-summary';

test('requested mode and schedule remain separate from observed liveness', () => {
  const f = taskFixture();
  try {
    f.put('config.json', { heartbeat: { enabled: false }, routines: [{ id: 'daily', enabled: true, schedule: '0 9 * * *' }] });
    fs.writeFileSync(path.join(f.dir, 'state/.boot-id'), 'boot');
    f.put('state/heartbeat-monitor.control.json', { mode: 'forced', boot_id: 'boot' });
    f.put('state/routine-monitor.runtime.json', { mode: 'croncreate-fallback', boot_id: 'boot' });
    f.put('state/heartbeat-liveness.json', { last_peek_at: new Date().toISOString() });
    expect(dutySummary(f.dir).join('\n')).toContain('mode=forced');
    expect(dutySummary(f.dir).join('\n')).toContain('mode=croncreate-fallback');
    expect(dutySummary(f.dir).join('\n')).toContain('observed pid=unknown');
    f.put('state/heartbeat-monitor.control.json', { mode: 'forced', boot_id: 'previous' });
    expect(dutySummary(f.dir).join('\n')).toContain('mode=auto');
  } finally { f.cleanup(); }
});


test('routine summary pairs the newest event with its own timestamp', () => {
  const f = taskFixture();
  try {
    f.put('config.json', { routines: [{ id: 'daily' }, { id: 'new' }] });
    fs.writeFileSync(path.join(f.dir, 'state/routine-metrics.jsonl'), [
      { routine_id: 'daily', event: 'fired', ts: '2026-09-14T10:00:00Z' },
      { routine_id: 'daily', event: 'skipped-precheck', ts: '2026-09-20T10:00:00Z' },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    f.put('state/alert-state.json', { alerts: {}, total_ticks: 1, last_clean_eval_at: '2026-09-20T11:00:00Z' });
    f.put('state/monitors.runtime.json', { monitors: [{ id: 'watch-1', last_event_at: '2026-09-20T12:00:00Z', last_verdict: 'ok' }] });
    const lines = dutySummary(f.dir);
    expect(lines.find(line => line.startsWith('routine:daily:'))).toContain('last_woke=2026-09-14T10:00:00Z, last_event=skipped-precheck@2026-09-20T10:00:00Z');
    expect(lines.find(line => line.startsWith('routine:new:'))).toContain('last_woke=unknown, last_event=unknown');
    expect(lines.find(line => line.startsWith('heartbeat:'))).toContain('last_woke=2026-09-20T11:00:00Z, last_event=ok');
    expect(lines.find(line => line.startsWith('watch:watch-1:'))).toContain('last_woke=2026-09-20T12:00:00Z, last_event=ok');
  } finally { f.cleanup(); }
});
