// Shared validated-append primitive for JSONL event ledgers (proposal-metrics.jsonl,
// observations.jsonl, micro-proposals.json's metrics companion, etc). Every writer
// goes through here so the validate-then-append contract is defined once: the typed
// constructors in lib/observations.ts and lib/proposals/event.ts, and the gate and
// queue-micro verbs that build their own events.

import fs from 'node:fs';

/**
 * Validates `eventJson` is non-empty parseable JSON, then appends it (+ newline)
 * to `filePath`. Returns null on success, or an error message on failure (no write).
 * The message is prose: callers carry it as detail after their own error token.
 */
function appendJsonlLine(filePath: string, eventJson: string): string | null {
  if (!eventJson) return 'Error: event payload is empty';
  try {
    JSON.parse(eventJson);
  } catch (err: any) {
    return `Invalid JSON: ${err.message}`;
  }
  ensureLedgerFile(filePath);
  fs.appendFileSync(filePath, eventJson + '\n', 'utf-8');
  return null;
}

/**
 * Create the ledger at 0600 if it does not exist yet. Rows across these files carry
 * channel and user IDs, tool names and command programs, and `fs.appendFileSync`
 * would otherwise leave a new file at the process umask (0644 under the usual 022).
 * Defined here so every JSONL writer inherits it instead of each remembering the
 * openSync dance.
 */
function ensureLedgerFile(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) fs.closeSync(fs.openSync(filePath, 'a', 0o600));
  } catch { /* fail-open — the append below reports the real error */ }
}

/** Drop rows older than the retention window; only called when the head row is stale. */
function pruneStale(filePath: string, retentionMs: number, now: Date): void {
  const cutoff = now.getTime() - retentionMs;
  const kept = fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter((line) => {
      if (!line.trim()) return false;
      try {
        return new Date(JSON.parse(line).ts).getTime() >= cutoff;
      } catch {
        return true; // unparseable lines are kept verbatim, per house rule
      }
    });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '', { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

/**
 * Prune only when the ledger's oldest row has aged out — avoids rewriting on every
 * append. Rows must carry a `ts` field parseable by `new Date()`.
 *
 * The rewrite is a whole-file read-modify-write with no lock, so a concurrent
 * append landing between the read and the rename is lost. That is bounded by the
 * head gate: once a prune runs the head is fresh, so in steady state this rewrites
 * at most once per retention period per install.
 */
function pruneJsonlIfHeadStale(filePath: string, retentionMs: number, now: Date): void {
  if (!fs.existsSync(filePath)) return;
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(512);
    const read = fs.readSync(fd, buf, 0, 512, 0);
    const head = buf.subarray(0, read).toString('utf-8').split('\n')[0];
    if (!head.trim()) return;
    const ts = new Date(JSON.parse(head).ts).getTime();
    if (Number.isNaN(ts) || ts >= now.getTime() - retentionMs) return;
  } catch {
    return;
  } finally {
    fs.closeSync(fd);
  }
  pruneStale(filePath, retentionMs, now);
}

export { appendJsonlLine, pruneJsonlIfHeadStale, ensureLedgerFile };
