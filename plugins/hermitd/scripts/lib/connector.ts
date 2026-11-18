// Host-only connector store: the trusted server's code and settings (`sidecar/`), its
// database and admin handshake (`data/`), and the socket folder the agent mounts
// (`bridge/`). It lives under the host config dir, never under the project folder, so
// the agent can read neither the sign-in state nor the record, and cannot rewrite them.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { storeDir as hostStoreDir } from './credproxy';
import { tmuxSessionAlive } from './tmux';
import { writeFileAtomic } from './md-write';

export type ConnectorConfig = { port: number; public_url: string; wait_seconds: number; rate_per_hour: number };

export const DEFAULT_WAIT_SECONDS = 25;
export const MAX_WAIT_SECONDS = 200;
export const DEFAULT_RATE_PER_HOUR = 60;
const CONTAINER_SOCKET = '/run/hermit-connector/connector.sock';
const ADMIN_WAIT_MS = 5000;

/** Same naming and root as the credential proxy store, so one project names one store. */
export const storeDir = (project: string, configRoot?: string) => hostStoreDir(project, configRoot, 'connector');

const sidecarDir = (store: string) => path.join(store, 'sidecar');
const dataDir = (store: string) => path.join(store, 'data');
const bridgeDir = (store: string) => path.join(store, 'bridge');
export const socketPath = (store: string) => path.join(bridgeDir(store), 'connector.sock');
const configPath = (store: string) => path.join(sidecarDir(store), 'connector.json');
const adminDir = (store: string) => path.join(dataDir(store), 'admin');

/** Enabled means the trusted server's settings file exists; `disable` removes only that file. */
export const isEnabled = (store: string) => fs.existsSync(configPath(store));

export function readConfig(store: string): ConnectorConfig | null {
  try { return JSON.parse(fs.readFileSync(configPath(store), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('config_unreadable');
  }
}

/** Create the three folders with their modes and write the settings in place. */
export function writeConfig(store: string, config: ConnectorConfig): void {
  for (const [dir, mode] of [[store, 0o700], [sidecarDir(store), 0o700], [dataDir(store), 0o700], [adminDir(store), 0o700], [bridgeDir(store), 0o755]] as const) {
    fs.mkdirSync(dir, { recursive: true, mode });
    fs.chmodSync(dir, mode);
  }
  writeFileAtomic(configPath(store), JSON.stringify(config, null, 2) + '\n', 0o600);
}

export function disable(store: string): boolean {
  if (!isEnabled(store)) return false;
  fs.rmSync(configPath(store));
  return true;
}

/** Refresh the server copy beside its settings; nothing is written when the store is not enabled. */
export function render(store: string, gatewaySource: string): { status: 'rendered' } | { status: 'skipped'; reason: 'not_enabled' } {
  if (!isEnabled(store)) return { status: 'skipped', reason: 'not_enabled' };
  writeFileAtomic(path.join(sidecarDir(store), 'gateway.ts'), fs.readFileSync(gatewaySource, 'utf8'), 0o600);
  return { status: 'rendered' };
}

/**
 * Hand one admin request to the trusted server by atomic rename and wait for its
 * result file. The server is the only writer of the database; this never opens it.
 */
export async function adminRequest(store: string, request: object, waitMs = ADMIN_WAIT_MS): Promise<object> {
  const dir = adminDir(store);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = randomBytes(8).toString('hex');
  writeFileAtomic(path.join(dir, `${id}.request.json`), JSON.stringify(request), 0o600);
  const result = path.join(dir, `${id}.result.json`);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(result)) {
      const body = JSON.parse(fs.readFileSync(result, 'utf8'));
      fs.rmSync(result, { force: true });
      return body;
    }
    await Bun.sleep(100);
  }
  return { status: 'pending', reason: 'server_not_running' };
}

export const connectorSession = (resident: string) => `connector-${resident}`;

type HostDeps = { container: boolean; spawn?: typeof spawnSync; sessionAlive?: (name: string) => boolean; configRoot?: string };

/**
 * Before the resident launches: point the channel at the socket and, on a host
 * install with an enabled store, start the trusted server in its own detached tmux
 * session. A failed start warns once and never blocks the launch; nothing restarts a
 * server that dies later, the next start does.
 */
export function startConnector(project: string, resident: string, deps: HostDeps): void {
  delete process.env.HERMIT_CONNECTOR_SOCKET;
  if (deps.container) {
    if (fs.existsSync(path.dirname(CONTAINER_SOCKET))) process.env.HERMIT_CONNECTOR_SOCKET = CONTAINER_SOCKET;
    return;
  }
  try {
    const store = storeDir(project, deps.configRoot);
    if (!isEnabled(store)) return;
    process.env.HERMIT_CONNECTOR_SOCKET = socketPath(store);
    const session = connectorSession(resident);
    if ((deps.sessionAlive ?? tmuxSessionAlive)(session)) return;
    const gateway = path.join(import.meta.dir, '..', 'connector-gateway.ts');
    const result = (deps.spawn ?? spawnSync)('tmux', ['new-session', '-d', '-s', session, '-c', '/', process.execPath, gateway, store], { stdio: 'ignore' });
    if (result.error || result.status !== 0) throw new Error(result.error?.message ?? `tmux exited ${result.status}`);
  } catch (error) {
    console.log(`[hermit] WARNING: connector server did not start (${error instanceof Error ? error.message : error}); the agent starts without it.`);
  }
}

export function stopConnector(resident: string, spawn = spawnSync, sessionAlive: (name: string) => boolean = tmuxSessionAlive): void {
  const session = connectorSession(resident);
  if (sessionAlive(session)) spawn('tmux', ['kill-session', '-t', `=${session}`], { stdio: 'ignore' });
}

/** The trusted server's own status over the socket, or null when nothing answers. */
export async function serverStatus(store: string, timeoutMs = ADMIN_WAIT_MS): Promise<Record<string, unknown> | null> {
  if (!fs.existsSync(socketPath(store))) return null;
  try {
    const res = await fetch('http://connector/status', { unix: socketPath(store), signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() as Record<string, unknown> : null;
  } catch { return null; }
}
