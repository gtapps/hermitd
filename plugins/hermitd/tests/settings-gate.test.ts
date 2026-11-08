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
  test('Edit and Write on config-run scripts ask, including symlinks', async () => {
    const dir = fixture({
      routines: [{ precheck: 'tools/gate.sh' }, { precheck: 'reflect' }],
      channels: { example: { send_script: 'tools/send.sh' } },
      monitors: [{ command: 'bun ${CLAUDE_PROJECT_DIR}/tools/watch.ts' }],
    });
    fs.mkdirSync(path.join(dir, 'tools'));
    for (const name of ['gate.sh', 'send.sh', 'watch.ts', 'other.sh', 'reflect']) {
      fs.writeFileSync(path.join(dir, 'tools', name), '', { mode: 0o755 });
    }
    fs.symlinkSync('gate.sh', path.join(dir, 'tools', 'alias.sh'));
    for (const [file, setting, display] of [
      ['gate.sh', 'routines[0].precheck', 'tools/gate.sh'],
      ['send.sh', 'channels.example.send_script', 'tools/send.sh'],
      ['watch.ts', 'monitors[0].command', '${CLAUDE_PROJECT_DIR}/tools/watch.ts'],
      ['alias.sh', 'routines[0].precheck', 'tools/gate.sh'],
    ]) {
      for (const tool of ['Edit', 'Write'] as const) {
        const r = await runGate(payload({ dir, tool, input: { file_path: path.join(dir, 'tools', file) } }), dir);
        expect(r.exitCode).toBe(0);
        expectAsk(r.stdout, `Hermit setting: script run by ${setting} (${display})`);
      }
    }
    for (const file of ['other.sh', 'reflect']) {
      expectSilent(await runGate(payload({ dir, tool: 'Edit', input: { file_path: path.join(dir, 'tools', file) } }), dir));
    }
    fs.unlinkSync(path.join(dir, '.hermit', 'config.json'));
    expectSilent(await runGate(payload({ dir, tool: 'Write', input: { file_path: path.join(dir, 'tools', 'gate.sh') } }), dir));
  });

  test('writes to missing or non-executable config-run scripts and quoted watch paths ask', async () => {
    const dir = fixture({
      routines: [{ precheck: 'tools/gate.sh' }, { precheck: 'tools/missing.sh' }],
      monitors: [{ command: 'bash "${CLAUDE_PROJECT_DIR}/tools/watch.sh"' }],
    });
    fs.mkdirSync(path.join(dir, 'tools'));
    fs.writeFileSync(path.join(dir, 'tools', 'gate.sh'), '', { mode: 0o644 });
    fs.writeFileSync(path.join(dir, 'tools', 'watch.sh'), '', { mode: 0o644 });
    for (const [file, setting, display] of [
      ['gate.sh', 'routines[0].precheck', 'tools/gate.sh'],
      ['missing.sh', 'routines[1].precheck', 'tools/missing.sh'],
      ['watch.sh', 'monitors[0].command', '"${CLAUDE_PROJECT_DIR}/tools/watch.sh"'],
    ]) {
      const r = await runGate(payload({ dir, tool: 'Write', input: { file_path: path.join(dir, 'tools', file) } }), dir);
      expectAsk(r.stdout, `Hermit setting: script run by ${setting} (${display})`);
    }
  });

  test('shell writes to config-run scripts ask, while reads, removals and literal text stay silent', async () => {
    const dir = fixture({ routines: [{ precheck: 'tools/gate.sh' }] });
    fs.mkdirSync(path.join(dir, 'tools'));
    for (const file of ['gate.sh', 'other.sh']) {
      fs.writeFileSync(path.join(dir, 'tools', file), '', { mode: 0o755 });
    }
    fs.symlinkSync('gate.sh', path.join(dir, 'tools', 'alias.sh'));
    for (const command of [
      'echo x > tools/gate.sh', 'echo x >> ./tools/gate.sh',
      'cp /tmp/a tools/gate.sh', 'mv /tmp/a tools/gate.sh', 'tee tools/gate.sh',
      'sed -i s/a/b/ tools/gate.sh', `echo x > "${path.join(dir, 'tools/gate.sh')}"`,
      'echo x > tools/alias.sh',
    ]) {
      const r = await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir);
      expect(r.exitCode).toBe(0);
      expectAsk(r.stdout, 'Hermit setting: script run by routines[0].precheck (tools/gate.sh)');
    }
    for (const command of [
      'echo x > tools/other.sh', 'cp /tmp/a tools/other.sh', 'tee tools/other.sh',
      'sed -i s/a/b/ tools/other.sh', 'rm tools/gate.sh', "echo '> tools/gate.sh'",
      "cat <<'EOF'\necho x > tools/gate.sh\nEOF", 'cp tools/gate.sh /tmp/a',
    ]) {
      expectSilent(await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir));
    }
  });

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
      "# don't touch\necho x > .hermit/config.json\n# it's fine",
      "echo $'it\\'s'; echo x > .hermit/config.json; echo $'a\\'b'",
      'cat <<EOF-1 > r.md\nx\nEOF-1\necho x > .hermit/config.json\nEOF',
      'cat <<E"OF" > r.md\nx\nEOF\necho x > .hermit/config.json\nE',
      'awk \'BEGIN { print 1 > ".hermit/config.json" }\'',
      "tmux send-keys -t s 'echo x > .hermit/config.json' Enter",
      "python3 - <<'EOF'\nimport os; os.system('echo x > .hermit/config.json')\nEOF",
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
      'docker.packages', 'docker.recommended_plugins.0.enabled', 'docker.fleet_mesh', 'browser', 'remote', 'chrome', 'auth_mode']) {
      for (const rest of [`set ${field} true`, `set ${field} false`, `unset ${field}`, `toggle ${field}`]) {
        const r = await runGate(payload({ dir, tool: 'Bash', input: { command: cmd(rest) } }), dir);
        expectAsk(r.stdout, `Hermit setting: ${field}${rest.startsWith('set ') ? '=' + rest.split(' ').at(-1) : ''}`);
      }
    }
    // 84 sequential gate subprocesses: the 5s default fails under parallel suite load.
  }, 30_000);

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
    ['pair discord ABC123', 'pair discord code ABC123 (home chat if unset)'],
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

