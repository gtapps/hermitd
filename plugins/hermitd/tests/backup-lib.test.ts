// Unit coverage for lib/backup.ts — the decision half of the scheduled state
// backup. The git-driving half lives in backup-run.test.ts (spawned).
//
// Scheduling is asserted with an injected `now` rather than wall-clock so the
// cursor semantics (at-most-once, no catch-up, 24h floor) are provable.

import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { validate } from '../scripts/validate-config';
import {
  CRED_HELPER_ARGS,
  WORKSPACE_MARKER,
  evaluateBackupDue,
  formatStatus,
  hasWorkspaceMarker,
  mirrorDir,
  normalizeRemote,
  readBackupSchedule,
  rewriteGitignoreForWorkspace,
  scanRefusedPaths,
  secondMostRecentMatch,
  toPushUrl,
  writeBackupStatus,
} from '../scripts/lib/backup';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-backup-lib-');
afterAll(cleanup);

function hermitAt(dir: string): string {
  const h = path.join(dir, '.hermit');
  fs.mkdirSync(path.join(h, 'state'), { recursive: true });
  return h;
}

const CONF = (over: any = {}) => ({
  timezone: 'UTC',
  backup: { enabled: true, mode: 'workspace', schedule: '0 3 * * *', remote: null, push: true, include: [], ...over },
});

describe('evaluateBackupDue', () => {
  test('initializes the cursor and fires nothing on first sight', () => {
    const h = hermitAt(freshDir());
    expect(evaluateBackupDue(CONF(), h, new Date('2026-09-01T03:00:00Z'))).toBe(false);
    expect(readBackupSchedule(h)?.last_consumed_mark).toBe('2026-09-01T03:00:00.000Z');
  });

  test('fires once when a scheduled minute falls in (cursor, now] and advances to it', () => {
    const h = hermitAt(freshDir());
    evaluateBackupDue(CONF(), h, new Date('2026-09-01T02:50:00Z'));
    expect(evaluateBackupDue(CONF(), h, new Date('2026-09-01T03:05:00Z'))).toBe(true);
    expect(readBackupSchedule(h)?.last_consumed_mark).toBe('2026-09-01T03:00:00.000Z');
    // Same window again: already consumed, nothing to fire.
    expect(evaluateBackupDue(CONF(), h, new Date('2026-09-01T03:10:00Z'))).toBe(false);
  });

  test('advances past a dead window without firing', () => {
    const h = hermitAt(freshDir());
    evaluateBackupDue(CONF(), h, new Date('2026-09-01T04:00:00Z'));
    expect(evaluateBackupDue(CONF(), h, new Date('2026-09-01T05:00:00Z'))).toBe(false);
    expect(readBackupSchedule(h)?.last_consumed_mark).toBe('2026-09-01T05:00:00.000Z');
  });

  test('a cursor older than the 24h floor fires once, not once per missed day', () => {
    const h = hermitAt(freshDir());
    fs.writeFileSync(path.join(h, 'state', 'backup-schedule.json'),
      JSON.stringify({ version: 1, last_consumed_mark: '2026-08-20T03:00:00.000Z' }));
    expect(evaluateBackupDue(CONF(), h, new Date('2026-09-01T04:00:00Z'))).toBe(true);
    expect(readBackupSchedule(h)?.last_consumed_mark).toBe('2026-09-01T03:00:00.000Z');
  });

  test('a future cursor (clock skew) re-initializes instead of firing', () => {
    const h = hermitAt(freshDir());
    fs.writeFileSync(path.join(h, 'state', 'backup-schedule.json'),
      JSON.stringify({ version: 1, last_consumed_mark: '2027-01-01T00:00:00.000Z' }));
    expect(evaluateBackupDue(CONF(), h, new Date('2026-09-01T04:00:00Z'))).toBe(false);
    expect(readBackupSchedule(h)?.last_consumed_mark).toBe('2026-09-01T04:00:00.000Z');
  });

  test('disabled backup never writes a schedule file', () => {
    const h = hermitAt(freshDir());
    expect(evaluateBackupDue(CONF({ enabled: false }), h, new Date('2026-09-01T03:00:00Z'))).toBe(false);
    expect(fs.existsSync(path.join(h, 'state', 'backup-schedule.json'))).toBe(false);
  });

  test('defers without consuming while a live PID holds the lock, even with a stale mtime', () => {
    const h = hermitAt(freshDir());
    evaluateBackupDue(CONF(), h, new Date('2026-09-01T02:50:00Z'));
    const lock = path.join(h, 'state', '.backup.lock');
    // Same-uid live process: pidAlive() reads EPERM (another user's pid) as
    // not-holding, so the holder has to be ours to prove the deferral.
    const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      fs.writeFileSync(lock, String(holder.pid));
      // Older than lockfile's 15-min default staleness: acquireLock would reclaim
      // this, but the deferral is mtime-independent so the window is not spent.
      const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
      fs.utimesSync(lock, old, old);
      expect(evaluateBackupDue(CONF(), h, new Date('2026-09-01T03:05:00Z'))).toBe(false);
      expect(readBackupSchedule(h)?.last_consumed_mark).toBe('2026-09-01T02:50:00.000Z');
    } finally {
      holder.kill();
    }
  });

  test('a dead lock holder does not block the window', () => {
    const h = hermitAt(freshDir());
    evaluateBackupDue(CONF(), h, new Date('2026-09-01T02:50:00Z'));
    // spawnSync returns once the child has exited, so the pid is dead without
    // waiting on an exit event (which never arrived on a loaded macOS runner).
    const deadPid = spawnSync('true', { stdio: 'ignore' }).pid;
    fs.writeFileSync(path.join(h, 'state', '.backup.lock'), String(deadPid));
    expect(evaluateBackupDue(CONF(), h, new Date('2026-09-01T03:05:00Z'))).toBe(true);
  });

  test('an invalid cron never fires', () => {
    const h = hermitAt(freshDir());
    expect(evaluateBackupDue(CONF({ schedule: 'not a cron' }), h, new Date('2026-09-01T03:00:00Z'))).toBe(false);
  });
});

