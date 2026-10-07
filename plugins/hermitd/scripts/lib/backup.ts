// Pure helpers + git wrappers for the scheduled state backup (scripts/backup.ts).
//
// Nothing here does I/O at import time, and nothing here spawns backup.ts — the
// watchdog owns the trigger (step 0e), this file owns the decisions. The four
// git verbs a backup must never run (pull/fetch/rebase/merge/reset, push --force,
// --no-verify) appear nowhere in this file or its caller: a backup that rewrites
// the live tree is a new failure class, and divergence is the operator's call.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { latestFires } from './cron';
import { validateCronSchedule } from '../validate-config';
import { pidAlive } from './lockfile';
import { scanCredentials } from './sanitize';
import { transcriptPathKey } from './cc-compat';
import { readJson } from './cli';
import { writeFileAtomic } from './md-write';

export type Json = any;

const MINUTE_MS = 60_000;
// Same 24h scan bound as lib/routines/due.ts: a cursor older than this is
// intentionally abandoned rather than re-walked every tick (no catch-up).
const WINDOW_MS = 24 * 60 * 60 * 1000;

export const CONTENT_SCAN_CAP = 512 * 1024;
export const TOO_LARGE_BYTES = 95 * 1024 * 1024;

// Copied into the mirror repo in `mirror` mode. Workspace mode commits the repo
// root instead, so this list is mirror-only.
export const BACKUP_MANIFEST = ['.hermit', '.claude', 'CLAUDE.md', 'CLAUDE.local.md'];

// The .gitignore marker that says workspace-mode backup owns this file. Contains
// the literal `.hermit` on purpose: hatch-report probes for that
// substring to decide whether the gitignore is configured at all.
export const WORKSPACE_MARKER = '# .hermit state is tracked here (backup: workspace mode)';

// Refusal screen, not a secret boundary — see docs/backup.md. Filename shapes
// only: `*TOKEN*`-style content globs were removed from deny-patterns.json as
// trivially bypassable and noisy, and the same reasoning applies here.
const SECRET_NAME_RES: RegExp[] = [
  /^\.env$/,
  /^\.env\..+$/,
  /\.pem$/,
  /\.key$/,
  /^id_rsa/,
  /^\.credentials\.json$/,
];

// The operator's verbatim DM log. docs/security.md states it is never committed;
// backup honors that in every mode regardless of the gitignore.
const CHANNEL_LOG_RE = /^channel-log\.sqlite(-wal|-shm)?$/;

// Transient or self-referential, and excluded for the same reason: committing
// them makes every run produce a diff even when nothing else changed, so the
// history stops meaning "hermit state moved". A lock is held during our own
// `git add`; the backup's status and cursor are rewritten by the run itself.
// Neither is needed to restore. Lock takeover markers and atomic-write temps are
// suffixed, not prefixed (`.foo.lock.steal.<ino>.<mtime>`, `<file>.<pid>.tmp`),
// so both shapes are matched on the tail rather than the head.
const TRANSIENT_RE = /(\.lock$|\.lock\.|\.\d+\.tmp$|^backup-status\.json$|^backup-schedule\.json$)/;

export interface RefusedPath { path: string; reason: string; }

