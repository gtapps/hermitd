// Fake `claude` for `claude auth status`, answering the way Claude Code 2.1.323 was
// probed to (~/.agents/probe-results/cc-auth-status-login-shapes-2-1-323.md): a
// `.credentials.json` with a non-empty access token is a claude.ai login whose
// `loginExpiresAt` is its refreshTokenExpiresAt; a stub, an absent file or an
// unreadable one is logged out with exit 1. Tests drive it with the credential
// fixtures they already write, or override the reply with writeAuthStatusReply().
//
// Each call appends the env it saw to `.fake-auth-status.log` in the config dir, so a
// test can assert what the caller stripped or set.

import { afterAll, beforeAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPLY_FILE = '.fake-auth-status.json';
const LOG_FILE = '.fake-auth-status.log';

const SCRIPT = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
if (process.argv[2] !== 'auth' || process.argv[3] !== 'status') process.exit(0);
const dir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.claude');
try {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, '${LOG_FILE}'), JSON.stringify({
    config_dir_set: 'CLAUDE_CONFIG_DIR' in process.env,
    oauth_token: 'CLAUDE_CODE_OAUTH_TOKEN' in process.env,
    api_key: 'ANTHROPIC_API_KEY' in process.env,
  }) + '\\n');
} catch {}
try {
  const reply = JSON.parse(fs.readFileSync(path.join(dir, '${REPLY_FILE}'), 'utf8'));
  process.stdout.write(reply.stdout);
  process.exit(reply.code);
} catch {}
let token = '', rex = null;
try {
  const o = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8')).claudeAiOauth || {};
  token = typeof o.accessToken === 'string' ? o.accessToken : '';
  rex = typeof o.refreshTokenExpiresAt === 'number' ? o.refreshTokenExpiresAt : null;
} catch {}
if (!token) {
  process.stdout.write(JSON.stringify({ loggedIn: false, authMethod: 'none', loginExpiresAt: null }));
  process.exit(1);
}
process.stdout.write(JSON.stringify({
  loggedIn: true, authMethod: 'claude.ai',
  loginExpiresAt: rex === null ? null : new Date(rex).toISOString(),
}));
`;

/** Install the fake as `claude` in binDir, which the test puts first on PATH. */
export function installFakeClaude(binDir: string): string {
  fs.mkdirSync(binDir, { recursive: true });
  const bin = path.join(binDir, 'claude');
  fs.writeFileSync(bin, SCRIPT, { mode: 0o755 });
  return bin;
}

/** Put the fake first on PATH for the enclosing describe (or file), so the real CLI is
 *  never spawned; subprocesses inherit it through process.env. */
export function useFakeClaude(): void {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-fake-claude-'));
  installFakeClaude(binDir);
  const saved = process.env.PATH;
  beforeAll(() => { process.env.PATH = `${binDir}:${saved}`; });
  afterAll(() => {
    process.env.PATH = saved;
    fs.rmSync(binDir, { recursive: true, force: true });
  });
}

/** Override the next replies in configDir: raw stdout and exit code. */
export function writeAuthStatusReply(configDir: string, code: number, stdout: string): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, REPLY_FILE), JSON.stringify({ code, stdout }));
}

/** The env each call saw, oldest first. */
export function authStatusCalls(configDir: string): Array<{ config_dir_set: boolean; oauth_token: boolean; api_key: boolean }> {
  try {
    return fs.readFileSync(path.join(configDir, LOG_FILE), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
