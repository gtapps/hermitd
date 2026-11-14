// Shared wake marker. Producers hold their store lock before taking this lock.
import fs from 'node:fs';
import path from 'node:path';
import { acquireLockWithWait, releaseLock } from './lockfile';

function withMarker(dir: string, body: (file: string) => void): void {
  const file = path.join(dir, 'state', 'recovery-pending');
  const lock = `${file}.lock`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!acquireLockWithWait(lock, 5000)) return;
    try { body(file); } finally { releaseLock(lock); }
  } catch { /* recovery must not break admission or hooks */ }
}

export function markRecoveryPending(dir: string): void {
  withMarker(dir, file => fs.writeFileSync(file, ''));
}

export function clearRecoveryPendingIf(dir: string, isEmpty: () => boolean): void {
  withMarker(dir, file => {
    if (isEmpty()) { try { fs.unlinkSync(file); } catch {} }
  });
}
