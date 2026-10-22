// Spawns the settings-gate hook: the stdout JSON and exit code are the thing
// Claude Code actually consumes (tests/helpers/run.ts).
import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-settings-gate-');
afterAll(cleanup);

function fixture(config?: any): string {
  const dir = freshDir();
  const hermit = path.join(dir, '.hermit');
  fs.mkdirSync(path.join(hermit, 'state'), { recursive: true });
  if (config) fs.writeFileSync(path.join(hermit, 'config.json'), JSON.stringify(config));
  return dir;
}

function payload(opts: {
  dir: string;
  tool: 'Bash' | 'Edit' | 'Write';
  input: any;
  permission_mode?: string;
}): string {
  const transcript = path.join(opts.dir, 'terminal.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'configure routines' } }) + '\n');
  return JSON.stringify({
    transcript_path: transcript,
    hook_event_name: 'PreToolUse',
    tool_name: opts.tool,
    tool_input: opts.input,
    cwd: opts.dir,
    permission_mode: opts.permission_mode ?? 'default',
  });
}

async function runGate(stdin: string, dir: string) {
  return runScript('settings-gate.ts', {
    stdin,
    cwd: dir,
    env: { AGENT_DIR: path.join(dir, '.hermit') },
  });
}

function cmd(rest: string): string {
  return `bun /p/scripts/settings-edit.ts .hermit/config.json ${rest}`;
}

test('channel-access group-add asks with the listening chat in the reason', async () => {
  const dir = fixture();
  for (const command of [
    'bun /p/scripts/channel-access.ts /state group-add discord 123',
    'bun "/p with spaces/scripts/channel-access.ts" "/state with spaces" group-add telegram -123 --no-mention',
    "bun /p/scripts/channel-access.ts /state 'group-add' discord 123",
    'bun /p/scripts/channel-access.ts /state gr\\oup-add discord 123',
  ]) {
    const r = await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir);
    expect(r.exitCode).toBe(0);
    const output = JSON.parse(r.stdout).hookSpecificOutput;
    expect(output.permissionDecision).toBe('ask');
    expect(output.permissionDecisionReason).toContain(command.includes('telegram') ? 'listen in telegram chat -123' : 'listen in discord chat 123');
  }
  const chained = await runGate(payload({ dir, tool: 'Bash', input: {
    command: `bun /p/scripts/channel-access.ts /state group-add discord 123 && ${cmd('set permission_mode bypassPermissions')}`,
  } }), dir);
  expect(JSON.parse(chained.stdout).hookSpecificOutput.permissionDecisionReason).toContain('permission_mode');
  const r = await runGate(payload({ dir, tool: 'Bash', input: { command: 'bun /p/scripts/channel-access.ts /state help' } }), dir);
  expectSilent(r);
});

function expectAsk(stdout: string, reason: string) {
  expect(JSON.parse(stdout.trim())).toEqual({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  });
}

function expectSilent(r: { exitCode: number; stdout: string }) {
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toBe('');
}