/** Refusal screen over candidate paths (repo-root-relative, POSIX separators). */
export function scanRefusedPaths(root: string, relPaths: string[]): RefusedPath[] {
  const out: RefusedPath[] = [];
  for (const rel of relPaths) {
    const segments = rel.split('/');
    const base = segments[segments.length - 1] ?? '';
    if (segments.includes('.claude.local')) { out.push({ path: rel, reason: 'secret-filename' }); continue; }
    if (CHANNEL_LOG_RE.test(base)) { out.push({ path: rel, reason: 'channel-log' }); continue; }
    if (TRANSIENT_RE.test(base)) { out.push({ path: rel, reason: 'transient' }); continue; }
    if (SECRET_NAME_RES.some(re => re.test(base))) { out.push({ path: rel, reason: 'secret-filename' }); continue; }

    let size = -1;
    try { size = fs.statSync(path.join(root, rel)).size; } catch { continue; }
    if (size > TOO_LARGE_BYTES) { out.push({ path: rel, reason: 'too-large' }); continue; }
    if (size > CONTENT_SCAN_CAP) continue;
    try {
      const hit = scanCredentials(fs.readFileSync(path.join(root, rel), 'utf-8'));
      if (hit) out.push({ path: rel, reason: `credential-marker (${hit})` });
    } catch { /* unreadable or binary — nothing to scan */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Remotes
// ---------------------------------------------------------------------------

/** Comparable identity for a remote, so two spellings of one repo match. */
export function normalizeRemote(url: string): string | null {
  const raw = (url ?? '').trim();
  if (!raw) return null;
  const strip = (s: string) => s.replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
  let m = raw.match(/^git@([^:]+):(.+)$/);
  if (m) return strip(`${m[1]}/${m[2]}`);
  m = raw.match(/^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/);
  if (m) return strip(`${m[1]}/${m[2]}`);
  m = raw.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/);
  if (m) return strip(`${m[1]}/${m[2]}`);
  if (raw.startsWith('file://')) return strip(raw.slice('file://'.length));
  if (path.isAbsolute(raw)) return strip(raw);
  return null;
}

export interface PushTarget { url: string; kind: 'https' | 'local'; }

/**
 * The URL the backup pushes to. SSH forms convert to https because the hermit
 * Docker image ships git without an ssh client; local paths and file:// are kept
 * verbatim and push without a credential helper.
 */
export function toPushUrl(url: string | null | undefined): PushTarget | null {
  const raw = (url ?? '').trim();
  if (!raw) return null;
  let m = raw.match(/^git@([^:]+):(.+)$/);
  if (m) return { url: `https://${m[1]}/${m[2]}`, kind: 'https' };
  m = raw.match(/^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/);
  if (m) return { url: `https://${m[1]}/${m[2]}`, kind: 'https' };
  if (/^https?:\/\//.test(raw)) return { url: raw, kind: 'https' };
  if (raw.startsWith('file://')) return { url: raw, kind: 'local' };
  if (path.isAbsolute(raw)) return { url: raw, kind: 'local' };
  return null;
}

/** Directories one or two levels under `root` that are their own git repos. */
export function childRepoDirs(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === '.git' || e.name === 'node_modules') continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = path.join(dir, e.name);
      if (fs.existsSync(path.join(childAbs, '.git'))) { found.push(childRel); continue; }
      if (depth > 1) walk(childAbs, childRel, depth - 1);
    }
  };
  walk(root, '', 2);
  return found;
}

/**
 * Remotes the backup must never push to: the enclosing project repo, any child
 * repo, and — in mirror mode — the workspace repo itself (pushing hermit state to
 * the project's own remote is exactly what mirror mode exists to avoid).
 */