test('native permission edits ask from chat, unknown or unproven origins, but not a typed terminal', async () => {
  const dir = fixture({ channels: { discord: { allowed_users: ['u1'] } } });
  const transcript = path.join(dir, 'channel.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({
    type: 'user', message: { content: '<channel source="discord" chat_id="100" user_id="u1">change rules</channel>' },
  }) + '\n');
  const typed = path.join(dir, 'typed.jsonl');
  fs.writeFileSync(typed, JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { content: 'change rules' } }) + '\n');
  for (const tool of ['Edit', 'Write'] as const) {
    for (const name of ['settings.json', 'settings.local.json']) {
      const base = JSON.parse(payload({ dir, tool, input: { file_path: path.join(dir, '.claude', name) } }));
      expectAsk((await runGate(JSON.stringify({ ...base, transcript_path: transcript }), dir)).stdout, 'Hermit setting: native permissions');
      expectAsk((await runGate(JSON.stringify({ ...base, transcript_path: path.join(dir, 'missing') }), dir)).stdout, 'Hermit setting: native permissions');
      expectAsk((await runGate(JSON.stringify(base), dir)).stdout, 'Hermit setting: native permissions');
      expectSilent(await runGate(JSON.stringify({ ...base, transcript_path: typed }), dir));
    }
  }
});