describe('settings-gate ask list', () => {
  test('each ask path as leaf and as container', async () => {
    const dir = fixture();
    const cases: Array<[string, string]> = [
      ['set env \'{"A":"x"}\'', 'Hermit setting: env.A=[set]'],
      ['set env.X foo', 'Hermit setting: env.X=[set]'],
      ['set monitors \'[]\'', 'Hermit setting: monitors=[]'],
      ['set channels.discord.allowed_users \'["u"]\'', 'Hermit setting: channels.discord.allowed_users=["u"]'],
      ['set routines.0.precheck tools/x.sh', 'Hermit setting: routines.0.precheck=tools/x.sh'],
      ['set channels.slack.send_script tools/s.sh', 'Hermit setting: channels.slack.send_script=tools/s.sh'],
      ['set channels.discord.attributes.user_id user', 'Hermit setting: channels.discord.attributes.user_id=user'],
      ['set channels.slack.plugin x', 'Hermit setting: channels.slack.plugin=x'],
      ['set permission_mode default', 'Hermit setting: permission_mode=default'],
      ['set boot_skill /x:boot', 'Hermit setting: boot_skill=/x:boot'],
      ['set shutdown_skill /x:stop', 'Hermit setting: shutdown_skill=/x:stop'],
      ['set backup.enabled true', 'Hermit setting: backup.enabled=true'],
      ['set voice.prose \'"be brief"\'', 'Hermit setting: voice.prose="be brief"'],
    ];
    for (const [rest, reason] of cases) {
      const r = await runGate(payload({ dir, tool: 'Bash', input: { command: cmd(rest) } }), dir);
      expect(r.exitCode).toBe(0);
      expectAsk(r.stdout, reason);
    }
  });

  test('channel replacement gates send paths but allows brief changes', async () => {
    const dir = fixture({ channels: { slack: { send_script: 'tools/old.sh', morning_brief: { time: '07:00' } } } });
    const changedScript = await runGate(payload({ dir, tool: 'Bash', input: {
      command: cmd(`set channels.slack '{"send_script":"tools/s.sh","morning_brief":{"time":"07:00"}}'`),
    } }), dir);
    expect(changedScript.exitCode).toBe(0);
    expect(JSON.parse(changedScript.stdout).hookSpecificOutput.permissionDecision).toBe('ask');
    expectSilent(await runGate(payload({ dir, tool: 'Bash', input: {
      command: cmd(`set channels.slack '{"send_script":"tools/old.sh","morning_brief":{"time":"08:00"}}'`),
    } }), dir));
  });

  test('apply-known permissions asks', async () => {
    const dir = fixture();
    const r = await runGate(
      payload({ dir, tool: 'Bash', input: { command: cmd('apply-known permissions default') } }),
      dir,
    );
    expect(r.exitCode).toBe(0);
    expectAsk(r.stdout, 'Hermit setting: permission_mode=default');
  });

  test('set voice.style Concise allows', async () => {
    const dir = fixture();
    const r = await runGate(
      payload({ dir, tool: 'Bash', input: { command: cmd('set voice.style Concise') } }),
      dir,
    );
    expectSilent(r);
  });

  for (const [key, value] of [['isolate_chats', 'false'], ['shared_chats', "'[]'"], ['operators', "'[]'"], ['instructions', "'[]'"]]) {
    test(`channel ${key} asks`, async () => {
      const dir = fixture();
      const r = await runGate(payload({ dir, tool: 'Bash', input: { command: cmd(`set channels.discord.${key} ${value}`) } }), dir);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('ask');
    });
  }

  test('channel recording and piped hatch-config remain silent', async () => {
    const dir = fixture();
    for (const command of [cmd('set channels.discord.log_chats false'),
      `echo '{"channels":{"discord":{"shared_chats":["C1"]}}}' | bun /p/scripts/hatch-config.ts .hermit --reinit`]) {
      expectSilent(await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir));
    }
  });

  test('per-channel everyday keys and retired dials allow', async () => {
    const dir = fixture();
    for (const rest of [
      'set channels.discord.morning_brief \'{"enabled":true,"time":"07:00"}\'',
      'unset channels.discord.settings_policy',
      'unset settings_permissions',
      'unset settings_from_chat',
    ]) {
      const r = await runGate(payload({ dir, tool: 'Bash', input: { command: cmd(rest) } }), dir);
      expectSilent(r);
    }
  });

  test('a quoted script or config path still asks', async () => {
    const dir = fixture();
    for (const command of [
      'bun "/home/x y/scripts/settings-edit.ts" .hermit/config.json set permission_mode default',
      'bun /p/scripts/settings-edit.ts "/home/x y/.hermit/config.json" set permission_mode default',
    ]) {
      const r = await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir);
      expect(r.exitCode).toBe(0);
      expectAsk(r.stdout, 'Hermit setting: permission_mode=default');
    }
  });

  test('a target the shell would expand asks', async () => {
    const dir = fixture();
    const command = 'P=permission_mode; ' + cmd('set $P default');
    const r = await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir);
    expect(r.exitCode).toBe(0);
    expectAsk(r.stdout, 'Hermit setting: $P');
  });
});

