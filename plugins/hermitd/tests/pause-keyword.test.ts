// Contract tests for the pause/resume!snooze command writer (PROP-015) —
// scripts/lib/prompt-stages/pause-keyword.ts, driven through the single
// UserPromptSubmit process, scripts/user-prompt-pipeline.ts. Writes the pause
// flag directly from an inbound <channel> envelope, before any model turn.
// Exercised as a subprocess (stdin in, exit code/stdout out), the boundary
// Claude Code sees.
//
// Grammar is slash-only: `!pause`, `!stop`, `!resume`, `!snooze <dur>`, matching
// the harness commands (`/compact`, `/clear`). The bare words these once
// accepted are deliberately inert — a word an operator might type in ordinary
// conversation must not be able to freeze the hermit.
//
// Pipeline note: prompt-context runs on every prompt, so stdout always carries
// a `[Now: …]` line. A "silent no-op" is therefore asserted as the absence of
// the `[pause]` marker, not as empty stdout.
//
// Usage: bun test tests/pause-keyword.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { isPaused } from '../scripts/lib/pause';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.hermit', ...p);
const write = (p: string, content: string) => fs.writeFileSync(p, content);

function withDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const wd: Workdir = setupWorkdir();
    // Default config: the operator's DM is chat_id "1" (matching the test envelopes).
    // With no allowed_users set, that DM is the trusted controller — the allowlist
    // tests below overwrite this config with their own.
    write(hermit(wd.dir, 'config.json'), '{"channels":{"discord":{"default_chat_id":"1"}}}');
    try { await fn(wd.dir); } finally { wd.cleanup(); }
  };
}

const run = (prompt: string, dir: string) =>
  runScript('user-prompt-pipeline.ts', { stdin: JSON.stringify({ prompt }), cwd: dir });

