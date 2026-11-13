// End-to-end tests for render-docker-templates.ts — renders the REAL base
// Docker templates into a tmp dir via the CLI and asserts the property contract
// (no golden fixtures; the repo style is property assertions).
//
// Usage: bun test tests/render-docker-templates.test.ts   (from the plugin root)

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript, PLUGIN_ROOT } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';
import { renderSources } from '../scripts/render-docker-templates';
import { deriveRenderInputs } from '../scripts/lib/derive-render-inputs';

const { freshDir, cleanup } = freshDirFactory('hermit-rdt-');
afterAll(cleanup);

const BASE_INPUT = {
  packages: [] as string[],
  channels: { envLines: [] as string[], volumeLines: [] as string[] },
  networkMode: 'bridge' as const,
  gitIdentityMount: true,
};

function config(dir: string, overrides: Record<string, any> = {}) {
  const input: Record<string, any> = { ...BASE_INPUT, ...overrides };
  fs.mkdirSync(path.join(dir, '.hermit'), { recursive: true });
  const channels: Record<string, any> = {};
  for (const line of input.channels.envLines ?? []) {
    const key = line.match(/channels\/([^/]+)$/)?.[1];
    if (key) channels[key] = {};
  }
  for (const plugin of overrides.channelPlugins ?? []) channels[plugin.plugin === 'custom-plugin' ? 'custom' : plugin.plugin] = plugin;
  fs.writeFileSync(path.join(dir, '.hermit/config.json'), JSON.stringify({
    channels,
    docker: { packages: input.packages, network_mode: input.networkMode, git_identity_mount: input.gitIdentityMount, fleet_mesh: input.fleetMesh },
    browser: { enabled: overrides.browser, port: overrides.browserPort },
  }));
}

async function render(dir: string, overrides: Record<string, unknown> = {}) {
  config(dir, overrides);
  return runScript('render-docker-templates.ts', { args: [dir] });
}

const dockerfile = (dir: string) => fs.readFileSync(path.join(dir, 'Dockerfile.hermit'), 'utf8');
const compose = (dir: string) => fs.readFileSync(path.join(dir, 'docker-compose.hermit.yml'), 'utf8');