describe('settings-gate routines container', () => {
  const current = [
    { id: 'reflect', precheck: 'reflect' },
    { id: 'brief' },
  ];

  test('set routines.0 with a precheck asks, without one allows', async () => {
    const dir = fixture({ routines: current });
    const withGate = JSON.stringify({ id: 'brief', precheck: 'tools/x.sh' });
    const asked = await runGate(
      payload({ dir, tool: 'Bash', input: { command: cmd(`set routines.0 '${withGate}'`) } }),
      dir,
    );
    expect(asked.exitCode).toBe(0);
    expectAsk(asked.stdout, `Hermit setting: routines.0=${withGate}`);

    const without = JSON.stringify({ id: 'brief' });
    const allowed = await runGate(
      payload({ dir, tool: 'Bash', input: { command: cmd(`set routines.0 '${without}'`) } }),
      dir,
    );
    expectSilent(allowed);
  });

  test('a reorder with the same gates allows', async () => {
    const dir = fixture({ routines: current });
    const reordered = JSON.stringify([{ id: 'brief' }, { id: 'reflect', precheck: 'reflect' }]);
    const r = await runGate(
      payload({ dir, tool: 'Bash', input: { command: cmd(`set routines '${reordered}'`) } }),
      dir,
    );
    expectSilent(r);
  });

  test('an unparseable routines value asks', async () => {
    const dir = fixture({ routines: current });
    const r = await runGate(
      payload({ dir, tool: 'Bash', input: { command: cmd("set routines 'not json'") } }),
      dir,
    );
    expect(r.exitCode).toBe(0);
    expectAsk(r.stdout, 'Hermit setting: routines=not json');
  });
});

describe('settings-gate reason shape', () => {
  test('a chained safe write plus an asked write names only the asked target', async () => {
    const dir = fixture();
    const command =
      cmd('set model haiku') + ' && ' + cmd('set permission_mode default');
    const r = await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir);
    expect(r.exitCode).toBe(0);
    expectAsk(r.stdout, 'Hermit setting: permission_mode=default');
  });

  test('a secret env value renders [set]', async () => {
    const dir = fixture();
    const r = await runGate(
      payload({ dir, tool: 'Bash', input: { command: cmd('set env.KEY sk-x') } }),
      dir,
    );
    expect(r.exitCode).toBe(0);
    expectAsk(r.stdout, 'Hermit setting: env.KEY=[set]');
  });

  test('a bare integer env value passes through', async () => {
    const dir = fixture();
    const r = await runGate(
      payload({ dir, tool: 'Bash', input: { command: cmd('set env.N 20000') } }),
      dir,
    );
    expect(r.exitCode).toBe(0);
    expectAsk(r.stdout, 'Hermit setting: env.N=20000');
  });
});

describe('settings-gate file writes', () => {
  test('Edit and Write on config.json ask', async () => {
    const dir = fixture();
    const fp = path.join(dir, '.hermit', 'config.json');
    for (const tool of ['Edit', 'Write'] as const) {
      const r = await runGate(payload({ dir, tool, input: { file_path: fp } }), dir);
      expect(r.exitCode).toBe(0);
      expectAsk(r.stdout, 'Hermit setting: config.json');
    }
  });

  test('a shell write onto config.json asks', async () => {
    const dir = fixture();
    for (const command of [
      'cat > .hermit/config.json <<EOF\n{}\nEOF',
      'cat /tmp/new.json > "$HERMIT_DIR/config.json"',
      'cp /tmp/new.json .hermit/config.json',
      'jq . /tmp/new.json | tee .hermit/config.json',
      'sed -i \'s/haiku/opus/\' .hermit/config.json',
    ]) {
      const r = await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir);
      expect(r.exitCode).toBe(0);
      expectAsk(r.stdout, 'Hermit setting: config.json');
    }
  });

  test('a real redirect beside quoted or heredoc text still asks', async () => {
    const dir = fixture();
    for (const command of [
      'cat > r.md <<EOF\nsee > .hermit/config.json\nEOF\necho x > .hermit/config.json',
      'echo "it\'s" > .hermit/config.json \'x\'',
      'echo \'<<X\'; echo x > .hermit/config.json',
      'cat <<<"x" > .hermit/config.json',
      'bash -c \'echo x > .hermit/config.json\'',
      'bash <<\'EOF\'\necho x > .hermit/config.json\nEOF',
      'echo "$(echo x > .hermit/config.json)"',
      'cat <<EOF > r.md\n$(echo x > .hermit/config.json)\nEOF',
      'cat <<EOF\nunterminated > .hermit/config.json',
    ]) {
      const r = await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir);
      expect(r.exitCode).toBe(0);
      expectAsk(r.stdout, 'Hermit setting: config.json');
    }
    const r = await runGate(payload({ dir, tool: 'Bash', input: { command: 'echo x > .hermit/resident-prompt.md' } }), dir);
    expectAsk(r.stdout, 'Hermit setting: resident-prompt.md');
  });

  test('a protected path inside quoted or heredoc text prints nothing', async () => {
    const dir = fixture();
    for (const command of [
      "bun /p/scripts/apply-settings.ts .claude/settings.json deny-add 'Bash(*> *.hermit/resident-prompt.md*)' 'Bash(*>.hermit/resident-prompt.md*)'",
      "cat > .hermit/helper-reports/x.md <<'EOF'\nquoted: `> .hermit/config.json`\nEOF",
      'cat <<-EOF > r.md\n\tsee > .hermit/config.json\n\tEOF',
      "cat <<'EOF' > r.md\n$(echo x > .hermit/config.json)\nEOF",
      'echo "a > .hermit/config.json b"',
    ]) {
      const r = await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir);
      expectSilent(r);
    }
  });

  test('reading config.json through the shell prints nothing', async () => {
    const dir = fixture();
    for (const command of [
      'jq .model .hermit/config.json > /tmp/out.txt',
      'sed -n 5p .hermit/config.json',
      'cp .hermit/config.json /tmp/backup.json',
    ]) {
      const r = await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir);
      expectSilent(r);
    }
  });
});

