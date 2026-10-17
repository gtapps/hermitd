#!/usr/bin/env bun
/**
 * Scheduled git snapshot of this hermit's own state — commit, and optionally push
 * to an operator-configured private remote. Model-free by design: the watchdog's
 * step 0e spawns `run` detached when the cron says a window is due, so a backup
 * costs no tokens and keeps working when the session is rate-limited, wedged, or
 * logged out. The doctor's `backup` check is the only path back into a model turn.
 *
 *   bun scripts/backup.ts run       # commit (+push); prints the run's digest object
 *   bun scripts/backup.ts setup     # terminal-only wizard; writes config.backup
 *   bun scripts/backup.ts status    # print the last run's digest object
 *
 * `run` and `status` exit 0 whatever the backup's own result (a failed run is a
 * recorded result, not a script failure); only a crash prints {"error"} and exits 1.
 *
 * What this never does, in any mode: pull, fetch, rebase, merge, reset, force-push,
 * --no-verify, or rewrite the repo's remote config. A backup that mutates the live
 * tree is a new failure class; divergence is reported for the operator to resolve.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { acquireLock, releaseLock } from './lib/lockfile';
import { readConfigRaw, readSettledConfig, agentNameFromConfig } from './lib/config-read';
import { readRuntimeJson } from './lib/runtime';
import { flagValue, printJson, exitError } from './lib/cli';
import { defaultConfigDir } from './lib/setup-token';
import { safe } from './lib/sanitize';
import { utcISOStamp } from './lib/time';
import { validateCronSchedule } from './validate-config';
import {
  BACKUP_MANIFEST,
  CRED_HELPER_ARGS,
  type Json,
  type RefusedPath,
  childRepoDirs,
  currentBranch,
  treeUnsafe,
  formatStatus,
  statusDigest,
  git,
  hasWorkspaceMarker,
  hostRepoRemotes,
  identityArgs,
  lockPath,
  mirrorDir,
  normalizeRemote,
  pushEnv,
  readBackupStatus,
  resolveToken,
  rewriteGitignoreForWorkspace,
  scanRefusedPaths,
  syncMemoryMirror,
  syncMirror,
  toPushUrl,
  writeBackupSchedule,
  writeBackupStatus,
} from './lib/backup';

const HERMIT_DIR = '.hermit';
// A first push of a repo carrying raw/ binaries can run for many minutes; the lock
// window has to clear that, because lockfile treats an old mtime as stale even when
// the holder is alive. Mutual exclusion proper is evaluateBackupDue's pidAlive gate.
const LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const PUSH_TIMEOUT_MS = 120_000;
const REFUSED_CAP = 50;

const GITIGNORE_TEMPLATE = path.join(import.meta.dir, '..', 'state-templates', 'GITIGNORE-APPEND.txt');

function resolveRoot(): { hermitDir: string; root: string } {
  const hermitDir = path.resolve(HERMIT_DIR);
  return { hermitDir, root: fs.realpathSync(path.resolve(hermitDir, '..')) };
}

/**
 * The watchdog spawns us before it adopts the session's stamped config dir, and a
 * host timer carries none at all — so resolve it here or the memory mirror and the
 * mirror repo land under the wrong key.
 */
function adoptConfigDir(): string {
  const runtime = readRuntimeJson();
  if (runtime && typeof runtime.config_dir === 'string' && runtime.config_dir) {
    process.env.CLAUDE_CONFIG_DIR = runtime.config_dir;
  }
  return defaultConfigDir();
}

function nowStamp(): string { return utcISOStamp(); }

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

interface RunOutcome { status: Json; }

