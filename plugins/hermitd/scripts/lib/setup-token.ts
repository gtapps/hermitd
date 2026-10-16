/**
 * Long-lived subscription OAuth token ("claude setup-token") support.
 *
 * Two artifacts, deliberately split by sensitivity:
 *
 *   - the token itself: a 0600 file in CLAUDE_CONFIG_DIR (the persistent
 *     claude-config volume under Docker, alongside .credentials.json). It is
 *     NOT stored in .env — compose applies env_file only at container
 *     creation, so an .env-stored token would force a host-side recreate on
 *     every renewal, which is the manual box access this whole feature exists
 *     to remove. hermitd-start exports it into the session env instead.
 *
 *   - the record: { minted_at, expires_at } in the hermit's state dir. Carries
 *     no secret, so doctor/watchdog can read expiry without touching the token.
 *     Expiry is deterministic precisely because the hermit mints the token: the
 *     CLI exposes no expiry surface for it (no warning, no /status row, no
 *     credentials-file field — confirmed live), so this record is the only
 *     source of truth.
 *
 * Auth-mode detection is env/file presence, never parsing `claude /status` or
 * any other TUI output — those labels shift between releases.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TOKEN_FILENAME = '.hermit-setup-token';
export const TOKEN_ENV_VAR = 'CLAUDE_CODE_OAUTH_TOKEN';
/** The stored /login credential. */
export const CREDENTIALS_FILENAME = '.credentials.json';
/** setup-token mints a 1-year credential. */
export const TOKEN_TTL_MS = 365 * 24 * 3600 * 1000;

export type TokenRecord = { minted_at: string; expires_at: string };

/** CLAUDE_CONFIG_DIR when set, else the CLI's default (~/.claude). */
export function defaultConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** Claude Code's global state is outside ~/.claude unless a config dir is supplied. */
export function claudeStateFile(configDir?: string): string {
  return path.join(configDir ?? (process.env.CLAUDE_CONFIG_DIR || os.homedir()), '.claude.json');
}

/**
 * True when this process's environment carries a credential Claude Code uses
 * INSTEAD of a stored login: an API key, a bearer token, or a cloud provider.
 * A 401 under any of these is not a login lapse.
 *
 * Only meaningful in a process that shares the session's environment — the
 * session itself, or Docker, where the whole container shares one. A host
 * watchdog does not, and reads the launch stamp in runtime.json instead.
 */
export function envAuthPresent(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      process.env.CLAUDE_CODE_USE_BEDROCK ||
      process.env.CLAUDE_CODE_USE_VERTEX ||
      process.env.CLAUDE_CODE_USE_FOUNDRY,
  );
}

export function tokenFilePath(configDir: string): string {
  return path.join(configDir, TOKEN_FILENAME);
}

export function credentialsFilePath(configDir: string): string {
  return path.join(configDir, CREDENTIALS_FILENAME);
}

/**
 * tmux session name for the mint pane, and the path its output streams to.
 *
 * Both are namespaced by project directory, like getSessionName() does for the
 * managed session: two hermits under one user's tmux server would otherwise
 * share a mint session and a capture file, and either one's cleanupMint()
 * would tear down the other's in-flight sign-in.
 */
export function mintSessionName(): string {
  return `hermit-reauth-mint-${path.basename(process.cwd())}`;
}

export function mintCaptureFilePath(): string {
  return path.join(os.tmpdir(), `.${mintSessionName()}-capture`);
}

export function tokenRecordPath(hermitDir: string): string {
  return path.join(hermitDir, 'state', 'setup-token.json');
}