describe('settings-gate silent paths', () => {
  test('reads print nothing', async () => {
    const dir = fixture();
    for (const rest of ['show', 'get permission_mode', 'history', 'record-file HEARTBEAT.md']) {
      const r = await runGate(payload({ dir, tool: 'Bash', input: { command: cmd(rest) } }), dir);
      expectSilent(r);
    }
  });

  test('ls prints nothing', async () => {
    const dir = fixture();
    const r = await runGate(payload({ dir, tool: 'Bash', input: { command: 'ls' } }), dir);
    expectSilent(r);
  });

  test('malformed stdin exits 0 printing nothing', async () => {
    const dir = fixture();
    const r = await runGate('not json at all', dir);
    expectSilent(r);
  });

  test('oversized stdin asks', async () => {
    const dir = fixture();
    const r = await runGate('x'.repeat(1.5 * 1024 * 1024), dir);
    expect(r.exitCode).toBe(0);
    expectAsk(r.stdout, 'Hermit setting: tool call too large to inspect');
  });
});

test('resident instructions and operator overlay are protected for every write tool', async () => {
  const dir = fixture();
  for (const name of ['claude-settings.json', 'resident-prompt.md', 'helper-prompt.md', 'state/helper-system-prompt.md', 'state/resident-system-prompt.md']) {
    const file = `.hermit/${name}`;
    for (const tool of ['Edit', 'Write'] as const) {
      const result = await runGate(payload({ dir, tool, input: { file_path: file, content: '{}' } }), dir);
      expectAsk(result.stdout, `Hermit setting: ${name}`);
    }
    for (const command of [`echo x > ${file}`, `sed -i s/a/b/ ${file}`, `cp other ${file}`]) {
      const result = await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir);
      expectAsk(result.stdout, `Hermit setting: ${name}`);
    }
  }
  const viaStateVar = await runGate(payload({ dir, tool: 'Bash', input: { command: 'echo x > "$STATE_DIR/helper-system-prompt.md"' } }), dir);
  expectAsk(viaStateVar.stdout, 'Hermit setting: helper-system-prompt.md');
});

