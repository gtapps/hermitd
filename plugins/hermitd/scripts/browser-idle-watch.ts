#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { hermitDir } from './lib/cc-compat';
import { readSettledConfig } from './lib/config-read';
import { acquireLock, pidAlive, releaseLock } from './lib/lockfile';
import { closeUnusedChrome, persistentChromeAlive, type CloseDeps } from './lib/browser-lease';

export const IDLE_WATCH_INTERVAL_MS = 30_000;
const lockFile = (dir: string) => path.join(dir, 'state/browser-idle-watch.lock');

/** One watcher per signed-in Chrome, started by the wrapper that launches it. */
export function startIdleWatch(dir: string): void {
  if (!(readSettledConfig(dir).browser.inactivity_timeout > 0)) return;
  try { if (pidAlive(Number(fs.readFileSync(lockFile(dir), 'utf8')))) return; } catch {}
  Bun.spawn([process.execPath, import.meta.path], { env: { ...process.env, AGENT_DIR: path.resolve(dir) }, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true }).unref();
}

interface WatchDeps extends CloseDeps { sleep?: (ms: number) => Promise<void>; chromeAlive?: (dir: string) => boolean }
/** Closes the signed-in Chrome once it sits unused past `browser.inactivity_timeout`; exits when Chrome is gone. */
export async function watchIdleBrowser(dir: string, deps: WatchDeps = {}): Promise<'already_running' | 'disabled' | 'browser_gone' | 'closed'> {
  const lock = lockFile(dir);
  // The lock's mtime is refreshed every pass, so a watcher that died leaves a lock that goes stale.
  if (!acquireLock(lock, IDLE_WATCH_INTERVAL_MS * 4)) return 'already_running';
  try {
    for (;;) {
      const seconds = readSettledConfig(dir).browser.inactivity_timeout;
      if (!(seconds > 0)) return 'disabled';
      if (!(deps.chromeAlive ?? persistentChromeAlive)(dir)) return 'browser_gone';
      if (closeUnusedChrome(dir, seconds * 1000, 'idle-close', deps)) return 'closed';
      const now = new Date();
      fs.utimesSync(lock, now, now);
      await (deps.sleep ?? Bun.sleep)(IDLE_WATCH_INTERVAL_MS);
    }
  } finally { releaseLock(lock); }
}

if (import.meta.main) await watchIdleBrowser(hermitDir());
