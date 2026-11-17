import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, releaseLock, claimPathFor, pidNamespace, procStartOf, ownIdentity, CROSS_NS_HOLD_MS } from '../scripts/lib/lockfile';

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-lock-'));
}

// Keep every contender alive until all acquisition results are in. A fixed
// sleep both delays the suite and lets a late contender steal a dead winner's
// lock on a busy runner. EOF on stdin releases the children in finally.
async function raceAcquirers(lock: string): Promise<string[]> {
  const script = `
    import { acquireLock } from ${JSON.stringify(path.join(import.meta.dir, '../scripts/lib/lockfile.ts'))};
    console.log(acquireLock(${JSON.stringify(lock)}) ? 'WON' : 'LOST');
    await Bun.stdin.text();
  `;
  const procs = Array.from({ length: 8 }, () =>
    Bun.spawn([process.execPath, '-e', script], { stdin: 'pipe', stdout: 'pipe' })
  );
  try {
    return await Promise.all(procs.map(async (proc) => {
      let output = '';
      for await (const chunk of proc.stdout) {
        output += Buffer.from(chunk).toString();
        if (output.includes('\n')) break;
      }
      return output.trim();
    }));
  } finally {
    for (const proc of procs) proc.stdin.end();
    await Promise.all(procs.map(proc => proc.exited));
  }
}

// A live pid we genuinely cannot signal (EPERM): alive, owned by another user.
// pid 1 is the obvious candidate but only qualifies when the runner is
// unprivileged AND pid 1 is not its own — neither holds inside a container or a
// PID namespace, where pid 1 shares our uid and is often the test process
// itself. Returns null where the environment cannot produce such a pid (running
// as root, or every visible process is ours).
function foreignUserPid(): number | null {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid === null) return null;
  let entries: string[];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return null; // no procfs — cannot identify another user's process
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = parseInt(entry, 10);
    if (pid === process.pid) continue;
    try {
      if (fs.statSync(`/proc/${entry}`).uid === uid) continue;
      process.kill(pid, 0); // signalable after all (we are root) — not a witness
    } catch (e: any) {
      if (e && e.code === 'EPERM') return pid;
    }
  }
  return null;
}

const FOREIGN_PID = foreignUserPid();
// Content that cannot be mistaken for this process. Liveness is irrelevant
// wherever this is used; only the string comparison against our own pid is.
const NOT_OUR_PID = String(process.pid + 1);
const OWN_NS = pidNamespace();
const OWN = ownIdentity();
// Our own pid number in a namespace that is not ours: what a sandboxed command,
// or a container sharing the project folder, would write.
const OTHER_NS_SAME_PID = `${process.pid} pid:[1]`;

function age(file: string, ms: number): void {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(file, t, t);
}

