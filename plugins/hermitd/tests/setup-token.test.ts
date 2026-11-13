// Long-lived setup-token storage, expiry record, and the doctor probe.

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript } from './helpers/run';
import { authStatusCalls, useFakeClaude, writeAuthStatusReply } from './helpers/auth-status';
import {
  credentialsFilePath,
  detectAuthModeFromVolume,
  installToken,
  isPlausibleToken,
  loginStatus,
  msUntilExpiry,
  resolveAuthMode,
  readTokenRecord,
  readTokenValue,
  tokenFilePath,
  tokenModeActive,
  TOKEN_ENV_VAR,
} from '../scripts/lib/setup-token';

const VALID = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789';

// Every login check here goes through a fake `claude` that answers `auth status` the
// way Claude Code does (tests/helpers/auth-status.ts).
useFakeClaude();

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-token-test-'));
}

function withDirs<T>(fn: (hermitDir: string, configDir: string) => T): () => T {
  return () => {
    const root = tmpdir();
    try {
      const hermitDir = path.join(root, '.hermit');
      const configDir = path.join(root, 'config');
      fs.mkdirSync(hermitDir, { recursive: true });
      fs.mkdirSync(configDir, { recursive: true });
      return fn(hermitDir, configDir);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

describe('token storage', () => {
  test('installs the token 0600 and writes a 1-year record', withDirs((hermitDir, configDir) => {
    const before = Date.now();
    const record = installToken(hermitDir, configDir, VALID);

    expect(readTokenValue(configDir)).toBe(VALID);

    // The token is a bearer credential sitting on a shared volume; anything
    // group- or world-readable here is a real leak.
    const mode = fs.statSync(tokenFilePath(configDir)).mode & 0o777;
    expect(mode).toBe(0o600);

    const ttlDays = (Date.parse(record.expires_at) - Date.parse(record.minted_at)) / 86400000;
    expect(Math.round(ttlDays)).toBe(365);
    expect(Date.parse(record.minted_at)).toBeGreaterThanOrEqual(before - 1000);
  }));

  test('the record round-trips and reports remaining time', withDirs((hermitDir, configDir) => {
    installToken(hermitDir, configDir, VALID);
    const record = readTokenRecord(hermitDir);
    expect(record).not.toBeNull();
    const left = msUntilExpiry(hermitDir);
    expect(left).not.toBeNull();
    expect(left! / 86400000).toBeGreaterThan(360);
  }));

  test('the record never contains the token', withDirs((hermitDir, configDir) => {
    installToken(hermitDir, configDir, VALID);
    const raw = fs.readFileSync(path.join(hermitDir, 'state', 'setup-token.json'), 'utf8');
    expect(raw).not.toContain(VALID);
  }));

  test('a re-install overwrites cleanly and moves expiry forward', withDirs((hermitDir, configDir) => {
    const first = installToken(hermitDir, configDir, VALID);
    const second = installToken(hermitDir, configDir, `${VALID}-two`);
    expect(readTokenValue(configDir)).toBe(`${VALID}-two`);
    expect(Date.parse(second.expires_at)).toBeGreaterThanOrEqual(Date.parse(first.expires_at));
    // No .tmp litter left behind by the atomic write.
    expect(fs.existsSync(`${tokenFilePath(configDir)}.tmp`)).toBe(false);
  }));

  test('absent or malformed record reads as null, never as expired', withDirs((hermitDir) => {
    expect(readTokenRecord(hermitDir)).toBeNull();
    expect(msUntilExpiry(hermitDir)).toBeNull();
    fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(hermitDir, 'state', 'setup-token.json'), '{not json');
    expect(readTokenRecord(hermitDir)).toBeNull();
    fs.writeFileSync(path.join(hermitDir, 'state', 'setup-token.json'), JSON.stringify({ expires_at: 'soon' }));
    expect(readTokenRecord(hermitDir)).toBeNull();
  }));
});

describe('stored credentials on install', () => {
  // Claude Code keeps a user-supplied env token ahead of a stored /login, and the
  // same file carries remote MCP servers' OAuth tokens, so installing a token
  // leaves it exactly as it was.
  test('install leaves an existing .credentials.json untouched', withDirs((hermitDir, configDir) => {
    const cred = JSON.stringify({
      claudeAiOauth: { accessToken: 'stored', expiresAt: 1 },
      mcpOAuth: { 'trello|abc': { accessToken: 'mcp-a', refreshToken: 'mcp-r' } },
    });
    fs.writeFileSync(credentialsFilePath(configDir), cred);
    installToken(hermitDir, configDir, VALID);
    expect(fs.readFileSync(credentialsFilePath(configDir), 'utf8')).toBe(cred);
    expect(readTokenValue(configDir)).toBe(VALID);
  }));
});

describe('token shape validation', () => {
  // The mint driver scrapes a terminal pane, so the realistic failure is
  // capturing prose or a truncated fragment. Installing either takes the hermit
  // dark, so refuse at the door.
  test('rejects implausible values', () => {
    expect(isPlausibleToken(VALID)).toBe(true);
    expect(isPlausibleToken('')).toBe(false);
    expect(isPlausibleToken('sk-ant-short')).toBe(false);
    expect(isPlausibleToken('Paste code here if prompted >')).toBe(false);
    expect(isPlausibleToken('sk-ant-oat01-abcdefghij klmnopqrstuvwxyz')).toBe(false);
    expect(isPlausibleToken('ghp_abcdefghijklmnopqrstuvwxyz0123')).toBe(false);
  });

  test('install refuses an implausible token', withDirs((hermitDir, configDir) => {
    expect(() => installToken(hermitDir, configDir, 'not a token')).toThrow();
    expect(readTokenValue(configDir)).toBeNull();
    expect(readTokenRecord(hermitDir)).toBeNull();
  }));
});

describe('auth-mode detection', () => {
  test('file presence alone means token mode', withDirs((hermitDir, configDir) => {
    const saved = process.env[TOKEN_ENV_VAR];
    delete process.env[TOKEN_ENV_VAR];
    try {
      expect(tokenModeActive(configDir)).toBe(false);
      installToken(hermitDir, configDir, VALID);
      // The docker entrypoint runs before anything exports the env var, so the
      // file has to be sufficient on its own.
      expect(tokenModeActive(configDir)).toBe(true);
    } finally {
      if (saved !== undefined) process.env[TOKEN_ENV_VAR] = saved;
    }
  }));

  test('env var alone means token mode', withDirs((_hermitDir, configDir) => {
    const saved = process.env[TOKEN_ENV_VAR];
    process.env[TOKEN_ENV_VAR] = VALID;
    try {
      expect(tokenModeActive(configDir)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env[TOKEN_ENV_VAR];
      else process.env[TOKEN_ENV_VAR] = saved;
    }
  }));
});

describe('doctor expiry probe', () => {
  // The probe is argument-free in hermit-meta.json, so a fixture is pointed at the
  // same way doctor points at the real thing: both dirs come from the child env.
  // CLAUDE_CONFIG_DIR is load-bearing here — without it the probe resolves the auth
  // mode from the test runner's own ~/.claude and the verdict stops being about the
  // fixture at all.
  const rawProbe = (hermitDir: string, configDir: string) =>
    runScript('setup-token-mint.ts', {
      args: ['probe'],
      env: { HERMIT_DIR: hermitDir, CLAUDE_CONFIG_DIR: configDir },
    });
  const probe = async (hermitDir: string, configDir: string) =>
    (await rawProbe(hermitDir, configDir)).stdout.trim();

  const withFixture = (fn: (hermitDir: string, configDir: string) => Promise<void>) => async () => {
    const root = tmpdir();
    try {
      const hermitDir = path.join(root, '.hermit');
      const configDir = path.join(root, 'config');
      fs.mkdirSync(hermitDir, { recursive: true });
      fs.mkdirSync(configDir, { recursive: true });
      await fn(hermitDir, configDir);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };

  const writeLogin = (configDir: string, oauth: Record<string, unknown>) =>
    fs.writeFileSync(credentialsFilePath(configDir), JSON.stringify({ claudeAiOauth: oauth }));

  test('token mode, record present → EXPIRES:<iso> matching the record', withFixture(async (hermitDir, configDir) => {
    const record = installToken(hermitDir, configDir, VALID);
    expect(await probe(hermitDir, configDir)).toBe(`EXPIRES:${record.expires_at}`);
  }));

  test('token mode with no record → OK (nothing to check is not a problem)', withFixture(async (hermitDir, configDir) => {
    fs.writeFileSync(tokenFilePath(configDir), `${VALID}\n`, { mode: 0o600 });
    expect(await probe(hermitDir, configDir)).toBe('OK');
  }));

  test('login mode, usable credential → EXPIRES: from refreshTokenExpiresAt', withFixture(async (hermitDir, configDir) => {
    const at = Date.now() + 30 * 24 * 3600_000;
    writeLogin(configDir, { accessToken: 'a', refreshToken: 'r', refreshTokenExpiresAt: at });
    expect(await probe(hermitDir, configDir)).toBe(`EXPIRES:${new Date(at).toISOString()}`);
  }));

  test('login mode, usable credential without the field → OK', withFixture(async (hermitDir, configDir) => {
    writeLogin(configDir, { accessToken: 'a', refreshToken: 'r' });
    expect(await probe(hermitDir, configDir)).toBe('OK');
  }));

  test('login mode, lapse stub → EXPIRED', withFixture(async (hermitDir, configDir) => {
    writeLogin(configDir, { accessToken: '', refreshToken: '', expiresAt: 0 });
    expect(await probe(hermitDir, configDir)).toBe('EXPIRED');
  }));

  test('login mode, unreadable credentials file → EXPIRED', withFixture(async (hermitDir, configDir) => {
    fs.writeFileSync(credentialsFilePath(configDir), '{not json');
    expect(await probe(hermitDir, configDir)).toBe('EXPIRED');
  }));

  // No verdict is a probe failure, which doctor shows as a warning, never a pass.
  test('login mode, login status unavailable → probe fails', withFixture(async (hermitDir, configDir) => {
    writeLogin(configDir, { accessToken: 'a', refreshToken: 'r' });
    writeAuthStatusReply(configDir, 0, 'not json');
    const out = await rawProbe(hermitDir, configDir);
    expect(out.exitCode).toBe(1);
    expect(JSON.parse(out.stdout)).toEqual({ error: 'auth_status_unavailable' });
  }));

  // An empty volume means "never signed in" on Linux, but on macOS it is the normal
  // state of a logged-in operator whose credential sits in the Keychain — reporting
  // EXPIRED there would fire a false alarm on every macOS install.
  test('nothing on the volume → EXPIRED, except on macOS where it is OK', withFixture(async (hermitDir, configDir) => {
    expect(await probe(hermitDir, configDir)).toBe(
      process.platform === 'darwin' ? 'OK' : 'EXPIRED',
    );
  }));

  test('an env credential is external → OK, whatever is on the volume', withFixture(async (hermitDir, configDir) => {
    writeLogin(configDir, { accessToken: '', refreshToken: '', expiresAt: 0 });
    const out = await runScript('setup-token-mint.ts', {
      args: ['probe'],
      env: { HERMIT_DIR: hermitDir, CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: 'sk-fixture' },
    });
    expect(out.stdout.trim()).toBe('OK');
  }));

  test('probe prints exactly one line (doctor parses only the first)', withFixture(async (hermitDir, configDir) => {
    installToken(hermitDir, configDir, VALID);
    const out = (await rawProbe(hermitDir, configDir)).stdout;
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(out).not.toContain(VALID);
  }));
});

describe('loginStatus (claude auth status)', () => {
  const writeCreds = (configDir: string, oauth: Record<string, unknown>) =>
    fs.writeFileSync(credentialsFilePath(configDir), JSON.stringify({ claudeAiOauth: oauth }));

  test('a signed-in login with a future refresh expiry is usable, with that expiry', withDirs((_h, configDir) => {
    const at = Date.now() + 30 * 86400_000;
    writeCreds(configDir, { accessToken: 'a', refreshToken: 'r', refreshTokenExpiresAt: at });
    expect(loginStatus(configDir)).toEqual({ state: 'usable', expiresAt: at });
  }));

  test('a signed-in login without an expiry is usable and undated', withDirs((_h, configDir) => {
    writeCreds(configDir, { accessToken: 'a', refreshToken: 'r' });
    expect(loginStatus(configDir)).toEqual({ state: 'usable', expiresAt: null });
  }));

  test('a passed refresh expiry is lapsed, though Claude Code still says logged in', withDirs((_h, configDir) => {
    writeCreds(configDir, { accessToken: 'a', refreshToken: 'r', refreshTokenExpiresAt: 5000 });
    expect(loginStatus(configDir, 10_000)).toEqual({ state: 'lapsed', expiresAt: 5000 });
  }));

  test('stub, absent and unreadable files are all lapsed', withDirs((_h, configDir) => {
    expect(loginStatus(configDir).state).toBe('lapsed');
    writeCreds(configDir, { accessToken: '', refreshToken: '', expiresAt: 0 });
    expect(loginStatus(configDir).state).toBe('lapsed');
    fs.writeFileSync(credentialsFilePath(configDir), '{not json');
    expect(loginStatus(configDir).state).toBe('lapsed');
  }));

  test('any reply outside the probed shape is unknown', withDirs((_h, configDir) => {
    for (const [code, stdout] of [
      [0, 'not json'],
      [0, 'null'],
      [0, '[]'],
      [0, '{}'],
      [0, JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', loginExpiresAt: null })],
      [0, JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', loginExpiresAt: 'soon' })],
      [1, JSON.stringify({ loggedIn: true })],
      [2, JSON.stringify({ loggedIn: false })],
    ] as const) {
      writeAuthStatusReply(configDir, code, stdout);
      expect(loginStatus(configDir)).toEqual({ state: 'unknown', expiresAt: null });
    }
  }));

  test('a missing claude binary is unknown', withDirs((_h, configDir) => {
    const saved = process.env.PATH;
    process.env.PATH = path.join(configDir, 'no-such-bin');
    try {
      expect(loginStatus(configDir)).toEqual({ state: 'unknown', expiresAt: null });
    } finally {
      process.env.PATH = saved;
    }
  }));

  test('credentials that mask the stored login are stripped from the call', withDirs((_h, configDir) => {
    const saved = { token: process.env[TOKEN_ENV_VAR], key: process.env.ANTHROPIC_API_KEY };
    process.env[TOKEN_ENV_VAR] = 'sk-ant-oat01-env';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api-env';
    try {
      loginStatus(configDir);
    } finally {
      for (const [k, v] of [[TOKEN_ENV_VAR, saved.token], ['ANTHROPIC_API_KEY', saved.key]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    expect(authStatusCalls(configDir)).toEqual([{ config_dir_set: true, oauth_token: false, api_key: false }]);
  }));

  // Claude Code keeps .claude.json under CLAUDE_CONFIG_DIR whenever it is set, even to
  // ~/.claude, so the default dir is checked with the variable left unset.
  test('the default config dir leaves CLAUDE_CONFIG_DIR unset', withDirs((hermitDir) => {
    const saved = { home: process.env.HOME, dir: process.env.CLAUDE_CONFIG_DIR };
    process.env.HOME = hermitDir;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      loginStatus();
    } finally {
      process.env.HOME = saved.home;
      if (saved.dir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved.dir;
    }
    expect(authStatusCalls(path.join(hermitDir, '.claude'))).toEqual([{ config_dir_set: false, oauth_token: false, api_key: false }]);
  }));
});

describe('resolveAuthMode', () => {
  const usableLogin = (configDir: string) =>
    fs.writeFileSync(
      credentialsFilePath(configDir),
      JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } }),
    );

  // tokenModeActive() consults the env var first, so every case here has to run
  // with it unset or the volume never gets a say.
  const withoutEnvToken = <T,>(fn: () => T): T => {
    const saved = process.env[TOKEN_ENV_VAR];
    delete process.env[TOKEN_ENV_VAR];
    try {
      return fn();
    } finally {
      if (saved !== undefined) process.env[TOKEN_ENV_VAR] = saved;
    }
  };

  test('explicit auth_mode wins over what is on the volume', withDirs((hermitDir, configDir) => {
    withoutEnvToken(() => {
      installToken(hermitDir, configDir, VALID);
      expect(resolveAuthMode({ auth_mode: 'login' }, configDir, false)).toBe('login');
      expect(resolveAuthMode({ auth_mode: 'token' }, configDir, false)).toBe('token');
    });
  }));

  // A macOS token hermit usually has no credential file (any login lives in the
  // Keychain), so the token has to outrank the Keychain heuristic or hermitd-start
  // exports nothing and the hermit boots credential-less.
  test('unset + token file → token, on either platform', withDirs((hermitDir, configDir) => {
    withoutEnvToken(() => {
      installToken(hermitDir, configDir, VALID);
      expect(resolveAuthMode({}, configDir, false, 'linux')).toBe('token');
      expect(resolveAuthMode({}, configDir, false, 'darwin')).toBe('token');
    });
  }));

  test('unset + usable login → login', withDirs((_h, configDir) => {
    withoutEnvToken(() => {
      usableLogin(configDir);
      expect(resolveAuthMode({}, configDir, false, 'linux')).toBe('login');
      expect(resolveAuthMode({}, configDir, false, 'darwin')).toBe('login');
    });
  }));

  test('unset or unrecognized + nothing on the volume → login is the residual', withDirs((_h, configDir) => {
    withoutEnvToken(() => {
      expect(resolveAuthMode({}, configDir, false, 'linux')).toBe('login');
      expect(resolveAuthMode({ auth_mode: 'oauth' }, configDir, false, 'linux')).toBe('login');
    });
  }));

  // On macOS the login lives in the Keychain, which this code cannot inspect, so an
  // empty volume means "not ours to renew" rather than "never signed in".
  test('darwin + nothing on the volume → external, not the login residual', withDirs((_h, configDir) => {
    withoutEnvToken(() => {
      expect(resolveAuthMode({}, configDir, false, 'darwin')).toBe('external');
      // An explicit auth_mode still wins — the heuristic only fills a gap.
      expect(resolveAuthMode({ auth_mode: 'login' }, configDir, false, 'darwin')).toBe('login');
    });
  }));

  test('an env credential is external regardless of files or config', withDirs((hermitDir, configDir) => {
    withoutEnvToken(() => {
      installToken(hermitDir, configDir, VALID);
      expect(resolveAuthMode({ auth_mode: 'login' }, configDir, true)).toBe('external');
      expect(resolveAuthMode({}, configDir, true)).toBe('external');
    });
  }));

  test('detectAuthModeFromVolume prefers the token file, else a usable login', withDirs((hermitDir, configDir) => {
    withoutEnvToken(() => {
      expect(detectAuthModeFromVolume(configDir)).toBeNull();
      usableLogin(configDir);
      expect(detectAuthModeFromVolume(configDir)).toBe('login');
      installToken(hermitDir, configDir, VALID); // the login stays; the token outranks it
      expect(detectAuthModeFromVolume(configDir)).toBe('token');
    });
  }));

  // A macOS login lives in the Keychain, which the relay's file install cannot serve,
  // so a signed-in status with no credentials file stays unresolved.
  test('detectAuthModeFromVolume needs the credentials file, not just a signed-in status', withDirs((_h, configDir) => {
    withoutEnvToken(() => {
      writeAuthStatusReply(configDir, 0, JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', loginExpiresAt: null }));
      expect(detectAuthModeFromVolume(configDir)).toBeNull();
    });
  }));
});
