// Launch stamp in startup-context.ts's SessionStart injection.
// Verifies: the managed session records the config dir and auth-env shape it
// actually resolved into state/runtime.json, an unmanaged session records
// nothing, and no credential value is ever written.
//
// Why the hook and not hermitd-start: the watchdog that later reads these fields
// runs from a systemd unit / launchd job / cron entry carrying only PATH, and a
// CLAUDE_CONFIG_DIR set in user or managed settings never passes through
// hermitd-start's environment at all. Only a process inside the session sees it.
//
// Usage: bun test tests/startup-context-stamp.test.ts   (from the plugin root)

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { setupWorkdir } from './helpers/workdir';
import { writeRegistryEntry } from './helpers/registry-fixture';

const API_KEY = 'sk-ant-api03-fixture-value';

function runtimePath(dir: string): string {
  return path.join(dir, '.hermit', 'state', 'runtime.json');
}

function seedRuntime(dir: string, patch: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    runtimePath(dir),
    JSON.stringify({ version: 1, tmux_session: null, ...patch }),
  );
}


const readRuntime = (dir: string) => JSON.parse(fs.readFileSync(runtimePath(dir), 'utf-8'));

// runScript inherits process.env, so every variable the stamp reads is blanked
// first: a `bun test` run from inside a managed hermit pane carries HERMIT_MANAGED=1
// (which would make the unmanaged fixture stamp) and a developer's own shell may
// carry any of the auth vars (which would make env_auth true against expectation).
const BLANK_ENV = {
  HERMIT_MANAGED: '',
  CLAUDE_CONFIG_DIR: '',
  CLAUDE_CODE_MESSAGING_SOCKET: '',
  ANTHROPIC_API_KEY: '',
  ANTHROPIC_AUTH_TOKEN: '',
  CLAUDE_CODE_USE_BEDROCK: '',
  CLAUDE_CODE_USE_VERTEX: '',
  CLAUDE_CODE_USE_FOUNDRY: '',
};

async function run(dir: string, env: Record<string, string>, sessionId?: string) {
  return runScript('startup-context.ts', {
    stdin: JSON.stringify({ source: 'startup', ...(sessionId ? { session_id: sessionId } : {}) }),
    env: { AGENT_DIR: path.join(dir, '.hermit'), ...BLANK_ENV, ...env },
  });
}

