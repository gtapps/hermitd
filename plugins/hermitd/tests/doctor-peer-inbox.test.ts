import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { checkPeerInbox, resolvePaths } from '../scripts/doctor-check';
import { freshDirFactory } from './helpers/workdir';
import { localIdentity } from './helpers/registry-fixture';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');
const { freshDir, cleanup } = freshDirFactory('hermit-peer-inbox-');
afterAll(cleanup);

// Serial by necessity: the check resolves the registry through
// CLAUDE_CONFIG_DIR, which is process-global, and bunfig.toml's
// `concurrentTestGlob` would let each test's fixture clobber the others'
// (observed: every listening-socket case read an empty registry).
// `test.serial` restores per-test pairing — `describe.serial` is silently
// ignored (Bun 1.3.14/1.4.0).
const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
});

/** A live socket that accepts and ignores connections — the shape of a session's inbox. */
async function listeningSocket(dir: string): Promise<{ path: string; close: () => void }> {
  const p = path.join(dir, 'inbox.sock');
  const server = net.createServer(() => {});
  await new Promise<void>((resolve) => server.listen(p, resolve));
  return { path: p, close: () => server.close() };
}

/** The registry entry the check must accept: this process, valid on this host. */
function seedRegistry(configDir: string, patch: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(configDir, 'sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'sessions', `${process.pid}.json`),
    JSON.stringify({
      ...localIdentity(),
      kind: 'interactive',
      status: 'idle',
      statusUpdatedAt: Date.now(),
      cwd: '/tmp/project',
      name: 'hermit',
      messagingSocketPath: path.join(configDir, 'inbox.sock'),
      ...patch,
    }),
  );
}

/** Build a hermit fixture and run the check against it. */
async function scenario(opts: {
  runtime?: Record<string, unknown> | 'missing';
  registry?: Record<string, unknown> | 'none';
  config?: Record<string, unknown>;
  listen?: boolean;
  overlay?: Record<string, unknown>;
}) {
  const projectRoot = freshDir();
  const hermitDir = path.join(projectRoot, '.hermit');
  const stateDir = path.join(hermitDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const configDir = path.join(projectRoot, 'config-dir');
  fs.mkdirSync(configDir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = configDir;

  const sock = opts.listen ? await listeningSocket(configDir) : null;
  if (opts.registry !== 'none') seedRegistry(configDir, opts.registry ?? {});
  if (opts.runtime !== 'missing') {
    fs.writeFileSync(
      path.join(stateDir, 'runtime.json'),
      JSON.stringify({ session_pid: process.pid, ...(opts.runtime ?? {}) }),
    );
  }
  fs.writeFileSync(
    path.join(hermitDir, 'config.json'),
    JSON.stringify({ agent_name: 'hermit', ...(opts.config ?? {}) }),
  );
  if (opts.overlay) {
    fs.writeFileSync(path.join(stateDir, 'claude-settings.overlay.json'), JSON.stringify(opts.overlay));
  }

  try {
    return await checkPeerInbox(resolvePaths(hermitDir, PLUGIN_ROOT));
  } finally {
    sock?.close();
  }
}

describe('doctor peer-inbox', () => {
  test.serial('registered resident with a reachable inbox → ok', async () => {
    const r = await scenario({ listen: true });
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('inbox reachable');
  });

  test.serial('no session_pid stamp → warn, wake will type', async () => {
    const r = await scenario({ runtime: { session_pid: null }, listen: true });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('not registered yet');
  });

  test.serial('stamped pid has no live registry entry → warn', async () => {
    const r = await scenario({ registry: 'none', listen: true });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('no live registry entry');
  });

  test.serial.skipIf(process.platform !== 'linux')('resident registered from another pid namespace → ok, not checked', async () => {
    // What a sandboxed doctor run sees: the entry exists, but its pid domain is not ours.
    const r = await scenario({ registry: { pidDomain: 'linux:0000:pid:[4026999999]' }, listen: true });
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('another pid namespace');
  });

  test.serial('nothing listening on the inbox socket → warn', async () => {
    const r = await scenario({ listen: false });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('not accepting connections');
  });

  test.serial('registered under a different name than peer_name → warn', async () => {
    const r = await scenario({ runtime: { peer_name: 'scout' }, listen: true });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('registered as "hermit"');
  });

  // Without the overlay's `accept`, the wake is inert under bypassPermissions
  // whatever the socket says: the receiver holds an unauthenticated post behind a
  // dialog that expires unseen.
  test.serial('bypassPermissions hermit with no overlay accept → warn even with a reachable inbox', async () => {
    const r = await scenario({ config: { permission_mode: 'bypassPermissions' }, listen: true });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('bypassPermissions');
  });

  // The launch overlay is the one scope that can loosen the key, so once it
  // carries `accept` the wake lands and this warn would be a false alarm.
  test.serial('bypassPermissions hermit launched with the accept overlay → ok', async () => {
    const r = await scenario({
      config: { permission_mode: 'bypassPermissions' },
      overlay: { crossSessionInbound: 'accept' },
      listen: true,
    });
    expect(r.status).toBe('ok');
  });

  test.serial('no runtime.json at all → ok, nothing to diagnose', async () => {
    const r = await scenario({ runtime: 'missing', listen: true });
    expect(r.status).toBe('ok');
  });

  // Typing into the pane is a working fallback for every warn above, so no
  // condition here may escalate the whole doctor report to red.
  test.serial('never fails', async () => {
    for (const r of [
      await scenario({ listen: false }),
      await scenario({ registry: 'none' }),
      await scenario({ runtime: { session_pid: null } }),
    ]) {
      expect(r.status).not.toBe('fail');
    }
  });
});