/** Trimmed token text, or null when absent/empty/unreadable. */
export function readTokenValue(configDir: string): string | null {
  try {
    const raw = fs.readFileSync(tokenFilePath(configDir), 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * True when this hermit authenticates with a long-lived setup-token — either
 * already exported into the environment, or installed on disk awaiting the
 * next process start. The file is the boot-time signal: the docker entrypoint
 * runs BEFORE hermitd-start exports the env var, so a gate keyed only on the
 * env var would never see token mode.
 */
export function tokenModeActive(configDir: string): boolean {
  if (process.env[TOKEN_ENV_VAR]) return true;
  return readTokenValue(configDir) !== null;
}

/** Parsed record, or null when absent/malformed (callers treat null as "not token mode"). */
export function readTokenRecord(hermitDir: string): TokenRecord | null {
  try {
    const rec = JSON.parse(fs.readFileSync(tokenRecordPath(hermitDir), 'utf8'));
    if (typeof rec?.expires_at !== 'string' || Number.isNaN(Date.parse(rec.expires_at))) return null;
    return { minted_at: String(rec.minted_at ?? ''), expires_at: rec.expires_at };
  } catch {
    return null;
  }
}

/**
 * Shape check for a scraped token. The mint driver captures from a tmux pane,
 * so the real failure mode is grabbing an adjacent line rather than the token —
 * hence the prefix and whitespace checks, which reject prose outright.
 */
export function isPlausibleToken(token: string): boolean {
  const t = token.trim();
  if (t.length < 20) return false;
  if (/\s/.test(t)) return false;
  return t.startsWith('sk-ant-');
}

/**
 * Install a freshly minted token: 0600 file + expiry record. Returns the record
 * only — the token value never appears in a return value that a caller might
 * print, because every front door prints its result to a terminal or a channel.
 */
export function installToken(hermitDir: string, configDir: string, token: string): TokenRecord {
  const value = token.trim();
  if (!isPlausibleToken(value)) throw new Error('refusing to install implausible token');

  fs.mkdirSync(configDir, { recursive: true });
  const dest = tokenFilePath(configDir);
  const tmp = `${dest}.tmp`;
  // Create with 0600 up front rather than write-then-chmod, so the secret is
  // never briefly world-readable.
  fs.writeFileSync(tmp, `${value}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, dest);

  const now = new Date();
  const record: TokenRecord = {
    minted_at: now.toISOString(),
    expires_at: new Date(now.getTime() + TOKEN_TTL_MS).toISOString(),
  };
  fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
  const recPath = tokenRecordPath(hermitDir);
  fs.writeFileSync(`${recPath}.tmp`, JSON.stringify(record, null, 2) + '\n');
  fs.renameSync(`${recPath}.tmp`, recPath);

  return record;
}

/** Milliseconds until the recorded expiry; null when there's no usable record. */
export function msUntilExpiry(hermitDir: string, now: number = Date.now()): number | null {
  const rec = readTokenRecord(hermitDir);
  if (!rec) return null;
  return Date.parse(rec.expires_at) - now;
}

/** How this hermit authenticates. `external` = an env credential outranks both files. */
export type AuthMode = 'login' | 'token' | 'external';

/** What a stored /login credential file is, for callers that need more than a boolean. */
export type StoredLoginStatus = 'absent' | 'malformed' | 'stub' | 'usable';

/**
 * Classify the stored /login credential, and surface the one expiry field that means
 * anything.
 *
 * The `stub` case is the load-bearing one. Observed live on CC 2.1.251: when a refresh
 * fails, Claude Code rewrites the file in place as
 * `{"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":0,…}}` — the file
 * survives as an inert stub. So "the file exists" and "the file changed" both keep
 * reading healthy through a lapse, and only the token's presence distinguishes a
 * hermit that can work from one that can't. `/logout` leaves the same stub.
 *
 * `expiresAt` stays rejected as an expiry signal: the access token refreshes silently
 * roughly every 8h, so a past value says nothing (doctor-check makes the same point
 * where it declines to warn on that field). `refreshTokenExpiresAt` is the field
 * refresh does NOT move — Claude Code computes it once at sign-in as
 * `now + refresh_token_expires_in * 1000` (~30 days for a claude.ai login) and carries
 * it forward untouched. It is the only durable "this hermit goes dark on" date a
 * stored login has.
 */
export function inspectStoredLogin(configDir: string): {
  status: StoredLoginStatus;
  refreshExpiresAt: number | null;
} {
  let raw: string;
  try {
    raw = fs.readFileSync(credentialsFilePath(configDir), 'utf8');
  } catch {
    return { status: 'absent', refreshExpiresAt: null };
  }
  let creds: any;
  try {
    creds = JSON.parse(raw);
  } catch {
    return { status: 'malformed', refreshExpiresAt: null };
  }
  const token = creds?.claudeAiOauth?.accessToken;
  if (typeof token !== 'string' || token.length === 0) {
    return { status: 'stub', refreshExpiresAt: null };
  }
  const exp = creds?.claudeAiOauth?.refreshTokenExpiresAt;
  return {
    status: 'usable',
    refreshExpiresAt: typeof exp === 'number' && Number.isFinite(exp) ? exp : null,
  };
}

/**
 * True when a stored /login credential still carries a token — i.e. somebody could
 * work with it. Deliberately NOT an expiry check; see inspectStoredLogin.
 */
export function storedLoginUsable(configDir: string): boolean {
  return inspectStoredLogin(configDir).status === 'usable';
}

/**
 * Milliseconds until a stored /login goes dark, or null when there is nothing to
 * measure. A stub returns -1: that credential is already spent, so callers comparing
 * `<= 0` treat "lapsed" and "expired" alike without a second check.
 */
export function msUntilLoginExpiry(configDir: string, now: number = Date.now()): number | null {
  const { status, refreshExpiresAt } = inspectStoredLogin(configDir);
  if (status === 'stub') return -1;
  if (status !== 'usable' || refreshExpiresAt === null) return null;
  return refreshExpiresAt - now;
}

/**
 * What is actually on the credential volume, for installs that predate `auth_mode` and
 * have to be stamped from evidence rather than asked. Null means "nothing conclusive" —
 * leave the key unset rather than guess.
 */
export function detectAuthModeFromVolume(configDir: string): 'login' | 'token' | null {
  if (readTokenValue(configDir) !== null) return 'token';
  if (storedLoginUsable(configDir)) return 'login';
  return null;
}

/**
 * How this hermit authenticates, in precedence order:
 *
 *   1. an env credential (API key, bearer, cloud provider) outranks both files and is
 *      nobody's to renew from chat → `external`
 *   2. the operator's explicit `auth_mode` in config
 *   3. a setup-token on the volume → `token`. This has to outrank the Keychain
 *      heuristic below, not follow it: a macOS token hermit usually has no
 *      `.credentials.json` (any login lives in the Keychain), and the
 *      darwin branch would read it as `external` — which stops hermitd-start from
 *      exporting the token and boots the hermit with no credential at all.
 *   4. macOS with no .credentials.json: the login lives in the Keychain, which this
 *      code cannot inspect → `external`
 *   5. otherwise `login` is the residual — a hermit with neither artifact has not
 *      signed in yet, and the flow it should get is the claude.ai one.
 *
 * `platform` is a parameter so the ladder's darwin arm is exercised on Linux CI.
 * Step 3 exists because a macOS-only ordering bug shipped invisibly without it.
 */
export function resolveAuthMode(
  config: any,
  configDir: string,
  envAuth: boolean = envAuthPresent(),
  platform: NodeJS.Platform = process.platform,
): AuthMode {
  if (envAuth) return 'external';
  const declared = config?.auth_mode;
  if (declared === 'login' || declared === 'token') return declared;
  if (tokenModeActive(configDir)) return 'token';
  if (platform === 'darwin' && !fs.existsSync(credentialsFilePath(configDir))) {
    return 'external';
  }
  return 'login';
}