describe('static settings policy', () => {
  test('new protected paths ask for both directions and unset', async () => {
    const dir = fixture();
    for (const field of ['operator_profile', 'channels.primary', 'channels.discord.state_dir',
      'channels.discord.marketplace', 'channels.discord.enabled', 'channels.discord.passive_chats', 'channels.discord.instructions', 'channels.discord.instructions.0', 'channels.discord.instructions.0.text',
      'telemetry_export.enabled',
      'telemetry_export.destination.url', 'telemetry_export.destination.bearer_env',
      'telemetry_export.redact_operator_text', 'artifacts.publish_authorized', 'artifacts.backend',
      'docker.packages', 'docker.recommended_plugins.0.enabled', 'docker.fleet_mesh', 'remote', 'chrome', 'auth_mode']) {
      for (const rest of [`set ${field} true`, `set ${field} false`, `unset ${field}`, `toggle ${field}`]) {
        const r = await runGate(payload({ dir, tool: 'Bash', input: { command: cmd(rest) } }), dir);
        expectAsk(r.stdout, `Hermit setting: ${field}${rest.startsWith('set ') ? '=' + rest.split(' ').at(-1) : ''}`);
      }
    }
  });

  test('ordinary preferences and routine commands stay silent', async () => {
    const dir = fixture();
    for (const field of ['agent_name', 'language', 'timezone', 'model', 'effort', 'escalation',
      'always_on', 'auto_session', 'ask_gate', 'budget.daily_usd', 'budget.action',
      'heartbeat.enabled', 'watchdog.scheduler_enabled', 'knowledge.channel_log_enabled',
      'channels.discord.log_chats', 'routines.0.skill', 'routines.0.enabled',
      'routines.0.schedule', 'scheduled_checks.0.skill', 'scheduled_checks']) {
      expectSilent(await runGate(payload({ dir, tool: 'Bash', input: { command: cmd(`unset ${field}`) } }), dir));
    }
  });

  test('parent replacements compare protected content and show paths only', async () => {
    const dir = fixture({
      voice: { prose: 'private instructions', style: 'Concise' },
      channels: { discord: { enabled: true, allowed_users: ['a', 'b'], morning_brief: { time: '07:00' } } },
      artifacts: { backend: 'claude', dashboard: true },
      telemetry_export: { destination: { url: 'https://private.example', type: 'webhook' }, interval_hours: 24 },
      docker: { packages: ['git'], fleet_mesh: false },
    });
    const cases: Array<[string, any, string | null]> = [
      ['voice', { style: 'Detailed', prose: 'private instructions' }, null],
      ['voice', { style: 'Detailed' }, 'voice.prose'],
      ['channels.discord', { morning_brief: { time: '08:00' }, allowed_users: ['a', 'b'], enabled: true }, null],
      ['channels.discord', { enabled: false, allowed_users: ['a', 'b'] }, 'channels.discord.enabled'],
      ['channels.discord', { enabled: true, allowed_users: ['b', 'a'] }, 'channels.discord.allowed_users'],
      ['channels.discord', { enabled: true, allowed_users: ['a', 'b'], passive_chats: ['C9'] },
        'channels.discord.passive_chats'],
      ['channels.telegram', {}, 'channels.telegram'],
      ['channels', { discord: { enabled: true, allowed_users: ['a', 'b'] }, telegram: {} }, 'channels.telegram'],
      ['channels', {}, 'channels.discord.allowed_users, channels.discord.enabled'],
      ['artifacts', { backend: 'claude', dashboard: false }, null],
      ['artifacts', {}, 'artifacts.backend'],
      ['telemetry_export', { interval_hours: 12, destination: { type: 'webhook', url: 'https://private.example' } }, null],
      ['telemetry_export', { destination: { url: 'https://changed.example' } }, 'telemetry_export.destination'],
      ['docker', { packages: ['git'], fleet_mesh: false }, null],
      ['docker', { packages: ['curl'], fleet_mesh: false }, 'docker.packages'],
    ];
    for (const [field, value, asked] of cases) {
      const command = cmd(`set ${field} '${JSON.stringify(value)}'`);
      const r = await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir);
      if (asked) expectAsk(r.stdout, `Hermit setting: ${asked}`);
      else expectSilent(r);
      expect(r.stdout).not.toContain('private.example');
      expect(r.stdout).not.toContain('private instructions');
    }
    for (const rest of ['unset voice', 'set voice none', 'set voice clear']) {
      expectAsk((await runGate(payload({ dir, tool: 'Bash', input: { command: cmd(rest) } }), dir)).stdout,
        'Hermit setting: voice.prose');
    }
  });

  test('missing, null, and opaque parent writes stay distinct', async () => {
    const dir = fixture();
    for (const [rest, asked] of [
      [`set voice '{"style":"Concise"}'`, null],
      [`set voice '{"prose":null}'`, 'voice.prose'],
      ['unset voice', null], ['set voice malformed', 'voice'], ['set voice "$VALUE"', 'voice'],
      ['toggle voice', 'voice'], ['set voice', 'voice'],
      ['set voice {"style":"Concise","prose":"x"}', 'voice'],
    ] as const) {
      const r = await runGate(payload({ dir, tool: 'Bash', input: { command: cmd(rest) } }), dir);
      if (asked) expectAsk(r.stdout, `Hermit setting: ${asked}`);
      else expectSilent(r);
    }
    fs.writeFileSync(path.join(dir, '.hermit/config.json'), '{');
    expectAsk((await runGate(payload({ dir, tool: 'Bash', input: { command: cmd('unset voice') } }), dir)).stdout,
      'Hermit setting: voice');
  });

  test('the named target and tool cwd determine the parent baseline', async () => {
    const dir = fixture({ voice: { prose: 'resident' } });
    fs.writeFileSync(path.join(dir, 'other config.json'), JSON.stringify({ voice: { style: 'Concise' } }));
    const command = `bun /p/scripts/settings-edit.ts 'other config.json' set voice '{"style":"Detailed"}'`;
    expectSilent(await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir));
    for (const command of [
      `bun /p/scripts/settings-edit.ts "$CONFIG" unset voice`,
      `bun /p/scripts/settings-edit.ts *.json unset voice`,
      `cd elsewhere && ${cmd('unset voice')}`,
    ]) expectAsk((await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir)).stdout, 'Hermit setting: voice');
  });

  test('routine commands and precheck removal preserve the existing exception', async () => {
    const dir = fixture({ routines: [{ id: 'custom', skill: 'old', precheck: 'tools/check.sh', precheck_timeout_s: 30 }] });
    for (const rest of [
      `set routines '[{"id":"custom","skill":"new"}]'`,
      `set routines.0 '{"id":"custom","skill":"new","precheck":"tools/check.sh","precheck_timeout_s":30}'`,
      'unset routines',
    ]) expectSilent(await runGate(payload({ dir, tool: 'Bash', input: { command: cmd(rest) } }), dir));
    for (const field of ['precheck', 'precheck_timeout_s']) {
      expectAsk((await runGate(payload({ dir, tool: 'Bash', input: { command: cmd(`unset routines.0.${field}`) } }), dir)).stdout,
        `Hermit setting: routines.0.${field}`);
    }
  });
});

