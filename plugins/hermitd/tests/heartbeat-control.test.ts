import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { effectiveHeartbeatMode } from '../scripts/lib/heartbeat/control';
import { legStopped } from '../scripts/lib/monitor-leg-stopped';

function fixture(run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-heartbeat-control-'));
  fs.mkdirSync(path.join(dir, 'state'));
  try { run(dir); } finally { fs.rmSync(dir, { recursive: true }); }
}
const control = (dir: string, record: unknown) =>
  fs.writeFileSync(path.join(dir, 'state/heartbeat-monitor.control.json'), JSON.stringify(record));

describe('effective heartbeat mode', () => {
  test('absent and unknown controls use auto', () => fixture(dir => {
    expect(effectiveHeartbeatMode(dir)).toBe('auto');
    control(dir, { mode: 'unrecognized' });
    expect(effectiveHeartbeatMode(dir)).toBe('auto');
  }));

  test('forced start lasts only for the issuing boot', () => fixture(dir => {
    fs.writeFileSync(path.join(dir, 'state/.boot-id'), 'current\n');
    control(dir, { mode: 'forced', boot_id: 'current' });
    expect(effectiveHeartbeatMode(dir)).toBe('forced');
    control(dir, { mode: 'forced', boot_id: 'old' });
    expect(effectiveHeartbeatMode(dir)).toBe('auto');
    control(dir, { mode: 'forced', boot_id: null });
    expect(effectiveHeartbeatMode(dir)).toBe('auto');
  }));

  test('a missing boot preserves the existing null-boot forced start', () => fixture(dir => {
    control(dir, { mode: 'forced', boot_id: null });
    expect(effectiveHeartbeatMode(dir)).toBe('forced');
  }));

  test('routine fallback does not stop watches', () => fixture(dir => {
    fs.writeFileSync(path.join(dir, 'state/.boot-id'), 'current');
    fs.writeFileSync(path.join(dir, 'state/routine-monitor.runtime.json'), JSON.stringify({
      mode: 'croncreate-fallback', boot_id: 'current',
    }));
    expect(legStopped(dir, 'routines')).toBe(true);
    expect(legStopped(dir, 'watches')).toBe(false);
  }));

  test('stopped stays stopped across boots and gates its supervisor', () => fixture(dir => {
    control(dir, { mode: 'stopped', boot_id: 'old' });
    fs.writeFileSync(path.join(dir, 'state/.boot-id'), 'current');
    expect(effectiveHeartbeatMode(dir)).toBe('stopped');
    expect(legStopped(dir, 'heartbeat')).toBe(true);
    control(dir, { mode: 'auto' });
    expect(legStopped(dir, 'heartbeat')).toBe(false);
  }));
});
