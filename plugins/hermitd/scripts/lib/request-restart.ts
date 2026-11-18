import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface QuietOptions { expect?: Record<string, string>; boot?: unknown }

/** Reads `--expect name=version` pairs; null on any other token or a malformed pair. */
export function parseExpectPairs(args: string[]): Record<string, string> | null {
  const expected: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const pair = args[i + 1] ?? '';
    const equals = pair.indexOf('=');
    if (args[i] !== '--expect' || equals < 1 || equals === pair.length - 1) return null;
    expected[pair.slice(0, equals)] = pair.slice(equals + 1);
  }
  return expected;
}

/** The caller can be inside the session being restarted. Leave the watchdog running independently.
 *  With `quiet`, the watchdog first waits for the expected versions and a quiet moment. */
export function requestRestart(hermitDir: string, reason: 'requested' | 'reauth', quiet?: QuietOptions): boolean {
  const bin = path.resolve(hermitDir, 'bin', 'hermitd-watchdog');
  if (!fs.existsSync(bin)) return false;
  const args = ['restart', reason];
  if (quiet) {
    args.push('--when-quiet');
    if (quiet.boot != null) args.push('--boot', String(quiet.boot));
    for (const [name, version] of Object.entries(quiet.expect ?? {})) args.push('--expect', `${name}=${version}`);
  }
  // The watchdog resolves its state folder from its working directory.
  const child = spawn(bin, args, { cwd: path.dirname(path.resolve(hermitDir)), detached: true, stdio: 'ignore' });
  child.unref();
  return true;
}