for (const mode of ['bypassPermissions', 'auto', 'default']) {
  for (const [args, label] of [
    ['pair discord ABC123', 'pair discord code ABC123'],
    ['policy telegram allowlist', 'policy telegram allowlist'],
    ['group-add discord 123 --mention no --allow none --shared no --passive yes --ack-off', 'listen in discord chat 123: mention=no allow=anyone shared=no passive=yes + seen-emoji off (channel-wide)'],
    ["'group-add' 'telegram' '-123' --mention 'yes' --allow '1,2' --shared yes --passive no --nicknames '[\"bot\"]'", 'listen in telegram chat -123: mention=yes allow=2 ids shared=yes passive=no + nickname triggers (channel-wide)'],
  ]) {
    test(`channel access ${mode}: ${args}`, async () => {
      const dir = fixture();
      const r = await runGate(payload({ dir, tool: 'Bash', permission_mode: mode, input: { command: `bun '/p with spaces/channel-access.ts' '/state with spaces' ${args}` } }), dir);
      expect(r.exitCode).toBe(0);
      const output = JSON.parse(r.stdout).hookSpecificOutput;
      expect(output.permissionDecision).toBe(mode === 'bypassPermissions' ? 'deny' : 'ask');
      expect(output.permissionDecisionReason).toBe(mode === 'bypassPermissions'
        ? 'Channel pairing and group enrolment are refused in bypass mode; run /hermitd:channel-setup from a normal session.'
        : `Hermit setting: ${label}`);
    });
  }
}

test('channel access expansion fallback and multiple writes remain guarded', async () => {
  const dir = fixture();
  for (const mode of ['default', 'bypassPermissions']) {
    const r = await runGate(payload({ dir, tool: 'Bash', permission_mode: mode, input: { command: 'bun channel-access.ts "$STATE" "$VERB" discord "$CODE"' } }), dir);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe(mode === 'default' ? 'ask' : 'deny');
  }
  const r = await runGate(payload({ dir, tool: 'Bash', input: { command: 'bun channel-access.ts /state pair discord ABC123 && bun channel-access.ts /state policy telegram allowlist' } }), dir);
  const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
  expect(reason).toContain('pair discord code ABC123');
  expect(reason).toContain('policy telegram allowlist');
});

