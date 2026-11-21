#!/usr/bin/env bun
/**
 * Host-only connector commands, run by `hermitd connector` from the installed plugin
 * (never a project wrapper) and by the host lifecycle.
 *
 *   connector.ts enable <project> --public-url <https url> [--port n] [--wait-seconds n] [--rate-per-hour n]
 *   connector.ts disable <project>
 *   connector.ts status <project>
 *   connector.ts pair <project> <code> [--name <label>]
 *   connector.ts list <project>
 *   connector.ts revoke <project> <grant id>
 *   connector.ts render <project>
 *
 * Every subcommand prints one JSON object.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isContainer } from './lib/container';
import { failJson, flagValue, printJson } from './lib/cli';
import { assertOutside } from './lib/credproxy';
import { readSettledConfig } from './lib/config-read';
import { acquireLockWithWait, releaseLock } from './lib/lockfile';
import {
  DEFAULT_RATE_PER_HOUR, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS, adminRequest, disable, isEnabled, readConfig,
  render, serverStatus, storeDir, writeConfig,
} from './lib/connector';

const APPLY = 'hermitd restart';
const GATEWAY = path.join(import.meta.dir, 'connector-gateway.ts');
const STORE_LOCK_WAIT_MS = 1000;
const FIRST_AUTO_PORT = 8790;
const MAX_PORT = 65535;

function intFlag(args: string[], flag: string, min: number, max: number, fallback?: number): number {
  const raw = flagValue(args, flag);
  if (raw === undefined && fallback !== undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`invalid_${flag.slice(2).replace(/-/g, '_')}`);
  return value;
}

function publicUrl(raw: string | undefined): string {
  const url = URL.parse(raw ?? '');
  if (!url || url.protocol !== 'https:' || url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('invalid_public_url');
  }
  return url.origin;
}

function portFree(port: number): boolean {
  try {
    const listener = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } });
    listener.stop(true);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    return false;
  }
}

function withStoreLock(root: string, update: () => object): object {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = root + '.lock';
  if (!acquireLockWithWait(lock, STORE_LOCK_WAIT_MS)) throw new Error('connector_store_busy');
  try { return update(); }
  finally { releaseLock(lock); }
}

function siblingClaims(root: string, store: string) {
  const ports = new Set<number>();
  const origins = new Set<string>();
  for (const name of fs.readdirSync(root)) {
    const sibling = path.join(root, name);
    if (sibling === store) continue;
    let config;
    try { config = readConfig(sibling); }
    catch { continue; }
    if (!config) continue;
    ports.add(config.port);
    const url = URL.parse(config.public_url);
    if (url) origins.add(url.origin);
  }
  return { ports, origins };
}

function hostNetwork(project: string): boolean {
  return fs.existsSync(path.join(project, 'docker-compose.hermit.yml'))
    && readSettledConfig(path.join(project, '.hermit')).docker?.network_mode === 'host';
}

export async function run(argv: string[], container = isContainer, configRoot?: string, probe = portFree): Promise<object> {
  const [sub, projectArg, ...args] = argv;
  if (container()) throw new Error('host_only');
  if (!projectArg) throw new Error('usage');
  const project = fs.realpathSync(projectArg);
  const store = storeDir(project, configRoot);
  const root = path.dirname(store);

  if (sub === 'enable') {
    if (hostNetwork(project)) throw new Error('host_network');
    assertOutside(store, project);
    const server = await serverStatus(store);
    return withStoreLock(root, () => {
      const previous = readConfig(store);
      const url = publicUrl(flagValue(args, '--public-url') ?? previous?.public_url);
      const wait = intFlag(args, '--wait-seconds', 1, MAX_WAIT_SECONDS, previous?.wait_seconds ?? DEFAULT_WAIT_SECONDS);
      const rate = intFlag(args, '--rate-per-hour', 1, 10000, previous?.rate_per_hour ?? DEFAULT_RATE_PER_HOUR);
      const { ports, origins } = siblingClaims(root, store);
      let port = args.includes('--port') ? intFlag(args, '--port', 1, MAX_PORT) : previous?.port;
      if (port !== undefined) {
        if (ports.has(port)) return { status: 'refused', reason: 'port_used_by_other_agent' };
        if (server?.port !== port && !probe(port)) return { status: 'refused', reason: 'port_in_use' };
      }
      if (origins.has(url)) return { status: 'refused', reason: 'public_url_used_by_other_agent' };
      if (port === undefined) {
        for (let candidate = FIRST_AUTO_PORT; candidate <= MAX_PORT; candidate++) {
          if (ports.has(candidate) || !probe(candidate)) continue;
          port = candidate;
          break;
        }
        if (port === undefined) throw new Error('no_free_port');
      }
      const config = { port, public_url: url, wait_seconds: wait, rate_per_hour: rate };
      writeConfig(store, config);
      render(store, GATEWAY);
      return { status: previous ? 'updated' : 'enabled', ...config, apply: APPLY };
    });
  }
  if (sub === 'disable') {
    assertOutside(store, project);
    return withStoreLock(root, () => disable(store)
      ? { status: 'disabled', apply: APPLY }
      : { status: 'skipped', reason: 'not_enabled' });
  }
  if (sub === 'render') return render(store, GATEWAY);
  if (sub === 'status') {
    const config = readConfig(store);
    if (!config) return { enabled: false };
    const server = await serverStatus(store);
    if (!server) return { enabled: true, ...config, server: 'not_running' };
    return {
      enabled: true, ...config, server: 'running', port: server.port ?? config.port,
      channel: server.channel, unanswered: server.unanswered, oldest_unanswered_at: server.oldest_unanswered_at,
      grants: server.grants,
    };
  }
  if (!isEnabled(store)) return { status: 'refused', reason: 'not_enabled' };
  if (sub === 'pair') {
    const code = String(args[0] ?? '').trim().toUpperCase();
    if (!code || code.startsWith('-')) throw new Error('usage');
    const name = flagValue(args, '--name');
    return adminRequest(store, { kind: 'pair', code, ...(name ? { name } : {}) });
  }
  if (sub === 'list') return adminRequest(store, { kind: 'list' });
  if (sub === 'revoke') {
    if (!args[0]) throw new Error('usage');
    return adminRequest(store, { kind: 'revoke', id: args[0] });
  }
  throw new Error('usage');
}

if (import.meta.main) {
  try {
    printJson(await run(process.argv.slice(2)));
  } catch (error) { failJson(error, 'connector_failed'); }
}
