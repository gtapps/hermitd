// heartbeat.ts — single CLI for the heartbeat mechanics, over
// lib/heartbeat/{precheck,alert-update}.ts.
//
// Usage:
//   bun heartbeat.ts precheck [--peek] <hermit-state-dir>
//     The monitor's poll and /heartbeat run's mutating tick. --peek is
//     read-only. Prints one verdict line: OK | EVALUATE | ALERT |
//     SKIP|<reason>. The monitor greps these, so the grammar is load-bearing.
//
//   bun heartbeat.ts tick <hermit-dir>
//     One deterministic tick: the mutating precheck plus the bookkeeping the run
//     handler uses for budget and runnable task notices. Prints one JSON line the skill branches on.
//
//   bun heartbeat.ts ack-queue <hermit-dir> <token>
//     Acknowledge an unchanged runnable record after pickup or notification.
//
//   bun heartbeat.ts start-check <hermit-dir>
//   bun heartbeat.ts start-commit <hermit-dir> <task-id>
//     The two halves of `heartbeat start`: is a re-arm needed, and record the
//     Monitor the skill registered in between. Each prints one JSON object.
//
//   bun heartbeat.ts alert-state <state-file>
//     Applies one alert-state update from stdin.
//
//   bun heartbeat.ts item-key                       # checklist line on stdin
//   bun heartbeat.ts add-item <hermit-dir>           # checklist line on stdin
//   bun heartbeat.ts remove-item <hermit-dir> <key>
//
// Exception to the helper-output convention: precheck, interval and control-state
// keep the line grammar heartbeat-monitor.sh parses.
//
// The verb is spliced out of process.argv before the module loads, so each
// module keeps the argv indices it used as a standalone script — 550-odd lines
// of alert derivation and lull arithmetic stay byte-for-byte unchanged rather
// than being rethreaded through a parameter. Loading is lazy for the same
// reason it is in routines.ts: a precheck poll runs every interval and has no
// business parsing the alert-update graph.

import { emitJson, exitError, readStdin } from './lib/cli'; // fs only; every verb module stays dynamic

const verb = process.argv[2];
process.argv.splice(2, 1);

switch (verb) {
  case 'precheck': {
    const { main } = await import('./lib/heartbeat/precheck');
    main();
    break;
  }
  case 'tick': {
    const { run } = await import('./lib/heartbeat/tick');
    await run(process.argv.slice(2));
    break;
  }
  case 'ack-queue': {
    const { acknowledgeQueue } = await import('./lib/heartbeat/tick');
    const { pinStateDirOrExit } = await import('./lib/cc-compat');
    const dir = pinStateDirOrExit(process.argv[2]);
    console.log(JSON.stringify(acknowledgeQueue(dir, process.argv[3])));
    break;
  }
  case 'control-state': {
    const { effectiveHeartbeatMode } = await import('./lib/heartbeat/control');
    const { readConfigRaw } = await import('./lib/config-read');
    const dir = process.argv[2];
    if (!dir) exitError();
    const mode = effectiveHeartbeatMode(dir);
    console.log(mode === 'stopped' ? 'stopped' : mode === 'auto' && readConfigRaw(dir)?.heartbeat?.enabled === false ? 'disabled' : 'active');
    break;
  }
  case 'start-check':
  case 'stop':
  case 'interval':
  case 'start-commit': {
    const { run } = await import('./lib/heartbeat/start');
    await run(verb, process.argv.slice(2));
    break;
  }
  case 'alert-state':
    await import('./lib/heartbeat/alert-update');
    break;
  case 'item-key':
  case 'add-item':
  case 'remove-item':
    emitJson(await checklistVerb(verb, process.argv.slice(2)));
    break;
  default:
    exitError();
}

async function checklistVerb(verb: 'item-key' | 'add-item' | 'remove-item', args: string[]): Promise<object> {
  const { normalizeItemKey, parseChecklistItems } = await import('./lib/heartbeat-items');
  if (args.length !== (verb === 'item-key' ? 0 : verb === 'add-item' ? 1 : 2)) return { error: 'usage' };
  const line = verb === 'remove-item' ? '' : (await readStdin()).replace(/\r?\n$/, '');
  const key = verb === 'remove-item' ? args[1] : /[\r\n]/.test(line) ? null : normalizeItemKey(line);
  if (!key) return { status: 'none', reason: 'no_key' };
  if (verb === 'item-key') return { key };
  if (verb === 'add-item' && parseChecklistItems(line).length === 0) return { error: 'invalid_checklist_line' };

  const { pinStateDirOrExit } = await import('./lib/cc-compat');
  const { acquireLockWithWait, releaseLock } = await import('./lib/lockfile');
  const { writeFileAtomic } = await import('./lib/md-write');
  const { default: fs } = await import('node:fs');
  const { default: path } = await import('node:path');
  const dir = pinStateDirOrExit(args[0]);
  const file = path.join(dir, 'HEARTBEAT.md');
  const lock = path.join(dir, 'state', 'heartbeat-items.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  if (!acquireLockWithWait(lock, 2000)) return { error: 'lock_unavailable' };
  try {
    const content = fs.readFileSync(file, 'utf8');
    const lines: string[] = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const index = lines.findIndex(candidate => parseChecklistItems(candidate).length > 0 && normalizeItemKey(candidate) === key);
    if (verb === 'remove-item') {
      if (index === -1) return { status: 'none', reason: 'not_found' };
      lines.splice(index, 1);
    } else {
      if (index !== -1) return { status: 'none', reason: 'exists', key };
      const newline = content.includes('\r\n') ? '\r\n' : '\n';
      lines.push((content && !content.endsWith('\n') ? newline : '') + line + newline);
    }
    writeFileAtomic(file, lines.join(''), fs.statSync(file).mode & 0o777);
    const audit = Bun.spawnSync([process.execPath, path.join(import.meta.dir, 'settings-edit.ts'), path.join(dir, 'config.json'), 'record-file', 'HEARTBEAT.md']);
    if (audit.exitCode !== 0) return { error: 'record_file_failed' };
    return verb === 'add-item' ? { status: 'added', key } : { status: 'removed' };
  } catch {
    return { error: 'checklist_update_failed' };
  } finally {
    releaseLock(lock);
  }
}