test('quoted nickname alternation does not truncate enrollment approval values', async () => {
  const dir = fixture();
  const r = await runGate(payload({ dir, tool: 'Bash', input: {
    command: `bun channel-access.ts /state group-add discord 123 --nicknames '["bot|helper"]' --mention no --allow none --shared yes --passive yes --ack-off`,
  } }), dir);
  expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toBe('Hermit setting: listen in discord chat 123: mention=no allow=anyone shared=yes passive=yes + nickname triggers (channel-wide) + seen-emoji off (channel-wide)');
});

describe('routine chat binding', () => {
  const ROUTINES = [
    { id: 'brief', schedule: '0 8 * * *', skill: 'hermitd:brief', enabled: true },
    { id: 'digest', schedule: '0 9 * * 1', skill: 'feed:digest', enabled: true, chat: 'discord:777' },
  ];

  /** A gate run whose turn opened on a discord message from `chatId`, or a terminal turn when null. */
  async function runFrom(chatId: string | null, rest: string, command = cmd(rest), userId = 'u1') {
    const dir = fixture({ channels: { discord: { enabled: true, default_chat_id: '100', allowed_users: ['u1', 'u2'] } }, routines: ROUTINES });
    let transcript: string | undefined;
    if (chatId !== null) {
      transcript = path.join(dir, 'transcript.jsonl');
      fs.writeFileSync(transcript, JSON.stringify({
        type: 'user',
        message: { content: `<channel source="plugin:discord:discord" chat_id="${chatId}" user_id="${userId}">every monday post the digest here</channel>` },
      }) + '\n');
    }
    const base = JSON.parse(payload({ dir, tool: 'Bash', input: { command } }));
    return runGate(JSON.stringify({ ...base, transcript_path: transcript ?? base.transcript_path }), dir);
  }

  const asked = (r: { stdout: string }) =>
    r.stdout.trim() !== '' && JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === 'ask';
  const added = (chat: string) =>
    `set routines.2 '${JSON.stringify({ id: 'weekly', schedule: '0 9 * * 1', skill: 'hermitd:brief', enabled: true, chat })}'`;

  test('a new routine bound to the asking chat applies without a prompt', async () => {
    expect(asked(await runFrom('555', added('discord:555')))).toBe(false);
  });

  test('a new routine bound to another chat asks', async () => {
    expect(asked(await runFrom('555', added('discord:999')))).toBe(true);
  });

  test('a binding written from a turn with no channel message asks', async () => {
    expect(asked(await runFrom(null, added('discord:555')))).toBe(true);
  });

  test('binding an existing routine asks, even to the asking chat', async () => {
    expect(asked(await runFrom('555', 'set routines.0.chat discord:555'))).toBe(true);
    expect(asked(await runFrom('555', `set routines.0 '${JSON.stringify({ ...ROUTINES[0], chat: 'discord:555' })}'`))).toBe(true);
    expect(asked(await runFrom('555', `set routines.1 '${JSON.stringify({ ...ROUTINES[1], chat: 'discord:555' })}'`))).toBe(true);
  });

  test('the owning chat removes a binding or edits its routine without a prompt', async () => {
    expect(asked(await runFrom('777', 'set routines.1.chat none'))).toBe(false);
    expect(asked(await runFrom('777', 'unset routines.1.chat'))).toBe(false);
    expect(asked(await runFrom('777', `set routines.1 '${JSON.stringify({ ...ROUTINES[1], enabled: false })}'`))).toBe(false);
    expect(asked(await runFrom('777', 'set routines.1.enabled false'))).toBe(false);
    expect(asked(await runFrom('777', 'unset routines.1'))).toBe(false);
  });

  test('another chat touching a routine it does not own asks', async () => {
    expect(asked(await runFrom('555', 'set routines.1.enabled false'))).toBe(true);
    expect(asked(await runFrom('555', 'unset routines.1'))).toBe(true);
    expect(asked(await runFrom('555', 'set routines.0.enabled false'))).toBe(true);
    // Overwriting the operator's routine under a fresh id is still that routine.
    const replaced = { id: 'brief2', schedule: '0 8 * * *', skill: 'hermitd:brief', enabled: true, chat: 'discord:555' };
    expect(asked(await runFrom('555', `set routines.0 '${JSON.stringify(replaced)}'`))).toBe(true);
    expect(asked(await runFrom('555', `set routines '${JSON.stringify(ROUTINES)}'`))).toBe(true);
  });

  test('the home chat and the terminal edit the operator routines without a prompt', async () => {
    expect(asked(await runFrom('100', 'set routines.0.enabled false'))).toBe(false);
    expect(asked(await runFrom(null, 'set routines.0.enabled false'))).toBe(false);
    expect(asked(await runFrom(null, 'unset routines.1'))).toBe(false);
  });

  const proposal = (entry: unknown) =>
    `bun /p/scripts/proposal.ts routine .hermit <<'HERMIT_ROUTINE'\n${JSON.stringify(entry)}\nHERMIT_ROUTINE`;
  const weekly = { id: 'weekly', schedule: '0 9 * * 1', skill: 'hermitd:brief', enabled: true };

  test('an accepted routine proposal follows the routine write rules', async () => {
    expect(asked(await runFrom(null, '', proposal(weekly)))).toBe(false);
    expect(asked(await runFrom('100', '', proposal(weekly)))).toBe(false);
    expect(asked(await runFrom('555', '', proposal({ ...weekly, chat: 'discord:555' })))).toBe(false);
    expect(asked(await runFrom('100', '', proposal(weekly), 'u2'))).toBe(true);
    expect(asked(await runFrom(null, '', proposal({ ...weekly, precheck: 'scripts/gate.sh' })))).toBe(true);
    expect(asked(await runFrom('555', '', proposal({ ...weekly, chat: 'discord:999' })))).toBe(true);
    expect(asked(await runFrom('555', '', proposal({ ...ROUTINES[1], enabled: false })))).toBe(true);
    expect(asked(await runFrom(null, '', 'bun /p/scripts/proposal.ts routine .hermit < entry.json'))).toBe(true);
  });
});