describe('render-docker-templates.ts', () => {
  test('every image has optional default-on ffmpeg and compose passes its build argument', async () => {
    const dir = freshDir();
    expect((await render(dir)).exitCode).toBe(0);
    expect(dockerfile(dir)).toContain('# --- transcription ---\nARG HERMIT_TRANSCRIPTION=1\nRUN if [ "$HERMIT_TRANSCRIPTION" = 1 ]; then apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -r /var/lib/apt/lists/*; fi');
    expect(compose(dir)).toContain('HERMIT_TRANSCRIPTION: ${HERMIT_TRANSCRIPTION:-1}');
  });
  test('renders all three files, exit 0, no {{ }} left', async () => {
    const dir = freshDir();
    const r = await render(dir);
    expect(r.exitCode).toBe(0);
    expect(dockerfile(dir)).not.toMatch(/\{\{[A-Z][A-Z0-9_]*\}\}/);
    expect(compose(dir)).not.toMatch(/\{\{[A-Z][A-Z0-9_]*\}\}/);
    expect(fs.existsSync(path.join(dir, 'docker-entrypoint.hermit.sh'))).toBe(true);
  });

  // config.json env is the only owner of the hook profile; an ambient compose
  // value would outrank it and silently override the operator's choice.
  test('compose carries no AGENT_HOOK_PROFILE', async () => {
    const dir = freshDir();
    await render(dir);
    expect(compose(dir)).not.toContain('AGENT_HOOK_PROFILE');
  });

  // The healthcheck must READ config.tmux_session_name at check time, never bake a copy.
  // A baked name is a second source of truth that silently desyncs from the entrypoint's
  // (a rename re-renders this file but leaves the already-written config value alone),
  // leaving the container permanently "unhealthy" against a session that never existed.
  test('healthcheck resolves the session name at runtime, with no name baked in', async () => {
    const dir = freshDir();
    await render(dir);
    const yml = compose(dir);
    expect(yml).toContain('.hermit/config.json');
    expect(yml).toContain('tmux has-session');
    // No literal session name anywhere in the file — not the default prefix, not a project name.
    expect(yml).not.toMatch(/has-session -t ["']?hermit-[a-z]/);
  });

  // `hermit-` is only the DEFAULT (lib/tmux.ts expandSessionName); tmux_session_name is an
  // operator-editable setting with no enforced prefix, so the check must not reconstruct it.
  test('healthcheck carries no assumption that the name starts with hermit-', async () => {
    const dir = freshDir();
    await render(dir);
    // Anchor on the `test:` key, not on a substring of the command — a nearby COMMENT
    // mentioning the same token would otherwise be picked up instead, and every assertion
    // below would pass vacuously against prose.
    const line = compose(dir).split('\n').find((l) => l.trim().startsWith('test:')) ?? '';
    expect(line).toContain('has-session');
    // The only permitted occurrence of the default is jq's fallback for an absent key.
    const hermitLiterals = (line.match(/hermit-\{project_name\}|hermit-[a-z]/g) ?? []);
    expect(hermitLiterals).toEqual(['hermit-{project_name}']);
  });

  test('entrypoint is byte-identical to the template (cp, not regenerate)', async () => {
    const dir = freshDir();
    await render(dir);
    const rendered = fs.readFileSync(path.join(dir, 'docker-entrypoint.hermit.sh'));
    const template = fs.readFileSync(
      path.join(PLUGIN_ROOT, 'state-templates', 'docker', 'docker-entrypoint.hermit.sh.template'));
    expect(rendered.equals(template)).toBe(true);
  });

  test('packages land in a Dockerfile RUN apt-get block', async () => {
    const dir = freshDir();
    await render(dir, { packages: ['libsqlite3-dev', 'ffmpeg'] });
    const df = dockerfile(dir);
    expect(df).toContain('# Project-specific packages (from config.json docker.packages)');
    expect(df).toMatch(/RUN apt-get update && apt-get install -y --no-install-recommends \\\n {6}libsqlite3-dev ffmpeg && \\/);
  });

  test('empty packages leaves no project-package RUN block', async () => {
    const dir = freshDir();
    await render(dir, { packages: [] });
    expect(dockerfile(dir)).not.toContain('# Project-specific packages');
  });

  test('generated image delegates root customization to an optional hook after the toolchain', async () => {
    const dir = freshDir(); await render(dir);
    const image = dockerfile(dir);
    expect(image).not.toContain('# --- operator:');
    const hook = 'USER root\nCOPY docker-build.hermit-local.sh* /opt/hermit-build/\nRUN if [ -f /opt/hermit-build/docker-build.hermit-local.sh ]; then bash /opt/hermit-build/docker-build.hermit-local.sh; fi\nUSER claude';
    expect(image).toContain(hook);
    expect(image.indexOf(hook)).toBeGreaterThan(image.indexOf('bun.sh/install'));
    expect(image.indexOf(hook)).toBeGreaterThan(image.indexOf('npm install -g @anthropic-ai/claude-code'));
    expect(image.indexOf(hook)).toBeLessThan(image.indexOf('COPY --chmod=755'));
    expect(image.match(/^USER .*$/gm)?.at(-1)).toBe('USER claude');
    expect(compose(dir)).not.toContain('ANTHROPIC_API_KEY=');
  });

  test('network_mode: host is present only for host networking', async () => {
    const bridgeDir = freshDir();
    await render(bridgeDir, { networkMode: 'bridge' });
    expect(compose(bridgeDir)).not.toContain('network_mode: host');

    const hostDir = freshDir();
    await render(hostDir, { networkMode: 'host' });
    expect(compose(hostDir)).toContain('network_mode: host');
  });

  test('fleet mesh wiring is present only when explicitly enabled', async () => {
    const absentDir = freshDir();
    await render(absentDir);
    expect(compose(absentDir)).not.toContain('hermit-fleet');

    const disabledDir = freshDir();
    await render(disabledDir, { fleetMesh: false });
    expect(compose(disabledDir)).not.toContain('hermit-fleet');

    const enabledDir = freshDir();
    await render(enabledDir, { fleetMesh: true });
    const enabledCompose = compose(enabledDir);
    expect(enabledCompose).toContain('pid: "container:hermit-fleet-pidns"');
    expect(enabledCompose).toContain('XDG_RUNTIME_DIR=/run/hermit-fleet');
    expect(enabledCompose).toMatch(/^ {6}- hermit-fleet-sessions:\/home\/claude\/\.claude\/sessions$/m);
    expect(enabledCompose).toMatch(/^ {6}- hermit-fleet-socks:\/run\/hermit-fleet$/m);
    expect(enabledCompose.match(/^ {4}external: true$/gm)).toHaveLength(2);
    expect(enabledCompose).not.toMatch(/\{\{[A-Z][A-Z0-9_]*\}\}/);
    expect(dockerfile(enabledDir)).toBe(dockerfile(disabledDir));
  });

  test('auth never adds an API key interpolation', async () => {
    const keyDir = freshDir();
    await render(keyDir, { auth: 'api-key' });
    expect(compose(keyDir)).not.toContain('ANTHROPIC_API_KEY=');

    const oauthDir = freshDir();
    await render(oauthDir, { auth: 'oauth-token' });
    expect(compose(oauthDir)).not.toContain('ANTHROPIC_API_KEY');
  });

  // The token must never be wired through compose. env_file is applied only at
  // container creation, so a token living there could not be rotated without
  // recreating the container from the host — the exact manual step the
  // channel-relayed renewal exists to remove.
  test('setup-token auth adds no auth env line at all', async () => {
    const dir = freshDir();
    await render(dir, { auth: 'setup-token' });
    const rendered = compose(dir);
    expect(rendered).not.toContain('ANTHROPIC_API_KEY');
    expect(rendered).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
  });

  test('git-identity bind-mount is conditional on gitIdentityMount', async () => {
    const withDir = freshDir();
    await render(withDir, { gitIdentityMount: true });
    expect(compose(withDir)).toContain('- ${HOME}/.gitconfig:/home/claude/.gitconfig:ro');

    const withoutDir = freshDir();
    await render(withoutDir, { gitIdentityMount: false });
    expect(compose(withoutDir)).not.toContain('${HOME}/.gitconfig');
  });

  test('channel volume + env lines render at exact 6-space indent', async () => {
    const dir = freshDir();
    await render(dir, {
      channels: {
        envLines: ['DISCORD_STATE_DIR=${PWD}/.claude.local/channels/discord'],
        volumeLines: ['${PWD}/.claude.local/channels/discord:/home/claude/.claude/channels/discord'],
      },
    });
    const c = compose(dir);
    // Exact-indent assertions — YAML breaks silently on wrong indent.
    expect(c).toMatch(/^ {6}- \$\{PWD\}\/\.claude\.local\/channels\/discord:\/home\/claude\/\.claude\/channels\/discord$/m);
    expect(c).toMatch(/^ {6}- DISCORD_STATE_DIR=\$\{PWD\}\/\.claude\.local\/channels\/discord$/m);
  });

  test('derives the renderer inputs from config and rendered compose', async () => {
    const dir = freshDir();
    const input = {
      packages: ['libsqlite3-dev', 'ffmpeg'],
      channelPlugins: [{ marketplace: 'claude-plugins-official', plugin: 'discord' }],
      channels: {
        envLines: ['DISCORD_STATE_DIR=${PWD}/.claude.local/channels/discord'],
        volumeLines: ['${PWD}/.claude.local/channels/discord:/home/claude/.claude/channels/discord'],
      },
      networkMode: 'host' as const,
      gitIdentityMount: false,
      fleetMesh: true,
      browser: true,
    };
    await render(dir, input);
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      channels: { discord: { enabled: true } },
      browser: { enabled: input.browser },
      docker: {
        packages: input.packages,
        network_mode: input.networkMode,
        fleet_mesh: input.fleetMesh,
        git_identity_mount: input.gitIdentityMount,

      },
    }));

    expect(deriveRenderInputs(configPath)).toEqual(input);
  });

  // The shipped config template has no `network_mode` key, and neither does any
  // deploy predating it — rejecting those would strand them on report-only.
  test('absent docker.network_mode derives as bridge, not as underivable', async () => {
    const dir = freshDir();
    await render(dir, { channels: { envLines: [], volumeLines: [] } });
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      channels: {},
      docker: { packages: [], fleet_mesh: false },
    }));

    const derived = deriveRenderInputs(configPath);
    expect(derived?.networkMode).toBe('bridge');
  });

  test('no channels leaves no channel state-dir wiring', async () => {
    const dir = freshDir();
    await render(dir, { channels: { envLines: [], volumeLines: [] } });
    expect(compose(dir)).not.toContain('STATE_DIR');
  });

  test('manifest_seed payload carries absolute paths and current plugin version', async () => {
    const dir = freshDir();
    const r = await render(dir);
    const out = JSON.parse(r.stdout);
    expect(out.entrypoint_copied).toBe(true);
    expect(out.written).toHaveLength(2);
    for (const w of out.written) expect(path.isAbsolute(w)).toBe(true);

    const pj = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
    expect(out.manifest_seed.plugin_version).toBe(pj.version);

    const byKey = Object.fromEntries(out.manifest_seed.entries.map((e: any) => [e.key, e.file]));
    for (const file of Object.values(byKey)) expect(path.isAbsolute(file as string)).toBe(true);
    // Entrypoint hashes the on-disk rendered file at the project root; the two
    // .template keys hash the upstream templates in the plugin.
    expect(byKey['docker/docker-entrypoint.hermit.sh']).toBe(path.join(dir, 'docker-entrypoint.hermit.sh'));
    expect(Object.keys(byKey)).toEqual(['docker/docker-entrypoint.hermit.sh']);
  });

  test('relative project-root argv is resolved to an absolute path', async () => {
    const dir = freshDir();
    config(dir);
    const rel = path.relative(process.cwd(), dir);
    const r = await runScript('render-docker-templates.ts', {
      args: [rel],
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    for (const w of out.written) expect(path.isAbsolute(w)).toBe(true);
  });

  test('--to writes only under the requested output directory', async () => {
    const projectRoot = freshDir();
    const outputDir = freshDir();
    config(projectRoot);
    const r = await runScript('render-docker-templates.ts', {
      args: [projectRoot, '--to', outputDir],
    });

    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(outputDir, 'Dockerfile.hermit'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'docker-compose.hermit.yml'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'docker-entrypoint.hermit.sh'))).toBe(false);
    expect(fs.readdirSync(projectRoot)).toEqual(['.hermit']);
    expect(JSON.parse(r.stdout).manifest_seed).toBeUndefined();
  });

  test('a failed render prints {"error"} on stdout and writes nothing', async () => {
    const dir = freshDir();
    const r = await runScript('render-docker-templates.ts', { args: [dir] });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).error).toStartWith('render_failed:');
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});


