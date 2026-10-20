import fs from 'node:fs';
import path from 'node:path';
import { effectiveHeartbeatMode } from './heartbeat/control';

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Whether a supervised leg must not poll: heartbeat stopped, or routines in fallback for this boot. */
export function legStopped(hermitDir: string, leg: string): boolean {
  if (leg === 'heartbeat') {
    return effectiveHeartbeatMode(hermitDir) === 'stopped';
  }
  if (leg !== 'routines') return false;
  const record = readJson(path.join(hermitDir, 'state', 'routine-monitor.runtime.json'));
  let boot: string | null = null;
  try {
    boot = fs.readFileSync(path.join(hermitDir, 'state', '.boot-id'), 'utf8').trim() || null;
  } catch {}
  // A fallback verdict only binds the boot that recorded it; a later boot must retry the poller.
  return record?.mode === 'croncreate-fallback' && (record.boot_id ?? null) === boot;
}

if (import.meta.main) {
  process.exit(legStopped(process.argv[2] ?? '', process.argv[3] ?? '') ? 0 : 1);
}
