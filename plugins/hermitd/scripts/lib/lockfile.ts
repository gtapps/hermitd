/**
 * Lifecycle lockfile — O_EXCL + PID-liveness replacement for fcntl.flock.
 *
 * Semantics: lock held ⇔ the file exists AND contains a live PID AND its mtime
 * is fresh. flock's auto-release-on-death is replaced by the liveness check;
 * the mtime staleness window covers PID reuse after a reboot.
 *
 * Content is `<pid> <pid namespace> <start time>` where the platform publishes
 * them (Linux), else the bare PID. A shell command in Claude Code's sandbox
 * runs in its own PID namespace, where the holder's PID is invisible
 * (kill(pid, 0) says ESRCH) and small PIDs repeat. So identity is the whole
 * string, a holder in another namespace counts as held for CROSS_NS_HOLD_MS
 * instead of being probed, and a same-namespace holder whose start time no
 * longer matches is a reused pid. A bare-PID file is judged as before. Legacy installs
 * have an empty .lifecycle.lock left behind by the old Python flock holders
 * (which created but never unlinked it) — an empty/unparseable file is treated
 * as stale and taken over.
 */

import fs from 'node:fs';

const DEFAULT_STALE_MS = 15 * 60 * 1000;
// A takeover is a handful of syscalls; a claim marker older than this was left
// behind by a stealer that died mid-swap.
const STALE_CLAIM_MS = 30 * 1000;
// How long a fresh lock whose holder sits in another PID namespace is honored.
// The holder cannot be probed from here; past this age it is taken over, so a
// lock left by a killed container does not block the next boot for staleMs.
const CROSS_NS_HOLD_MS = 2 * 60 * 1000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM means the pid exists but belongs to ANOTHER user. Every hermit
    // lifecycle process runs as the same uid, so a pid we can't signal cannot
    // be a hermit lock holder — treat it as not-holding rather than wedging the
    // lock for the full staleness window against an unrelated (possibly
    // pid-reused) process.
    return false;
  }
}

/** This process's PID namespace (`pid:[<inode>]`), or null where the platform
 *  publishes none (macOS). */
let ownNamespace: string | null | undefined;
function pidNamespace(): string | null {
  if (ownNamespace === undefined) {
    try {
      ownNamespace = fs.readlinkSync('/proc/self/ns/pid');
    } catch {
      ownNamespace = null;
    }
  }
  return ownNamespace;
}

/** Field 22 of /proc/<pid>/stat: the process start time in clock ticks.
 *  Parsed from the last ')' because a process name can hold spaces and parens. */
