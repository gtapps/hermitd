// Behavioral tests for scripts/lib/prompt-stages/channel-reply-reminder.ts —
// the stage that reminds the model which reply tool to use, and captures
// inbound messages into the episodic channel log. Driven through the single
// UserPromptSubmit process, scripts/user-prompt-pipeline.ts, as a subprocess
// (stdin in, stdout out) — the boundary Claude Code sees. Mirrors
// tests/pause-keyword.test.ts.
//
// tests/channel-responder-reply-rule.test.ts is a separate, static wiring
// check (skill text / hooks.json / script presence) — it does not run this
// script, so this file is the only behavioral coverage for it.
//
// Usage: bun test tests/channel-reply-reminder.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { unconsolidated, logMessage } from '../scripts/lib/channel-log';

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.hermit', ...p);
const write = (p: string, content: string) => fs.writeFileSync(p, content);

function withDir(fn: (dir: string) => Promise<void> | void, config?: string) {
  return async () => {
    const wd: Workdir = setupWorkdir();
    write(hermit(wd.dir, 'config.json'), config ?? '{"channels":{"discord":{"allowed_users":["U1"]}}}');
    try { await fn(wd.dir); } finally { wd.cleanup(); }
  };
}

const ID_ALLOWLIST = '{"channels":{"discord":{"allowed_users":["123456789012345678"]}}}';

const run = (prompt: string, dir: string, env?: Record<string, string>) =>
  runScript('user-prompt-pipeline.ts', { stdin: JSON.stringify({ prompt }), cwd: dir, env });