describe('pause-keyword', () => {
  test('"!pause" from the operator DM (no allowlist, chat_id matches default_chat_id) — sets flag, exit 0', withDir(async (dir) => {
    const r = await run('<channel source="discord" chat_id="1" user="U1">!pause</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('paused');
    const status = isPaused(hermit(dir));
    expect(status.paused).toBe(true);
    expect(status.until).toBeNull();
    expect(status.by).toBe('U1');
  }));

  // #3 fix: with no allowlist, a sender from a DIFFERENT chat than the operator's
  // DM can no longer freeze the hermit (previously accept-all let anyone stop it).
  test('no allowlist, message from a non-DM chat — silent no-op (cannot freeze)', withDir(async (dir) => {
    const r = await run('<channel source="discord" chat_id="99" user="STRANGER">!stop</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('[pause]');
    expect(isPaused(hermit(dir)).paused).toBe(false);
  }));

  test('"!stop" is a synonym for "!pause"', withDir(async (dir) => {
    await run('<channel source="discord" chat_id="1" user="U1">!stop</channel>', dir);
    expect(isPaused(hermit(dir)).paused).toBe(true);
  }));

  test('"!resume" clears an existing pause', withDir(async (dir) => {
    await run('<channel source="discord" chat_id="1" user="U1">!pause</channel>', dir);
    expect(isPaused(hermit(dir)).paused).toBe(true);
    const r = await run('<channel source="discord" chat_id="1" user="U1">!resume</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('resumed');
    expect(isPaused(hermit(dir)).paused).toBe(false);
  }));

  test('"!snooze 2h" pauses with a future paused_until', withDir(async (dir) => {
    const r = await run('<channel source="discord" chat_id="1" user="U1">!snooze 2h</channel>', dir);
    expect(r.exitCode).toBe(0);
    const status = isPaused(hermit(dir));
    expect(status.paused).toBe(true);
    expect(status.until).not.toBeNull();
    expect(new Date(status.until as string).getTime()).toBeGreaterThan(Date.now());
  }));

  test('"!snooze bogus" — unparseable duration, no state change, hint on stdout', withDir(async (dir) => {
    const r = await run('<channel source="discord" chat_id="1" user="U1">!snooze bogus</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Could not parse');
    expect(isPaused(hermit(dir)).paused).toBe(false);
  }));

  // The snooze grammar accepts `\s+` before the duration and must keep doing so:
  // addressing is shared across command families, argument tokenizing is not.
  test('"!snooze  2h" — multiple spaces before the duration still parse', withDir(async (dir) => {
    const r = await run('<channel source="discord" chat_id="1" user="U1">!snooze  2h</channel>', dir);
    expect(r.exitCode).toBe(0);
    const status = isPaused(hermit(dir));
    expect(status.paused).toBe(true);
    expect(status.until).not.toBeNull();
  }));

  test('unauthorized sender (allowlist configured, sender not listed) — silent no-op', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"channels":{"discord":{"allowed_users":["ALLOWED_ID"]}}}');
    const r = await run('<channel source="discord" chat_id="1" user="INTRUDER">!pause</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('[pause]');
    expect(isPaused(hermit(dir)).paused).toBe(false);
  }));

  test('allowlist configured, sender listed — acts', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"channels":{"discord":{"allowed_users":["ALLOWED_ID"]}}}');
    const r = await run('<channel source="discord" chat_id="1" user="ALLOWED_ID">!pause</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(isPaused(hermit(dir)).paused).toBe(true);
  }));

  test('allowed_users=[] lockdown — silent no-op even with a user id', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"channels":{"discord":{"allowed_users":[]}}}');
    const r = await run('<channel source="discord" chat_id="1" user="ANYONE">!pause</channel>', dir);
    expect(r.stdout).not.toContain('[pause]');
    expect(isPaused(hermit(dir)).paused).toBe(false);
  }));

  test('no user attribute, allowlist configured — rejected (unverifiable identity)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{"channels":{"discord":{"allowed_users":["ALLOWED_ID"]}}}');
    const r = await run('<channel source="discord" chat_id="1">!pause</channel>', dir);
    expect(r.stdout).not.toContain('[pause]');
    expect(isPaused(hermit(dir)).paused).toBe(false);
  }));

  test('ordinary conversational text — no accidental trigger', withDir(async (dir) => {
    const r = await run('<channel source="discord" chat_id="1" user="U1">please pause and think about this</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('[pause]');
    expect(isPaused(hermit(dir)).paused).toBe(false);
  }));

  test('no envelope — no-op', withDir(async (dir) => {
    const r = await run('hello world', dir);
    expect(r.stdout).not.toContain('[pause]');
    expect(isPaused(hermit(dir)).paused).toBe(false);
  }));

  test('empty stdin — fail-open, exit 0', withDir(async (dir) => {
    const r = await runScript('user-prompt-pipeline.ts', { stdin: '', cwd: dir });
    expect(r.exitCode).toBe(0);
  }));

  test('malformed JSON stdin — fail-open, exit 0', withDir(async (dir) => {
    const r = await runScript('user-prompt-pipeline.ts', { stdin: '{broken', cwd: dir });
    expect(r.exitCode).toBe(0);
  }));

  test('adversarial control char in user id is sanitized in the acknowledgement', withDir(async (dir) => {
    const r = await run('<channel source="discord" chat_id="1" user="U1\n2">!pause</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain('\n2');
  }));

  // The cutover: every word that used to bind is now inert here. These fall
  // through to the model, which classifies a bare "stop" under its existing
  // Emergency branch — cooperative, not binding.
  describe('bare control words are no longer binding', () => {
    for (const body of ['pause', 'stop', 'resume', 'snooze 2h', 'PAUSE', 'Stop']) {
      test(`"${body}" changes no state and emits no [pause] line`, withDir(async (dir) => {
        const r = await run(`<channel source="discord" chat_id="1" user="U1">${body}</channel>`, dir);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).not.toContain('[pause]');
        expect(isPaused(hermit(dir)).paused).toBe(false);
      }));
    }

    test('a bare "resume" cannot clear a pause set by "!pause"', withDir(async (dir) => {
      await run('<channel source="discord" chat_id="1" user="U1">!pause</channel>', dir);
      expect(isPaused(hermit(dir)).paused).toBe(true);
      const r = await run('<channel source="discord" chat_id="1" user="U1">resume</channel>', dir);
      expect(r.exitCode).toBe(0);
      expect(isPaused(hermit(dir)).paused).toBe(true);
    }));
  });

  // Telegram rewrites a command picked from the bot menu to `/cmd@thebot` in
  // groups. The suffix must name THIS bot: one aimed at another bot in a shared
  // group is not ours to act on. bot_username is stored bare (no leading '@').
  describe('@botname addressing', () => {
    const withHandle = '{"channels":{"discord":{"default_chat_id":"1","bot_username":"ourbot"}}}';

    test('suffix naming this bot — acts', withDir(async (dir) => {
      write(hermit(dir, 'config.json'), withHandle);
      const r = await run('<channel source="discord" chat_id="1" user="U1">!pause@ourbot</channel>', dir);
      expect(r.exitCode).toBe(0);
      expect(isPaused(hermit(dir)).paused).toBe(true);
    }));

    test('suffix naming a different bot — silent no-op', withDir(async (dir) => {
      write(hermit(dir, 'config.json'), withHandle);
      const r = await run('<channel source="discord" chat_id="1" user="U1">!pause@otherbot</channel>', dir);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('[pause]');
      expect(isPaused(hermit(dir)).paused).toBe(false);
    }));

    test('suffixed command with no stored bot_username — silent no-op', withDir(async (dir) => {
      // Default config carries no bot_username: an unknown handle can never
      // authorize an addressed command.
      const r = await run('<channel source="discord" chat_id="1" user="U1">!pause@ourbot</channel>', dir);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('[pause]');
      expect(isPaused(hermit(dir)).paused).toBe(false);
    }));

    test('unsuffixed command still works when a handle is stored', withDir(async (dir) => {
      write(hermit(dir, 'config.json'), withHandle);
      const r = await run('<channel source="discord" chat_id="1" user="U1">!pause</channel>', dir);
      expect(r.exitCode).toBe(0);
      expect(isPaused(hermit(dir)).paused).toBe(true);
    }));

    test('addressed snooze keeps its duration argument', withDir(async (dir) => {
      write(hermit(dir, 'config.json'), withHandle);
      const r = await run('<channel source="discord" chat_id="1" user="U1">!snooze@ourbot 2h</channel>', dir);
      expect(r.exitCode).toBe(0);
      expect(isPaused(hermit(dir)).until).not.toBeNull();
    }));
  });

  // A mention-gated channel — the default for a server channel — delivers the
  // operator's mention verbatim ahead of the command. These drive the whole hook,
  // so they cover the config→stage→addressing wiring, not just the primitive.
  describe('leading self-mention addressing', () => {
    const SELF_ID = '1503162355876499589';
    const withIdentity =
      `{"channels":{"discord":{"default_chat_id":"1","bot_username":"ourbot","bot_user_id":"${SELF_ID}"}}}`;

    test('Discord mention of this bot before the command — acts', withDir(async (dir) => {
      write(hermit(dir, 'config.json'), withIdentity);
      const r = await run(`<channel source="discord" chat_id="1" user="U1"><@${SELF_ID}> !pause</channel>`, dir);
      expect(r.exitCode).toBe(0);
      expect(isPaused(hermit(dir)).paused).toBe(true);
    }));

    test('mention of a different account — silent no-op', withDir(async (dir) => {
      write(hermit(dir, 'config.json'), withIdentity);
      const r = await run('<channel source="discord" chat_id="1" user="U1"><@999999999999999999> !pause</channel>', dir);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('[pause]');
      expect(isPaused(hermit(dir)).paused).toBe(false);
    }));

    test('mention with no stored bot_user_id — silent no-op', withDir(async (dir) => {
      // Default config carries no identity: an unknown id can never authorize
      // its own address form.
      const r = await run(`<channel source="discord" chat_id="1" user="U1"><@${SELF_ID}> !pause</channel>`, dir);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('[pause]');
      expect(isPaused(hermit(dir)).paused).toBe(false);
    }));

    test('a mention does not rescue a bare control word', withDir(async (dir) => {
      write(hermit(dir, 'config.json'), withIdentity);
      const r = await run(`<channel source="discord" chat_id="1" user="U1"><@${SELF_ID}> pause</channel>`, dir);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('[pause]');
      expect(isPaused(hermit(dir)).paused).toBe(false);
    }));

    test('mentioned snooze keeps its duration argument', withDir(async (dir) => {
      write(hermit(dir, 'config.json'), withIdentity);
      const r = await run(`<channel source="discord" chat_id="1" user="U1"><@${SELF_ID}> !snooze 2h</channel>`, dir);
      expect(r.exitCode).toBe(0);
      expect(isPaused(hermit(dir)).until).not.toBeNull();
    }));

    test('Telegram @handle mention before the command — acts', withDir(async (dir) => {
      write(hermit(dir, 'config.json'), withIdentity);
      const r = await run('<channel source="discord" chat_id="1" user="U1">@ourbot !pause</channel>', dir);
      expect(r.exitCode).toBe(0);
      expect(isPaused(hermit(dir)).paused).toBe(true);
    }));
  });

  // #634 regression: the harness injects a plugin-qualified source
  // (`plugin:discord:discord`) but config keys channels by the bare server
  // name — these pin the fix in lib/channel-auth.ts's channelEntry resolution.
  describe('plugin-qualified envelope source (#634)', () => {
    test('allowlist match on a qualified source against bare-keyed config — sets flag', withDir(async (dir) => {
      write(hermit(dir, 'config.json'), '{"channels":{"discord":{"allowed_users":["ALLOWED_ID"]}}}');
      const r = await run('<channel source="plugin:discord:discord" chat_id="1" user="ALLOWED_ID">!pause</channel>', dir);
      expect(r.exitCode).toBe(0);
      expect(isPaused(hermit(dir)).paused).toBe(true);
    }));

    test('DM-binding match on a qualified source, no allowlist — sets flag', withDir(async (dir) => {
      const r = await run('<channel source="plugin:discord:discord" chat_id="1" user="U1">!pause</channel>', dir);
      expect(r.exitCode).toBe(0);
      expect(isPaused(hermit(dir)).paused).toBe(true);
    }));

    test('stranger against an allowlist, qualified source — silent no-op', withDir(async (dir) => {
      write(hermit(dir, 'config.json'), '{"channels":{"discord":{"allowed_users":["ALLOWED_ID"]}}}');
      const r = await run('<channel source="plugin:discord:discord" chat_id="1" user="INTRUDER">!pause</channel>', dir);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('[pause]');
      expect(isPaused(hermit(dir)).paused).toBe(false);
    }));

    test('"resume" via a qualified source clears an existing pause', withDir(async (dir) => {
      await run('<channel source="plugin:discord:discord" chat_id="1" user="U1">!pause</channel>', dir);
      expect(isPaused(hermit(dir)).paused).toBe(true);
      const r = await run('<channel source="plugin:discord:discord" chat_id="1" user="U1">!resume</channel>', dir);
      expect(r.exitCode).toBe(0);
      expect(isPaused(hermit(dir)).paused).toBe(false);
    }));

    test('config keyed ONLY by the qualified source does not resolve — bare-name key is authoritative', withDir(async (dir) => {
      // Off-convention config keyed solely by the qualified form: the auth gate
      // resolves by the normalized bare name (matching the send path), so this
      // trusts nobody and the pause is not applied.
      write(hermit(dir, 'config.json'), '{"channels":{"plugin:discord:discord":{"default_chat_id":"1"}}}');
      const r = await run('<channel source="plugin:discord:discord" chat_id="1" user="U1">!pause</channel>', dir);
      expect(r.exitCode).toBe(0);
      expect(isPaused(hermit(dir)).paused).toBe(false);
    }));

    test('genericity pin: an unrecognized custom channel plugin normalizes the same way', withDir(async (dir) => {
      write(hermit(dir, 'config.json'), '{"channels":{"crm":{"default_chat_id":"1"}}}');
      const r = await run('<channel source="plugin:acme-crm:crm" chat_id="1" user="U1">!pause</channel>', dir);
      expect(r.exitCode).toBe(0);
      expect(isPaused(hermit(dir)).paused).toBe(true);
    }));
  });

  // Discord's wire envelope carries the display name in `user` and the numeric
  // platform id in `user_id`. allowed_users holds ids, so matching `user` made
  // every control keyword a silent no-op on allowlist-configured hermits.
  describe('user_id identity attribute', () => {
    const ID = '123456789012345678';
    const idConfig = `{"channels":{"discord":{"allowed_users":["${ID}"]}}}`;

    test('id-based allowlist, real wire shape — pauses, attributed to the display name', withDir(async (dir) => {
      write(hermit(dir, 'config.json'), idConfig);
      const r = await run(
        `<channel source="plugin:discord:discord" chat_id="1" user="display-name" user_id="${ID}">!pause</channel>`,
        dir,
      );
      expect(r.exitCode).toBe(0);
      const status = isPaused(hermit(dir));
      expect(status.paused).toBe(true);
      expect(status.by).toBe('display-name');
    }));

    test('display name mimicking an allowlisted id — silent no-op', withDir(async (dir) => {
      write(hermit(dir, 'config.json'), idConfig);
      const r = await run(
        `<channel source="plugin:discord:discord" chat_id="1" user="${ID}" user_id="EVIL">!pause</channel>`,
        dir,
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('[pause]');
      expect(isPaused(hermit(dir)).paused).toBe(false);
    }));
  });
});