function procStartOf(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

function ownIdentity(): string {
  const ns = pidNamespace();
  const start = procStartOf(process.pid);
  return ns && start ? `${process.pid} ${ns} ${start}` : String(process.pid);
}

// Atomic create-with-content: write the PID to a private temp file, then
// link() it into place — link fails with EEXIST if the lock exists, and the
// lock is never observable in a half-written (empty) state, which a plain
// open('wx')+write would expose to concurrent acquirers.
function tryCreate(lockPath: string): boolean {
  // Random suffix: two sandboxed commands can share a pid number.
  const tmp = `${lockPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, ownIdentity());
    fs.linkSync(tmp, lockPath);
    return true;
  } catch (e: any) {
    if (e && e.code === 'EEXIST') return false; // genuine contention — lock exists
    throw e; // real fs error (ENOSPC/EACCES/EROFS/EDQUOT) — surface it, don't mask as contention
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

// The marker naming the exact file a takeover is replacing. Every racer stats
// the same unchanging file, so they all derive the same name.
function claimPathFor(lockPath: string, ino: number, mtimeMs: number): string {
  return `${lockPath}.steal.${ino}.${Math.round(mtimeMs)}`;
}

// Exclusive-create the marker naming one specific stale lock file: the only
// compare-and-swap the filesystem offers. Whoever creates it is the single
// process allowed to replace that file. Returns false if a takeover of the same
// file is already in flight.
function claimStale(claimPath: string): boolean {
  try {
    fs.writeFileSync(claimPath, String(process.pid), { flag: 'wx' });
    return true;
  } catch (e: any) {
    if (!e || e.code !== 'EEXIST') throw e; // real fs error — surface it
  }
  try {
    if (Date.now() - fs.statSync(claimPath).mtimeMs < STALE_CLAIM_MS) return false;
    // The stealer died mid-swap. Dropping its marker reopens the race, which
    // the exclusive create below re-serializes.
    fs.unlinkSync(claimPath);
    fs.writeFileSync(claimPath, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    // Deliberately fail closed here: the marker vanished, or another racer got
    // to it first. Reporting contention costs the caller a retry; guessing
    // wrong in the other direction costs two holders.
    return false;
  }
}

/**
 * Whether lock content written `mtimeMs` ago names a holder other than this
 * process that still counts as holding it. The one judgment both acquireLock
 * and read-only gates (lockHeld) use.
 */
function heldByOther(content: string, mtimeMs: number, staleMs: number): boolean {
  const m = /^(\d+)(?: (\S+)(?: (\d+))?)?$/.exec(content);
  if (!m) return false; // empty or garbage: legacy flock file, stale
  const holderPid = parseInt(m[1], 10);
  const crossNs = m[2] !== undefined && m[2] !== pidNamespace();
  if (holderPid === process.pid && !crossNs) return false; // ours: reentrant
  const age = Date.now() - mtimeMs;
  if (crossNs) return age < Math.min(CROSS_NS_HOLD_MS, staleMs);
  // A recorded start time that no longer matches means the pid was reused.
  const sameProcess = m[3] === undefined || procStartOf(holderPid) === m[3];
  return pidAlive(holderPid) && sameProcess && age < staleMs;
}

/** Read-only: whether someone other than this process holds the lock now. */
function lockHeld(lockPath: string, staleMs: number = DEFAULT_STALE_MS): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(lockPath, 'r');
    const mtimeMs = fs.fstatSync(fd).mtimeMs;
    return heldByOther(fs.readFileSync(fd, 'utf-8').trim(), mtimeMs, staleMs);
  } catch {
    return false; // absent or unreadable: not held
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * Try to acquire the lock. Returns true on success, false on live contention.
 * Stale locks (dead PID, empty/unparseable content, or mtime older than
 * staleMs) are removed and re-acquired.
 */
function acquireLock(lockPath: string, staleMs: number = DEFAULT_STALE_MS): boolean {
  if (tryCreate(lockPath)) return true;

  let content = '';
  let mtimeMs = 0;
  let ino = 0;
  // Read the PID and the identity through ONE descriptor: a separate open for
  // each could straddle a concurrent takeover, judging the old file's dead PID
  // while identifying the replacement, and then delete a live lock.
  let fd: number | null = null;
  try {
    fd = fs.openSync(lockPath, 'r');
    const st = fs.fstatSync(fd);
    mtimeMs = st.mtimeMs;
    ino = st.ino;
    content = fs.readFileSync(fd, 'utf-8').trim();
  } catch {
    // Vanished between create-attempt and read — retry once.
    return tryCreate(lockPath);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }

  if (heldByOther(content, mtimeMs, staleMs)) return false; // genuinely held

  // Stale: dead holder, no/garbage PID (legacy empty flock file), expired
  // mtime, or a cross-namespace holder past CROSS_NS_HOLD_MS. Two racers that
  // both judged THIS file stale must not both replace it, so serialize on a
  // marker naming the exact file they judged. Neither
  // rename nor unlink can do this: both act on a path, not an inode, so a slow
  // racer would move or delete the winner's brand-new lock and acquire on top
  // of it → double-acquire.
  const claim = claimPathFor(lockPath, ino, mtimeMs);
  if (!claimStale(claim)) return false; // a takeover of this file is already in flight
  try {
    try {
      const st = fs.statSync(lockPath);
      // Still the file we judged? If not it was already replaced — leave it be
      // and let tryCreate report the truth.
      if (st.ino === ino && st.mtimeMs === mtimeMs) fs.unlinkSync(lockPath);
    } catch {
      // Vanished — fall through to the create.
    }
    return tryCreate(lockPath);
  } finally {
    try {
      fs.unlinkSync(claim);
    } catch {}
  }
}

/**
 * Poll acquireLock until it succeeds or waitMs elapses. Returns whether the
 * lock is held, so a caller that wants to proceed unlocked rather than lose its
 * write can decide for itself. An unwritable lock path gives up immediately.
 */
function acquireLockWithWait(lockPath: string, waitMs: number, staleMs: number = DEFAULT_STALE_MS): boolean {
  const deadline = Date.now() + waitMs;
  let held = false;
  while (!held && Date.now() < deadline) {
    try {
      held = acquireLock(lockPath, staleMs);
    } catch {
      break;
    }
    if (!held) Bun.sleepSync(20);
  }
  return held;
}

/** Release the lock if this process holds it. */
function releaseLock(lockPath: string): void {
  try {
    const content = fs.readFileSync(lockPath, 'utf-8').trim();
    if (content === ownIdentity()) fs.unlinkSync(lockPath);
  } catch {}
}

export { acquireLock, acquireLockWithWait, releaseLock, lockHeld, pidAlive, pidNamespace, procStartOf, ownIdentity, claimPathFor, DEFAULT_STALE_MS, CROSS_NS_HOLD_MS };