test('bypass mode denies chat edits of operator and native settings', async () => {
  const dir = fixture({ channels: { discord: { allowed_users: ['u1'] } } });
  const transcript = path.join(dir, 'channel.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({
    type: 'user', message: { content: '<channel source="discord" chat_id="100" user_id="u1">change rules</channel>' },
  }) + '\n');
  for (const file of ['.hermit/claude-settings.json', '.claude/settings.json', '.claude/settings.local.json']) {
    const base = JSON.parse(payload({ dir, tool: 'Edit', permission_mode: 'bypassPermissions', input: { file_path: path.join(dir, file) } }));
    const result = await runGate(JSON.stringify({ ...base, transcript_path: transcript }), dir);
    const output = JSON.parse(result.stdout).hookSpecificOutput;
    expect(output.permissionDecision).toBe('deny');
    expect(output.permissionDecisionReason).toContain('normal session or edit from the terminal');
  }
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

  test('append routines matches indexed adds for precheck, chat, origin, and resolver forms', async () => {
    for (const [chatId, userId, entry] of [
      [null, 'u1', { id: 'new' }],
      [null, 'u1', { id: 'new', precheck: 'scripts/gate.sh' }],
      ['555', 'u1', { id: 'new', chat: 'discord:555' }],
      ['555', 'u1', { id: 'new', chat: 'discord:999' }],
      ['100', 'u2', { id: 'new', chat: 'discord:100' }],
    ] as const) {
      const value = `'${JSON.stringify(entry)}'`;
      const indexed = asked(await runFrom(chatId, `set routines.2 ${value}`, undefined, userId));
      for (const runner of ['bun /p/scripts/settings-edit.ts', '.hermit/bin/hermitd-run settings-edit']) {
        expect(asked(await runFrom(chatId, '', `${runner} .hermit/config.json append routines ${value}`, userId))).toBe(indexed);
      }
    }
  });

  test('append monitors asks in both invocation forms', async () => {
    const entry = `'${JSON.stringify({ id: 'new', command: 'echo hello' })}'`;
    for (const runner of ['bun /p/scripts/settings-edit.ts', '.hermit/bin/hermitd-run settings-edit']) {
      expect(asked(await runFrom(null, '', `${runner} .hermit/config.json append monitors ${entry}`))).toBe(true);
    }
  });

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