test('marketplace channel renders an approval drop-in for all enabled channel plugins', async () => {
  const dir = freshDir();
  const channelPlugins = [
    { marketplace: 'claude-plugins-official', plugin: 'discord' },
    { marketplace: 'custom-market', plugin: 'custom-plugin' },
  ];
  expect((await render(dir, { channelPlugins })).exitCode).toBe(0);
  const df = dockerfile(dir);
  expect(df).toContain('/etc/claude-code/managed-settings.d/hermitd-channels.json');
  expect(df).toContain(JSON.stringify({ channelsEnabled: true, allowedChannelPlugins: channelPlugins }));
  expect(df.indexOf('hermitd-channels.json')).toBeLessThan(df.indexOf('USER claude'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    docker: { packages: [] },
    channels: { discord: {}, custom: { marketplace: 'custom-market', plugin: 'custom-plugin' }, disabled: { enabled: false } },
  }));
  const derived = deriveRenderInputs(configPath);
  expect(derived?.channelPlugins).toEqual(channelPlugins);
  expect((await render(dir, { ...derived! })).exitCode).toBe(0);
  expect(dockerfile(dir)).toContain(JSON.stringify({ channelsEnabled: true, allowedChannelPlugins: channelPlugins }));
});

test('official-only channel plugins need no managed approval drop-in', async () => {
  const dir = freshDir();
  expect((await render(dir, { channelPlugins: [{ marketplace: 'claude-plugins-official', plugin: 'discord' }] })).exitCode).toBe(0);
  expect(dockerfile(dir)).not.toContain('hermitd-channels.json');
});

