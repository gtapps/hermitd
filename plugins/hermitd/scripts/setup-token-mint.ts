#!/usr/bin/env bun
/**
 * Drives `claude setup-token` to mint a fresh long-lived credential, with two
 * front doors over one state machine:
 *
 *   - terminal: the operator is at a shell (`hermitd-docker setup-token`), so
 *     the URL prints to stdout and the login code is read from stdin.
 *   - relay:    nobody has box access, so the URL goes out over the operator's
 *     channel and the login code is polled back from the channel log. Fully
 *     deterministic — the watchdog spawns it with no model in the loop.
 *
 * The skill (/hermitd:relogin) drives the same machine one step at a
 * time via the stepwise verbs, so the model can relay through its own channel
 * reply without the token ever entering its context.
 *
 * Security shape: the one-time OAuth URL and the login code cross the channel;
 * the token never does. It goes tmux pane stream -> installToken() -> 0600 file,
 * and is never printed, logged, or returned to a caller. cleanupMint() destroys
 * both places it lands (the capture file and the tmux scrollback) on every exit
 * path, including aborts.
 *
 * Usage: bun scripts/setup-token-mint.ts <verb> [args]
 *   terminal                  attended end-to-end mint (stdin/stdout)
 *   relay                     ack-first channel-relayed mint (watchdog-spawned)
 *   start                     begin a mint session
 *   await-url                 print the OAuth URL once it appears
 *   submit-code <code>        paste a login code into the running mint
 *   await-token-and-install   capture the token, install it, print the digest
 *   finish                    restart the session so the new token takes effect
 *   abort                     tear down a running mint
 *   probe [hermitDir]         doctor's expiry probe — one line: OK | EXPIRED |
 *                             EXPIRES:<iso8601> (see hermit-meta.json)
 *   stamp-auth-mode           record what this install already authenticates with
 *
 * Two auth modes over the same machine. In `token` mode the pane runs
 * `claude setup-token` and the scraped token is installed directly. In `login`
 * mode the pane runs `claude auth login --claudeai` against a STAGING
 * CLAUDE_CONFIG_DIR: this script never writes the live `.credentials.json`,
 * because the resident session refreshes that file roughly every 8h and would
 * silently undo a renewal written underneath it. Instead the staged credential
 * is left in place with a pointer at `state/pending-credential.json`, and the
 * watchdog moves it into position inside its own kill→verify→start boundary,
 * where nothing else is running to race it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  AuthMode,
  defaultConfigDir,
  detectAuthModeFromVolume,
  envAuthPresent,
  inspectStoredLogin,
  installToken,
  isPlausibleToken,
  mintCaptureFilePath,
  mintSessionName,
  readTokenRecord,
  resolveAuthMode,
  tokenModeActive,
} from './lib/setup-token';
import { sendToChannel } from './lib/channel-send';
import { inboundSince } from './lib/channel-log';
import { tmuxSessionAlive } from './lib/tmux';
import { readSettledConfig } from './lib/config-read';
import { resolve as resolveOutboundChannel } from './resolve-outbound-channel';
import { resolveLocale, MINT, dates } from './lib/messages';
import { readRuntimeJson } from './lib/runtime';
import { flagValue } from './lib/cli';
import { writeFileAtomic } from './lib/md-write';

const HERMIT_DIR = process.env.HERMIT_DIR || '.hermit';
const MINT_SESSION = mintSessionName();
const CAPTURE_FILE = mintCaptureFilePath();
const MARKER_FILE = path.join(HERMIT_DIR, 'state', 'reauth-relay.json');
/** Where a relayed claude.ai sign-in lands until the watchdog commits it. */
const LOGIN_STAGING_DIR = path.join(defaultConfigDir(), '.hermit-login-staging');
/** Carries no secret — just where the staged credential is and when it got there. */
const PENDING_CREDENTIAL_FILE = path.join(HERMIT_DIR, 'state', 'pending-credential.json');
/**
 * Written when the relay's own send fails. The watchdog honours it for 24h, which
 * is what stops a hermit with no channel (or a dead one) from respawning a relay
 * nobody can answer on every tick.
 */