function doRun(hermitDir: string, root: string, configDir: string, quiet = false): RunOutcome | null {
  const config = readSettledConfig(hermitDir);
  const backup: Json = config?.backup ?? {};
  if (backup.enabled !== true) {
    if (!quiet) printJson({ status: 'skip', reason: 'not_configured' });
    return null;
  }

  if (!acquireLock(lockPath(hermitDir), LOCK_STALE_MS)) {
    if (!quiet) printJson({ status: 'skip', reason: 'locked' });
    return null;
  }

  const status: Json = readBackupStatus(hermitDir) ?? { version: 1 };
  status.version = 1;
  status.mode = backup.mode ?? 'workspace';
  status.last_attempt_at = nowStamp();
  status.last_error = null;

  try {
    const mirror = backup.mode === 'mirror';
    const repo = mirror ? mirrorDir(configDir, root) : root;

    if (mirror) {
      fs.mkdirSync(repo, { recursive: true });
      if (!fs.existsSync(path.join(repo, '.git'))) {
        git(repo, ['init', '-q', '-b', 'main']);
        if (backup.remote) git(repo, ['remote', 'add', 'origin', backup.remote]);
      }
    } else {
      const top = git(repo, ['rev-parse', '--show-toplevel']);
      if (!top.ok || fs.realpathSync(top.stdout.trim() || '/') !== root) {
        return fail(status, 'error', 'workspace is not a git repository (run `backup setup`)');
      }
      if (git(repo, ['check-ignore', '-q', `${HERMIT_DIR}/state`]).ok) {
        // hatch re-appends its ignore lines per-line and silently in quick mode,
        // so a re-hatch after setup would quietly stop backing up state. Repair it
        // when our marker says workspace mode owns this file; otherwise say so.
        if (hasWorkspaceMarker(root)) {
          rewriteGitignoreForWorkspace(root, fs.readFileSync(GITIGNORE_TEMPLATE, 'utf-8'));
          status.note = 'gitignore-repaired';
        } else {
          return fail(status, 'error', 'hermit state is gitignored (run `backup setup`)');
        }
      }
    }

    const unsafe = treeUnsafe(repo);
    if (unsafe) return fail(status, 'unsafe-tree', unsafe);

    // Never fold an operator's staged work into a backup commit: `git commit` takes
    // the whole index, not just what we added.
    if (!git(repo, ['diff', '--cached', '--quiet']).ok) {
      return fail(status, 'dirty-index', 'index has staged changes; commit or unstage them first');
    }

    const include = Array.isArray(backup.include) ? backup.include : [];
    if (!mirror) syncMemoryMirror(path.join(root, HERMIT_DIR), configDir, root, include);

    const candidates = mirror ? walkManifest(root) : porcelainCandidates(repo);
    const refused: RefusedPath[] = scanRefusedPaths(root, candidates);
    for (const rel of childRepoDirs(root)) {
      if (!refused.some(r => r.path === rel)) refused.push({ path: rel, reason: 'nested-repo' });
    }

    // Mirror mode copies the manifest first (it replaces the mirror's copy of the
    // hermit dir wholesale), then lays the memory mirror inside it — the reverse
    // order would wipe the memory copy on the way in.
    if (mirror) {
      syncMirror(root, repo, refused);
      syncMemoryMirror(path.join(repo, HERMIT_DIR), configDir, root, include);
      // The memory mirror lands inside the mirror repo, after the scan above could
      // see it — workspace mode catches it in `git status`, mirror mode only here.
      // docs/backup.md promises the same refusal table in both modes, and an
      // over-95MB transcript committed once breaks every later push permanently.
      refused.push(...scanRefusedPaths(repo, walkManifest(repo, [`${HERMIT_DIR}/memory-mirror`])));
    }

    // `.` in both modes: filtering to entries that still exist would leave a
    // deleted manifest entry (or a whole removed subtree) tracked forever, since
    // `git add -A` only stages a deletion the pathspec still reaches.
    const excludes = refused.map(r => `:(exclude,literal)${r.path}`);
    const added = git(repo, ['add', '-A', '--ignore-errors', '--', '.', ...excludes]);

    const agent = agentNameFromConfig(config);
    if (git(repo, ['diff', '--cached', '--quiet']).ok) {
      // An add that staged nothing *and* failed is a silent no-backup: reporting
      // it as nothing-to-commit would stamp last_success_at and keep doctor green.
      if (!added.ok) return fail(status, 'error', safe(added.stderr).slice(0, 200) || 'git add failed');
      status.last_result = 'nothing-to-commit';
    } else {
      const subject = `hermit backup ${nowStamp().slice(0, 16)}Z`;
      const body = `mode: ${status.mode}\nfiles scanned: ${candidates.length}\nrefused: ${refused.length}`;
      const commit = git(repo, [...identityArgs(agent), 'commit', '-q', '-m', subject, '-m', body]);
      if (!commit.ok) {
        // A repo hook rejected it. Recorded, never bypassed: --no-verify is exactly
        // what the hardened profile denies, and a backup is not the place to win
        // that argument.
        return fail(status, 'error', safe(commit.stderr).slice(0, 200) || 'commit failed');
      }
      status.last_result = 'committed';
      status.last_commit = git(repo, ['rev-parse', 'HEAD']).stdout.trim() || null;
      status.last_commit_at = nowStamp();
    }
    status.refused = refused.slice(0, REFUSED_CAP);

    doPush(repo, root, backup, status);
    writeBackupStatus(hermitDir, status);
    if (!quiet) printJson(statusDigest(status, backup));
    return { status };
  } catch (e: any) {
    return fail(status, 'error', safe(e?.message ?? e).slice(0, 200));
  } finally {
    releaseLock(lockPath(hermitDir));
  }

  function fail(s: Json, result: string, message: string): RunOutcome {
    s.last_result = result;
    s.last_error = message;
    writeBackupStatus(hermitDir, s);
    if (!quiet) printJson(statusDigest(s, backup));
    return { status: s };
  }
}