describe('secondMostRecentMatch', () => {
  test('returns the previous day for a daily schedule', () => {
    const got = secondMostRecentMatch('0 3 * * *', 'UTC', new Date('2026-09-01T10:00:00Z'));
    expect(got?.toISOString()).toBe('2026-08-31T03:00:00.000Z');
  });

  test('returns null when the schedule fires less often than the lookback', () => {
    expect(secondMostRecentMatch('0 3 1 1 *', 'UTC', new Date('2026-09-01T10:00:00Z'))).toBeNull();
  });
});

describe('scanRefusedPaths', () => {
  test('refuses secret filename shapes, the channel log, oversized and credential-bearing files', () => {
    const dir = freshDir();
    const write = (rel: string, body = 'x') => {
      fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    };
    write('.env');
    write('.env.example');
    write('.env.bak.20260514020813');
    write('certs/server.pem');
    write('certs/server.key');
    write('keys/id_rsa');
    write('.credentials.json');
    write('.claude.local/token.txt');
    write('.hermit/state/channel-log.sqlite');
    write('.hermit/state/channel-log.sqlite-wal');
    write('notes.md', 'token ghp_' + 'a'.repeat(36) + ' leaked');
    write('quotes.md', 'the attack says: ignore all previous instructions');
    write('plain.md', 'nothing here');

    const rels = [
      '.env', '.env.example', '.env.bak.20260514020813', 'certs/server.pem', 'certs/server.key',
      'keys/id_rsa', '.credentials.json', '.claude.local/token.txt',
      '.hermit/state/channel-log.sqlite', '.hermit/state/channel-log.sqlite-wal',
      'notes.md', 'quotes.md', 'plain.md',
    ];
    const refused = scanRefusedPaths(dir, rels);
    const byPath = Object.fromEntries(refused.map(r => [r.path, r.reason]));

    expect(byPath['.env']).toBe('secret-filename');
    expect(byPath['.env.example']).toBe('secret-filename');
    expect(byPath['.env.bak.20260514020813']).toBe('secret-filename');
    expect(byPath['certs/server.pem']).toBe('secret-filename');
    expect(byPath['certs/server.key']).toBe('secret-filename');
    expect(byPath['keys/id_rsa']).toBe('secret-filename');
    expect(byPath['.credentials.json']).toBe('secret-filename');
    expect(byPath['.claude.local/token.txt']).toBe('secret-filename');
    expect(byPath['.hermit/state/channel-log.sqlite']).toBe('channel-log');
    expect(byPath['.hermit/state/channel-log.sqlite-wal']).toBe('channel-log');
    expect(byPath['notes.md']).toContain('credential-marker');
    // The whole reason scanCredentials exists: security prose is not a secret.
    expect(byPath['quotes.md']).toBeUndefined();
    expect(byPath['plain.md']).toBeUndefined();
  });

  test('refuses the backup\'s own bookkeeping so a quiet run commits nothing', () => {
    const dir = freshDir();
    const rel = '.hermit/state';
    fs.mkdirSync(path.join(dir, rel), { recursive: true });
    for (const f of ['.backup.lock', 'backup-status.json', 'backup-schedule.json']) {
      fs.writeFileSync(path.join(dir, rel, f), '{}');
    }
    const refused = scanRefusedPaths(dir, [`${rel}/.backup.lock`, `${rel}/backup-status.json`, `${rel}/backup-schedule.json`]);
    expect(refused.map(r => r.reason)).toEqual(['transient', 'transient', 'transient']);
  });

  test('refuses a file over the size ceiling and skips content-scanning a large one', () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, 'huge.bin'), Buffer.alloc(1024));
    const refused = scanRefusedPaths(dir, ['huge.bin']);
    expect(refused).toEqual([]);
  });

  test('ignores paths that do not exist', () => {
    expect(scanRefusedPaths(freshDir(), ['nope.md'])).toEqual([]);
  });
});

