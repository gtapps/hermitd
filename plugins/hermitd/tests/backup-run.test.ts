// Integration coverage for scripts/backup.ts — the git-driving half. Spawned, not
// imported: the assertions are about what lands in a real repository, what never
// does, and what the status file says afterwards.
//
// The remote is a local bare repo (`local` push kind), so the push path is
// exercised end to end without a network or a token.

import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-backup-run-');
afterAll(cleanup);

const IDENT = ['-c', 'user.name=test', '-c', 'user.email=test@test', '-c', 'commit.gpgsign=false'];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', `safe.directory=${cwd}`, ...IDENT, ...args], { cwd, encoding: 'utf-8' });
}

// An explicit git dir, so this also works where safe.bareRepository=explicit.
function bareHead(bare: string): string {
  return git(bare, '--git-dir=.', 'rev-parse', 'HEAD').trim();
}

interface Fixture {
  root: string;
  hermit: string;
  bare: string;
  configDir: string;
  key: string;
}

function write(root: string, rel: string, body: string): void {
  fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

/** A hatched-looking workspace on a real branch, plus a bare remote and a CC config dir. */
function fixture(over: any = {}): Fixture {
  const root = freshDir();
  const hermit = path.join(root, '.hermit');
  fs.mkdirSync(path.join(hermit, 'state'), { recursive: true });
  fs.mkdirSync(path.join(hermit, 'sessions'), { recursive: true });

  const bare = path.join(freshDir(), 'remote.git');
  // Pin the bare's HEAD symref to the branch the workspace repo uses below.
  // Without -b it follows the machine's init.defaultBranch, so on a host where
  // that is master the pushed `main` is a non-HEAD ref and `rev-parse HEAD`
  // resolves nothing — green locally, red on CI.
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);

  const configDir = freshDir();
  const key = root.replace(/[^a-zA-Z0-9]/g, '-');
  fs.mkdirSync(path.join(configDir, 'projects', key, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'projects', key, 'memory', 'MEMORY.md'), '- a remembered fact\n');

  fs.writeFileSync(path.join(hermit, 'config.json'), JSON.stringify({
    agent_name: 'Testhermit', timezone: 'UTC',
    backup: { enabled: true, mode: 'workspace', schedule: '0 3 * * *', remote: bare, push: true, include: [], ...over },
  }, null, 2));
  fs.writeFileSync(path.join(hermit, 'sessions', 'frozen-report.md'), '# Shell\n');
  write(root, 'README.md', '# project\n');
  write(root, '.gitignore', 'node_modules/\n');

  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', 'README.md', '.gitignore');
  git(root, 'commit', '-q', '-m', 'init');
  return { root, hermit, bare, configDir, key };
}

async function run(f: Fixture, verb = 'run', args: string[] = []) {
  return runScript('backup.ts', {
    args: [verb, ...args],
    cwd: f.root,
    env: { CLAUDE_CONFIG_DIR: f.configDir, HERMIT_BACKUP_TOKEN: '' },
  });
}

const status = (f: Fixture): any =>
  JSON.parse(fs.readFileSync(path.join(f.hermit, 'state', 'backup-status.json'), 'utf-8'));

const committedFiles = (repo: string): string[] =>
  git(repo, 'show', '--name-only', '--pretty=format:', 'HEAD').split('\n').filter(Boolean);

