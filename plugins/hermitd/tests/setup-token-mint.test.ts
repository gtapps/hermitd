// Pane-stream parsing for the setup-token mint driver.
//
// The fixtures below are the shapes `claude setup-token` actually produced in a
// tmux pane (captured live against CC 2.1.216), not invented ones. That matters:
// the reason this code reads an escape sequence instead of the visible text is
// that the visible copy of the URL is hard-wrapped and truncated mid-string, so
// scraping what a human sees yields a broken sign-in link.

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractToken, extractUrl, findAck, findCode, mintCommand } from '../scripts/setup-token-mint';
import { EN_MESSAGES, LOCKED, friendlyDate } from '../scripts/lib/messages';
import { PT } from './helpers/pt-messages';
import { runScript } from './helpers/run';

const FULL_URL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e' +
  '&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback' +
  '&scope=user%3Ainference&code_challenge=7Y59PHdULkTsKkXw-NE-XnzFSVjcJ4cNhsjYPe7T5OM' +
  '&code_challenge_method=S256&state=6DeG9yq3qjtEYPN1PJaGnMnskjpXeN5UFqMOkii_FjM';

/** OSC-8 hyperlink: complete URL as the target, truncated copy as visible text. */
const TRUNCATED_VISIBLE = FULL_URL.slice(0, 140);
const PANE_STREAM =
  '\x1b[2m Browser didn\'t open? Use the url below to sign in (c to copy)\x1b[0m\r\n' +
  `\x1b]8;;${FULL_URL}\x07${TRUNCATED_VISIBLE}\x1b]8;;\x07\r\n` +
  ' Paste code here if prompted > \r\n';

const TOKEN = 'sk-ant-oat01-QWERTYuiop1234567890asdfghjklZXCVBNM-_abcdefghij';

describe('extractUrl', () => {
  test('recovers the complete URL from the hyperlink target', () => {
    expect(extractUrl(PANE_STREAM)).toBe(FULL_URL);
  });

  test('never returns the truncated visible copy', () => {
    const url = extractUrl(PANE_STREAM)!;
    expect(url).not.toBe(TRUNCATED_VISIBLE);
    // A URL missing its state parameter is unusable — that is exactly what the
    // wrapped visible text loses.
    expect(url).toContain('state=');
  });

  test('falls back to plain text when there is no hyperlink escape', () => {
    expect(extractUrl(`sign in here: ${FULL_URL}\r\n`)).toBe(FULL_URL);
  });

  test('ignores non-oauth URLs and returns null when there is nothing yet', () => {
    expect(extractUrl('Loading https://claude.com/docs ...')).toBeNull();
    expect(extractUrl('')).toBeNull();
    expect(extractUrl('\x1b[2mstarting\x1b[0m\r\n')).toBeNull();
  });

  test('strips trailing punctuation that is not part of the link', () => {
    expect(extractUrl(`open (${FULL_URL}).`)).toBe(FULL_URL);
  });
});

describe('extractToken', () => {
  test('finds the minted token in the stream', () => {
    expect(extractToken(`${PANE_STREAM}\r\n${TOKEN}\r\n`)).toBe(TOKEN);
  });

  test('returns null before the token prints', () => {
    expect(extractToken(PANE_STREAM)).toBeNull();
  });

  test('takes the last token printed', () => {
    const older = 'sk-ant-oat01-OLDEROLDEROLDEROLDEROLDER123456';
    expect(extractToken(`${older}\r\nreissued\r\n${TOKEN}\r\n`)).toBe(TOKEN);
  });

  test('ignores fragments too short to be a real token', () => {
    expect(extractToken('sk-ant-oat01-abc\r\n')).toBeNull();
  });
});

describe('channel reply matching', () => {
  test('ack matches the word regardless of casing or surrounding prose', () => {
    expect(findAck([{ text: 'reauth' }])).toBe(true);
    expect(findAck([{ text: 'ok Reauth now please' }])).toBe(true);
    expect(findAck([{ text: 'what is going on?' }])).toBe(false);
    expect(findAck([])).toBe(false);
  });

  test('code picks the pasted value and skips the ack and prose', () => {
    expect(findCode([{ text: 'reauth' }, { text: 'ABC-123-XYZ' }])).toBe('ABC-123-XYZ');
    expect(findCode([{ text: 'reauth' }])).toBeNull();
    // A sentence is the operator talking, not a code.
    expect(findCode([{ text: 'I opened the link but nothing happened yet' }])).toBeNull();
  });
});

// The ack matcher is language-agnostic: `reauth` is a locked placeholder value,
// so every wording of the prompt, translated or custom, carries it.
describe('mint ack prompt keeps the reauth keyword in every language', () => {
  test('English and translated ack prompts both match the reauth matcher', () => {
    for (const m of [EN_MESSAGES, PT]) {
      const prompt = m.t('mint_ack_prompt', { keyword: LOCKED.keyword });
      expect(prompt).toMatch(/\breauth\b/i);
      expect(findAck([{ text: prompt }])).toBe(true);
    }
  });
});