describe('watch mutations', () => {
  const watch = (id: string, extra: Record<string, unknown> = {}) => ({
    id, description: 'watch test', command: `.hermit/bin/hermitd-run watch-poll ${id} --every 5m -- echo ready`,
    class: 'event', enabled: true, ...extra,
  });
  const entries = [watch('home'), watch('group', { chat: 'discord:555' }),
    watch('staged', { chat: 'discord:555', enabled: false })];
  const append = (entry: unknown) => `append monitors '${JSON.stringify(entry)}'`;

  async function decision(rest: string, mode: string, chat: string | null, sender = 'primary', missing = false, runner = '.hermit/bin/hermitd-run settings-edit') {
    const dir = fixture({
      channels: { discord: { default_chat_id: '100', allowed_users: ['primary', 'member'], operators: ['primary'] } },
      monitors: entries,
    });
    const transcript = path.join(dir, 'watch.jsonl');
    const content = chat === null ? 'watch this' : `<channel source="discord" chat_id="${chat}" user_id="${sender}">watch this</channel>`;
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { content } }) + '\n');
    const input = JSON.parse(payload({ dir, tool: 'Bash', permission_mode: mode,
      input: { command: `${runner} .hermit/config.json ${rest}` } }));
    input.transcript_path = missing ? path.join(dir, 'missing') : transcript;
    const result = await runGate(JSON.stringify(input), dir);
    expect(result.exitCode).toBe(0);
    return result.stdout !== '';
  }

  const cases: Array<[string, string, string | null, string, boolean]> = [
    ['primary home add', append(watch('new')), '100', 'primary', false],
    ['primary own group add', append(watch('new', { chat: 'discord:555' })), '555', 'primary', false],
    ['primary terminal add', append(watch('new')), null, 'primary', false],
    ['member staged add', append(watch('new', { enabled: false, chat: 'discord:555' })), '555', 'member', false],
    ['primary enable', 'set monitors.2.enabled true', '555', 'primary', false],
    ['terminal enable', 'set monitors.0.enabled true', null, 'primary', false],
    ['member owning stop', 'set monitors.1.enabled false', '555', 'member', false],
    ['member owning remove', 'unset monitors.1', '555', 'member', false],
    ['home stop', 'set monitors.0.enabled false', '100', 'member', false],
    ['terminal remove', 'unset monitors.0', null, 'primary', false],
    ['non-shape', append(watch('new', { command: 'echo ready' })), '100', 'primary', true],
    ['mismatched id', append(watch('new', { command: '.hermit/bin/hermitd-run watch-poll other -- echo ready' })), '100', 'primary', true],
    ['duplicate id', append(watch('home')), '100', 'primary', true],
    ['expanded value', 'append monitors "$ENTRY"', '100', 'primary', true],
    ['expanded index', 'set monitors.$N.enabled false', '555', 'member', true],
    ['another chat', 'unset monitors.1', '999', 'primary', true],
    ['other chat add', append(watch('new', { chat: 'discord:999' })), '555', 'primary', true],
    ['command edit', 'set monitors.0.command echo', '100', 'primary', true],
    ['whole array', "set monitors '[]'", '100', 'primary', true],
    ['member enable', 'set monitors.2.enabled true', '555', 'member', true],
    ['chained write', 'set monitors.0.enabled false && echo ok', '100', 'primary', true],
  ];
  for (const [label, rest, chat, sender, autoAsks] of cases) {
    test(label, async () => {
      expect(await decision(rest, 'auto', chat, sender)).toBe(autoAsks);
      expect(await decision(rest, 'default', chat, sender)).toBe(true);
    });
  }

  test('unknown origin asks in both modes', async () => {
    for (const mode of ['auto', 'default']) {
      expect(await decision(append(watch('new')), mode, null, 'primary', true)).toBe(true);
    }
  });

  test('a thread of the watch chat owns its thread-less watches', async () => {
    const threaded = [...entries, watch('other-thread', { chat: 'discord:555~T2' })];
    async function asks(rest: string, sender = 'member') {
      const dir = fixture({
        channels: { discord: { default_chat_id: '100', allowed_users: ['primary', 'member'], operators: ['primary'], attributes: { thread_id: 'thread_ts' } } },
        monitors: threaded,
      });
      const transcript = path.join(dir, 'watch.jsonl');
      const content = `<channel source="discord" chat_id="555" thread_ts="T1" user_id="${sender}">yes</channel>`;
      fs.writeFileSync(transcript, JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { content } }) + '\n');
      const input = JSON.parse(payload({ dir, tool: 'Bash', permission_mode: 'auto',
        input: { command: `.hermit/bin/hermitd-run settings-edit .hermit/config.json ${rest}` } }));
      input.transcript_path = transcript;
      const result = await runGate(JSON.stringify(input), dir);
      expect(result.exitCode).toBe(0);
      return result.stdout !== '';
    }
    expect(await asks('set monitors.1.enabled false')).toBe(false);
    expect(await asks('unset monitors.1')).toBe(false);
    expect(await asks(append(watch('new', { enabled: false, chat: 'discord:555' })))).toBe(false);
    expect(await asks('set monitors.3.enabled false')).toBe(true);
    expect(await asks('set monitors.2.enabled true')).toBe(true);
  });

  test('direct script form follows the same watch rules', async () => {
    for (const mode of ['auto', 'default']) {
      expect(await decision(append(watch('new')), mode, '100', 'primary', false,
        'bun /p/scripts/settings-edit.ts')).toBe(mode !== 'auto');
    }
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

test('browser-default-on migration requests permission for the protected browser object', async () => {
  const dir = fixture();
  expectAsk((await runGate(payload({ dir, tool: 'Bash', input: { command: cmd('migrate browser-default-on') } }), dir)).stdout, 'Hermit setting: browser');
});


for (const mode of ['bypassPermissions', 'auto', 'default']) {
  for (const command of [
    'bun /p/scripts/task.ts answer .hermit T-20261101-120000 --local --reply yes',
    '.hermit/bin/hermitd-run task answer .hermit T-20261101-120000 --local --reply yes',
    'hermitd run task answer .hermit T-20261101-120000 --local --reply yes',
  ]) test('local decision answer gate ' + mode + ': ' + command, async () => {
    const dir = fixture();
    const r = await runGate(payload({ dir, tool: 'Bash', permission_mode: mode, input: { command } }), dir);
    expect(r.exitCode).toBe(0);
    const output = JSON.parse(r.stdout).hookSpecificOutput;
    expect(output.permissionDecision).toBe(mode === 'bypassPermissions' ? 'deny' : 'ask');
    expect(output.permissionDecisionReason).toBe(mode === 'bypassPermissions'
      ? 'Answering a decision as admin is refused in bypass mode; answer from a connected chat.'
      : 'Admin decision: answer T-20261101-120000 "yes" as admin');
  });
}

test('local answer fallbacks, mixed settings and ordinary channel answers', async () => {
  const dir = fixture();
  const channel = path.join(dir, 'channel.jsonl');
  fs.writeFileSync(channel, JSON.stringify({
    type: 'user', message: { content: '<channel source="discord" chat_id="home" user_id="admin">yes</channel>' },
  }) + '\n');
  const answer = JSON.parse(payload({ dir, tool: 'Bash', input: {
    command: 'task answer .hermit --chat discord:home --user admin --reply yes',
  } }));
  expectSilent(await runGate(JSON.stringify({ ...answer, transcript_path: channel }), dir));
  expectSilent(await runGate(payload({ dir, tool: 'Bash', input: { command: 'task list .hermit --open' } }), dir));
  for (const [command, reason] of [
    ['task "$V" --local', 'Admin decision: task answer --local'],
    ["bash -c 'hermitd-run task answer .hermit --local --reply yes'", 'Admin decision: task answer --local'],
    ['task answer .hermit --local --reply "yes please"', 'Admin decision: answer the pending decision "yes please" as admin'],
    ['task answer .hermit --local --reply yes && ' + cmd('set voice friendly'), 'Admin decision: answer the pending decision "yes" as admin; Hermit setting: voice'],
  ]) expectAsk((await runGate(payload({ dir, tool: 'Bash', input: { command } }), dir)).stdout, reason);
});

describe('task sender binding', () => {
  const channel = (user: string, chat = '100', extra = '') =>
    `<channel source="plugin:discord:discord" chat_id="${chat}" user_id="${user}"${extra}>yes</channel>`;
  const opener = (content: string, origin: any = { kind: 'channel' }) =>
    ({ type: 'user', origin, message: { content } });
  const queued = (prompt: string, origin: any = { kind: 'channel', server: 'discord' }) =>
    ({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', origin, prompt } });
  const answer = (user: string, chat = 'discord:100', runner = 'task') =>
    `${runner} answer .hermit --chat ${chat} --user ${user} --reply yes`;

  async function gate(command: string, entries: any[] | null, mode = 'default', config: any = {}) {
    const dir = fixture({ channels: { discord: { allowed_users: ['admin', 'member'], ...config } } });
    const base = JSON.parse(payload({ dir, tool: 'Bash', permission_mode: mode, input: { command } }));
    const transcript = path.join(dir, 'turn.jsonl');
    if (entries) fs.writeFileSync(transcript, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    return runGate(JSON.stringify({ ...base, transcript_path: transcript }), dir);
  }

  function expectDeny(result: { exitCode: number; stdout: string }, reason = 'must reply themselves') {
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout).hookSpecificOutput;
    expect(output.permissionDecision).toBe('deny');
    expect(output.permissionDecisionReason).toContain(reason);
  }
  const expectOpaque = (result: { exitCode: number; stdout: string }) => expectDeny(result, 'could not be read');

  test('channel opener binds the claimed sender and chat in every permission mode', async () => {
    for (const mode of ['default', 'auto', 'bypassPermissions']) {
      expectSilent(await gate(answer('admin'), [opener(channel('admin'))], mode));
      expectDeny(await gate(answer('member'), [opener(channel('admin'))], mode));
      expectDeny(await gate(answer('admin', 'discord:999'), [opener(channel('admin'))], mode));
    }
  });

  for (const [label, command, entries] of [
    ['different sender', answer('member'), [opener(channel('admin'))]],
    ['terminal opener', answer('admin'), [opener('yes', { kind: 'human' })]],
    ['wake with another sender', answer('admin'), [
      opener('<task-notification>go</task-notification>', { kind: 'task-notification' }), queued(channel('member')),
    ]],
    ['missing transcript', answer('admin'), null],
    ['different chat', answer('admin', 'discord:999'), [opener(channel('admin'))]],
  ] as const) {
    test(`rejects ${label}`, async () => { expectDeny(await gate(command, entries ? [...entries] : null)); });
  }

  test('queued channel senders join the opener without replacing it', async () => {
    const entries = [opener(channel('admin')), queued(channel('member'))];
    expectSilent(await gate(answer('admin'), entries));
    expectSilent(await gate(answer('member'), entries));
    expectDeny(await gate(answer('member'), [opener(channel('admin')), queued(channel('member'), { kind: 'human' })]));
    expectDeny(await gate(answer('member'), [opener(channel('admin')), { ...queued(channel('member')), type: 'user' }]));
  });

  test('terminal, wake, missing and truncated turns never invent a sender', async () => {
    expectDeny(await gate(answer('admin'), [opener('yes', { kind: 'human' })]));
    const wake = opener('<task-notification>go</task-notification>', { kind: 'task-notification' });
    expectSilent(await gate(answer('member'), [wake, queued(channel('member'))]));
    expectDeny(await gate(answer('admin'), [wake, queued(channel('member'))]));
    expectDeny(await gate(answer('admin'), null));
    expectDeny(await gate(answer('admin'), [queued(channel('admin'))]));
    expectDeny(await gate(answer('admin'), [opener(channel('admin')), { type: 'assistant', text: 'x'.repeat(512 * 1024) }]));
  });

  test('task command forms bind every claimed sender', async () => {
    const entries = [opener(channel('admin'))];
    for (const runner of ['task', 'bun /p/scripts/task.ts', '.hermit/bin/hermitd-run task', 'hermitd run task']) {
      expectSilent(await gate(answer('admin', 'discord:100', runner), entries));
      expectDeny(await gate(answer('member', 'discord:100', runner), entries));
    }
    for (const verb of ['close', 'cancel', 'note']) {
      const suffix = verb === 'note' ? ' --clear-waiting' : '';
      expectSilent(await gate(`task ${verb} .hermit T-20261101-120000 --chat discord:100 --user admin${suffix}`, entries));
      expectDeny(await gate(`task ${verb} .hermit T-20261101-120000 --chat discord:100 --user member${suffix}`, entries));
    }
    expectDeny(await gate(`${answer('admin')} && ${answer('member')}`, entries));
    expectSilent(await gate(`${answer('admin')} && ${answer('admin')}`, entries));
    for (const user of ['admin', 'member']) {
      const close = `task close .hermit T-20261101-120000 --chat discord:100 --user ${user} --reason-stdin`;
      const expectation = user === 'admin' ? expectSilent : expectDeny;
      expectation(await gate(`${close} <<'EOF'\nPaid $40\nEOF`, entries));
      expectation(await gate(`echo "Paid $40" | ${close}`, entries));
    }
    expectOpaque(await gate('set -- --user admin; task answer .hermit --chat discord:100 --reply yes "$@"', entries));
  });

  test('opaque task commands deny and unrelated commands do not need a transcript', async () => {
    const entries = [opener(channel('admin'))];
    expectOpaque(await gate(`bash -c '.hermit/bin/hermitd-run ${answer('admin')}'`, entries));
    expectOpaque(await gate('task answer .hermit --chat discord:100 --user "$USER" --reply yes', entries));
    expectOpaque(await gate(`ta'sk' answer .hermit --chat discord:100 --user admin --reply yes`, entries));
    expectOpaque(await gate(`task answer .hermit --chat discord:100 --us'er' admin --reply yes`, entries));
    expectSilent(await gate('systemctl --user restart hermitd-watchdog && tail task.log', null));
    expectSilent(await gate('task list .hermit --open', null));
    expectOpaque(await gate('task answer .hermit --chat discord:100 --reply yes', entries));
    expectOpaque(await gate('printf -- "--user\\nmember\\n" | xargs task answer .hermit --chat discord:100 --reply yes', entries));
    expectOpaque(await gate('xargs -a f .hermit/bin/hermitd-run task answer .hermit --reply yes', entries));
    expectOpaque(await gate(`bash -c 'task answer .hermit --chat discord:100 --reply yes $(cat f)'`, entries));
    expectSilent(await gate('task answer .hermit --user admin --reply yes', null));
    expectSilent(await gate('git commit -m "bind task --user claims"', null));
    expectSilent(await gate('later add .hermit --claim "task done" --chat discord:100 --remind --due 2026-11-09T09:00:00Z --origin hermit', null));
    expectSilent(await gate('echo --chat discord:100 --user admin', null));
  });

  test('mapped thread and canonical user id identify the exact pair', async () => {
    const config = { attributes: { thread_id: 'thread_ts' } };
    const entries = [opener(channel('admin', '100', ' thread_ts="T1" user="member"'))];
    expectSilent(await gate(answer('admin', 'discord:100~T1'), entries, 'default', config));
    expectDeny(await gate(answer('admin', 'discord:100'), entries, 'default', config));
    expectDeny(await gate(answer('member', 'discord:100~T1'), entries, 'default', config));
    expectDeny(await gate(answer('admin'), [opener(channel('admin', '100', ' user_id="admin"'))]));
  });
});