const RELAY_UNREACHABLE_FILE = path.join(HERMIT_DIR, 'state', 'relay-unreachable.json');

// A tmux pane hard-wraps its output, and both artifacts we scrape are long: the
// OAuth URL (~250 chars) and the minted token (~110). A wrapped token would be
// silently truncated by the extractor and installed as garbage, taking the
// hermit dark with no obvious cause — so the mint pane is created far wider
// than either can be. This width is load-bearing, not cosmetic.
const MINT_COLS = 400;
const MINT_ROWS = 50;

const URL_TIMEOUT_MS = 90_000;
const TOKEN_TIMEOUT_MS = 180_000;
const ACK_TIMEOUT_MS = 24 * 3600_000;
const CODE_TIMEOUT_MS = 30 * 60_000;
const POLL_MS = 2_000;

// Resolved once at process start (the relay is a single-shot process, so this IS
// "pinned at flow start"): the operator's locale for all prompts, and the primary
// reply route the ack/code intake is bound to. A login code pasted in any other
// chat the bot can see must never be accepted — matching the physical chat_id is
// the strong pin. Null route = no channel configured (terminal/attended flow), so
// no filtering.
const MINT_CONFIG: any = readSettledConfig(HERMIT_DIR);
const OPERATOR_LOCALE = resolveLocale(MINT_CONFIG.language);
const REPLY_ROUTE = resolveOutboundChannel(MINT_CONFIG.channels);

// Which credential this run mints. Resolved from config + volume at process start;
// `terminal`/`relay` accept `--target login|token` to override it for one run, which
// is how `hermitd-docker login` switches a hermit that is currently on a token.
let AUTH_TARGET: AuthMode = resolveAuthMode(MINT_CONFIG, defaultConfigDir());

function rowMatchesReplyRoute(r: any): boolean {
  if (!REPLY_ROUTE) return true;
  return String(r?.chat_id ?? '') === String(REPLY_ROUTE.chat_id);
}

// ---------- pane-stream parsing (shapes confirmed live against CC 2.1.216) ----------

const OSC8_TARGET_RE = /\x1b\]8;;(https:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/g;
const PLAIN_URL_RE = /https:\/\/[^\s\x07"'<>]+/g;
const TOKEN_RE = /sk-ant-[A-Za-z0-9_-]{20,}/g;

/**
 * The OAuth URL from a pipe-pane stream.
 *
 * The visible pane text is hard-wrapped and elided mid-URL, so scraping what a
 * human sees yields a broken link — capture-pane is unusable here even with -J
 * (confirmed live). The complete URL survives as the OSC-8 hyperlink target,
 * which is why this reads the escape sequence rather than the rendered text.
 * Longest candidate wins, so a truncated visible copy can never outrank it.
 */
export function extractUrl(stream: string): string | null {
  const candidates: string[] = [];
  for (const m of stream.matchAll(OSC8_TARGET_RE)) candidates.push(m[1]);
  for (const m of Bun.stripANSI(stream).matchAll(PLAIN_URL_RE)) candidates.push(m[0]);

  const oauth = candidates
    .map((u) => u.trim().replace(/[)\],.]+$/, ''))
    .filter((u) => u.includes('oauth'));
  if (oauth.length === 0) return null;
  return oauth.sort((a, b) => b.length - a.length)[0];
}

/** The minted token, or null. Last match wins — the token is the final thing printed. */
export function extractToken(stream: string): string | null {
  const matches = [...Bun.stripANSI(stream).matchAll(TOKEN_RE)].map((m) => m[0]);
  for (let i = matches.length - 1; i >= 0; i--) {
    if (isPlausibleToken(matches[i])) return matches[i];
  }
  return null;
}

/** First inbound channel message after `sinceIso` that looks like an ack. */
export function findAck(rows: { text: string }[]): boolean {
  return rows.some((r) => /\breauth\b/i.test(r.text || ''));
}

