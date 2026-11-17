import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRegistry, findResident, residentInOtherPidNamespace } from '../scripts/lib/session-registry';
import { procStartOf, localPidDomain } from './helpers/registry-fixture';

const dirs: string[] = [];

function registryDir(): string {
  const configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-registry-')));
  dirs.push(configDir);
  fs.mkdirSync(path.join(configDir, 'sessions'), { recursive: true });
  return configDir;
}

function writeEntry(configDir: string, pid: number, patch: Record<string, unknown> = {}): void {
  const entry = {
    // Not localIdentity(): these cases build entries for pids OTHER than this
    // process (a dead one, a reused one), so the identity is per-pid here.
    pid,
    procStart: procStartOf(pid) ?? '1',
    pidDomain: localPidDomain(),
    sessionId: `sess-${pid}`,
    kind: 'interactive',
    status: 'idle',
    statusUpdatedAt: Date.now(),
    cwd: '/tmp/project',
    name: `session-${pid}`,
    messagingSocketPath: `/run/user/1000/cc-socks/${pid}.sock`,
    ...patch,
  };
  fs.writeFileSync(path.join(configDir, 'sessions', `${pid}.json`), JSON.stringify(entry));
}

// afterAll, not afterEach: bunfig.toml runs these tests concurrently, so a
// per-test teardown of a shared list would rm a fixture another in-flight test
// is still reading. Each test builds its own dir; they are removed together here.
afterAll(() => {
  while (dirs.length) {
    try { fs.rmSync(dirs.pop()!, { recursive: true, force: true }); } catch {}
  }
});

describe('readRegistry validation', () => {
  test('a live entry for this process resolves', () => {
    const c = registryDir();
    writeEntry(c, process.pid);
    const entries = readRegistry(c);
    expect(entries.map((e) => e.pid)).toEqual([process.pid]);
    expect(entries[0].status).toBe('idle');
  });

  test('a same-pid entry with a different procStart is dropped (pid reuse)', () => {
    const c = registryDir();
    writeEntry(c, process.pid, { procStart: '1' });
    // Off Linux there is no /proc to contradict the entry, so the check is
    // skipped by design and the entry survives — assert the platform's rule.
    const expected = procStartOf(process.pid) === null ? 1 : 0;
    expect(readRegistry(c).length).toBe(expected);
  });

  test('an entry from another pid domain is dropped', () => {
    const c = registryDir();
    writeEntry(c, process.pid, { pidDomain: 'linux:0000:pid:[4026999999]' });
    const expected = os.platform() === 'linux' ? 0 : 1;
    expect(readRegistry(c).length).toBe(expected);
  });

  test('a dead pid is dropped', () => {
    const c = registryDir();
    // Reserved, never-allocated pid: 0 is rejected by the shape check, so use a
    // pid above the system max, which cannot be alive.
    writeEntry(c, 4_194_304, { procStart: '1' });
    expect(readRegistry(c)).toEqual([]);
  });

  test('an unparseable file is skipped without throwing', () => {
    const c = registryDir();
    fs.writeFileSync(path.join(c, 'sessions', '999999.json'), '{not json');
    writeEntry(c, process.pid);
    expect(readRegistry(c).map((e) => e.pid)).toEqual([process.pid]);
  });

  test('an entry with an unknown status is dropped', () => {
    const c = registryDir();
    writeEntry(c, process.pid, { status: 'compacting' });
    expect(readRegistry(c)).toEqual([]);
  });

  test('sibling .key files are ignored', () => {
    const c = registryDir();
    fs.writeFileSync(path.join(c, 'sessions', `${process.pid}.abc123.key`), 'secret');
    writeEntry(c, process.pid);
    expect(readRegistry(c).length).toBe(1);
  });

  test('an absent registry dir reads as unknown, not as an error', () => {
    expect(readRegistry(path.join(os.tmpdir(), 'hermit-registry-does-not-exist'))).toEqual([]);
  });
});

describe('findResident', () => {
  test('resolves the entry named by runtime.session_pid', () => {
    const c = registryDir();
    writeEntry(c, process.pid, { status: 'waiting' });
    expect(findResident({ session_pid: process.pid }, c)?.status).toBe('waiting');
  });

  test('null when the runtime carries no session_pid stamp', () => {
    const c = registryDir();
    writeEntry(c, process.pid);
    expect(findResident({ session_pid: null }, c)).toBeNull();
    expect(findResident({}, c)).toBeNull();
    expect(findResident(null, c)).toBeNull();
  });

  test('null when the stamped pid has no validated entry', () => {
    const c = registryDir();
    writeEntry(c, process.pid);
    expect(findResident({ session_pid: 4_194_304 }, c)).toBeNull();
  });
});

describe('residentInOtherPidNamespace', () => {
  test.skipIf(process.platform !== 'linux')('true for the stamped pid registered from another pid domain', () => {
    const c = registryDir();
    writeEntry(c, 4_194_000, { pidDomain: 'linux:0000:pid:[4026999999]' });
    expect(residentInOtherPidNamespace({ session_pid: 4_194_000 }, c)).toBe(true);
  });

  test('false for an entry in this pid domain, a missing entry, or no stamp', () => {
    const c = registryDir();
    writeEntry(c, process.pid);
    expect(residentInOtherPidNamespace({ session_pid: process.pid }, c)).toBe(false);
    expect(residentInOtherPidNamespace({ session_pid: 4_194_001 }, c)).toBe(false);
    expect(residentInOtherPidNamespace({}, c)).toBe(false);
  });
});
