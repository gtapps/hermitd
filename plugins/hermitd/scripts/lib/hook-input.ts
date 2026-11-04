// Shared stdin-drain helper for PreToolUse hooks.
//
// Every hook must consume stdin to completion even past a size cap (avoids
// broken-pipe errors and keeps the "hooks must never leave the pipe half
// read" contract) — so this drains fully and only stops *buffering* once
// maxBytes is exceeded. Returns null on empty or unparseable input, and the
// distinct OVERSIZE sentinel once the cap is exceeded. Most callers treat both
// as their fail-open signal; a default-deny gate (pause-gate) instead fails
// closed on OVERSIZE, since a payload too large to parse is exactly the shape
// an evasion would take.

export const MAX_HOOK_STDIN = 1024 * 1024; // 1MB

// Returned when stdin exceeds the cap — kept distinct from null (empty /
// unparseable) so a caller can choose to fail closed on oversize alone.
export const OVERSIZE: unique symbol = Symbol('hook-input-oversize');

// `source` defaults to process.stdin; tests inject a fake async iterable
// since the real stdin stream isn't mockable in-process.
export async function readHookInput(
  maxBytes: number = MAX_HOOK_STDIN,
  source: AsyncIterable<Buffer | string> = process.stdin
): Promise<any | null | typeof OVERSIZE> {
  try {
    let total = 0;
    let oversize = false;
    const chunks: Buffer[] = [];
    if (source === process.stdin) process.stdin.on('error', () => {});
    for await (const chunk of source) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      total += buf.length;
      if (total > maxBytes) { oversize = true; continue; }
      chunks.push(buf);
    }
    if (oversize) return OVERSIZE;
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Standard drain-parse-dispatch-exit(0) wrapper for hooks whose `main` is a
// single-shot handler (no internal early exit(0) branches).
// `onOversize` lets a default-deny gate fail closed on a payload too large to
// parse (it may call process.exit(2)); omit it to fail open, the default hook
// contract.
export async function runHook(
  main: (payload: any) => void | Promise<void>,
  onOversize?: () => void
): Promise<void> {
  try {
    const payload = await readHookInput();
    if (payload === OVERSIZE) onOversize?.();
    else if (payload) await main(payload);
  } catch { /* fail-open */ }
  process.exit(0);
}