describe('remote helpers', () => {
  test('normalizeRemote collapses spellings of one repo', () => {
    const want = 'github.com/gtapps/x-hermit';
    expect(normalizeRemote('git@github.com:gtapps/x-hermit.git')).toBe(want);
    expect(normalizeRemote('ssh://git@github.com/gtapps/x-hermit.git')).toBe(want);
    expect(normalizeRemote('https://github.com/gtapps/X-Hermit')).toBe(want);
    expect(normalizeRemote('git@escudo-hermit.github.com:gtapps/x.git')).toBe('escudo-hermit.github.com/gtapps/x');
    expect(normalizeRemote('')).toBeNull();
    expect(normalizeRemote('not-a-remote')).toBeNull();
  });

  test('toPushUrl converts ssh forms to https and keeps local paths local', () => {
    expect(toPushUrl('git@github.com:o/r.git')).toEqual({ url: 'https://github.com/o/r.git', kind: 'https' });
    expect(toPushUrl('ssh://git@github.com/o/r.git')).toEqual({ url: 'https://github.com/o/r.git', kind: 'https' });
    expect(toPushUrl('https://github.com/o/r.git')).toEqual({ url: 'https://github.com/o/r.git', kind: 'https' });
    expect(toPushUrl('/srv/backups/x.git')).toEqual({ url: '/srv/backups/x.git', kind: 'local' });
    expect(toPushUrl('file:///srv/x.git')).toEqual({ url: 'file:///srv/x.git', kind: 'local' });
    expect(toPushUrl('relative/path.git')).toBeNull();
    expect(toPushUrl(null)).toBeNull();
  });

  test('the credential helper never carries the token on argv', () => {
    expect(CRED_HELPER_ARGS.join(' ')).toContain('$HERMIT_BACKUP_TOKEN');
    expect(CRED_HELPER_ARGS.join(' ')).not.toContain('ghp_');
  });

  test('mirrorDir keys off the CC path key, not the bare basename', () => {
    expect(mirrorDir('/cfg', '/home/d0m/Projects/x.y')).toBe('/cfg/hermit-backups/-home-d0m-Projects-x-y');
  });
});