test('browser derives true when absent and rejects non-booleans', async () => {
  const dir = freshDir();
  await render(dir);
  const configPath = path.join(dir, 'config.json');
  for (const value of [undefined, false, true, null, 'true', 1]) {
    fs.writeFileSync(configPath, JSON.stringify({ channels: {}, browser: { enabled: value }, docker: { packages: [] } }));
    const derived = deriveRenderInputs(configPath);
    if (value === undefined || typeof value === 'boolean') {
      expect(derived?.browser).toBe(value ?? true);
    } else {
      expect(derived).toBeNull();
    }
  }
});

test('browser false is byte-identical to absent and keeps the gated browser block', async () => {
  const absent = freshDir();
  const disabled = freshDir();
  await render(absent);
  await render(disabled, { browser: false });
  expect(dockerfile(disabled)).toBe(dockerfile(absent));
  expect(compose(disabled)).toBe(compose(absent));
  expect(dockerfile(disabled)).toContain('# --- managed browser ---\nARG HERMIT_BROWSER=1\nRUN if [ "$HERMIT_BROWSER" = 1 ]; then');
  expect(dockerfile(disabled)).toContain("printf 'display=plugin\\n' > /etc/hermit/managed-browser");
  expect(dockerfile(disabled)).not.toContain('ENV AGENT_BROWSER_');
  expect(compose(disabled)).toContain('HERMIT_BROWSER: ${HERMIT_BROWSER:-1}');
});