describe('channel-reply-reminder', () => {
  const SELF_ID = '987654321098765432';
  const withBotId = (extra = '') =>
    `{"channels":{"discord":{"allowed_users":["U1"],"bot_user_id":"${SELF_ID}"${extra}}}}`;

  test('self-mention — names the bot id as the agent itself', withDir(async (dir) => {
    const r = await run(`<channel source="discord" chat_id="1" user="U1"><@${SELF_ID}> ping</channel>`, dir);
    expect(r.stdout).toContain(SELF_ID);
    expect(r.stdout).toContain('your own account on this channel');
  }, withBotId()));

  test('id embedded in a longer number — not a self-mention', withDir(async (dir) => {
    const r = await run(`<channel source="discord" chat_id="1" user="U1">order 5${SELF_ID}7 shipped</channel>`, dir);
    expect(r.stdout).not.toContain('your own account on this channel');
  }, withBotId()));

  test('configured but not mentioned — reminder is unchanged', withDir(async (dir) => {
    const r = await run('<channel source="discord" chat_id="1" user="U1">plain message</channel>', dir);
    expect(r.stdout).not.toContain('your own account on this channel');
    expect(r.stdout).toContain('[channel reply reminder]');
    expect(r.stdout).toContain('invoke `/hermitd:channel-responder` now');
  }, withBotId()));

  test('invoke request survives non-channel prompts and repeats until observed after reset', withDir(async (dir) => {
    const reset = '2026-09-20T12:00:00.000Z';
    write(hermit(dir, 'state', 'runtime.json'), JSON.stringify({ last_context_reset_at: reset }));
    const prompt = '<channel source="discord" chat_id="1" user="U1">plain message</channel>';
    const runSession = (prompt: string, session = 'resident') => runScript('user-prompt-pipeline.ts', {
      stdin: JSON.stringify({ prompt, session_id: session }), cwd: dir,
    });
    const invoke = 'invoke `/hermitd:channel-responder` now';
    expect((await runSession(prompt)).stdout).toContain(invoke);
    expect((await runSession('heartbeat')).stdout).not.toContain(invoke);
    expect((await runSession(prompt)).stdout).toContain(invoke);
    write(hermit(dir, 'state', 'channel-responder-invoked.json'), JSON.stringify({
      session_id: 'resident', at: '2026-09-20T11:00:00.000Z',
    }));
    expect((await runSession(prompt)).stdout).toContain(invoke);
    expect((await runSession(prompt)).stdout).toContain(invoke);
    const hook = await runScript('channel-responder-invoked.ts', {
      cwd: dir, stdin: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Skill',
        session_id: 'resident', tool_input: { skill: 'hermitd:channel-responder' },
        tool_response: { success: true } }),
    });
    expect(hook.exitCode).toBe(0);
    expect(hook.stdout).toBe('');
    expect(hook.stderr).toBe('');
    const record = JSON.parse(fs.readFileSync(hermit(dir, 'state', 'channel-responder-invoked.json'), 'utf8'));
    expect(record.session_id).toBe('resident');
    expect(Date.parse(record.at)).toBeGreaterThan(Date.parse(reset));
    expect((await runSession(prompt)).stdout).not.toContain('invoke `');
    expect((await runSession(prompt, 'another-session')).stdout).toContain(invoke);
    for (const runtime of ['{}', '{broken']) {
      write(hermit(dir, 'state', 'runtime.json'), runtime);
      expect((await runSession(prompt)).stdout).not.toContain('invoke `');
      expect((await runSession(prompt, 'another-session')).stdout).toContain(invoke);
    }
  }));

  test('Skill hook ignores other skills, failed calls, guests and malformed payloads', withDir(async (dir) => {
    const recordPath = hermit(dir, 'state', 'channel-responder-invoked.json');
    const baseline = '{"session_id":"prior","at":"2026-09-20T10:00:00.000Z"}';
    write(recordPath, baseline);
    write(hermit(dir, 'state', '.guest-guest'), 'guest');
    const payload = { hook_event_name: 'PostToolUse', tool_name: 'Skill', session_id: 'resident',
      tool_input: { skill: 'channel-responder' }, tool_response: { success: true } };
    for (const input of ['{broken', 'null', JSON.stringify({ ...payload, tool_input: {} }),
      JSON.stringify({ ...payload, tool_input: { skill: 'task' } }),
      JSON.stringify({ ...payload, tool_response: { success: false } }),
      JSON.stringify({ ...payload, session_id: 'guest' }),
      JSON.stringify({ ...payload, session_id: null })]) {
      const result = await runScript('channel-responder-invoked.ts', { cwd: dir, stdin: input });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      expect(fs.readFileSync(recordPath, 'utf8')).toBe(baseline);
    }
    const result = await runScript('channel-responder-invoked.ts', { cwd: dir, stdin: JSON.stringify(payload) });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(fs.readFileSync(recordPath, 'utf8')).session_id).toBe('resident');
  }));

  test('control verdicts retain reply routing without requesting a Skill call', withDir(async (dir) => {
    write(hermit(dir, 'state', 'runtime.json'), JSON.stringify({ runtime_mode: 'headless', tmux_session: 'hermit-test' }));
    for (const command of ['!permission-mode auto', '!pause', '!snooze 30m']) {
      const result = await run(`<channel source="discord" chat_id="1" user="U1">${command}</channel>`, dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('mcp__plugin_discord_discord__reply');
      expect(result.stdout).not.toContain('invoke `');
      if (command === '!permission-mode auto') {
        expect(result.stdout).toContain('End the turn with no tool call and no reply');
      } else expect(result.stdout).toContain('Only the channel reply tool works');
    }
    for (const command of ['!resume', '!permission-mode plan']) {
      const result = await run(`<channel source="discord" chat_id="1" user="U1">${command}</channel>`, dir);
      expect(result.stdout).toContain('invoke `/hermitd:channel-responder` now');
    }
  }));

  // pause-gate denies the Skill call outright, and a denied call leaves no
  // PostToolUse record — so the request would repeat on every paused message.
  test('a paused hermit is not asked to invoke the responder', withDir(async (dir) => {
    write(hermit(dir, 'state', 'runtime.json'), JSON.stringify({ runtime_mode: 'headless', tmux_session: 'hermit-test' }));
    const message = '<channel source="discord" chat_id="1" user="U1">any update?</channel>';
    expect((await run(message, dir)).stdout).toContain('invoke `/hermitd:channel-responder` now');
    await run('<channel source="discord" chat_id="1" user="U1">!pause</channel>', dir);
    const paused = await run(message, dir);
    expect(paused.stdout).toContain('mcp__plugin_discord_discord__reply');
    expect(paused.stdout).not.toContain('invoke `');
    await run('<channel source="discord" chat_id="1" user="U1">!resume</channel>', dir);
    expect((await run(message, dir)).stdout).toContain('invoke `/hermitd:channel-responder` now');
  }));

  test('bot_username — an @handle mention matches case-insensitively (telegram shape)', withDir(async (dir) => {
    const r = await run('<channel source="telegram" chat_id="1" user="U1">hey @HermitBot status?</channel>', dir);
    expect(r.stdout).toContain('@hermitbot');
    expect(r.stdout).toContain('your own account on this channel');
  }, '{"channels":{"telegram":{"allowed_users":["U1"],"bot_username":"hermitbot"}}}'));

  test('no bot identity configured — reminder is unchanged', withDir(async (dir) => {
    const r = await run(`<channel source="discord" chat_id="1" user="U1"><@${SELF_ID}> ping</channel>`, dir);
    expect(r.stdout).not.toContain('your own account on this channel');
  }));

  test('bare source — names the exact reply tool', withDir(async (dir) => {
    const r = await run('<channel source="discord" chat_id="1" user="U1">hi</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('mcp__plugin_discord_discord__reply');
    expect(r.stdout).toContain('`discord` channel');
  }));

  // #634 regression: the harness injects a plugin-qualified source
  // (`plugin:discord:discord`); REPLY_TOOLS must be looked up by the
  // normalized bare key, not the raw qualified one.
  test('plugin-qualified source — still names the exact reply tool', withDir(async (dir) => {
    const r = await run('<channel source="plugin:discord:discord" chat_id="1" user="U1">hi</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('mcp__plugin_discord_discord__reply');
    expect(r.stdout).toContain('`discord` channel');
  }));

  test('unrecognized custom channel plugin — generic fallback phrase, no crash', withDir(async (dir) => {
    const r = await run('<channel source="plugin:acme-crm:crm" chat_id="1" user="U1">hi</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("the channel's `reply` tool");
    expect(r.stdout).toContain('`crm` channel');
  }));

  test('plugin-qualified source — episodic capture logs the bare channel key', withDir(async (dir) => {
    const r = await run('<channel source="plugin:discord:discord" chat_id="1" user="U1">hello there</channel>', dir);
    expect(r.exitCode).toBe(0);
    const { rows } = unconsolidated(hermit(dir));
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe('discord');
    expect(rows[0].text).toBe('hello there');
  }));

  test('plugin-qualified source, sender not on the allowlist — reminder still fires, capture is skipped', withDir(async (dir) => {
    const r = await run('<channel source="plugin:discord:discord" chat_id="1" user="STRANGER">hello there</channel>', dir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('mcp__plugin_discord_discord__reply'); // reminder is not gated by allowlist
    const { rows } = unconsolidated(hermit(dir));
    expect(rows.length).toBe(0); // capture is gated by isAllowedSender
  }));

  // Discord puts the display name in `user` and the numeric id in `user_id`.
  // allowed_users holds ids (what every doc instructs), so matching `user`
  // rejected the operator on every inbound message and nothing was ever logged.
  test('id-based allowlist, real wire shape — captured, sender keeps the display name', withDir(async (dir) => {
    const r = await run(
      '<channel source="plugin:discord:discord" chat_id="1" user="display-name" user_id="123456789012345678">hello there</channel>',
      dir,
    );
    expect(r.exitCode).toBe(0);
    const { rows } = unconsolidated(hermit(dir));
    expect(rows.length).toBe(1);
    expect(rows[0].text).toBe('hello there');
    expect(rows[0].sender).toBe('display-name');
  }, ID_ALLOWLIST));

  test('display name mimicking an allowlisted id — not captured', withDir(async (dir) => {
    const r = await run(
      '<channel source="plugin:discord:discord" chat_id="1" user="123456789012345678" user_id="EVIL">hello there</channel>',
      dir,
    );
    expect(r.exitCode).toBe(0);
    const { rows } = unconsolidated(hermit(dir));
    expect(rows.length).toBe(0);
  }, ID_ALLOWLIST));
});

describe('passive capture', () => {
  const config = (source = 'discord', extra: Record<string, unknown> = {}, logging = true) => JSON.stringify({
    channels: { [source]: { passive_chats: ['1'], allowed_users: ['U1'], bot_user_id: '123', bot_username: 'handle', ...extra } },
    knowledge: { channel_log_enabled: logging },
  });
  for (const logging of [true, false]) {
    test(`log_chats overrides global ${logging} for capture and earlier messages`, withDir(async dir => {
      logMessage(hermit(dir), { source: 'discord', chat_id: '1', direction: 'in', sender_id: 'U1', text: 'previous chatter' });
      const r = await run('<channel source="plugin:discord:discord" chat_id="1" user="U1"><@123> new message</channel>', dir);
      expect(r.exitCode).toBe(0);
      expect(unconsolidated(hermit(dir)).rows).toHaveLength(logging ? 1 : 2);
      expect(r.stdout.includes('Earlier messages in this chat')).toBe(!logging);
      await run('<channel source="telegram" chat_id="2" user="U1">other channel</channel>', dir);
      expect(unconsolidated(hermit(dir)).rows.some(row => row.source === 'telegram')).toBe(logging);
    }, config('discord', { log_chats: !logging }, logging)));
  }
  const prompt = (body: string, user = 'U1', source = 'discord', chat = '1') =>
    `<channel source="${source}" chat_id="${chat}" user="${user}">${body}</channel>`;
  const blocked = (stdout: string) => {
    expect(JSON.parse(stdout)).toEqual({
      decision: 'block', reason: 'passive chat: recorded, not addressed',
    });
    expect(stdout).not.toContain('channel-responder');
  };

  for (const [user, body, block] of [
    ['STRANGER', 'plain', true], ['U1', '<@123> hello', false], ['STRANGER', '<@123> hello', true],
  ] as const) {
    test(`capture ${user} ${body}`, withDir(async dir => {
      const r = await run(prompt(body, user), dir);
      expect(r.exitCode).toBe(0);
      expect(unconsolidated(hermit(dir)).rows.map(row => row.text)).toEqual([body]);
      if (block) blocked(r.stdout);
      else { expect(r.stdout).toContain('[channel reply reminder]'); expect(r.stdout).not.toContain('"decision":"block"'); }
    }, config()));
  }

  test('absent allowlist still blocks unaddressed chatter', withDir(async dir => {
    blocked((await run(prompt('plain'), dir)).stdout);
  }, config('discord', { allowed_users: undefined })));

  test('guild role membership is fetched, then reused for role mentions', withDir(async dir => {
    const stateDir = path.join(dir, 'discord');
    fs.mkdirSync(stateDir);
    fs.writeFileSync(path.join(stateDir, '.env'), 'DISCORD_BOT_TOKEN=test-token');
    const requests: string[] = [];
    const server = Bun.serve({ port: 0, fetch(req) {
      const route = new URL(req.url).pathname;
      requests.push(route);
      return Response.json(route.includes('/guilds/') ? { roles: ['456'] } : { parent_id: null, guild_id: 'guild', type: 0 });
    } });
    const env = { DISCORD_STATE_DIR: stateDir, HERMIT_DISCORD_API_URL: server.url.toString().replace(/\/$/, '') };
    try {
      const first = await run(prompt('<@&456> hello'), dir, env);
      expect(first.stdout).toContain('[channel reply reminder]');
      expect(first.stdout).toContain('Every reply, including a short acknowledgement');
      expect(first.stdout).not.toContain('Sub' + 'stantive');
      blocked((await run(prompt('<@&789> hello'), dir, env)).stdout);
      expect(requests).toEqual(['/channels/1', '/guilds/guild/members/123']);
      expect(unconsolidated(hermit(dir)).rows.length).toBe(2);
    } finally { server.stop(true); }
  }, config()));

  // The reply stage warms the metadata cache that record-operator-action's
  // cache-only gate reads, so it must run first: auditing first misread the very
  // first message of an unseen thread or guild in both directions.
  for (const [name, extra, chat, body, block] of [
    ['unseen thread chatter does not freeze the clock', { allowed_users: undefined }, 'thread', 'idle chatter', true],
    ['a first role mention still advances the clock', {}, '1', '<@&456> hello', false],
  ] as const) {
    test(name, withDir(async dir => {
      const stateDir = path.join(dir, 'discord');
      fs.mkdirSync(stateDir);
      fs.writeFileSync(path.join(stateDir, '.env'), 'DISCORD_BOT_TOKEN=test-token');
      const server = Bun.serve({ port: 0, fetch(req) {
        const route = new URL(req.url).pathname;
        return Response.json(route.includes('/guilds/')
          ? { roles: ['456'] }
          : { parent_id: '1', guild_id: 'guild', type: 11 });
      } });
      try {
        const env = { DISCORD_STATE_DIR: stateDir, HERMIT_DISCORD_API_URL: server.url.toString().replace(/\/$/, '') };
        const r = await run(prompt(body, 'U1', 'discord', chat), dir, env);
        if (block) blocked(r.stdout);
        else expect(r.stdout).toContain('[channel reply reminder]');
        expect(fs.existsSync(hermit(dir, 'state', 'last-operator-action.json'))).toBe(!block);
      } finally { server.stop(true); }
    }, config('discord', extra)));
  }

  test('Telegram handles require a complete token', withDir(async dir => {
    expect((await run(prompt('@handle hello', 'U1', 'telegram'), dir)).stdout).toContain('[channel reply reminder]');
    blocked((await run(prompt('@handlex hello', 'U1', 'telegram'), dir)).stdout);
  }, config('telegram')));

  test('unlisted non-allowed chat keeps its reminder and skips capture', withDir(async dir => {
    const r = await run(prompt('plain', 'STRANGER', 'telegram', 'other'), dir);
    expect(r.stdout).toContain('[channel reply reminder]');
    expect(unconsolidated(hermit(dir)).rows.length).toBe(0);
  }, config('telegram')));

  test('disabled logging still blocks without creating a database', withDir(async dir => {
    blocked((await run(prompt('plain'), dir)).stdout);
    expect(fs.existsSync(hermit(dir, 'state', 'channel-log.sqlite'))).toBe(false);
  }, config('discord', {}, false)));

  for (const scenario of ['thread', 'forbidden', 'empty'] as const) {
    test(`Discord lookup: ${scenario}`, withDir(async dir => {
      const stateDir = path.join(dir, 'discord');
      fs.mkdirSync(stateDir);
      fs.writeFileSync(path.join(stateDir, '.env'), 'DISCORD_BOT_TOKEN=test-token');
      let requests = 0;
      const server = Bun.serve({ port: 0, fetch(req) {
        requests++;
        expect(new URL(req.url).pathname).toBe('/channels/thread');
        return scenario === 'forbidden' ? new Response('', { status: 403 })
          : Response.json({ parent_id: '1', guild_id: 'guild', type: 11 });
      } });
      try {
        const env = { DISCORD_STATE_DIR: stateDir, HERMIT_DISCORD_API_URL: server.url.toString().replace(/\/$/, '') };
        for (const body of ['first message', 'second message']) {
          const r = await run(prompt(body, 'U1', 'discord', 'thread'), dir, env);
          expect(r.exitCode).toBe(0);
          if (scenario === 'thread') blocked(r.stdout);
          else expect(r.stdout).toContain('[channel reply reminder]');
        }
        expect(requests).toBe(scenario === 'empty' ? 0 : 1);
        expect(fs.existsSync(hermit(dir, 'state', 'channel-chats.json'))).toBe(scenario !== 'empty');
      } finally { server.stop(true); }
    }, config('discord', scenario === 'empty' ? { passive_chats: [] } : {})));
  }

  test('addressed turn injects a prior allowed un-mentioned message', withDir(async dir => {
    blocked((await run(prompt('plain'), dir)).stdout);
    const r = await run(prompt('<@123> hello'), dir);
    expect(r.stdout).toContain('plain');
    expect(r.stdout).toContain('last recorded reply');
  }, config()));

  test('stranger un-mentioned text is not injected on an addressed turn', withDir(async dir => {
    blocked((await run(prompt('plain', 'STRANGER'), dir)).stdout);
    const r = await run(prompt('<@123> hello'), dir);
    expect(r.stdout).not.toContain('plain');
    expect(r.stdout).not.toContain('last recorded reply');
  }, config()));

  test('one allowed row then eight stranger rows still injects the allowed row', withDir(async dir => {
    blocked((await run(prompt('first'), dir)).stdout);
    for (let i = 0; i < 8; i++) {
      blocked((await run(prompt(`stranger-${i}`, 'STRANGER'), dir)).stdout);
    }
    const r = await run(prompt('<@123> hello'), dir);
    expect(r.stdout).toContain('first');
  }, config()));

  test('inbound before the last outbound in the chat is not injected', withDir(async dir => {
    blocked((await run(prompt('plain'), dir)).stdout);
    logMessage(hermit(dir), {
      source: 'discord', chat_id: '1', direction: 'out', text: 'hermit replied',
    });
    const r = await run(prompt('<@123> hello'), dir);
    expect(r.stdout).not.toContain('plain');
    expect(r.stdout).not.toContain('last recorded reply');
  }, config()));

  test('more than eight eligible rows injects the newest eight oldest first', withDir(async dir => {
    for (let i = 0; i < 10; i++) {
      blocked((await run(prompt(`backlog-${i}`), dir)).stdout);
    }
    const r = await run(prompt('<@123> hello'), dir);
    expect(r.stdout).not.toContain('backlog-0');
    expect(r.stdout).not.toContain('backlog-1');
    let last = -1;
    for (let i = 2; i <= 9; i++) {
      const idx = r.stdout.indexOf(`backlog-${i}`);
      expect(idx).toBeGreaterThan(last);
      last = idx;
    }
  }, config()));

  test('a message older than six hours is not injected even with no outbound row', withDir(async dir => {
    logMessage(hermit(dir), {
      source: 'discord', chat_id: '1', direction: 'in', sender: 'U1', sender_id: 'U1',
      text: 'stale-plain', ts: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
    });
    const r = await run(prompt('<@123> hello'), dir);
    expect(r.stdout).not.toContain('stale-plain');
    expect(r.stdout).not.toContain('last recorded reply');
  }, config()));

  test('the addressed message body is not echoed in the reminder', withDir(async dir => {
    blocked((await run(prompt('prior-plain'), dir)).stdout);
    const r = await run(prompt('<@123> WAKE_BODY_UNIQUE'), dir);
    expect(r.stdout).toContain('prior-plain');
    expect(r.stdout).not.toContain('WAKE_BODY_UNIQUE');
  }, config()));

  test('a non-passive chat gets a reminder without the introducing sentence', withDir(async dir => {
    logMessage(hermit(dir), {
      source: 'discord', chat_id: '1', direction: 'in', sender: 'U1', sender_id: 'U1',
      text: 'should-not-appear',
    });
    const r = await run(prompt('<@123> hello'), dir);
    expect(r.stdout).toContain('[channel reply reminder]');
    expect(r.stdout).not.toContain('last recorded reply');
    expect(r.stdout).not.toContain('should-not-appear');
  }, config('discord', { passive_chats: [] })));

  test('disabled logging skips the digest even when the log already has rows', withDir(async dir => {
    logMessage(hermit(dir), {
      source: 'discord', chat_id: '1', direction: 'in', sender: 'U1', sender_id: 'U1',
      text: 'pre-logged-plain',
    });
    const r = await run(prompt('<@123> hello'), dir);
    expect(r.stdout).toContain('[channel reply reminder]');
    expect(r.stdout).not.toContain('pre-logged-plain');
    expect(r.stdout).not.toContain('last recorded reply');
  }, config('discord', {}, false)));
});
