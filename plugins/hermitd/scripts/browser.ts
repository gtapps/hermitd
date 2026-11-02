#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { browserLease, browserEventCursor, browserEventSequence, type BrowserEvent } from './lib/browser-lease';
import { hermitDir } from './lib/cc-compat';
import { acquireLockWithWait, releaseLock } from './lib/lockfile';
import { writeFileAtomic } from './lib/md-write';
import { emitJson, failJson } from './lib/cli';

/** Print before advancing: interrupted delivery may replay, but can never skip a wake. */
export async function deliverBrowserEvents(dir: string, emit: (event: BrowserEvent) => Promise<void> = async event => {
  await Bun.write(Bun.stdout, JSON.stringify(event) + '\n');
}): Promise<void> {
  if (!fs.existsSync(path.join(dir, 'state/browser-lease.json'))) return;
  const file = path.join(dir, 'state/browser-events.cursor.json');
  const lock = `${file}.lock`;
  if (!acquireLockWithWait(lock, 2000)) throw new Error('browser_cursor_lock_unavailable');
  try {
    let cursor = browserEventCursor(dir);
    const state = browserLease('inspect', undefined, dir);
    for (const event of state.pending ?? []) {
      const sequence = browserEventSequence(event.id);
      if (sequence <= cursor) continue;
      await emit(event);
      writeFileAtomic(file, JSON.stringify({ sequence }) + '\n', 0o600);
      cursor = sequence;
    }
  } finally { releaseLock(lock); }
}

async function events(): Promise<void> {
  let stopping = false;
  let wake: (() => void) | undefined;
  const stop = () => { stopping = true; wake?.(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    while (!stopping) {
      try { await deliverBrowserEvents(hermitDir()); }
      catch (error) { console.error(error instanceof Error ? error.message : error); }
      if (!stopping) await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 2000);
        wake = () => { clearTimeout(timer); resolve(); };
      });
    }
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }
}

if (import.meta.main) {
  const [action, task, ...extra] = process.argv.slice(2);
  try {
    if (action === 'events' && task === undefined) { await events(); }
    else {
      if (!['claim', 'release', 'status', 'human-release', 'teardown'].includes(action) || extra.length || (['status', 'human-release'].includes(action) && task !== undefined)) {
        throw new Error('usage: browser claim <task> | release [task] | status | human-release | events');
      }
      emitJson(browserLease(action as 'teardown' | 'claim' | 'release' | 'status' | 'human-release', task));
    }
  } catch (error) {
    failJson(error);
  }
}