export function hostRepoRemotes(root: string, mode: string): Set<string> {
  const out = new Set<string>();
  const collect = (dir: string) => {
    const res = git(dir, ['remote', '-v']);
    if (!res.ok) return;
    for (const line of res.stdout.split('\n')) {
      const url = line.split(/\s+/)[1];
      const n = url ? normalizeRemote(url) : null;
      if (n) out.add(n);
    }
  };
  const parent = path.dirname(root);
  if (parent !== root) {
    const top = git(parent, ['rev-parse', '--show-toplevel']);
    if (top.ok && top.stdout.trim()) collect(top.stdout.trim());
  }
  for (const rel of childRepoDirs(root)) collect(path.join(root, rel));
  if (mode === 'mirror') collect(root);
  return out;
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

export interface GitResult { ok: boolean; stdout: string; stderr: string; }

/** Never throws. safe.directory covers the Docker bind-mount uid mismatch. */
export function git(repoDir: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): GitResult {
  try {
    const res = spawnSync('git', ['-C', repoDir, '-c', `safe.directory=${repoDir}`, ...args], {
      encoding: 'utf-8',
      timeout: opts.timeoutMs ?? 60_000,
      env: opts.env,
    });
    return { ok: res.status === 0, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  } catch (e: any) {
    return { ok: false, stdout: '', stderr: String(e?.message ?? e) };
  }
}

export function identityArgs(agentName: string): string[] {
  const name = (agentName || 'hermit').replace(/[^\w .-]/g, '') || 'hermit';
  return ['-c', `user.name=${name}`, '-c', `user.email=${name.replace(/\s+/g, '-')}@hermit.local`, '-c', 'commit.gpgsign=false'];
}

/**
 * The token reaches git through the child's environment, expanded by `sh` inside
 * the helper — never on argv (visible in `ps`), never written to disk. The empty
 * first helper resets any host-configured helper so ours is the only one asked
 * and no host keychain is handed the token to persist.
 */
export const CRED_HELPER_ARGS = [
  '-c', 'credential.helper=',
  '-c', 'credential.helper=!f() { echo username=x-access-token; echo "password=$HERMIT_BACKUP_TOKEN"; }; f',
  '-c', 'core.askPass=',
];

export function pushEnv(token: string): NodeJS.ProcessEnv {
  return { ...process.env, HERMIT_BACKUP_TOKEN: token, GIT_TERMINAL_PROMPT: '0' };
}

/**
 * Host schedulers (systemd user timer, launchd, cron) carry a bare PATH-only
 * environment, so the project-root .env — the same file compose already loads —
 * is the fallback that makes host installs behave like Docker ones.
 */
export function resolveToken(root: string): string | null {
  const fromEnv = process.env.HERMIT_BACKUP_TOKEN || process.env.GH_TOKEN;
  if (fromEnv) return fromEnv;
  let content = '';
  try { content = fs.readFileSync(path.join(root, '.env'), 'utf-8'); } catch { return null; }
  for (let line of content.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    if (line.slice(0, eq).trim() !== 'HERMIT_BACKUP_TOKEN') continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value || null;
  }
  return null;
}

/** A tree the backup must not commit into. Returns the reason, or null. */
export function treeUnsafe(repoDir: string): string | null {
  const head = git(repoDir, ['symbolic-ref', '-q', 'HEAD']);
  if (!head.ok) return 'detached HEAD';
  const dir = git(repoDir, ['rev-parse', '--git-dir']);
  if (!dir.ok) return 'not a git repository';
  const gitDir = path.resolve(repoDir, dir.stdout.trim());
  if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) return 'merge in progress';
  if (fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'))) {
    return 'rebase in progress';
  }
  return null;
}

export function currentBranch(repoDir: string): string | null {
  const res = git(repoDir, ['symbolic-ref', '--short', 'HEAD']);
  return res.ok ? res.stdout.trim() || null : null;
}

// ---------------------------------------------------------------------------
// Paths and state
// ---------------------------------------------------------------------------

export function mirrorDir(configDir: string, root: string): string {
  return path.join(configDir, 'hermit-backups', transcriptPathKey(root));
}

export function schedulePath(hermitDir: string): string {
  return path.join(hermitDir, 'state', 'backup-schedule.json');
}

export function statusPath(hermitDir: string): string {
  return path.join(hermitDir, 'state', 'backup-status.json');
}

export function lockPath(hermitDir: string): string {
  return path.join(hermitDir, 'state', '.backup.lock');
}

// writeFileAtomic is per-PID tmp + rename: a shared tmp name lets two writers
// truncate the same fd and publish a zero-length file (lib/runtime.ts explains
// the same reasoning). The mkdir is ours — state/ may not exist yet on a fresh
// mirror repo.
function writeJsonAtomic(p: string, data: Json): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeFileAtomic(p, JSON.stringify(data, null, 2) + '\n');
}

export const readBackupSchedule = (hermitDir: string): Json | null => readJson(schedulePath(hermitDir));
export const writeBackupSchedule = (hermitDir: string, data: Json): void => writeJsonAtomic(schedulePath(hermitDir), data);
export const readBackupStatus = (hermitDir: string): Json | null => readJson(statusPath(hermitDir));
export const writeBackupStatus = (hermitDir: string, data: Json): void => writeJsonAtomic(statusPath(hermitDir), data);

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

function floorToMinute(d: Date): Date {
  return new Date(Math.floor(d.getTime() / MINUTE_MS) * MINUTE_MS);
}

/**
 * The second-most-recent scheduled minute at or before `now` — the doctor's
 * "two windows missed" threshold. Null when the schedule fires less often than
 * maxBackMinutes covers.
 */