describe('startup-context.ts — session launch stamp', () => {
  it('managed session records its config dir and auth-env shape, never the secret', async () => {
    const wd = setupWorkdir();
    try {
      seedRuntime(wd.dir);
      const configDir = path.join(wd.dir, 'session-config');
      const res = await run(wd.dir, {
        HERMIT_MANAGED: '1',
        CLAUDE_CONFIG_DIR: configDir,
        ANTHROPIC_API_KEY: API_KEY,
      });
      expect(res.exitCode).toBe(0);
      const runtime = readRuntime(wd.dir);
      expect(runtime.config_dir).toBe(configDir);
      expect(runtime.env_auth).toBe(true);
      // Lifecycle fields survive the read-modify-write.
      expect(runtime.version).toBe(1);
      expect(fs.readFileSync(runtimePath(wd.dir), 'utf-8')).not.toContain(API_KEY);
    } finally {
      wd.cleanup();
    }
  });

  // The watchdog wakes the resident over this socket instead of typing into its
  // pane, so the path has to reach runtime.json from inside the session — it is
  // never visible to hermitd-start or to the cron-launched watchdog.
  it('managed session records its inbox socket and its own pid', async () => {
    const wd = setupWorkdir();
    try {
      seedRuntime(wd.dir);
      const sock = path.join(wd.dir, 'inbox.sock');
      const res = await run(wd.dir, {
        HERMIT_MANAGED: '1',
        CLAUDE_CODE_MESSAGING_SOCKET: sock,
      });
      expect(res.exitCode).toBe(0);
      const runtime = readRuntime(wd.dir);
      expect(runtime.inbox_socket).toBe(sock);
      // ppid of the spawned hook is this test process — the stand-in for claude.
      expect(runtime.session_pid).toBe(process.pid);
    } finally {
      wd.cleanup();
    }
  });

  // Older Claude Code exports no socket. The field must still be written (as
  // null) so the watchdog reads "no inbox" rather than "stale value from a
  // previous launch" and falls back to typing.
  it('no socket in the environment → inbox_socket is null, not stale', async () => {
    const wd = setupWorkdir();
    try {
      seedRuntime(wd.dir);
      fs.writeFileSync(
        runtimePath(wd.dir),
        JSON.stringify({ ...readRuntime(wd.dir), inbox_socket: '/run/user/1000/cc-socks/old.sock' }),
      );
      const res = await run(wd.dir, { HERMIT_MANAGED: '1' });
      expect(res.exitCode).toBe(0);
      expect(readRuntime(wd.dir).inbox_socket).toBeNull();
    } finally {
      wd.cleanup();
    }
  });

  // hermitd-start writes peer_name at boot, seconds before this hook runs. Both
  // sides read-modify-write, so the later write must carry the earlier's fields.
  it('peer_name written by hermitd-start survives the stamp', async () => {
    const wd = setupWorkdir();
    try {
      fs.writeFileSync(
        runtimePath(wd.dir),
        JSON.stringify({ version: 1, tmux_session: 'hermit-x', peer_name: 'Atlas' }),
      );
      const res = await run(wd.dir, {
        HERMIT_MANAGED: '1',
        CLAUDE_CODE_MESSAGING_SOCKET: path.join(wd.dir, 'inbox.sock'),
      });
      expect(res.exitCode).toBe(0);
      const runtime = readRuntime(wd.dir);
      expect(runtime.peer_name).toBe('Atlas');
      expect(runtime.tmux_session).toBe('hermit-x');
      expect(runtime.inbox_socket).toBeTruthy();
    } finally {
      wd.cleanup();
    }
  });

  // Claude Code keeps .claude.json under CLAUDE_CONFIG_DIR whenever it is set, so
  // recording the resolved default would make a watchdog restart export it and
  // boot against a fresh state file. Unset stays unset, and a stale stamp clears.
  it('no config dir in the environment → nothing recorded, stale stamp cleared', async () => {
    const wd = setupWorkdir();
    try {
      seedRuntime(wd.dir, { config_dir: path.join(wd.dir, '.claude') });
      const res = await run(wd.dir, {
        HERMIT_MANAGED: '1',
        HOME: wd.dir,
        CLAUDE_CONFIG_DIR: '',
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: '',
      });
      expect(res.exitCode).toBe(0);
      const runtime = readRuntime(wd.dir);
      expect('config_dir' in runtime).toBe(false);
      expect(runtime.env_auth).toBe(false);
    } finally {
      wd.cleanup();
    }
  });

  it('an explicitly set default config dir is still recorded', async () => {
    const wd = setupWorkdir();
    try {
      seedRuntime(wd.dir);
      const configDir = path.join(wd.dir, '.claude');
      const res = await run(wd.dir, { HERMIT_MANAGED: '1', HOME: wd.dir, CLAUDE_CONFIG_DIR: configDir });
      expect(res.exitCode).toBe(0);
      expect(readRuntime(wd.dir).config_dir).toBe(configDir);
    } finally {
      wd.cleanup();
    }
  });

  // A compaction fires SessionStart too. Re-stamping identical values would move
  // updated_at, and doctor reads that as proof the session is doing work — so a
  // wedged hermit that keeps auto-compacting would stop looking stale.
  it('unchanged values → the record is left alone, updated_at does not move', async () => {
    const wd = setupWorkdir();
    try {
      seedRuntime(wd.dir);
      const env = { HERMIT_MANAGED: '1', CLAUDE_CONFIG_DIR: path.join(wd.dir, 'session-config') };
      expect((await run(wd.dir, env)).exitCode).toBe(0);
      const first = readRuntime(wd.dir);
      expect(first.updated_at).toBeTruthy();

      fs.writeFileSync(runtimePath(wd.dir), JSON.stringify({ ...first, updated_at: 'sentinel' }));
      expect((await run(wd.dir, env)).exitCode).toBe(0);
      expect(readRuntime(wd.dir).updated_at).toBe('sentinel');
    } finally {
      wd.cleanup();
    }
  });

  // A hand-launched session in the same folder must not overwrite the record
  // describing the managed one — the watchdog only ever diagnoses the latter.
  it('unmanaged session stamps nothing', async () => {
    const wd = setupWorkdir();
    try {
      seedRuntime(wd.dir);
      const res = await run(wd.dir, {
        CLAUDE_CONFIG_DIR: path.join(wd.dir, 'guest-config'),
        ANTHROPIC_API_KEY: API_KEY,
      });
      expect(res.exitCode).toBe(0);
      const runtime = readRuntime(wd.dir);
      expect(runtime.config_dir).toBeUndefined();
      expect(runtime.env_auth).toBeUndefined();
    } finally {
      wd.cleanup();
    }
  });

  // Issue #916: the hygiene tiers had no way to tell the resident's own context from any
  // other session's in the folder. The identity must survive context changes.
  // Under HERMIT_MANAGED this hook IS the resident, so its payload id is the exact answer.
  it('managed session records its own Claude Code session id', async () => {
    const wd = setupWorkdir();
    try {
      seedRuntime(wd.dir);
      const res = await run(wd.dir, { HERMIT_MANAGED: '1' }, 'cc-resident-abc');
      expect(res.exitCode).toBe(0);
      expect(readRuntime(wd.dir).cc_session_id).toBe('cc-resident-abc');
    } finally {
      wd.cleanup();
    }
  });

  // /clear mints a new session id. The stamp's no-op guard must not treat that as
  // "nothing moved", or the tiers keep reading the dead session's rows forever.
  it('a new session id replaces the previous one', async () => {
    const wd = setupWorkdir();
    try {
      seedRuntime(wd.dir);
      await run(wd.dir, { HERMIT_MANAGED: '1' }, 'cc-old');
      const res = await run(wd.dir, { HERMIT_MANAGED: '1' }, 'cc-new');
      expect(res.exitCode).toBe(0);
      expect(readRuntime(wd.dir).cc_session_id).toBe('cc-new');
    } finally {
      wd.cleanup();
    }
  });

  // A guest carries no HERMIT_MANAGED, so it must never claim the resident's identity.
  it('unmanaged session never stamps a session id over the resident\'s', async () => {
    const wd = setupWorkdir();
    try {
      seedRuntime(wd.dir);
      await run(wd.dir, { HERMIT_MANAGED: '1' }, 'cc-resident-abc');
      const res = await run(wd.dir, {}, 'cc-guest-xyz');
      expect(res.exitCode).toBe(0);
      expect(readRuntime(wd.dir).cc_session_id).toBe('cc-resident-abc');
    } finally {
      wd.cleanup();
    }
  });

  // HERMIT_MANAGED is an exported shell variable, so a `claude` the resident launches from
  // its own pane inherits it and would otherwise repoint every stamped field at itself —
  // leaving the hygiene tiers reading a dead child's frozen row. The discriminator is pid
  // identity, which env inheritance cannot fake. runScript spawns the hook directly, so the
  // hook's ppid is this test process (process.pid); process.ppid is therefore a live pid
  // that is NOT the hook's parent, i.e. exactly the nested-session shape.
  it('a live incumbent at another pid blocks the stamp', async () => {
    const wd = setupWorkdir();
    try {
      const configDir = path.join(wd.dir, 'cc-config');
      writeRegistryEntry(configDir, process.ppid);
      seedRuntime(wd.dir, {
        config_dir: configDir,
        session_pid: process.ppid,
        cc_session_id: 'cc-resident-abc',
        inbox_socket: '/run/resident.sock',
      });
      const res = await run(wd.dir, { HERMIT_MANAGED: '1', CLAUDE_CODE_MESSAGING_SOCKET: '/run/nested.sock' }, 'cc-nested');
      expect(res.exitCode).toBe(0);
      const runtime = readRuntime(wd.dir);
      expect(runtime.cc_session_id).toBe('cc-resident-abc');
      expect(runtime.session_pid).toBe(process.ppid);
      expect(runtime.inbox_socket).toBe('/run/resident.sock');
    } finally {
      wd.cleanup();
    }
  });

  // The incumbent restamping itself is the resume/compact/clear path, which must keep
  // working — the gate is about who, not about freezing the record.
  it('the incumbent itself still restamps', async () => {
    const wd = setupWorkdir();
    try {
      const configDir = path.join(wd.dir, 'cc-config');
      writeRegistryEntry(configDir, process.pid);
      seedRuntime(wd.dir, { config_dir: configDir, session_pid: process.pid, cc_session_id: 'cc-old' });
      const res = await run(wd.dir, { HERMIT_MANAGED: '1' }, 'cc-new');
      expect(res.exitCode).toBe(0);
      expect(readRuntime(wd.dir).cc_session_id).toBe('cc-new');
    } finally {
      wd.cleanup();
    }
  });

  // A restarted resident finds its predecessor's pid recorded but dead. The registry drops
  // it, so the new session stamps freely — otherwise a reboot would leave the hermit
  // permanently unidentified to the hygiene tiers.
  it('a dead incumbent does not pin the stamp', async () => {
    const wd = setupWorkdir();
    try {
      const configDir = path.join(wd.dir, 'cc-config');
      fs.mkdirSync(path.join(configDir, 'sessions'), { recursive: true });
      seedRuntime(wd.dir, { config_dir: configDir, session_pid: 4_194_304, cc_session_id: 'cc-predecessor' });
      const res = await run(wd.dir, { HERMIT_MANAGED: '1' }, 'cc-fresh');
      expect(res.exitCode).toBe(0);
      expect(readRuntime(wd.dir).cc_session_id).toBe('cc-fresh');
    } finally {
      wd.cleanup();
    }
  });

  // runtime.json is hermitd-start's to create; a hook must never conjure a
  // lifecycle record that would make a never-booted project look live.
  it('no runtime.json → none is created', async () => {
    const wd = setupWorkdir();
    try {
      const res = await run(wd.dir, { HERMIT_MANAGED: '1', CLAUDE_CONFIG_DIR: wd.dir });
      expect(res.exitCode).toBe(0);
      expect(fs.existsSync(runtimePath(wd.dir))).toBe(false);
    } finally {
      wd.cleanup();
    }
  });
});
