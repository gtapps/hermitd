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
 * Auth-mode detection is env/file presence; a stored login's state comes from
 * `claude auth status` JSON (loginStatus), never from TUI output or the
 * credentials file's contents.
 */

import { spawnSync } from 'node:child_process';
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
  return ENV_AUTH_VARS.some((key) => Boolean(process.env[key]));
}

/** Env credentials that outrank a stored login: an API key, a bearer token, a cloud provider. */
const ENV_AUTH_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

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

/** Claude Code's own verdict on the stored claude.ai login. */
export type LoginState = 'usable' | 'lapsed' | 'unknown';

/**
 * The stored claude.ai login as Claude Code reports it through `claude auth status`.
 *
 * Exit 0 with `authMethod: "claude.ai"` is a signed-in login; `loginExpiresAt` is its
 * refresh expiry, which Claude Code reports without judging, so a passed date is
 * `lapsed` here. Exit 1 with `loggedIn: false` covers a refresh-failure stub, an absent
 * file and an unreadable one alike. Anything else is `unknown`, and callers act on
 * nothing they cannot see: a missing binary, a timeout, or output in another shape.
 *
 * This is local usability, not proof that a request will succeed. With an expired
 * access token the command refreshes the login itself under Claude Code's own lock,
 * and a refresh that fails there still reports usable on that call; the next call
 * reads lapsed.
 *
 * CLAUDE_CONFIG_DIR is set only for a dir other than the default: Claude Code keeps
 * `.claude.json` under it whenever it is set, even to `~/.claude`.
 */
export function loginStatus(
  configDir: string = defaultConfigDir(),
  now: number = Date.now(),
): { state: LoginState; expiresAt: number | null } {
  const unknown = { state: 'unknown' as const, expiresAt: null };
  const env: Record<string, string | undefined> = { ...process.env };
  // Anything that makes Claude Code ignore the stored login is stripped, so the verdict is about the login.
  for (const key of [...ENV_AUTH_VARS, TOKEN_ENV_VAR]) delete env[key];
  if (configDir !== defaultConfigDir()) env.CLAUDE_CONFIG_DIR = configDir;
  const r = spawnSync('claude', ['auth', 'status'], { env, encoding: 'utf8', timeout: 3000 });
  if (r.error || r.signal || (r.status !== 0 && r.status !== 1)) return unknown;
  let out: any;
  try {
    out = JSON.parse(r.stdout);
  } catch {
    return unknown;
  }
  if (!out || typeof out !== 'object' || Array.isArray(out)) return unknown;
  if (r.status === 1) return out.loggedIn === false ? { state: 'lapsed', expiresAt: null } : unknown;
  if (out.authMethod !== 'claude.ai') return unknown;
  if (out.loginExpiresAt == null) return { state: 'usable', expiresAt: null };
  const expiresAt = typeof out.loginExpiresAt === 'string' ? Date.parse(out.loginExpiresAt) : NaN;
  if (Number.isNaN(expiresAt)) return unknown;
  return { state: expiresAt > now ? 'usable' : 'lapsed', expiresAt };
}

/**
 * What is actually on the credential volume, for installs that predate `auth_mode` and
 * have to be stamped from evidence rather than asked. Null means "nothing conclusive" —
 * leave the key unset rather than guess.
 */
export function detectAuthModeFromVolume(configDir: string): 'login' | 'token' | null {
  if (readTokenValue(configDir) !== null) return 'token';
  // The file gate keeps a macOS Keychain login out: the relay installs into the file.
  if (fs.existsSync(credentialsFilePath(configDir)) && loginStatus(configDir).state === 'usable') return 'login';
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