export function secondMostRecentMatch(
  schedule: string, tz: string | null, now: Date, maxBackMinutes = 8 * 1440,
): Date | null {
  const end = floorToMinute(now);
  const fires = latestFires(schedule, tz, new Date(end.getTime() - maxBackMinutes * MINUTE_MS), end, 2);
  return fires.length === 2 ? fires[0] : null;
}

/**
 * Is a backup due now? Sole writer of state/backup-schedule.json.
 *
 * At-most-once, like lib/routines/due.ts: the cursor is consumed here, before the
 * detached run starts, so a failed spawn loses that occurrence and waits for the
 * next window. The doctor surfaces two missed windows, which is the recovery path
 * — a spawn-confirmation handshake would break parity with the routine scheduler.
 */
export function evaluateBackupDue(config: Json, hermitDir: string, now: Date): boolean {
  const backup = config?.backup;
  if (!backup || backup.enabled !== true || typeof backup.schedule !== 'string') return false;
  // Before the lock check and cursor init: an invalid schedule leaves backup state untouched.
  if (validateCronSchedule(backup.schedule)) return false;

  // A live run still holds the lock: defer without consuming, so its window is
  // not silently spent while it works. This is the primary mutual-exclusion gate;
  // the lock itself is the backstop (an old mtime is reclaimable even alive).
  const holder = readLockPid(hermitDir);
  if (holder !== null && holder !== process.pid && pidAlive(holder)) return false;

  const tz: string | null = typeof config?.timezone === 'string' ? config.timezone : null;
  const nowMinute = floorToMinute(now);
  const entry = readBackupSchedule(hermitDir);
  const raw = entry && typeof entry.last_consumed_mark === 'string' ? new Date(entry.last_consumed_mark) : null;

  if (!raw || isNaN(raw.getTime()) || raw.getTime() > nowMinute.getTime()) {
    // Missing, corrupt, or future (clock skew): initialize to now, fire nothing.
    writeBackupSchedule(hermitDir, { version: 1, last_consumed_mark: nowMinute.toISOString() });
    return false;
  }

  const windowFloor = new Date(nowMinute.getTime() - WINDOW_MS);
  const from = raw.getTime() < windowFloor.getTime() ? windowFloor : raw;
  const latest = latestFires(backup.schedule, tz, from, nowMinute, 1)[0] ?? null;

  if (!latest) {
    if (raw.getTime() < nowMinute.getTime()) {
      writeBackupSchedule(hermitDir, { version: 1, last_consumed_mark: nowMinute.toISOString() });
    }
    return false;
  }
  writeBackupSchedule(hermitDir, { version: 1, last_consumed_mark: latest.toISOString() });
  return true;
}

function readLockPid(hermitDir: string): number | null {
  try {
    const pid = parseInt(fs.readFileSync(lockPath(hermitDir), 'utf-8').trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Copying
// ---------------------------------------------------------------------------

/**
 * Mirror the CC-owned auto-memory into the backed-up tree. It lives outside every
 * workspace (`<configDir>/projects/<key>/`), so a repo-only backup would miss the
 * most valuable state. `destDir` is the workspace hermit dir in workspace mode and
 * the mirror repo in mirror mode — mirror mode never writes into the workspace.
 */
export function syncMemoryMirror(destDir: string, configDir: string, root: string, include: string[]): void {
  const src = path.join(configDir, 'projects', transcriptPathKey(root));
  const dest = path.join(destDir, 'memory-mirror');
  fs.rmSync(dest, { recursive: true, force: true });
  const memSrc = path.join(src, 'memory');
  if (fs.existsSync(memSrc)) {
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(memSrc, path.join(dest, 'memory'), { recursive: true, dereference: false });
  }
  if (include.includes('transcripts') && fs.existsSync(src)) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        fs.copyFileSync(path.join(src, entry.name), path.join(dest, entry.name));
      }
    }
  }
}

