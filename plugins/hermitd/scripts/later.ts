// Output exception: `due` is the hermitd:later-check routine gate, so it prints bare `SKIP` or `WAKE`.
import fs from 'node:fs';
import { runEvidence } from './lib/evidence-runner';
import { readTasks } from './lib/tasks';
import path from 'node:path';
import { appendJsonlLine } from './lib/append-jsonl';
import { exitError, failJson, flagValue, printJson, readJson, readStdinIfFlagged } from './lib/cli';
import { checkKey } from './lib/conversation-key';
import { scanForInjection } from './lib/injection-scan';
import { readConfigRaw } from './lib/config-read';
import { maxLatenessMinutes } from './lib/routines/lateness';
import { nextFire } from './lib/cron';
import { acquireLockWithWait, releaseLock } from './lib/lockfile';
import { writeFileAtomic } from './lib/md-write';
import { resolveHermitNowMs } from './lib/time';
import { DIRECT_SEND_CHANNELS } from './lib/channel-config';
import { lookupChat } from './lib/channel-chats';
import { sendToOwnedChat } from './lib/channel-send';

import { readRows, type Row, type State } from './lib/later-ledger';

const DAY_MS = 86400000;
/** Long enough for a monthly schedule to resolve; a rarer one falls back to `due` + 1 day. */
const HORIZON_MS = 32 * DAY_MS;

/** First fire of the enabled `hermitd:later-check` routine within the horizon after `after`, or null. */
function laterCheckFire(dir: string, after: Date): Date | null {
  const config = readConfigRaw(dir);
  const routine = config?.routines?.find((r: any) => r?.id === 'hermitd:later-check');
  if (!routine || routine.enabled !== true) return null;
  const fire = nextFire(String(routine.schedule ?? ''), config?.timezone ?? null, after);
  return fire && fire.getTime() - after.getTime() < HORIZON_MS ? fire : null;
}

/** Operator rows use monitor lateness; hermit claims allow the first daily check. */
function isLate(dir: string, row: Row, date: Date): boolean {
  const due = new Date(row.due);
  if (row.kind === 'reminder' || row.origin === 'operator') {
    return date.getTime() - due.getTime() > maxLatenessMinutes(readConfigRaw(dir)?.routine_max_lateness_minutes) * 60000;
  }
  const first = laterCheckFire(dir, due);
  const second = first && laterCheckFire(dir, first);
  return second ? date.getTime() >= second.getTime() : date.getTime() > due.getTime() + DAY_MS;
}

function withLedgerLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!acquireLockWithWait(lock, 2000)) throw new Error('ledger_lock_unavailable');
  try { return fn(); } finally { releaseLock(lock); }
}

/** Re-read under the lock and patch one still-pending row; null when it is no longer pending. */
function updatePending(file: string, id: string, patch: Partial<Row>): Row | null {
  return withLedgerLock(file, () => {
    const rows = readRows(file);
    const row = rows.find(r => r.id === id);
    if (!row || row.state !== 'pending') return null;
    Object.assign(row, patch);
    writeFileAtomic(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 0o600);
    return row;
  });
}

const DEFAULT_TIMEOUT_S = 30;
const MAX_TIMEOUT_S = 300;

/** A `--chat` whose value went missing must fail, never silently widen the scope to every chat. */
function chatFlag(args: string[]): string | undefined {
  if (!args.includes('--chat')) return undefined;
  const chat = flagValue(args, '--chat') ?? '';
  checkKey(chat);
  return chat;
}


