#!/usr/bin/env bun
/**
 * Host-only credential proxy commands, run by `hermitd credproxy` from the installed plugin
 * (never a project wrapper) and by hermitd-docker.sh at start, restart and update.
 *
 *   credproxy.ts map <project> <host> --header <name> --secret <name> [--prefix <text>] [--basic-user <user>]
 *   credproxy.ts unmap <project> <host> [--header <name>]
 *   credproxy.ts status <project>
 *   credproxy.ts set <project> <secret>     value from the terminal (echo off) or stdin
 *   credproxy.ts unset <project> <secret>
 *   credproxy.ts render <project>
 *
 * Every subcommand prints one JSON object. No output carries a secret value.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isContainer } from './lib/container';
import { failJson, flagValue, printJson, readStdin } from './lib/cli';
import {
  type Binding, assertOutside, deleteSecret, hasValue, normalizeHost, readBindings, removeBindings, render,
  scrubConfig, storeDir, upsertBinding, validHeader, validSecretName, validText, writeBindings, writeSecret,
} from './lib/credproxy';

const APPLY = 'hermitd restart';

/** Read a value from the terminal with echo off; Enter ends it, Ctrl-C cancels. */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stderr.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    let value = '';
    const done = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
    stdin.resume();
  });
}

async function readValue(name: string): Promise<string> {
  if (process.stdin.isTTY) return readHidden(`Value for ${name} (not shown): `);
  return (await readStdin()).replace(/\r?\n$/, '');
}

export async function run(argv: string[], container = isContainer): Promise<object> {
  const [sub, projectArg, ...args] = argv;
  if (container()) throw new Error('host_only');
  if (!projectArg) throw new Error('usage');
  const project = fs.realpathSync(projectArg);
  if (!fs.existsSync(path.join(project, 'docker-compose.hermit.yml'))) throw new Error('docker_only');
  const store = storeDir(project);

  if (sub === 'status') {
    return { bindings: readBindings(store).map(b => ({ host: b.host, header: b.header, secret: b.secret, has_value: hasValue(store, b.secret) })) };
  }
  if (sub === 'map') {
    const host = normalizeHost(args[0]);
    const header = flagValue(args, '--header');
    const secret = flagValue(args, '--secret');
    const prefix = flagValue(args, '--prefix');
    const user = flagValue(args, '--basic-user');
    if (!host) throw new Error('invalid_host');
    if (!header || !validHeader(header)) throw new Error('invalid_header');
    if (!secret || !validSecretName(secret)) throw new Error('invalid_secret_name');
    if (prefix !== undefined && user !== undefined) throw new Error('prefix_and_basic_user');
    if ((prefix !== undefined && !validText(prefix)) || (user !== undefined && (!validText(user) || user.includes(':')))) throw new Error('invalid_value');
    const binding: Binding = { host, header, secret, ...(prefix !== undefined ? { prefix } : {}), ...(user !== undefined ? { basic_user: user } : {}) };
    assertOutside(store, project);
    writeBindings(store, project, upsertBinding(readBindings(store), binding));
    scrubConfig(store);
    return { status: 'mapped', host, header, secret, has_value: hasValue(store, secret), apply: APPLY };
  }
  if (sub === 'unmap') {
    const host = normalizeHost(args[0]);
    if (!host) throw new Error('invalid_host');
    const header = flagValue(args, '--header');
    const before = readBindings(store);
    const after = removeBindings(before, host, header);
    if (after.length !== before.length) { writeBindings(store, project, after); scrubConfig(store); }
    return { status: 'unmapped', host, removed: before.length - after.length, apply: APPLY };
  }
  if (sub === 'set' || sub === 'unset') {
    const name = args[0];
    if (!name || !validSecretName(name)) throw new Error('invalid_secret_name');
    if (sub === 'unset') { deleteSecret(store, name); scrubConfig(store); return { status: 'unset', secret: name, apply: APPLY }; }
    const value = await readValue(name);
    if (!value) throw new Error('empty_value');
    if (!validText(value)) throw new Error('invalid_value');
    assertOutside(store, project);
    writeSecret(store, name, value);
    scrubConfig(store);
    return { status: 'set', secret: name, apply: APPLY };
  }
  if (sub === 'render') return render(store, project);
  throw new Error('usage');
}

if (import.meta.main) {
  try {
    printJson(await run(process.argv.slice(2)));
  } catch (error) { failJson(error, 'credproxy_failed'); }
}