/** Copy the manifest into the mirror repo, pruning refused paths and nested repos. */
export function syncMirror(root: string, mirror: string, refused: RefusedPath[]): void {
  const refusedAbs = new Set(refused.map(r => path.join(root, r.path)));
  for (const entry of BACKUP_MANIFEST) {
    const src = path.join(root, entry);
    const dest = path.join(mirror, entry);
    fs.rmSync(dest, { recursive: true, force: true });
    if (!fs.existsSync(src)) continue;
    fs.cpSync(src, dest, {
      recursive: true,
      dereference: false,
      filter: (from) => {
        if (refusedAbs.has(from)) return false;
        const base = path.basename(from);
        if (base === '.git' || CHANNEL_LOG_RE.test(base) || TRANSIENT_RE.test(base)) return false;
        try { if (fs.statSync(from).isDirectory() && fs.existsSync(path.join(from, '.git'))) return false; } catch { /* ignore */ }
        return true;
      },
    });
  }
}

// ---------------------------------------------------------------------------
// .gitignore (workspace mode)
// ---------------------------------------------------------------------------

/**
 * Lines the template ignores that workspace-mode backup must keep ignoring.
 * `claude-settings.json` is here for the same reason as `.claude.local/`: it
 * carries the operator's `env` block, so un-ignoring it would commit live
 * tokens into the backup repo on the next `git add -A`.
 */
const GITIGNORE_KEEP = new Set([
  '.claude/scheduled_tasks.lock',
  '.claude.local/',
  '.hermit/claude-settings.json',
]);

const GITIGNORE_ALWAYS = [
  '.claude.local/',
  '.claude/scheduled_tasks.lock',
  '.env',
  '.env.*',
  '.hermit/state/channel-log.sqlite*',
];

export function hasWorkspaceMarker(root: string): boolean {
  try {
    return fs.readFileSync(path.join(root, '.gitignore'), 'utf-8').includes(WORKSPACE_MARKER);
  } catch {
    return false;
  }
}

/**
 * Stop ignoring hermit state so workspace mode can commit it, while keeping every
 * secret-bearing line. Idempotent: the marker replaces the template's header, and
 * hatch skips its gitignore step when it sees that marker.
 */
export function rewriteGitignoreForWorkspace(root: string, templateText: string): { removed: number; added: number } {
  const sandboxIdx = templateText.indexOf('# Claude Code sandbox');
  const hermitPart = sandboxIdx === -1 ? templateText : templateText.slice(0, sandboxIdx);
  const remove = new Set(
    hermitPart.split('\n').map(l => l.trim())
      .filter(l => l && !l.startsWith('#') && !GITIGNORE_KEEP.has(l)),
  );

  const target = path.join(root, '.gitignore');
  let lines: string[] = [];
  try { lines = fs.readFileSync(target, 'utf-8').split('\n'); } catch { lines = []; }

  let removed = 0;
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (remove.has(t)) { removed += 1; continue; }
    if (t === '# hermitd') { kept.push(WORKSPACE_MARKER); continue; }
    kept.push(line);
  }
  if (!kept.some(l => l.trim() === WORKSPACE_MARKER)) {
    if (kept.length && kept[kept.length - 1].trim() !== '') kept.push('');
    kept.push(WORKSPACE_MARKER);
  }

  const present = new Set(kept.map(l => l.trim()));
  let added = 0;
  for (const want of [...GITIGNORE_ALWAYS, ...childRepoDirs(root).map(d => `${d}/`)]) {
    if (present.has(want)) continue;
    kept.push(want);
    present.add(want);
    added += 1;
  }

  const out = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, out, 'utf-8');
  fs.renameSync(tmp, target);
  return { removed, added };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export function formatStatus(status: Json, backup: Json): string {
  if (!status) return 'backup: no run recorded yet';
  const lines = [
    `backup: ${status.last_result ?? 'unknown'} (${backup?.mode ?? status.mode ?? 'workspace'} mode)`,
    `  last attempt: ${status.last_attempt_at ?? 'never'}`,
    `  last success: ${status.last_success_at ?? 'never'}`,
    `  push: ${status.push ?? 'disabled'}${status.last_push_error ? ` — ${status.last_push_error}` : ''}`,
  ];
  const refused = Array.isArray(status.refused) ? status.refused : [];
  if (refused.length) lines.push(`  refused: ${refused.length} path(s), first: ${refused[0].path} (${refused[0].reason})`);
  if (status.last_error) lines.push(`  error: ${status.last_error}`);
  return lines.join('\n');
}