describe('backup run — workspace mode', () => {
  test('commits hermit state plus the memory mirror and pushes to the remote', async () => {
    const f = fixture();
    const res = await run(f);
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({ result: 'committed', push: 'ok' });

    const s = status(f);
    expect(s.last_result).toBe('committed');
    expect(s.push).toBe('ok');
    expect(s.last_success_at).toBeTruthy();

    const files = committedFiles(f.root);
    expect(files).toContain('.hermit/config.json');
    expect(files).toContain('.hermit/sessions/frozen-report.md');
    expect(files).toContain('.hermit/memory-mirror/memory/MEMORY.md');

    expect(git(f.root, 'log', '-1', '--pretty=%s')).toContain('hermit backup');
    expect(git(f.root, 'log', '-1', '--pretty=%ae').trim()).toBe('Testhermit@hermit.local');
    // The remote got it, and the workspace's own remote config was never touched.
    expect(bareHead(f.bare)).toBe(git(f.root, 'rev-parse', 'HEAD').trim());
    expect(() => git(f.root, 'remote', 'get-url', 'origin')).toThrow();
  });

  test('refuses secret-shaped and credential-bearing paths, and never the channel log', async () => {
    const f = fixture();
    write(f.root, '.env', 'HERMIT_BACKUP_TOKEN=secretvalue\n');
    write(f.root, 'certs/server.pem', 'PRIVATE\n');
    write(f.root, 'notes.md', 'token ghp_' + 'a'.repeat(36) + '\n');
    write(f.root, '.hermit/state/channel-log.sqlite', 'SQLite format 3\0');
    write(f.root, 'keep.md', 'ordinary content\n');

    await run(f);
    const files = committedFiles(f.root);

    expect(files).not.toContain('.env');
    expect(files).not.toContain('certs/server.pem');
    expect(files).not.toContain('notes.md');
    expect(files).not.toContain('.hermit/state/channel-log.sqlite');
    expect(files).toContain('keep.md');

    const reasons = Object.fromEntries(status(f).refused.map((r: any) => [r.path, r.reason]));
    expect(reasons['.env']).toBe('secret-filename');
    expect(reasons['certs/server.pem']).toBe('secret-filename');
    expect(reasons['notes.md']).toContain('credential-marker');
    expect(reasons['.hermit/state/channel-log.sqlite']).toBe('channel-log');
  });

  test('a refused path that is already tracked stays at its committed version', async () => {
    const f = fixture();
    // Tracked before backup existed — untracking it would delete it from the
    // operator's tree, so the backup only declines to update it.
    write(f.root, '.env.bak.1', 'OLD=1\n');
    git(f.root, 'add', '-f', '.env.bak.1');
    git(f.root, 'commit', '-q', '-m', 'pre-existing');
    write(f.root, '.env.bak.1', 'NEW=2\n');

    await run(f);
    expect(committedFiles(f.root)).not.toContain('.env.bak.1');
    expect(git(f.root, 'show', 'HEAD:.env.bak.1')).toBe('OLD=1\n');
  });

  test('a diverged remote is reported, never reconciled', async () => {
    const f = fixture();
    await run(f);

    // Someone else pushed in the meantime.
    const other = freshDir();
    execFileSync('git', ['clone', '-q', f.bare, other]);
    fs.writeFileSync(path.join(other, 'other.txt'), 'from elsewhere\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'other work');
    git(other, 'push', '-q', 'origin', 'HEAD:main');
    const remoteHead = bareHead(f.bare);

    write(f.root, 'local.md', 'local work\n');
    await run(f);

    const s = status(f);
    expect(s.last_result).toBe('committed');
    expect(s.push).toBe('diverged');
    expect(committedFiles(f.root)).toContain('local.md');
    // The local commit is preserved; the remote is untouched; nothing was merged.
    expect(bareHead(f.bare)).toBe(remoteHead);
    expect(git(f.root, 'log', '--oneline').split('\n').length).toBeGreaterThan(2);
  });

  test('refuses to run on a detached HEAD or mid-merge tree', async () => {
    const f = fixture();
    const head = git(f.root, 'rev-parse', 'HEAD').trim();
    git(f.root, 'checkout', '-q', '--detach', head);
    await run(f);
    expect(status(f).last_result).toBe('unsafe-tree');
    expect(status(f).last_error).toContain('detached');

    git(f.root, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(f.root, '.git', 'MERGE_HEAD'), head + '\n');
    await run(f);
    expect(status(f).last_result).toBe('unsafe-tree');
    expect(status(f).last_error).toContain('merge');
  });

  test('refuses to commit an operator\'s staged work', async () => {
    const f = fixture();
    write(f.root, 'wip.md', 'half-written\n');
    git(f.root, 'add', 'wip.md');
    const before = git(f.root, 'rev-parse', 'HEAD').trim();

    await run(f);

    expect(status(f).last_result).toBe('dirty-index');
    expect(git(f.root, 'rev-parse', 'HEAD').trim()).toBe(before);
    expect(git(f.root, 'diff', '--cached', '--name-only').trim()).toBe('wip.md');
  });

  test('a second run with nothing new still counts as a success', async () => {
    const f = fixture();
    await run(f);
    const head = git(f.root, 'rev-parse', 'HEAD').trim();

    await run(f);
    const s = status(f);
    expect(s.last_result).toBe('nothing-to-commit');
    expect(s.push).toBe('ok');
    expect(git(f.root, 'rev-parse', 'HEAD').trim()).toBe(head);
  });

  test('repairs a re-ignored gitignore when the workspace marker is present', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, '.gitignore'),
      '# .hermit state is tracked here (backup: workspace mode)\n.hermit/state/\n');

    await run(f);

    const s = status(f);
    expect(s.note).toBe('gitignore-repaired');
    expect(s.last_result).toBe('committed');
    expect(committedFiles(f.root).some(p => p.startsWith('.hermit/'))).toBe(true);
  });

  test('without the marker, a gitignored state dir is an error naming setup', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, '.gitignore'), '.hermit/state/\n');

    await run(f);

    const s = status(f);
    expect(s.last_result).toBe('error');
    expect(s.last_error).toContain('backup setup');
  });

  test('is inert until configured', async () => {
    const f = fixture({ enabled: false });
    const res = await run(f);
    expect(res.exitCode).toBe(0);
    expect(fs.existsSync(path.join(f.hermit, 'state', 'backup-status.json'))).toBe(false);
  });
});