/** Added/modified/untracked paths. Deletions are staged by `add -A` but carry no content to scan. */
function porcelainCandidates(repo: string): string[] {
  const res = git(repo, ['status', '--porcelain=v1', '-z', '-uall', '--no-renames']);
  if (!res.ok) return [];
  const out: string[] = [];
  for (const entry of res.stdout.split('\0')) {
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const rel = entry.slice(3);
    if (!rel) continue;
    if (/[AM?]/.test(xy)) out.push(rel);
  }
  return out;
}

/** Every file under `entries`, as paths relative to `root`. */
function walkManifest(root: string, entries: string[] = BACKUP_MANIFEST): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = path.join(root, rel);
    let children: fs.Dirent[];
    try { children = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of children) {
      if (e.name === '.git') continue;
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(childRel);
      else if (e.isFile()) out.push(childRel);
    }
  };
  for (const entry of entries) {
    const abs = path.join(root, entry);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) walk(entry);
    else out.push(entry);
  }
  return out;
}

function failPush(status: Json, message: string): void {
  status.push = 'failed';
  status.consecutive_push_failures = (status.consecutive_push_failures ?? 0) + 1;
  status.last_push_error = message;
}

function doPush(repo: string, root: string, backup: Json, status: Json): void {
  if (!backup.remote || backup.push !== true) {
    status.push = 'disabled';
    if (status.last_result === 'committed' || status.last_result === 'nothing-to-commit') {
      status.last_success_at = nowStamp();
    }
    return;
  }
  const target = toPushUrl(backup.remote);
  if (!target) {
    failPush(status, `unusable remote "${safe(backup.remote)}"`);
    return;
  }
  const branch = currentBranch(repo);
  if (!branch) {
    failPush(status, 'no current branch');
    return;
  }
  const refspec = `HEAD:refs/heads/${branch}`;

  let res;
  if (target.kind === 'local') {
    res = git(repo, ['push', '--porcelain', target.url, refspec], { timeoutMs: PUSH_TIMEOUT_MS });
  } else {
    const token = resolveToken(root);
    if (!token) {
      failPush(status, 'no token (HERMIT_BACKUP_TOKEN, GH_TOKEN, or .env)');
      return;
    }
    res = git(repo, [...CRED_HELPER_ARGS, 'push', '--porcelain', target.url, refspec],
      { env: pushEnv(token), timeoutMs: PUSH_TIMEOUT_MS });
  }

  if (res.ok) {
    status.push = 'ok';
    status.last_push_at = nowStamp();
    status.consecutive_push_failures = 0;
    status.last_push_error = null;
    status.last_success_at = nowStamp();
    return;
  }
  const combined = `${res.stdout}\n${res.stderr}`;
  status.consecutive_push_failures = (status.consecutive_push_failures ?? 0) + 1;
  if (/non-fast-forward|fetch first|\[rejected\]/i.test(combined)) {
    // Deliberately terminal: reconciling means pulling or forcing, and a backup
    // job must do neither to a live workspace.
    status.push = 'diverged';
    status.last_push_error = 'remote has commits this hermit lacks — reconcile manually (docs/backup.md)';
  } else {
    status.push = 'failed';
    status.last_push_error = safe(res.stderr).slice(0, 200) || 'push failed';
  }
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

async function doSetup(hermitDir: string, root: string, configDir: string, argv: string[]): Promise<number> {
  if (!readConfigRaw(hermitDir)) {
    process.stderr.write(`backup setup: no ${HERMIT_DIR}/config.json here — run this from the hermit's project root\n`);
    return 1;
  }
  const yes = argv.includes('--yes');
  const tty = Boolean(process.stdin.isTTY);
  const rl = tty ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ask = async (question: string, fallback: string): Promise<string> => {
    if (!rl) return fallback;
    const answer = (await rl.question(`${question} [${fallback || 'none'}]: `)).trim();
    return answer || fallback;
  };
  try {
    let mode = flagValue(argv, '--mode') ?? (tty ? await ask('Backup mode (workspace/mirror)', 'workspace') : 'workspace');
    if (mode !== 'workspace' && mode !== 'mirror') {
      process.stderr.write(`backup setup: --mode must be workspace or mirror, got "${mode}"\n`);
      return 2;
    }

    if (mode === 'workspace' && !git(root, ['rev-parse', '--is-inside-work-tree']).ok) {
      const answer = yes || !tty ? 'y' : (await ask(`No git repository at ${root}. Initialize one? (y/n)`, 'y'));
      if (answer.toLowerCase().startsWith('y')) {
        git(root, ['init', '-q', '-b', 'main']);
      } else {
        mode = 'mirror';
        process.stdout.write('Using mirror mode: hermit state is copied to a separate repo instead.\n');
      }
    }

    const schedule = flagValue(argv, '--schedule') ?? (tty ? await ask('Schedule (5-field cron)', '0 3 * * *') : '0 3 * * *');
    const cronErr = validateCronSchedule(schedule);
    if (cronErr) {
      process.stderr.write(`backup setup: invalid --schedule "${schedule}" — ${cronErr}\n`);
      return 2;
    }
    const tz = readSettledConfig(hermitDir)?.timezone ?? 'machine local time';
    process.stdout.write(`Backups will fire on "${schedule}" in ${tz}.\n`);

    const existingOrigin = git(root, ['remote', 'get-url', 'origin']).stdout.trim();
    let remoteFlag = flagValue(argv, '--remote');
    if (remoteFlag === undefined) {
      if (!tty) { process.stderr.write('backup setup: --remote is required when stdin is not a terminal (pass "" for commit-only)\n'); return 2; }
      remoteFlag = await ask('Push to remote (blank = commit only)', mode === 'workspace' ? existingOrigin : '');
    }
    const remote = remoteFlag.trim();

    if (remote) {
      const target = toPushUrl(remote);
      if (!target) {
        process.stderr.write(`backup setup: "${remote}" is not a pushable remote — use https://, git@host:path, ssh://, file:// or an absolute path\n`);
        return 2;
      }
      const forbidden = hostRepoRemotes(root, mode);
      const normalized = normalizeRemote(remote);
      if (normalized && forbidden.has(normalized)) {
        process.stderr.write(mode === 'mirror'
          ? `backup setup: "${remote}" is this workspace's own remote — mirror mode exists to keep hermit state off it; use --mode workspace instead\n`
          : `backup setup: "${remote}" belongs to a project repository under this workspace; back up to a dedicated private repo\n`);
        return 2;
      }
      // No --exit-code: a brand-new empty backup repo is the normal case, and it
      // answers with an empty ref list. Only unreachable or unauthorized fails.
      let probe;
      if (target.kind === 'local') {
        probe = git(root, ['ls-remote', target.url], { timeoutMs: PUSH_TIMEOUT_MS });
      } else {
        const token = resolveToken(root);
        if (!token) {
          process.stderr.write('backup setup: set HERMIT_BACKUP_TOKEN (or GH_TOKEN), or add HERMIT_BACKUP_TOKEN= to the project .env\n');
          return 2;
        }
        probe = git(root, [...CRED_HELPER_ARGS, 'ls-remote', target.url],
          { env: pushEnv(token), timeoutMs: PUSH_TIMEOUT_MS });
      }
      if (!probe.ok) {
        process.stderr.write(`backup setup: cannot reach ${remote} — ${safe(probe.stderr).slice(0, 200)}\n`);
        return 2;
      }
    }

    const repo = mode === 'mirror' ? mirrorDir(configDir, root) : root;
    if (mode === 'mirror') {
      fs.mkdirSync(repo, { recursive: true });
      if (!fs.existsSync(path.join(repo, '.git'))) git(repo, ['init', '-q', '-b', 'main']);
    }
    // Remote config is the operator's: we only fill in a missing origin so their own
    // `git log origin/...` works. The push itself always uses an explicit URL, so a
    // manual `git push` on this box keeps whatever auth it had.
    if (remote && !git(repo, ['remote', 'get-url', 'origin']).ok) {
      git(repo, ['remote', 'add', 'origin', remote]);
    }

    if (mode === 'workspace') {
      const counts = rewriteGitignoreForWorkspace(root, fs.readFileSync(GITIGNORE_TEMPLATE, 'utf-8'));
      process.stdout.write(`.gitignore: stopped ignoring ${counts.removed} hermit path(s), added ${counts.added} guard line(s).\n`);
    }

    const envKeys = collectEnvKeys(hermitDir, root);
    if (envKeys.length) {
      process.stdout.write(`\nThese config files will be committed and they define env vars: ${envKeys.join(', ')}.\n`);
      process.stdout.write('Credentials belong in .env (refused by the backup), not in config.env.\n');
      if (!yes && tty) {
        const go = await ask('Continue? (y/n)', 'y');
        if (!go.toLowerCase().startsWith('y')) { process.stdout.write('Aborted; nothing was written.\n'); return 1; }
      }
    }

    // One validated object, one audit entry: settings-edit validates the whole
    // config before writing, so a rejected block leaves config.json untouched.
    const block = JSON.stringify({
      enabled: true, mode, schedule, remote: remote || null,
      push: !argv.includes('--no-push'), include: [],
    });
    const res = spawnSync(process.execPath, [
      path.join(import.meta.dir, 'settings-edit.ts'), path.join(hermitDir, 'config.json'), 'set', 'backup', block,
    ], { encoding: 'utf-8' });
    if (res.status !== 0) {
      process.stderr.write(`backup setup: settings-edit rejected the block — ${safe(res.stdout).slice(0, 300)}\n`);
      return 1;
    }

    const seeded = readBackupStatus(hermitDir) ?? { version: 1 };
    seeded.configured_at = nowStamp();
    writeBackupStatus(hermitDir, seeded);
    // Seed the cursor at now so the next watchdog tick does not immediately re-fire
    // the run we are about to do here.
    writeBackupSchedule(hermitDir, { version: 1, last_consumed_mark: new Date(Math.floor(Date.now() / 60000) * 60000).toISOString() });

    process.stdout.write('\nRunning the first backup now...\n');
    const outcome = doRun(hermitDir, root, configDir, true);
    if (outcome) process.stdout.write(formatStatus(outcome.status, { mode }) + '\n');
    if (remote && toPushUrl(remote)?.kind === 'https') {
      process.stdout.write('\nPushes read HERMIT_BACKUP_TOKEN (or GH_TOKEN) from the environment the watchdog runs in;\n');
      process.stdout.write('on a host timer that environment is bare, so put it in the project .env. See docs/backup.md.\n');
    }
    return 0;
  } finally {
    rl?.close();
  }
}

function collectEnvKeys(hermitDir: string, root: string): string[] {
  const keys = new Set<string>();
  const add = (obj: Json) => {
    if (obj && typeof obj === 'object') for (const k of Object.keys(obj)) keys.add(k);
  };
  add(readConfigRaw(hermitDir)?.env);
  try {
    add(JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.local.json'), 'utf-8'))?.env);
  } catch { /* absent is normal */ }
  return [...keys];
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const verb = process.argv[2] ?? 'run';
  const { hermitDir, root } = resolveRoot();
  const configDir = adoptConfigDir();

  if (verb === 'run') {
    doRun(hermitDir, root, configDir);
    process.exit(0);
  }
  if (verb === 'status') {
    const config = readSettledConfig(hermitDir);
    printJson(statusDigest(readBackupStatus(hermitDir), config?.backup ?? {}));
    process.exit(0);
  }
  if (verb === 'setup') {
    process.exit(await doSetup(hermitDir, root, configDir, process.argv.slice(3)));
  }
  exitError();
}

if (import.meta.main) {
  main().catch((e) => {
    if (process.argv[2] === 'setup') process.stderr.write(`backup: ${safe(e?.message ?? e)}\n`);
    else printJson({ error: `backup_failed:${safe(e?.message ?? e)}` });
    process.exit(1);
  });
}