// The mint success line renders the next-renewal date in the catalog's locale.
describe('mint renewal date rendering', () => {
  const ISO = '2026-07-05T12:00:00Z'; // noon UTC -> day 5 in every real timezone
  test('English is byte-identical to the en-GB long form', () => {
    const expected = new Date(ISO).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    expect(friendlyDate(EN_MESSAGES, ISO)).toBe(expected);
  });
  test('a pt-PT catalog renders the Portuguese long form', () => {
    expect(friendlyDate(PT, ISO)).toBe('5 de julho de 2026');
  });
});

// PROP-059: code intake is pinned to the resolved primary reply route. The pin
// itself (rowMatchesReplyRoute) is module-internal — the intake calls
// findCode(inboundSince(...).filter(rowMatchesReplyRoute)). findCode is
// deliberately chat-agnostic (text-only), so the chat_id gate is the caller's
// filter; we reproduce that filter here to prove the composed behavior: a short
// message from a DIFFERENT chat than the pinned route is dropped before findCode
// sees it, so it can never be accepted as the login code.
describe('mint code intake pins to the reply route', () => {
  const PINNED = '12345';
  const pinFilter = (r: { chat_id: string }) => String(r.chat_id) === PINNED;

  test('a short code from a foreign chat is filtered out before findCode', () => {
    const rows: { text: string; chat_id: string }[] = [
      { text: 'reauth', chat_id: PINNED },
      { text: 'ABC-123-XYZ', chat_id: '999' }, // another chat the bot can see
    ];
    expect(findCode(rows.filter(pinFilter))).toBeNull();
  });

  test('the code from the pinned chat is accepted', () => {
    const rows: { text: string; chat_id: string }[] = [
      { text: 'reauth', chat_id: PINNED },
      { text: 'ABC-123-XYZ', chat_id: PINNED },
    ];
    expect(findCode(rows.filter(pinFilter))).toBe('ABC-123-XYZ');
  });

  test('findCode alone does not gate on chat_id — the upstream pin is what closes the hole', () => {
    expect(findCode([{ text: 'ABC-123-XYZ', chat_id: '999' } as any])).toBe('ABC-123-XYZ');
  });
});

describe('mint pane command', () => {
  test('login mode redirects the CLI at the staging dir, never the live one', () => {
    const cmd = mintCommand('login', '/home/agent/.claude/.hermit-login-staging');
    expect(cmd).toBe(
      "CLAUDE_CONFIG_DIR='/home/agent/.claude/.hermit-login-staging' claude auth login --claudeai; sleep 20",
    );
    // The live dir is the parent — a bare `/home/agent/.claude` would mean the mint
    // is writing the credential the resident session is refreshing underneath it.
    expect(cmd).not.toMatch(/CLAUDE_CONFIG_DIR='[^']*\.claude'/);
  });

  test('token mode is unchanged and names no config dir', () => {
    expect(mintCommand('token', '/ignored')).toBe('claude setup-token; sleep 20');
  });

  test('a staging path with a quote in it cannot break out of the shell word', () => {
    expect(mintCommand('login', "/tmp/a'b")).toContain(`'/tmp/a'\\''b'`);
  });
});