test('browser true pins and verifies both architectures above the root operator block', async () => {
  const dir = freshDir();
  expect((await render(dir, { browser: true })).exitCode).toBe(0);
  const image = dockerfile(dir);
  expect(image).toContain('agent-browser@0.41.0');
  expect(image).toContain('156.0.8078.80');
  expect(image).toContain('sha256sum -c -');
  expect(image).toContain('amd64) platform=linux64');
  expect(image).toContain('arm64) platform=linux-arm64');
  expect(image).toContain('b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7');
  expect(image).toContain('1f496a826c9ba4d6a5f5bf2de686145fe718528c2cc3dbeb96b5893b89653724');
  expect(image).toContain('/etc/hermit/managed-browser');
  expect(image).toContain('scripts/browser-agent.ts');
  expect(image.indexOf('npm install -g --allow-scripts')).toBeLessThan(image.indexOf('# Match host UID'));
  expect(image).not.toContain('ENV AGENT_BROWSER_PROFILE');
  const baseline = freshDir();
  await render(baseline);
  expect(compose(dir)).toBe(compose(baseline));
});

test('entrypoint keeps marker-gated admission cleanup and plugin display shutdown', () => {
  const source = fs.readFileSync(path.join(PLUGIN_ROOT, 'state-templates/docker/docker-entrypoint.hermit.sh.template'), 'utf8');
  const gates = [...source.matchAll(/if \[ -f \/etc\/hermit\/managed-browser \]; then([\s\S]*?)\n(?:  )?fi/g)].map(match => match[1]);
  expect(gates).toHaveLength(2);
  expect(gates[0]).toContain('/tmp/hermit-browser-*/*.pid');
  expect(gates[0]).toContain('/tmp/hermit-browser-*/admissions.json');
  expect(source).not.toContain('Xvnc :1');
  expect(source).not.toContain('openbox &');
  expect(source).not.toContain('scripts/browser-viewer.ts');
  for (const action of ['human-release', 'teardown shutdown', 'agent-browser --task shutdown close', 'browser.ts" teardown', 'scripts/browser-display.ts" stop']) {
    expect(gates[1]).toContain(action);
  }
});

test('viewer port has one bridge publish site, survives derivation, and binds directly on host networking', async () => {
  for (const networkMode of ['bridge', 'host'] as const) {
    const dir = freshDir();
    await render(dir, { browser: true, browserPort: 6090, networkMode });
    const source = compose(dir);
    expect(source.includes('127.0.0.1:6090:6080')).toBe(networkMode === 'bridge');
    expect(source.includes('HERMIT_BROWSER_VIEWER_BIND=127.0.0.1:6090')).toBe(networkMode === 'host');
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ channels: {}, browser: { enabled: true, port: 6090 }, docker: { packages: [], network_mode: networkMode } }));
    expect(deriveRenderInputs(configPath)?.browserPort).toBe(6090);
    fs.writeFileSync(configPath, JSON.stringify({ channels: {}, browser: { enabled: true, port: 6090 }, docker: { packages: [], security: { network: { enabled: true } } } }));
    expect(deriveRenderInputs(configPath)?.browserPort).toBeUndefined();
    await render(dir, { browser: true });
    expect(compose(dir)).not.toContain('ports:');
    expect(dockerfile(dir)).toContain('novnc-1.7.0.tgz');
    expect(dockerfile(dir)).toContain('32689f18d6abe96bc6530828a6bd0b9ae33bda07c083a6575ed255b5a8f2e903');
  }
});

