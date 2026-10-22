/**
 * Post a message into another Claude Code session's inbox socket.
 *
 * Claude Code binds a per-session Unix socket and delivers whatever arrives on
 * it as a user turn: immediately when the session is idle, at the next tool
 * boundary when it is mid-turn. That is the whole appeal over typing
 * into a tmux pane — no pane state, no Escape/Enter choreography, no keystrokes
 * swallowed by a running tool.
 *
 * Wire format is newline-delimited JSON: an optional
 * `{"type":"auth","token":…}` line (required only on native Windows; the token
 * is a session's own `CLAUDE_CODE_MESSAGING_TOKEN`), then
 * `{"type":"user","message":{"role":"user","content":"…"}}`. The daemon closes
 * a connection that hasn't sent a complete line within 30s, so the payload is
 * built before connecting, never streamed.
 *
 * The verdict is deliberately two-valued. A successful write means the bytes
 * reached the socket, NOT that the model read them: the receiving session
 * applies its own inbound controls afterwards, and both ways it can drop the
 * message are invisible to us — `crossSessionInbound: refuse` drops silently,
 * and a receiver whose inbound controls still hold an unauthenticated post (one
 * launched without the hermit's `accept` overlay, or an operator-set `hold`)
 * leaves it behind an approval dialog that expires in five minutes. A model
 * that declines to act on the text is equally unobservable. So callers must
 * never read 'sent' as
 * "delivered"; confirm the effect instead (the watchdog re-checks staleness on
 * the next tick and falls back to the core mod's command queue).
 */

import net from 'node:net';

export type PostVerdict = 'sent' | 'dead';

/** Connect timeout. Generous next to a local Unix socket connect, well under
 *  the daemon's own 30s line deadline. */
const DEFAULT_TIMEOUT_MS = 5000;

/** One NDJSON frame. Exported so tests and drift guards can rebuild the exact
 *  bytes without re-deriving the shape. */
export function userMessageLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
}

/**
 * Write one user message to `socketPath`.
 *
 * Resolves 'sent' once the payload is flushed, 'dead' for every failure mode
 * (no such socket, nothing listening, refused, timed out). Never rejects — a
 * wake path must not throw on an absent peer.
 */
export function postToSession(
  socketPath: string,
  text: string,
  opts: { token?: string; timeoutMs?: number } = {},
): Promise<PostVerdict> {
  const payload =
    (opts.token ? JSON.stringify({ type: 'auth', token: opts.token }) + '\n' : '') +
    userMessageLine(text);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (verdict: PostVerdict) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(verdict);
    };

    const socket = net.connect(socketPath);
    socket.setTimeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    socket.on('timeout', () => finish('dead'));
    socket.on('error', () => finish('dead'));
    socket.on('connect', () => {
      // The callback fires after the write is flushed to the kernel, which is
      // as far as delivery is observable from this side.
      socket.write(payload, () => finish('sent'));
    });
  });
}
