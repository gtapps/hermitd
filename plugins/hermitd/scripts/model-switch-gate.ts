import fs from 'node:fs';
import path from 'node:path';
import { hermitDir, sessionId } from './lib/cc-compat';
import { readJson } from './lib/cli';
import { runHook } from './lib/hook-input';
import { readRuntimeJson } from './lib/runtime';

// Keep the command hooks independent of the queue library and its state mutations.
export const QUEUE_PROTOCOL = 1;
export const INFLIGHT_DIR = 'harness-inflight';

export function residentMarker(dir: string, id: string | null) {
  const state = path.join(dir, 'state');
  if (typeof id !== 'string' || !id || readRuntimeJson(state)?.cc_session_id !== id) return null;
  const loaded = readJson(path.join(state, 'harness-mod-loaded.json'));
  return loaded?.session_id === id && loaded.queue === QUEUE_PROTOCOL ? loaded : null;
}

if (import.meta.main) await runHook(payload => {
  if (payload.source !== 'command' || typeof payload.requested_model !== 'string') return;
  const dir = hermitDir();
  if (!residentMarker(dir, sessionId(payload))) return;
  const inflight = path.join(dir, 'state', INFLIGHT_DIR);
  for (const name of fs.readdirSync(inflight)) {
    if (!name.endsWith('.json')) continue;
    const entry = readJson(path.join(inflight, name));
    if (entry === null) return;
    const legs = entry.legs ?? [];
    if (!Array.isArray(entry.commands) || !Array.isArray(legs)) continue;
    const current = entry.commands[legs.length];
    if (current?.command === '/model' && current.arg === payload.requested_model) {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreModelSwitch', permissionDecision: 'allow' } }));
      return;
    }
  }
});
