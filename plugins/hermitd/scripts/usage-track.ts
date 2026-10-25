import { hermitDir } from './lib/cc-compat';
import { appendUsageEvent } from './lib/usage-ledger';

type Json = any;

/**
 * PostToolUse hook — appends a usage event to state/usage-metrics.jsonl when a
 * compiled/ artifact is read.
 *
 * Compiled reads feed weekly-review's "no tracked use" section, which
 * auto-archives on that evidence. Subagent reads ARE captured: PostToolUse
 * fires for sidechain tool calls, with the parent session_id in the payload
 * (probed on CC 2.1.239).
 *
 * Coverage gaps that remain, and why "no tracked use" is weaker than "unused":
 * startup-context injection; Reads whose PostToolUse payload (tool_response
 * carries the full file body) exceeds MAX_STDIN; and the write-then-deliver
 * path, where a doc the hermit authors and relays over a channel is never Read
 * at all. Legacy `procedure-brief` artifacts remain excluded from the
 * startup catalog, so nothing surfaces them. Docs are therefore only eligible
 * once their own created/updated date is past the window, and weekly-review
 * gates archiving on the ledger having recorded at least one compiled read.
 *
 * Fails open on every error path — never blocks Claude Code. Zero stdout.
 */

// tool_response carries the full file body, so a tight cap drops exactly the
// reads the ledger exists to record — a large doc looked permanently unused.
const MAX_STDIN = 1024 * 1024;
const COMPILED_RE = /(?:^|\/)\.hermit\/compiled\/([^/]+)\.md$/;

function readEvent(callback: (event: Json) => void): void {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    raw += chunk;
    if (raw.length > MAX_STDIN) process.exit(0);
  });
  process.stdin.on('end', () => {
    try {
      callback(JSON.parse(raw));
    } catch (_e) {
      process.exit(0);
    }
  });
  process.stdin.on('error', () => process.exit(0));
}

function main() {
  readEvent(event => {
    const name = event && event.tool_name;
    const input = (event && event.tool_input) || {};

    let usageEvent: Json | null = null;

    if (name === 'Read') {
      const filePath = input.file_path || '';
      const m = typeof filePath === 'string' ? filePath.match(COMPILED_RE) : null;
      if (m) {
        usageEvent = { ts: new Date().toISOString(), kind: 'compiled', name: m[1], source: 'read' };
      }
    }

    if (!usageEvent) process.exit(0);

    try {
      appendUsageEvent(hermitDir(), usageEvent);
    } catch (_e) {
      // fail open
    }
    process.exit(0);
  });
}

main();
