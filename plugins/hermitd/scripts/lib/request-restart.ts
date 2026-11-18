import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** The caller can be inside the session being restarted. Leave the watchdog running independently. */
export function requestRestart(hermitDir: string, reason: 'requested' | 'reauth'): boolean {
  const bin = path.resolve(hermitDir, 'bin', 'hermitd-watchdog');
  if (!fs.existsSync(bin)) return false;
  const child = spawn(bin, ['restart', reason], { detached: true, stdio: 'ignore' });
  child.unref();
  return true;
}