describe('backup run — mirror mode', () => {
  test('copies the manifest into its own repo and leaves the workspace untouched', async () => {
    const f = fixture({ mode: 'mirror' });
    const before = git(f.root, 'status', '--porcelain');

    await run(f);

    const mirror = path.join(f.configDir, 'hermit-backups', f.key);
    expect(fs.existsSync(path.join(mirror, '.git'))).toBe(true);
    const files = committedFiles(mirror);
    expect(files).toContain('.hermit/config.json');
    expect(files).toContain('.hermit/memory-mirror/memory/MEMORY.md');
    expect(files).not.toContain('README.md'); // manifest-scoped, not the whole tree

    // Nothing new in the workspace: no memory-mirror, no new commit, same status.
    expect(fs.existsSync(path.join(f.root, '.hermit', 'memory-mirror'))).toBe(false);
    expect(git(f.root, 'status', '--porcelain')).toBe(before);
    expect(git(f.root, 'log', '--oneline').trim().split('\n').length).toBe(1);
    expect(status(f).push).toBe('ok');
  });
});

describe('backup setup', () => {
  function bareFixture(over: any = {}) {
    const f = fixture(over);
    // setup writes its own config; start from an unconfigured one.
    const cfg = JSON.parse(fs.readFileSync(path.join(f.hermit, 'config.json'), 'utf-8'));
    delete cfg.backup;
    fs.writeFileSync(path.join(f.hermit, 'config.json'), JSON.stringify(cfg, null, 2));
    return f;
  }

  test('writes the block in one settings-edit call, rewrites gitignore, and backs up once', async () => {
    const f = bareFixture();
    const res = await run(f, 'setup', ['--mode', 'workspace', '--schedule', '0 3 * * *', '--remote', f.bare, '--yes']);
    expect(res.exitCode).toBe(0);

    const cfg = JSON.parse(fs.readFileSync(path.join(f.hermit, 'config.json'), 'utf-8'));
    expect(cfg.backup).toEqual({
      enabled: true, mode: 'workspace', schedule: '0 3 * * *', remote: f.bare, push: true, include: [],
    });

    const ignore = fs.readFileSync(path.join(f.root, '.gitignore'), 'utf-8');
    expect(ignore).toContain('.hermit state is tracked here');
    expect(ignore).toContain('.env');

    expect(bareHead(f.bare)).toBe(git(f.root, 'rev-parse', 'HEAD').trim());
    expect(status(f).configured_at).toBeTruthy();
    // The cursor is seeded so the next tick does not immediately re-fire.
    const sched = JSON.parse(fs.readFileSync(path.join(f.hermit, 'state', 'backup-schedule.json'), 'utf-8'));
    expect(sched.last_consumed_mark).toBeTruthy();
  });

  test('refuses a remote belonging to a project repo inside the workspace', async () => {
    const f = bareFixture();
    const child = path.join(f.root, 'app');
    fs.mkdirSync(child, { recursive: true });
    execFileSync('git', ['init', '-q', child]);
    execFileSync('git', ['-C', child, 'remote', 'add', 'origin', 'git@github.com:acme/app.git']);

    const res = await run(f, 'setup', ['--mode', 'workspace', '--remote', 'git@github.com:acme/app.git', '--yes']);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('project repositor');
  });

  test('refuses an unusable remote and a bad schedule', async () => {
    const f = bareFixture();
    expect((await run(f, 'setup', ['--remote', 'github.com/o/r', '--yes'])).exitCode).toBe(2);
    expect((await run(f, 'setup', ['--schedule', '99 * * * *', '--remote', f.bare, '--yes'])).exitCode).toBe(2);
  });

  test('will not prompt when stdin is not a terminal', async () => {
    const f = bareFixture();
    const res = await run(f, 'setup', ['--mode', 'workspace', '--schedule', '0 3 * * *']);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('--remote is required');
  });
});

describe('backup status', () => {
  test('prints a digest without touching the repo', async () => {
    const f = fixture();
    await run(f);
    const head = git(f.root, 'rev-parse', 'HEAD').trim();

    const res = await run(f, 'status');
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({ result: 'committed', mode: 'workspace' });
    expect(git(f.root, 'rev-parse', 'HEAD').trim()).toBe(head);
  });
});
