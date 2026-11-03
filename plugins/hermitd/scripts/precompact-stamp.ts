import { observeExecution } from './lib/tasks';
process.stdout.on('error', () => {});

// PreCompact records resident execution and stamps its context reset.
import path from 'node:path';
import { hermitDir } from './lib/cc-compat';
import { stampContextReset } from './lib/context-reset';
import { isGuest } from './lib/guest-marker';

type Json = any;

function readJSON(raw: string): Json | null {
  try { return JSON.parse(raw); } catch { return null; }
}

function main(raw: string): void {
  const payload = readJSON(raw);
  if (!payload || payload.hook_event_name !== 'PreCompact') return;
  const trigger = payload.trigger;
  if (trigger !== 'auto' && trigger !== 'manual') return;

  const agentDir = hermitDir();
  const guest = isGuest(path.join(agentDir, 'state'), payload.session_id);
  // The watchdog's own stamps only cover compactions it initiated; this is the only
  // signal for an operator-typed /compact or a native auto-compaction, both of which
  // leave the last cost-log entry describing a context that no longer exists.
  //
  // Not for a guest: the stamp says the RESIDENT's context was reset, and the watchdog
  // reads it to decide that the resident's last cost entry describes a context that no
  // longer exists. The guest's own compaction says nothing about the resident's context.
  if (!guest) {
    stampContextReset(agentDir);
    observeExecution(agentDir, trigger === 'manual' ? 'idle' : 'unknown', payload.session_id ?? null, null, 'precompact');
  }
}

try {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { buf += chunk; });
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => {
    try { main(buf); } catch { /* fail-open */ }
    process.exit(0);
  });
} catch {
  process.exit(0);
}