async function main() {
  const [verb, dirArg, ...args] = process.argv.slice(2);
  if (!dirArg) exitError();
  const dir = path.resolve(dirArg);
  const file = path.join(dir, 'state', 'hypotheses.jsonl');
  const rows = readRows(file);
  const date = new Date(resolveHermitNowMs());
  if (verb === 'due') {
    const taskCheckDue = readTasks(dir).some(record => record.status === 'open' && record.result && 'check' in record && record.check);
    console.log(taskCheckDue || rows.some(row => row.state === 'pending' && new Date(row.due) <= date) ? 'WAKE' : 'SKIP');
    return;
  }
  if (verb === 'add') {
    const claim = flagValue(args, '--claim');
    const cmd = flagValue(args, '--cmd') ?? null;
    const remind = args.includes('--remind');
    if (remind && args.includes('--cmd')) throw new Error('invalid_add_arguments');
    const chat = chatFlag(args);
    const due = flagValue(args, '--due');
    const origin = flagValue(args, '--origin');
    if (!claim || !due || !Number.isFinite(Date.parse(due)) || (origin !== 'operator' && origin !== 'hermit')) throw new Error('invalid_add_arguments');
    const timeoutRaw = flagValue(args, '--timeout-s');
    const timeoutS = timeoutRaw === undefined ? DEFAULT_TIMEOUT_S : Number(timeoutRaw);
    if (!Number.isInteger(timeoutS) || timeoutS < 1 || timeoutS > MAX_TIMEOUT_S) throw new Error('invalid_timeout');
    const row: Row = { id: crypto.randomUUID(), claim, cmd, due: new Date(due).toISOString(), origin,
      session: flagValue(args, '--session') ?? null, created_at: date.toISOString(), state: 'pending',
      ...(remind ? { kind: 'reminder' as const } : {}),
      ...(chat !== undefined ? { chat } : {}),
      ...(timeoutS !== DEFAULT_TIMEOUT_S ? { timeout_s: timeoutS } : {}) };
    const error = withLedgerLock(file, () => appendJsonlLine(file, JSON.stringify(row)));
    if (error) throw new Error(`ledger_append_failed:${error}`);
    const config = readConfigRaw(dir);
    if (chat?.startsWith('discord:')) await lookupChat(dir, config, chat.slice('discord:'.length));
    const monitor = readJson(path.join(dir, 'state', 'routine-monitor.runtime.json'));
    const exact = (row.kind === 'reminder' || row.origin === 'operator')
      && new Date(row.due) > date
      && config?.routines?.some((r: any) => r?.id === 'hermitd:later-check' && r.enabled === true)
      && monitor?.mode === 'monitor';
    printJson({ id: row.id, next_fire: exact ? row.due : laterCheckFire(dir, date)?.toISOString() ?? null });
    return;
  }
  if (verb === 'list') {
    const chat = chatFlag(args);
    const visible = chat === undefined ? rows : rows.filter(row => row.chat === chat);
    const listed = [...visible.filter(row => row.state === 'pending'), ...visible.filter(row => row.state !== 'pending').slice(-10)];
    printJson({ rows: listed.map(({ cmd, output, ...summary }) => summary) });
    return;
  }
  if (!['cancel', 'check', 'verdict', 'deliver'].includes(verb)) exitError('unknown_verb');
  const chat = chatFlag(args);
  const row = rows.find(row => row.id === args[0] && (chat === undefined || row.chat === chat));
  if (!row) { printJson({ status: 'none', reason: 'unknown_id' }); return; }
  // The row can close between the read above and the locked update (a concurrent cancel or verdict).
  const noop = () => printJson({ status: 'noop', reason: 'not_pending', state: readRows(file).find(r => r.id === row.id)?.state ?? row.state });
  if (row.state !== 'pending') { noop(); return; }
  if (verb === 'deliver') {
    if (!row.chat) { printJson({ status: 'unsupported', reason: 'no_chat' }); return; }
    const channel = row.chat.slice(0, row.chat.indexOf(':'));
    const config = readConfigRaw(dir);
    if (!DIRECT_SEND_CHANNELS.includes(channel) && !config?.channels?.[channel]?.send_script) {
      printJson({ status: 'unsupported', reason: 'no_send_path' });
      return;
    }
    const text = (await readStdinIfFlagged(args, '--text-stdin')).trim();
    if (!text) throw new Error('text_required');
    const result = await sendToOwnedChat(dir, row.chat, text, { config });
    if (!result.ok) {
      const reason = result.platform_code !== undefined ? `discord_${result.platform_code}`
        : /^[a-z_]+$/.test(result.error ?? '') ? result.error : 'send_failed';
      printJson({ status: 'undelivered', reason });
    } else if (row.kind === 'reminder') {
      if (!updatePending(file, row.id, { state: 'sent', reason: 'delivered', checked_at: date.toISOString(), late: isLate(dir, row, date) })) { noop(); return; }
      printJson({ id: row.id, state: 'sent', route: result.route });
    } else {
      printJson({ status: 'delivered', route: result.route });
    }
    return;
  }
  if (verb === 'cancel') {
    if (!updatePending(file, row.id, { state: 'cancelled' })) { noop(); return; }
    printJson({ id: row.id, state: 'cancelled' });
    return;
  }
  if (verb === 'check') {
    const hit = scanForInjection(row.claim) || (row.cmd != null && scanForInjection(row.cmd));
    if (hit) {
      if (!updatePending(file, row.id, { state: 'indeterminate', reason: `injection-suspect:${hit.cls}`, checked_at: date.toISOString(), late: isLate(dir, row, date) })) { noop(); return; }
      printJson({ status: 'injection_suspect', class: hit.cls });
      return;
    }
    const result = row.kind === 'reminder' || row.cmd == null
      ? { exit: null, output: '', timed_out: false }
      : await runEvidence(row.cmd, path.dirname(dir), row.timeout_s ?? DEFAULT_TIMEOUT_S);
    if (!updatePending(file, row.id, { exit: result.exit, output: result.output })) { noop(); return; }
    console.log(JSON.stringify({ ...row, ...result, late: isLate(dir, row, date) }));
    return;
  }
  const state = args[1];
  if ((!['held', 'broken', 'indeterminate'].includes(state) && !(state === 'sent' && row.kind === 'reminder')) || !args.includes('--reason-stdin')) throw new Error('invalid_verdict_arguments');
  const reason = (await readStdinIfFlagged(args, '--reason-stdin')).trim().split(/\r?\n/)[0];
  if (!reason) throw new Error('reason_required');
  if (!updatePending(file, row.id, { state: state as State, reason, checked_at: date.toISOString(), late: isLate(dir, row, date) })) { noop(); return; }
  printJson({ id: row.id, state });
}

if (import.meta.main) {
  main().catch(error => failJson(error));
}