test('instruction-only parent replacements protect changes and removals', async () => {
  const instructions = [{ chat_id: 'C1', text: 'Review carefully' }];
  const dir = fixture({ channels: { discord: { instructions } } });
  for (const [field, value, asks] of [
    ['channels.discord', { instructions, log_chats: false }, false],
    ['channels.discord', { instructions: [{ chat_id: 'C1', text: 'Changed' }] }, true],
    ['channels', { discord: {} }, true],
  ] as const) {
    const r = await runGate(payload({ dir, tool: 'Bash', input: { command: cmd(`set ${field} '${JSON.stringify(value)}'`) } }), dir);
    if (asks) expectAsk(r.stdout, 'Hermit setting: channels.discord.instructions');
    else expectSilent(r);
  }
});

test('an apostrophe spliced into a single-quoted value stays in the ask label', async () => {
  const dir = fixture();
  const text = `Don'\\''t skip evidence`;
  const r = await runGate(payload({ dir, tool: 'Bash', input: { command: cmd(`set channels.discord.instructions.0 '{"chat_id":"C1","text":"${text}"}'`) } }), dir);
  expectAsk(r.stdout, `Hermit setting: channels.discord.instructions.0={"chat_id":"C1","text":"${text}"}`);
});


test('routine writes ask for non-primary, empty operators and unreadable origins', async () => {
  for (const operators of [undefined, []]) {
    const dir = fixture({ channels: { discord: { allowed_users: ['primary', 'member'], operators } },
      routines: [{ id: 'review', chat: 'discord:100', enabled: true }] });
    const transcript = path.join(dir, 'member.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: {
      content: '<channel source="discord" chat_id="100" user_id="member">request</channel>',
    } }) + '\n');
    for (const rest of ["set routines.1 '{\"id\":\"new\",\"chat\":\"discord:100\"}'",
      'set routines.0.skill hermitd:brief', 'set routines.0.enabled true', 'unset routines.0']) {
      const input = JSON.parse(payload({ dir, tool: 'Bash', input: { command: cmd(rest) } }));
      const r = await runGate(JSON.stringify({ ...input, transcript_path: transcript }), dir);
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('ask');
    }
    const input = JSON.parse(payload({ dir, tool: 'Bash', input: { command: cmd('unset routines.0') } }));
    const r = await runGate(JSON.stringify({ ...input, transcript_path: path.join(dir, 'missing') }), dir);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('ask');
  }
});