/**
 * First inbound message after `sinceIso` that looks like a login code. The code
 * is an opaque string the operator pastes, so this takes the first non-ack
 * message and trims it rather than pattern-matching a format that may change.
 */
export function findCode(rows: { text: string }[]): string | null {
  for (const r of rows) {
    const t = (r.text || '').trim();
    if (!t || /\breauth\b/i.test(t)) continue;
    if (t.split(/\s+/).length > 3) continue; // prose, not a pasted code
    return t;
  }
  return null;
}

// ---------- tmux mint session ----------

function tmux(args: string[]): { status: number; stdout: string } {
  const r = spawnSync('tmux', args, { encoding: 'utf-8', timeout: 10_000 });
  return { status: r.status ?? 1, stdout: typeof r.stdout === 'string' ? r.stdout : '' };
}

function mintSessionAlive(): boolean {
  return tmuxSessionAlive(MINT_SESSION);
}

function readStream(): string {
  try {
    return fs.readFileSync(CAPTURE_FILE, 'utf8');
  } catch {
    return '';
  }
}

export function readMarker(): any | null {
  try {
    return JSON.parse(fs.readFileSync(MARKER_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeMarker(stage: string, mode: string): void {
  try {
    fs.mkdirSync(path.dirname(MARKER_FILE), { recursive: true });
    const existing = readMarker();
    fs.writeFileSync(
      MARKER_FILE,
      JSON.stringify(
        {
          pid: process.pid,
          mode,
          stage,
          started_at: existing?.started_at ?? new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        null,
        2
      ) + '\n'
    );
  } catch {}
}

function clearMarker(): void {
  try {
    fs.unlinkSync(MARKER_FILE);
  } catch {}
}

/** Single-quote a path for the shell command `pipe-pane` runs. */
function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Create the capture file fresh, refusing to follow anything already at that
 * path. The path is predictable and lives in a world-writable tmpdir, and
 * pipe-pane appends to it through a shell redirect — which would happily follow
 * a pre-planted symlink and hand the minted token to whoever planted it.
 * O_CREAT|O_EXCL ('wx') does not follow symlinks, so it fails loudly instead.
 */
function createCaptureFile(): void {
  fs.rmSync(CAPTURE_FILE, { force: true });
  fs.closeSync(fs.openSync(CAPTURE_FILE, 'wx', 0o600));
  fs.chmodSync(CAPTURE_FILE, 0o600);
}

/**
 * A fresh 0700 staging dir for a claude.ai sign-in. Emptied first: a half-finished
 * earlier attempt could otherwise leave a stub `.credentials.json` that the success
 * poll would have to distinguish from the real thing.
 */
function resetLoginStaging(): void {
  fs.rmSync(LOGIN_STAGING_DIR, { recursive: true, force: true });
  fs.mkdirSync(LOGIN_STAGING_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(LOGIN_STAGING_DIR, 0o700);
}

/** Throw away a staged sign-in and the pointer at it. Safe when neither exists. */
function discardStagedLogin(): void {
  fs.rmSync(LOGIN_STAGING_DIR, { recursive: true, force: true });
  try {
    fs.unlinkSync(PENDING_CREDENTIAL_FILE);
  } catch {}
}

export function readPendingCredential(): { staged_dir: string; staged_at: string } | null {
  try {
    const p = JSON.parse(fs.readFileSync(PENDING_CREDENTIAL_FILE, 'utf8'));
    return typeof p?.staged_dir === 'string' ? p : null;
  } catch {
    return null;
  }
}

/**
 * The pane command for a mode. Login mode points the CLI at the staging dir and
 * never at the live one — that redirection is the whole reason a renewal cannot be
 * clobbered by the resident session's own 8-hourly refresh.
 *
 * Takes its inputs rather than reading module state so the shape can be asserted
 * without starting tmux.
 */
export function mintCommand(mode: AuthMode, stagingDir: string): string {
  return mode === 'login'
    ? `CLAUDE_CONFIG_DIR=${shQuote(stagingDir)} claude auth login --claudeai; sleep 20`
    : 'claude setup-token; sleep 20';
}

/** Start the sign-in in a wide detached pane, streaming to a 0600 capture file. */
function startMint(mode: string): void {
  cleanupMint();
  createCaptureFile();
  if (AUTH_TARGET === 'login') resetLoginStaging();

  // Linger briefly after the CLI exits so the token stays streamable even if the
  // poller is between ticks when the process ends.
  const r = tmux([
    'new-session', '-d', '-s', MINT_SESSION,
    '-x', String(MINT_COLS), '-y', String(MINT_ROWS),
    mintCommand(AUTH_TARGET, LOGIN_STAGING_DIR),
  ]);
  if (r.status !== 0) throw new Error('failed to start mint session');
  tmux(['pipe-pane', '-o', '-t', MINT_SESSION, `cat >> ${shQuote(CAPTURE_FILE)}`]);
  writeMarker('started', mode);
}

/**
 * Paste a login code into the mint pane (text then Enter — bracketed-paste bug).
 *
 * `-l --` is load-bearing: without it tmux parses the code as a key sequence, so
 * a code that happens to start with `-` is read as an option (the send fails
 * silently and the flow times out on a link already burned), and one that
 * matches a key name is sent as that key rather than as text.
 */
function submitCode(code: string): void {
  tmux(['send-keys', '-l', '-t', MINT_SESSION, '--', code]);
  Bun.sleepSync(500);
  tmux(['send-keys', '-t', MINT_SESSION, 'Enter']);
}

/**
 * Destroy every copy of the token: the capture file and the pane scrollback it
 * was printed into. Safe to call when nothing is running.
 */
export function killMintPane(): void {
  tmux(['kill-session', '-t', MINT_SESSION]);
  try {
    fs.unlinkSync(CAPTURE_FILE);
  } catch {}
}

/**
 * Full teardown: the pane, plus any staged sign-in and the pointer at it. This is
 * the abort/failure path. A login-mode SUCCESS calls killMintPane() instead,
 * because the staged credential has to outlive this process — the watchdog is what
 * moves it into place.
 */
export function cleanupMint(): void {
  killMintPane();
  discardStagedLogin();
}

async function waitFor<T>(
  probe: () => T | null,
  timeoutMs: number,
  onTick?: () => void
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const got = probe();
    if (got !== null && got !== undefined) return got;
    onTick?.();
    await Bun.sleep(POLL_MS);
  }
  return null;
}

// ---------- operator I/O adapters ----------

/** notify() reports delivery: an unreachable operator must stop the flow, not stall it. */
type OperatorIO = {
  notify(text: string): Promise<boolean>;
  awaitAck(sinceIso: string): Promise<boolean>;
  awaitCode(sinceIso: string): Promise<string | null>;
};

const terminalIO: OperatorIO = {
  async notify(text) {
    console.log(text);
    return true;
  },
  async awaitAck() {
    return true; // the operator is already here
  },
  async awaitCode() {
    process.stdout.write('Paste the login code (or press Enter to skip): ');
    for await (const line of console) return line.trim() || null;
    return null;
  },
};

const channelIO: OperatorIO = {
  async notify(text) {
    // Auth prompts are sensitive but must reach the SAME chat the ack/code intake
    // is pinned to (REPLY_ROUTE = the resolved primary chat) — otherwise a
    // maintainer-tier send would land the sign-in link in the maintainer chat
    // while replies are only accepted from the primary chat, deadlocking reauth.
    // `sensitive` keeps the OAuth URL out of the searchable channel log.
    const r = await sendToChannel(HERMIT_DIR, text, { sensitive: true });
    return r.ok;
  },
  async awaitAck(sinceIso) {
    const got = await waitFor(
      () => (findAck(inboundSince(HERMIT_DIR, sinceIso).filter(rowMatchesReplyRoute)) ? true : null),
      ACK_TIMEOUT_MS
    );
    return got === true;
  },
  async awaitCode(sinceIso) {
    return await waitFor(
      () => findCode(inboundSince(HERMIT_DIR, sinceIso).filter(rowMatchesReplyRoute)),
      CODE_TIMEOUT_MS
    );
  },
};

// ---------- the shared flow ----------

async function runMintFlow(io: OperatorIO, mode: string, requireAck: boolean): Promise<number> {
  const startedAt = new Date().toISOString();

  if (requireAck) {
    writeMarker('awaiting-ack', mode);
    const reached = await io.notify(MINT[OPERATOR_LOCALE].ackPrompt());
    // No way to reach the operator means no way to finish: bail now rather than
    // minting a link nobody will see and then waiting on a reply that can't come.
    if (!reached) {
      clearMarker();
      // The send is the reachability test — a hermit with no channel and one whose
      // channel is dead both fail here. Stamping it is what keeps the watchdog from
      // respawning this same doomed relay on its next tick.
      writeRelayUnreachable();
      return fail('operator unreachable — no channel to relay the sign-in link');
    }
    const acked = await io.awaitAck(startedAt);
    if (!acked) {
      clearMarker();
      return fail('no acknowledgement — nothing minted');
    }
  }

  writeMarker('minting', mode);
  startMint(mode);

  const url = await waitFor(() => extractUrl(readStream()), URL_TIMEOUT_MS);
  if (!url) return abortMint('sign-in link never appeared');

  writeMarker('awaiting-code', mode);
  await io.notify(MINT[OPERATOR_LOCALE].openLink(url));
  // The code window opens only once the link is out. Anchoring it earlier (at
  // the ack) would let ordinary chatter between "reauth" and the link — an "ok",
  // a "sure" — be picked up as the login code and pasted into the pane, failing
  // the mint on a one-time link that is now burned.
  const linkAt = new Date().toISOString();

  // In login mode success is a file appearing in the staging dir, not a token on the
  // pane: `claude auth login` prints no credential. Everything else — the 15s
  // browser-completed grace window, then ask for a code — is the same in both modes.
  const captured = () =>
    AUTH_TARGET === 'login'
      ? inspectStoredLogin(LOGIN_STAGING_DIR).status === 'usable'
        ? 'staged'
        : null
      : extractToken(readStream());

  let got = await waitFor(captured, 15_000);
  if (!got) {
    const code = await io.awaitCode(linkAt);
    if (code) submitCode(code);
    got = await waitFor(captured, TOKEN_TIMEOUT_MS);
  }

  if (!got) {
    cleanupMint();
    clearMarker();
    await io.notify(MINT[OPERATOR_LOCALE].failed());
    return fail(AUTH_TARGET === 'login' ? 'no sign-in captured' : 'no token captured');
  }

  // Drop the marker on success too, not just on failure: it is the "a renewal is
  // in flight" flag that the /relogin preflight and the watchdog both read, and
  // leaving it behind makes the next renewal look already-running.
  if (AUTH_TARGET === 'login') {
    const expiresAt = writePendingCredential();
    // killMintPane, not cleanupMint: the staged credential and its pointer have to
    // survive until the watchdog commits them inside the restart boundary.
    killMintPane();
    clearMarker();
    // Always confirm: the operator just pasted a code and is waiting to hear that it
    // landed. Only the renewal date is conditional — an undated credential gets the
    // dateless phrasing rather than silence.
    await io.notify(
      expiresAt
        ? MINT[OPERATOR_LOCALE].signedIn(dates.friendlyDate(OPERATOR_LOCALE, expiresAt))
        : MINT[OPERATOR_LOCALE].signedInUndated(),
    );
    console.log(JSON.stringify({ ok: true, expires_at: expiresAt }));
    return 0;
  }

  const record = installToken(HERMIT_DIR, defaultConfigDir(), got);
  writeAuthMode('token');
  cleanupMint();
  clearMarker();

  await io.notify(MINT[OPERATOR_LOCALE].signedIn(dates.friendlyDate(OPERATOR_LOCALE, record.expires_at)));
  console.log(JSON.stringify({ ok: true, expires_at: record.expires_at }));
  return 0;
}

/**
 * Point at the staged sign-in and report when it lapses. The ISO string is derived
 * here rather than by the caller so an undated credential surfaces as null — the
 * operator-facing date formatter renders an invalid date as "in about a year",
 * which on a ~30-day login would be a lie the operator acts on.
 */
function writePendingCredential(): string | null {
  const { refreshExpiresAt } = inspectStoredLogin(LOGIN_STAGING_DIR);
  fs.mkdirSync(path.dirname(PENDING_CREDENTIAL_FILE), { recursive: true });
  // Atomic: the watchdog reads this file from another process on its own schedule,
  // so a torn read would look like "no credential pending" and skip the commit.
  writeFileAtomic(
    PENDING_CREDENTIAL_FILE,
    JSON.stringify({ staged_dir: LOGIN_STAGING_DIR, staged_at: new Date().toISOString() }, null, 2) + '\n',
  );
  if (refreshExpiresAt === null) return null;
  const iso = new Date(refreshExpiresAt);
  return Number.isNaN(iso.getTime()) ? null : iso.toISOString();
}

function writeRelayUnreachable(): void {
  try {
    fs.mkdirSync(path.dirname(RELAY_UNREACHABLE_FILE), { recursive: true });
    writeFileAtomic(
      RELAY_UNREACHABLE_FILE,
      JSON.stringify({ at: new Date().toISOString() }, null, 2) + '\n',
    );
  } catch {}
}

/**
 * Record which credential this hermit now runs on. Routed through settings-edit's
 * CLI rather than an fs write: that is where the validation and the audit ledger
 * live, and the module exports only pure helpers.
 */
function writeAuthMode(value: 'login' | 'token', hermitDir: string = HERMIT_DIR): void {
  spawnSync(
    process.execPath,
    [
      path.join(import.meta.dir, 'settings-edit.ts'),
      path.join(hermitDir, 'config.json'),
      'set',
      'auth_mode',
      value,
    ],
    { stdio: 'ignore' },
  );
}

function fail(reason: string): number {
  console.log(JSON.stringify({ ok: false, error: reason }));
  return 1;
}

/** Give up: tear down the mint, drop the marker, report the failure. */
function abortMint(reason: string): number {
  cleanupMint();
  clearMarker();
  return fail(reason);
}

/**
 * Bounce the claude process so it picks up the new token (credentials are read
 * at process start).
 *
 * Detached and unawaited, because the proactive path runs this from inside the
 * very session being restarted: anything that waited would be killed mid-call,
 * and the caller must be free to exit immediately.
 */
function requestRestart(): boolean {
  const bin = path.join(HERMIT_DIR, 'bin', 'hermitd-watchdog');
  if (!fs.existsSync(bin)) return false;
  const child = spawn(bin, ['restart', 'reauth'], { detached: true, stdio: 'ignore' });
  child.unref();
  return true;
}

// ---------- verbs ----------

/**
 * Where the stamp should look for credentials. The session's own `config_dir`
 * (stamped into runtime.json by startup-context.ts) carries a value set in user or
 * managed settings, which this process cannot observe any other way — the same
 * reason the watchdog adopts it before any auth decision.
 */
function stampConfigDir(): string {
  const runtime = readRuntimeJson(path.join(HERMIT_DIR, 'state'));
  if (typeof runtime?.config_dir === 'string' && runtime.config_dir) return runtime.config_dir;
  return defaultConfigDir();
}

async function main(): Promise<void> {
  const verb = process.argv[2] ?? '';
  let code = 0;

  // `--target login|token` overrides the resolved mode for this run only — nothing
  // is written to config until a credential actually exists.
  // `flagValue` reports a trailing `--target` (no value) as undefined, which would
  // silently fall through to the resolved mode — so the flag's presence decides
  // whether a value is required, not whether one was found.
  const target = process.argv.includes('--target') ? (flagValue(process.argv, '--target') ?? '') : undefined;
  if (target === 'login' || target === 'token') AUTH_TARGET = target;
  else if (target !== undefined) {
    console.log(JSON.stringify({ ok: false, error: `--target must be login or token` }));
    process.exit(1);
  }

  // One staged sign-in at a time. Starting a second would reset the staging dir out
  // from under a credential the watchdog has already been told to commit.
  if (verb === 'start' || verb === 'terminal' || verb === 'relay') {
    if (readPendingCredential()) {
      console.log(
        JSON.stringify({ ok: false, error: 'a signed-in credential is already waiting for the next restart' }),
      );
      process.exit(1);
    }
  }

  switch (verb) {
    case 'terminal':
      code = await runMintFlow(terminalIO, 'terminal', false);
      break;

    case 'relay': {
      // clearMarker() unconditionally: runMintFlow already drops the marker on
      // both its own exits, and a throw would otherwise leave one behind that
      // the watchdog reads as a relay still in flight.
      let succeeded = false;
      try {
        code = await runMintFlow(channelIO, 'relay', true);
        succeeded = code === 0;
        if (succeeded) requestRestart();
      } finally {
        // A successful login-mode run deliberately leaves the staged credential and
        // its pointer behind for the watchdog. Only a failure gets the full teardown.
        if (succeeded) killMintPane();
        else cleanupMint();
        clearMarker();
      }
      break;
    }

    case 'start':
      startMint('skill');
      console.log(JSON.stringify({ ok: true, stage: 'started' }));
      break;

    case 'await-url': {
      const url = await waitFor(() => extractUrl(readStream()), URL_TIMEOUT_MS);
      if (!url) {
        code = abortMint('sign-in link never appeared');
      } else {
        writeMarker('awaiting-code', 'skill');
        console.log(JSON.stringify({ ok: true, url }));
      }
      break;
    }

    case 'submit-code': {
      const value = process.argv[3];
      if (!value) {
        code = fail('no code given');
      } else if (!mintSessionAlive()) {
        code = fail('no mint in progress');
      } else {
        submitCode(value);
        console.log(JSON.stringify({ ok: true, stage: 'code-submitted' }));
      }
      break;
    }

    case 'await-token-and-install': {
      if (AUTH_TARGET === 'login') {
        const staged = await waitFor(
          () => (inspectStoredLogin(LOGIN_STAGING_DIR).status === 'usable' ? true : null),
          TOKEN_TIMEOUT_MS,
        );
        if (!staged) {
          code = abortMint('no sign-in captured');
        } else {
          const expiresAt = writePendingCredential();
          killMintPane();
          clearMarker();
          console.log(JSON.stringify({ ok: true, expires_at: expiresAt }));
        }
        break;
      }
      const token = await waitFor(() => extractToken(readStream()), TOKEN_TIMEOUT_MS);
      if (!token) {
        code = abortMint('no token captured');
      } else {
        const record = installToken(HERMIT_DIR, defaultConfigDir(), token);
        writeAuthMode('token');
        cleanupMint();
        clearMarker();
        console.log(JSON.stringify({ ok: true, expires_at: record.expires_at }));
      }
      break;
    }

    case 'abort':
      cleanupMint();
      clearMarker();
      console.log(JSON.stringify({ ok: true, stage: 'aborted' }));
      break;

    // Final step of the proactive (/relogin) path. A verb rather than the skill
    // shelling out to the watchdog directly, so the whole flow stays inside one
    // sealed permission entry — a skill that runs over a channel can't afford a
    // command that prompts, since an unanswerable prompt is a denial.
    case 'finish':
      console.log(JSON.stringify({ ok: requestRestart(), stage: 'restarting' }));
      break;

    case 'status': {
      // token_mode keys on the credential itself, not the expiry record — a
      // leftover record on a hermit that no longer uses token auth must not
      // report as token mode. Same definition the watchdog and entrypoint use.
      // Kept alongside auth_mode because `hermitd-docker login` parses it.
      const record = readTokenRecord(HERMIT_DIR);
      const loginExpiry = inspectStoredLogin(defaultConfigDir()).refreshExpiresAt;
      console.log(
        JSON.stringify({
          ok: true,
          auth_mode: AUTH_TARGET,
          token_mode: tokenModeActive(defaultConfigDir()),
          expires_at:
            AUTH_TARGET === 'login'
              ? loginExpiry === null
                ? null
                : new Date(loginExpiry).toISOString()
              : (record?.expires_at ?? null),
          pending: readPendingCredential() !== null,
          in_progress: readMarker()?.stage ?? null,
        })
      );
      break;
    }

    case 'probe': {
      // Expiry probe for core's own setup-token credential, declared in
      // .claude-plugin/hermit-meta.json and run by doctor's credential-expiry
      // check. Protocol (doctor-check.ts runExpiryProbe): exactly one line of
      // stdout — OK | EXPIRED | EXPIRES:<iso8601>.
      //
      // A hermit not using token auth has no record and prints OK: there is
      // nothing to check, which is materially different from "expired". Note
      // this never reads the token file itself — expiry lives in the record.
      //
      // Takes an optional dir positionally so the declared probe command can
      // stay argument-free while tests can point it at a fixture.
      //
      // One probe, both modes: which credential is live is a property of the
      // install, not of the declaration, so hermit-meta.json declares a single
      // `claude-subscription` entry and this branch decides what to measure.
      try {
        if (AUTH_TARGET === 'external') {
          // An env credential is nobody's to renew from here.
          console.log('OK');
        } else if (AUTH_TARGET === 'login') {
          const { status, refreshExpiresAt } = inspectStoredLogin(defaultConfigDir());
          if (status === 'usable') {
            console.log(refreshExpiresAt === null ? 'OK' : `EXPIRES:${new Date(refreshExpiresAt).toISOString()}`);
          } else if (status === 'malformed') {
            console.log('OK'); // unreadable is a probe problem, not an expiry verdict
          } else {
            // A stub is a spent login; absent in login mode means the sign-in the
            // hermit runs on is gone. Both need the same relogin the operator gets
            // for an expired token.
            console.log('EXPIRED');
          }
        } else {
          const record = readTokenRecord(process.argv[3] || HERMIT_DIR);
          console.log(record ? `EXPIRES:${record.expires_at}` : 'OK');
        }
      } catch {
        // Never let a probe failure read as a credential problem; doctor
        // reports an unparseable line as "probe failed" on its own.
        console.log('OK');
      }
      break;
    }

    // Stamps `auth_mode` on an install that predates the key, from what is
    // actually on the credential volume. Run by hermit-evolve; asks nothing, and
    // never overrides an operator's explicit choice.
    case 'stamp-auth-mode': {
      const configDir = stampConfigDir();
      if (envAuthPresent() || MINT_CONFIG.auth_mode === 'login' || MINT_CONFIG.auth_mode === 'token') {
        console.log(JSON.stringify({ ok: true, source: 'kept' }));
        break;
      }
      const detected = detectAuthModeFromVolume(configDir);
      if (!detected) {
        console.log(JSON.stringify({ ok: true, source: 'unresolved' }));
        break;
      }
      writeAuthMode(detected);
      console.log(JSON.stringify({ ok: true, auth_mode: detected, source: 'detected' }));
      break;
    }

    default:
      process.stderr.write(
        'Usage: setup-token-mint.ts <terminal|relay|start|await-url|submit-code|await-token-and-install|finish|abort|status|probe|stamp-auth-mode> [--target login|token]\n'
      );
      code = 1;
  }

  process.exit(code);
}

if (import.meta.main) {
  main().catch((e) => {
    cleanupMint();
    process.stderr.write(`[setup-token-mint] ${e}\n`);
    process.exit(1);
  });
}