test('operator-installed agent-browser defaults off and an explicit browser choice wins', async () => {
  const dir = freshDir(); await render(dir);
  const file = path.join(dir, 'Dockerfile.hermit');
  fs.appendFileSync(file, '\nRUN npm install -g agent-browser\n');
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ channels: {}, docker: { packages: [] } }));
  expect(deriveRenderInputs(configPath)?.browser).toBe(true);
  fs.writeFileSync(configPath, JSON.stringify({ channels: {}, browser: { enabled: true }, docker: { packages: [] } }));
  expect(deriveRenderInputs(configPath)?.browser).toBe(true);
});


test.each([
  ['unconverted', 'FROM debian\n', 'not_converted'],
  ['newer', '# Generated by hermitd 999.0.0\n', 'newer_renderer'],
])('header gate: %s', async (_label, content, reason) => {
  const dir = freshDir(); config(dir);
  fs.writeFileSync(path.join(dir, 'Dockerfile.hermit'), content);
  const result = await runScript('render-docker-templates.ts', { args: [dir] });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ status: 'skipped', reason });
  expect(dockerfile(dir)).toBe(content);
  expect(fs.existsSync(path.join(dir, 'docker-compose.hermit.yml'))).toBe(false);
  const output = freshDir();
  expect((await runScript('render-docker-templates.ts', { args: [dir, '--to', output] })).exitCode).toBe(0);
  expect(dockerfile(output)).toContain('Generated by hermitd');
});

test('convert, current and older headers render without overwriting an existing entrypoint', async () => {
  const dir = freshDir(); config(dir);
  fs.writeFileSync(path.join(dir, 'Dockerfile.hermit'), 'FROM debian\n');
  fs.writeFileSync(path.join(dir, 'docker-entrypoint.hermit.sh'), 'operator entrypoint');
  const converted = await runScript('render-docker-templates.ts', { args: [dir, '--convert'] });
  expect(converted.exitCode).toBe(0);
  expect(JSON.parse(converted.stdout).manifest_seed).toBeUndefined();
  expect(fs.readFileSync(path.join(dir, 'docker-entrypoint.hermit.sh'), 'utf8')).toBe('operator entrypoint');
  for (const header of [dockerfile(dir).split('\n')[0], '# Generated by hermitd 0.0.1']) {
    fs.writeFileSync(path.join(dir, 'Dockerfile.hermit'), header + '\nstale');
    expect((await runScript('render-docker-templates.ts', { args: [dir] })).exitCode).toBe(0);
    expect(dockerfile(dir)).toContain('ffmpeg');
    expect(dockerfile(dir)).toContain('agent-browser@');
    expect(dockerfile(dir)).not.toContain('stale');
  }
});

test.each(['x', 'curl;touch pwned', 'UPPER', '-curl', 'curl foo'])('invalid package writes nothing: %s', async pkg => {
  const dir = freshDir(); config(dir, { packages: [pkg] });
  const result = await runScript('render-docker-templates.ts', { args: [dir] });
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout)).toEqual({ error: `invalid_package:${pkg}` });
  expect(fs.readdirSync(dir)).toEqual(['.hermit']);
});

test('a channel key that is not a shell identifier renders without state-dir wiring', () => {
  const dir = freshDir();
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ channels: { 'my-chat': { plugin: 'my-chat' } }, docker: { packages: [] } }));
  const derived = deriveRenderInputs(configPath);
  expect(derived?.channels).toEqual({ envLines: [], volumeLines: [] });
  expect(derived?.channelPlugins).toEqual([{ marketplace: 'claude-plugins-official', plugin: 'my-chat' }]);
});