describe('lockfile', () => {
  test('acquire on clean state succeeds and records our pid', () => {
    const dir = makeDir();
    try {
      const lock = path.join(dir, '.lifecycle.lock');
      expect(acquireLock(lock)).toBe(true);
      expect(fs.readFileSync(lock, 'utf-8')).toBe(OWN);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('live contention: fresh lock held by a running same-user pid is not stolen', () => {
    const dir = makeDir();
    try {
      const lock = path.join(dir, '.lifecycle.lock');
      // A real, signalable, same-user process — pid 1 is no longer usable here
      // because EPERM (another user) now reads as not-a-hermit-holder.
      const holder = Bun.spawn(['sleep', '30']);
      try {
        fs.writeFileSync(lock, String(holder.pid));
        expect(acquireLock(lock)).toBe(false);
        expect(fs.readFileSync(lock, 'utf-8')).toBe(String(holder.pid));
      } finally {
        holder.kill();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(FOREIGN_PID === null)('foreign-user pid (EPERM) is treated as not-holding, not wedged for the stale window', () => {
    const dir = makeDir();
    try {
      const lock = path.join(dir, '.lifecycle.lock');
      // A live process owned by another user is unsignalable here → EPERM. The
      // single-user invariant means it cannot be a hermit holder, so a FRESH
      // lock naming it is still taken over immediately.
      fs.writeFileSync(lock, String(FOREIGN_PID)); // mtime = now (fresh)
      expect(acquireLock(lock)).toBe(true);
      expect(fs.readFileSync(lock, 'utf-8')).toBe(OWN);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('dead-pid takeover: crashed holder is replaced', () => {
    const dir = makeDir();
    try {
      const lock = path.join(dir, '.lifecycle.lock');
      // Spawn-and-reap a process so its pid is known-dead.
      const proc = Bun.spawnSync(['true']);
      const deadPid = proc.pid ?? 99999;
      fs.writeFileSync(lock, String(deadPid));
      expect(acquireLock(lock)).toBe(true);
      expect(fs.readFileSync(lock, 'utf-8')).toBe(OWN);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('legacy empty flock file is treated as stale (python holders never wrote pids)', () => {
    const dir = makeDir();
    try {
      const lock = path.join(dir, '.lifecycle.lock');
      fs.writeFileSync(lock, '');
      expect(acquireLock(lock)).toBe(true);
      expect(fs.readFileSync(lock, 'utf-8')).toBe(OWN);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('garbage content is treated as stale', () => {
    const dir = makeDir();
    try {
      const lock = path.join(dir, '.lifecycle.lock');
      fs.writeFileSync(lock, 'not-a-pid\n');
      expect(acquireLock(lock)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('mtime staleness overrides liveness (pid-reuse-after-reboot guard)', () => {
    const dir = makeDir();
    try {
      const lock = path.join(dir, '.lifecycle.lock');
      // A genuinely-alive same-user pid, but the lock is an hour old → stale wins.
      const holder = Bun.spawn(['sleep', '30']);
      try {
        fs.writeFileSync(lock, String(holder.pid));
        const old = new Date(Date.now() - 60 * 60 * 1000);
        fs.utimesSync(lock, old, old);
        expect(acquireLock(lock, 15 * 60 * 1000)).toBe(true);
        expect(fs.readFileSync(lock, 'utf-8')).toBe(OWN);
      } finally {
        holder.kill();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('real fs errors surface — they are NOT masked as contention', () => {
    const dir = makeDir();
    try {
      // A lock path whose parent does not exist makes the temp write fail ENOENT;
      // the old bare catch returned false ("another op in progress"), masking it.
      const bad = path.join(dir, 'no-such-subdir', '.lifecycle.lock');
      expect(() => acquireLock(bad)).toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('seeded-stale double-acquire: two racers over one stale lock yield exactly one holder', async () => {
    const dir = makeDir();
    try {
      const lock = path.join(dir, '.lifecycle.lock');
      // Pre-seed an hour-old stale lock, then race N acquirers. Exactly one must
      // win — a takeover acting on the path rather than on the file it judged
      // lets a loser displace the winner's fresh lock and both end up "holding" it.
      fs.writeFileSync(lock, '999999'); // bogus pid, hour-old → unambiguously stale
      const old = new Date(Date.now() - 60 * 60 * 1000);
      fs.utimesSync(lock, old, old);
      const outs = await raceAcquirers(lock);
      expect(outs.filter((o) => o === 'WON').length).toBe(1);
      expect(outs.filter((o) => o === 'LOST').length).toBe(7);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // Only the marker's holder may replace the file it names, which is what
  // keeps two racers from both replacing it. Derived through the production
  // formula so the two can't drift apart.
  function claimMarker(lock: string): string {
    const st = fs.statSync(lock);
    return claimPathFor(lock, st.ino, st.mtimeMs);
  }

  test('takeover backs off while another process is already replacing the same stale lock', () => {
    const dir = makeDir();
    try {
      const lock = path.join(dir, '.lifecycle.lock');
      fs.writeFileSync(lock, '999999');
      const old = new Date(Date.now() - 60 * 60 * 1000);
      fs.utimesSync(lock, old, old);
      fs.writeFileSync(claimMarker(lock), '4242'); // an in-flight takeover
      expect(acquireLock(lock)).toBe(false);
      expect(fs.readFileSync(lock, 'utf-8')).toBe('999999'); // left for the stealer
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a takeover marker left by a crashed stealer does not wedge the lock forever', () => {
    const dir = makeDir();
    try {
      const lock = path.join(dir, '.lifecycle.lock');
      fs.writeFileSync(lock, '999999');
      const old = new Date(Date.now() - 60 * 60 * 1000);
      fs.utimesSync(lock, old, old);
      const claim = claimMarker(lock);
      fs.writeFileSync(claim, '4242');
      fs.utimesSync(claim, old, old); // stealer died mid-swap an hour ago
      expect(acquireLock(lock)).toBe(true);
      expect(fs.readFileSync(lock, 'utf-8')).toBe(OWN);
      expect(fs.existsSync(claim)).toBe(false); // and the marker is cleaned up
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reentrant: our own pid in the lock is not contention', () => {
    const dir = makeDir();
    try {
      const lock = path.join(dir, '.lifecycle.lock');
      expect(acquireLock(lock)).toBe(true);
      expect(acquireLock(lock)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('release removes only our own lock', () => {
    const dir = makeDir();
    try {
      const lock = path.join(dir, '.lifecycle.lock');
      fs.writeFileSync(lock, NOT_OUR_PID);
      releaseLock(lock);
      expect(fs.existsSync(lock)).toBe(true); // not ours — untouched
      fs.unlinkSync(lock);
      acquireLock(lock);
      releaseLock(lock);
      expect(fs.existsSync(lock)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('concurrent acquisition race: exactly one of N parallel processes wins', async () => {
    const dir = makeDir();
    try {
      const lock = path.join(dir, '.lifecycle.lock');
      const outs = await raceAcquirers(lock);
      const winners = outs.filter((o) => o === 'WON');
      expect(winners.length).toBe(1);
      expect(outs.filter((o) => o === 'LOST').length).toBe(7);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(OWN_NS === null)('lockfile across pid namespaces', () => {
  test('a fresh lock from another namespace is held, even when its pid number is ours', () => {
    const dir = makeDir();
    try {
      const lock = path.join(dir, '.lifecycle.lock');
      fs.writeFileSync(lock, OTHER_NS_SAME_PID);
      expect(acquireLock(lock)).toBe(false);
      expect(fs.readFileSync(lock, 'utf-8')).toBe(OTHER_NS_SAME_PID);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('past the cross-namespace window the lock is taken', () => {
    const dir = makeDir();
    try {
      const lock = path.join(dir, '.lifecycle.lock');
      fs.writeFileSync(lock, OTHER_NS_SAME_PID);
      age(lock, CROSS_NS_HOLD_MS + 5000);
      expect(acquireLock(lock)).toBe(true);
      expect(fs.readFileSync(lock, 'utf-8')).toBe(OWN);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a caller stale window shorter than the cross-namespace window still applies', () => {
    const dir = makeDir();
    try {
      const lock = path.join(dir, '.lifecycle.lock');
      fs.writeFileSync(lock, OTHER_NS_SAME_PID);
      age(lock, 10_000);
      expect(acquireLock(lock, 5000)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('release leaves a lock that names our pid number in another namespace', () => {
    const dir = makeDir();
    try {
      const lock = path.join(dir, '.lifecycle.lock');
      fs.writeFileSync(lock, OTHER_NS_SAME_PID);
      releaseLock(lock);
      expect(fs.readFileSync(lock, 'utf-8')).toBe(OTHER_NS_SAME_PID);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a live same-namespace holder with its recorded start time is held', () => {
    const dir = makeDir();
    const holder = Bun.spawn(['sleep', '30']);
    try {
      const lock = path.join(dir, '.lifecycle.lock');
      fs.writeFileSync(lock, `${holder.pid} ${OWN_NS} ${procStartOf(holder.pid)}`);
      expect(acquireLock(lock)).toBe(false);
    } finally {
      holder.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a reused pid (live process, different start time) does not hold the lock', () => {
    const dir = makeDir();
    const holder = Bun.spawn(['sleep', '30']);
    try {
      const lock = path.join(dir, '.lifecycle.lock');
      fs.writeFileSync(lock, `${holder.pid} ${OWN_NS} 1`);
      expect(acquireLock(lock)).toBe(true);
      expect(fs.readFileSync(lock, 'utf-8')).toBe(OWN);
    } finally {
      holder.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('racers over an expired cross-namespace lock yield exactly one holder', async () => {
    const dir = makeDir();
    try {
      const lock = path.join(dir, '.lifecycle.lock');
      fs.writeFileSync(lock, OTHER_NS_SAME_PID);
      age(lock, CROSS_NS_HOLD_MS + 5000);
      const outs = await raceAcquirers(lock);
      expect(outs.filter((o) => o === 'WON').length).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
