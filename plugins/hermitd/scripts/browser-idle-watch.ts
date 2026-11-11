#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { hermitDir } from './lib/cc-compat';
import { readSettledConfig } from './lib/config-read';
import { acquireLock, pidAlive, releaseLock } from './lib/lockfile';
import { closeUnusedChrome, persistentChromeAlive, type CloseDeps } from './lib/browser-lease';

export const IDLE_WATCH_INTERVAL_MS = 30_000;
// The lock's mtime is refreshed every pass, so a watcher that died leaves a lock that goes stale.
const LOCK_STALE_MS = IDLE_WATCH_INTERVAL_MS * 4;
const lockFile = (dir: string) => path.join(dir, 'state/browser-idle-watch.lock');

/** One watcher per signed-in Chrome, started by the wrapper that launches it. */
export function startIdleWatch(dir: string): void {
  if (!(readSettledConfig(dir).browser.inactivity_timeout > 0)) return;
  // A killed watcher's pid can be reused after a restart, so only a fresh lock counts as running.
  try {
    const pid = Number(fs.readFileSync(lockFile(dir), 'utf8'));
    if (pid > 0 && pidAlive(pid) && Date.now() - fs.statSync(lockFile(dir)).mtimeMs < LOCK_STALE_MS) return;
  } catch {}
  Bun.spawn([process.execPath, import.meta.path], { env: { ...process.env, AGENT_DIR: path.resolve(dir) }, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true }).unref();
}

interface WatchDeps extends CloseDeps { sleep?: (ms: number) => Promise<void>; chromeAlive?: (dir: string) => boolean }
/** Closes the signed-in Chrome once it sits unused past `browser.inactivity_timeout`; exits when Chrome is gone. */
export async function watchIdleBrowser(dir: string, deps: WatchDeps = {}): Promise<'already_running' | 'disabled' | 'browser_gone' | 'closed'> {
  const lock = lockFile(dir);
  if (!acquireLock(lock, LOCK_STALE_MS)) return 'already_running';
  try {
    for (;;) {
      const seconds = readSettledConfig(dir).browser.inactivity_timeout;
      if (!(seconds > 0)) return 'disabled';
      if (!(deps.chromeAlive ?? persistentChromeAlive)(dir)) return 'browser_gone';
      // A transient lease-lock timeout must not end the watcher; the next pass retries.
      try { if (closeUnusedChrome(dir, seconds * 1000, 'idle-close', deps)) return 'closed'; } catch {}
      const now = new Date();
      fs.utimesSync(lock, now, now);
      await (deps.sleep ?? Bun.sleep)(IDLE_WATCH_INTERVAL_MS);
    }
  } finally { releaseLock(lock); }
}

if (import.meta.main) await watchIdleBrowser(hermitDir());