describe('auth-mode verbs', () => {
  const VALID = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789';

  function fixture(): { root: string; hermitDir: string; configDir: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-mint-mode-'));
    const hermitDir = path.join(root, '.hermit');
    const configDir = path.join(root, 'config');
    fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(hermitDir, 'config.json'), JSON.stringify({ agent_name: 'fix' }, null, 2));
    return { root, hermitDir, configDir };
  }

  const run = (hermitDir: string, configDir: string, args: string[], extraEnv: Record<string, string> = {}) =>
    runScript('setup-token-mint.ts', {
      args,
      env: { HERMIT_DIR: hermitDir, CLAUDE_CONFIG_DIR: configDir, ...extraEnv },
    });

  const readConfig = (hermitDir: string) =>
    JSON.parse(fs.readFileSync(path.join(hermitDir, 'config.json'), 'utf8'));

  const usableLogin = (configDir: string) =>
    fs.writeFileSync(
      path.join(configDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } }),
    );

  test('stamp-auth-mode writes token when the volume holds a token file', async () => {
    const { root, hermitDir, configDir } = fixture();
    try {
      fs.writeFileSync(path.join(configDir, '.hermit-setup-token'), `${VALID}\n`, { mode: 0o600 });
      const out = await run(hermitDir, configDir, ['stamp-auth-mode']);
      expect(JSON.parse(out.stdout)).toEqual({ ok: true, auth_mode: 'token', source: 'detected' });
      expect(readConfig(hermitDir).auth_mode).toBe('token');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('stamp-auth-mode writes login when a usable sign-in is stored', async () => {
    const { root, hermitDir, configDir } = fixture();
    try {
      usableLogin(configDir);
      const out = await run(hermitDir, configDir, ['stamp-auth-mode']);
      expect(JSON.parse(out.stdout)).toEqual({ ok: true, auth_mode: 'login', source: 'detected' });
      expect(readConfig(hermitDir).auth_mode).toBe('login');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('stamp-auth-mode keeps an explicit choice and never overwrites it', async () => {
    const { root, hermitDir, configDir } = fixture();
    try {
      fs.writeFileSync(
        path.join(hermitDir, 'config.json'),
        JSON.stringify({ auth_mode: 'login' }, null, 2),
      );
      fs.writeFileSync(path.join(configDir, '.hermit-setup-token'), `${VALID}\n`, { mode: 0o600 });
      const out = await run(hermitDir, configDir, ['stamp-auth-mode']);
      expect(JSON.parse(out.stdout)).toEqual({ ok: true, source: 'kept' });
      expect(readConfig(hermitDir).auth_mode).toBe('login');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('stamp-auth-mode leaves an API-key hermit alone', async () => {
    const { root, hermitDir, configDir } = fixture();
    try {
      usableLogin(configDir);
      const out = await run(hermitDir, configDir, ['stamp-auth-mode'], { ANTHROPIC_API_KEY: 'sk-fixture' });
      expect(JSON.parse(out.stdout)).toEqual({ ok: true, source: 'kept' });
      expect(readConfig(hermitDir).auth_mode).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('stamp-auth-mode writes nothing when the volume is inconclusive', async () => {
    const { root, hermitDir, configDir } = fixture();
    try {
      const out = await run(hermitDir, configDir, ['stamp-auth-mode']);
      expect(JSON.parse(out.stdout)).toEqual({ ok: true, source: 'unresolved' });
      expect(readConfig(hermitDir).auth_mode).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('stamp-auth-mode prefers the session config dir stamped in runtime.json', async () => {
    const { root, hermitDir, configDir } = fixture();
    try {
      // The env dir is empty; the credential lives only where runtime.json points.
      const sessionDir = path.join(root, 'session-config');
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, '.hermit-setup-token'), `${VALID}\n`, { mode: 0o600 });
      fs.writeFileSync(
        path.join(hermitDir, 'state', 'runtime.json'),
        JSON.stringify({ config_dir: sessionDir }),
      );
      const out = await run(hermitDir, configDir, ['stamp-auth-mode']);
      expect(JSON.parse(out.stdout)).toEqual({ ok: true, auth_mode: 'token', source: 'detected' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('status reports the resolved mode, and --target overrides it for one run', async () => {
    const { root, hermitDir, configDir } = fixture();
    try {
      fs.writeFileSync(path.join(configDir, '.hermit-setup-token'), `${VALID}\n`, { mode: 0o600 });
      const asIs = JSON.parse((await run(hermitDir, configDir, ['status'])).stdout);
      expect(asIs.auth_mode).toBe('token');
      expect(asIs.token_mode).toBe(true); // the key hermitd-docker parses stays
      expect(asIs.pending).toBe(false);

      const overridden = JSON.parse(
        (await run(hermitDir, configDir, ['status', '--target', 'login'])).stdout,
      );
      expect(overridden.auth_mode).toBe('login');
      // An override is for the run only — nothing is written until a credential exists.
      expect(readConfig(hermitDir).auth_mode).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a nonsense --target is refused rather than silently ignored', async () => {
    const { root, hermitDir, configDir } = fixture();
    try {
      const out = await run(hermitDir, configDir, ['status', '--target', 'oauth']);
      expect(out.exitCode).toBe(1);
      expect(JSON.parse(out.stdout)).toEqual({ error: 'invalid_target' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a relay that cannot reach the operator stamps itself instead of looping', async () => {
    const { root, hermitDir, configDir } = fixture();
    try {
      // No channels configured, so the ack send fails before anything is minted —
      // which is the reachability test. Without the stamp the watchdog would spawn
      // this same doomed relay again on its next tick, forever.
      const out = await run(hermitDir, configDir, ['relay']);
      expect(out.exitCode).toBe(1);
      expect(JSON.parse(out.stdout)).toEqual({ error: 'operator_unreachable' });
      const stamp = JSON.parse(
        fs.readFileSync(path.join(hermitDir, 'state', 'relay-unreachable.json'), 'utf8'),
      );
      expect(typeof stamp.at).toBe('string');
      expect(Number.isNaN(Date.parse(stamp.at))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('a staged sign-in awaiting restart blocks a second mint', async () => {
    const { root, hermitDir, configDir } = fixture();
    try {
      fs.writeFileSync(
        path.join(hermitDir, 'state', 'pending-credential.json'),
        JSON.stringify({ staged_dir: path.join(configDir, '.hermit-login-staging'), staged_at: 'now' }),
      );
      for (const verb of ['start', 'terminal', 'relay']) {
        const out = await run(hermitDir, configDir, [verb]);
        expect(out.exitCode).toBe(1);
        expect(JSON.parse(out.stdout)).toEqual({ error: 'credential_pending' });
      }
      // status stays readable while one is pending — it is how the skill reports it.
      expect(JSON.parse((await run(hermitDir, configDir, ['status'])).stdout).pending).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