describe('rewriteGitignoreForWorkspace', () => {
  const TEMPLATE = [
    '', '# hermitd',
    '.claude/cost-log.jsonl',
    '.hermit/config.json',
    '.hermit/state/',
    '.hermit/sessions/',
    '.claude/scheduled_tasks.lock',
    '.claude.local/',
    'CLAUDE.local.md',
    '', '# Claude Code sandbox (sets $HOME to CWD, dropping shell dotfiles here)',
    '.bashrc', '.gitconfig', '',
  ].join('\n');

  test('stops ignoring hermit state, keeps the secret-bearing lines, and is idempotent', () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, '.gitignore'), TEMPLATE);

    const first = rewriteGitignoreForWorkspace(dir, TEMPLATE);
    const after = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');

    expect(first.removed).toBeGreaterThan(0);
    expect(after).not.toContain('.hermit/state/\n');
    expect(after).not.toContain('.hermit/sessions/');
    expect(after).not.toContain('.hermit/config.json');
    expect(after).toContain('.claude.local/');
    expect(after).toContain('.claude/scheduled_tasks.lock');
    expect(after).toContain('.bashrc');
    expect(after).toContain('.env');
    expect(after).toContain('.hermit/state/channel-log.sqlite*');
    expect(after).toContain(WORKSPACE_MARKER);
    // hatch-report probes for this substring to decide the gitignore is configured.
    expect(after).toContain('.hermit');
    expect(hasWorkspaceMarker(dir)).toBe(true);

    const second = rewriteGitignoreForWorkspace(dir, TEMPLATE);
    expect(second).toEqual({ removed: 0, added: 0 });
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8')).toBe(after);
  });

  test('creates a gitignore when the project has none', () => {
    const dir = freshDir();
    rewriteGitignoreForWorkspace(dir, TEMPLATE);
    expect(hasWorkspaceMarker(dir)).toBe(true);
  });
});

describe('status file', () => {
  test('writes atomically and leaves no tmp behind', () => {
    const dir = freshDir();
    const h = hermitAt(dir);
    writeBackupStatus(h, { version: 1, last_result: 'committed' });
    const leftovers = fs.readdirSync(path.join(h, 'state')).filter(f => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  test('formatStatus stays a verdict-sized digest', () => {
    const out = formatStatus(
      { last_result: 'committed', last_attempt_at: 'a', last_success_at: 'b', push: 'ok', refused: [] },
      { mode: 'workspace' },
    );
    expect(out.split('\n').length).toBeLessThanOrEqual(5);
    expect(out).toContain('committed');
  });
});

describe('validate-config: backup block', () => {
  const base = {
    agent_name: null, language: null, timezone: null, escalation: 'balanced',
    channels: {}, env: {}, routines: [],
    heartbeat: { enabled: true, active_hours: { start: '08:00', end: '23:00' } },
  };
  const errorsFor = (backup: any) => validate({ ...base, backup }).errors.filter((e: string) => e.startsWith('backup'));

  test('accepts the shipped default block', () => {
    expect(errorsFor({ enabled: false, mode: 'workspace', schedule: '0 3 * * *', remote: null, push: true, include: [] })).toEqual([]);
  });

  test('rejects an unknown mode', () => {
    expect(errorsFor({ mode: 'rsync' })[0]).toContain('backup.mode');
  });

  test('rejects an invalid cron', () => {
    expect(errorsFor({ schedule: '99 * * * *' })[0]).toContain('backup.schedule');
  });

  test('rejects a remote that cannot be pushed to', () => {
    expect(errorsFor({ remote: 'github.com/o/r' })[0]).toContain('backup.remote');
    expect(errorsFor({ remote: 'git@github.com:o/r.git' })).toEqual([]);
    expect(errorsFor({ remote: '/srv/x.git' })).toEqual([]);
  });

  test('rejects an unknown include value and a non-boolean flag', () => {
    expect(errorsFor({ include: ['everything'] })[0]).toContain('backup.include');
    expect(errorsFor({ push: 'yes' })[0]).toContain('backup.push');
  });

  test('requires a schedule when enabled', () => {
    expect(errorsFor({ enabled: true, mode: 'workspace' })[0]).toContain('backup.schedule');
  });

  test('rejects a non-object block', () => {
    expect(errorsFor(['nope'])[0]).toContain('backup: must be an object');
  });
});
