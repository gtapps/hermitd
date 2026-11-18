#!/usr/bin/env bun
/**
 * Host-only connector commands, run by `hermitd connector` from the installed plugin
 * (never a project wrapper) and by the host lifecycle.
 *
 *   connector.ts enable <project> --port <n> --public-url <https url> [--wait-seconds n] [--rate-per-hour n]
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
import {
  DEFAULT_RATE_PER_HOUR, DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS, adminRequest, disable, isEnabled, readConfig,
  render, serverStatus, storeDir, writeConfig,
} from './lib/connector';

const APPLY = 'hermitd restart';
const GATEWAY = path.join(import.meta.dir, 'connector-gateway.ts');

function intFlag(args: string[], flag: string, min: number, max: number, fallback?: number): number {
  const raw = flagValue(args, flag);
  if (raw === undefined && fallback !== undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`invalid_${flag.slice(2).replace(/-/g, '_')}`);
  return value;
}

function publicUrl(raw: string | undefined): string {
  let url: URL;
  try { url = new URL(raw ?? ''); } catch { throw new Error('invalid_public_url'); }
  if (url.protocol !== 'https:' || url.search || url.hash || url.username || url.password) throw new Error('invalid_public_url');
  return url.toString().replace(/\/+$/, '');
}

function hostNetwork(project: string): boolean {
  return fs.existsSync(path.join(project, 'docker-compose.hermit.yml'))
    && readSettledConfig(path.join(project, '.hermit')).docker?.network_mode === 'host';
}

export async function run(argv: string[], container = isContainer, configRoot?: string): Promise<object> {
  const [sub, projectArg, ...args] = argv;
  if (container()) throw new Error('host_only');
  if (!projectArg) throw new Error('usage');
  const project = fs.realpathSync(projectArg);
  const store = storeDir(project, configRoot);

  if (sub === 'enable') {
    const previous = readConfig(store);
    const port = intFlag(args, '--port', 1, 65535, previous?.port);
    const url = publicUrl(flagValue(args, '--public-url') ?? previous?.public_url);
    const wait = intFlag(args, '--wait-seconds', 1, MAX_WAIT_SECONDS, previous?.wait_seconds ?? DEFAULT_WAIT_SECONDS);
    const rate = intFlag(args, '--rate-per-hour', 1, 10000, previous?.rate_per_hour ?? DEFAULT_RATE_PER_HOUR);
    if (hostNetwork(project)) throw new Error('host_network');
    assertOutside(store, project);
    writeConfig(store, { port, public_url: url, wait_seconds: wait, rate_per_hour: rate });
    render(store, GATEWAY);
    return { status: previous ? 'updated' : 'enabled', port, public_url: url, wait_seconds: wait, rate_per_hour: rate, apply: APPLY };
  }
  if (sub === 'disable') return disable(store) ? { status: 'disabled', apply: APPLY } : { status: 'skipped', reason: 'not_enabled' };
  if (sub === 'render') return render(store, GATEWAY);
  if (sub === 'status') {
    const config = readConfig(store);
    if (!config) return { enabled: false };
    const server = await serverStatus(store);
    return { enabled: true, ...config, server: server ? 'running' : 'not_running', ...(server ? { channel_connected: server.channel_connected, grants: server.grants } : {}) };
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
