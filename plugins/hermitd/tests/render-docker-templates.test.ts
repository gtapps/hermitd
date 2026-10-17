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
import { deriveRenderInputs } from '../scripts/lib/derive-render-inputs';

const { freshDir, cleanup } = freshDirFactory('hermit-rdt-');
afterAll(cleanup);

const BASE_INPUT = {
  packages: [] as string[],
  auth: 'oauth-token' as const,
  channels: { envLines: [] as string[], volumeLines: [] as string[] },
  agentHookProfile: 'strict',
  networkMode: 'bridge' as const,
  gitIdentityMount: true,
};

async function render(dir: string, overrides: Record<string, unknown> = {}) {
  const input = { ...BASE_INPUT, ...overrides };
  const r = await runScript('render-docker-templates.ts', { args: [dir], stdin: JSON.stringify(input) });
  return r;
}

const dockerfile = (dir: string) => fs.readFileSync(path.join(dir, 'Dockerfile.hermit'), 'utf8');
const compose = (dir: string) => fs.readFileSync(path.join(dir, 'docker-compose.hermit.yml'), 'utf8');

describe('render-docker-templates.ts', () => {
  test('renders all three files, exit 0, no {{ }} left', async () => {
    const dir = freshDir();
    const r = await render(dir);
    expect(r.exitCode).toBe(0);
    expect(dockerfile(dir)).not.toMatch(/\{\{[A-Z][A-Z0-9_]*\}\}/);
    expect(compose(dir)).not.toMatch(/\{\{[A-Z][A-Z0-9_]*\}\}/);
    expect(fs.existsSync(path.join(dir, 'docker-entrypoint.hermit.sh'))).toBe(true);
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

  // The operator block is a durable merge contract: hermit-evolve's section 5d
  // merges operator edits around it, and docker-customize tells operators to put
  // root-context installs inside it. A later template edit that drops or moves it
  // would silently remove that surface, so pin both markers and their position.
  test('operator block survives rendering, once, above the host-UID layer', async () => {
    const dir = freshDir();
    await render(dir, { packages: ['ffmpeg'] });
    const df = dockerfile(dir);
    expect(df.match(/^# --- operator:/gm) ?? []).toHaveLength(1);
    expect(df.match(/^# --- end operator ---$/gm) ?? []).toHaveLength(1);
    expect(df.indexOf('# --- operator:')).toBeLessThan(df.indexOf('# --- end operator ---'));
    expect(df.indexOf('# --- end operator ---')).toBeLessThan(df.indexOf('# Match host UID'));
  });

  test('operator block sits between the packages token and the host-UID layer in the template', () => {
    const tpl = fs.readFileSync(
      path.join(PLUGIN_ROOT, 'state-templates', 'docker', 'Dockerfile.hermit.template'), 'utf8');
    expect(tpl.match(/^# --- operator:/gm) ?? []).toHaveLength(1);
    expect(tpl.match(/^# --- end operator ---$/gm) ?? []).toHaveLength(1);
    const order = ['{{PACKAGES_BLOCK}}', '# --- operator:', '# --- end operator ---', '# Match host UID']
      .map((needle) => tpl.indexOf(needle));
    expect(order).not.toContain(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // No template token inside the block, or rendering would substitute into
    // operator-owned lines and the merge would fight the renderer.
    const block = tpl.slice(order[1], order[2]);
    expect(block).not.toMatch(/\{\{[A-Z][A-Z0-9_]*\}\}/);
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

  test('api-key auth adds ANTHROPIC_API_KEY env line; oauth does not', async () => {
    const keyDir = freshDir();
    await render(keyDir, { auth: 'api-key' });
    expect(compose(keyDir)).toContain('- ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}');

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
      auth: 'api-key' as const,
      channels: {
        envLines: ['DISCORD_STATE_DIR=${PWD}/.claude.local/channels/discord'],
        volumeLines: ['${PWD}/.claude.local/channels/discord:/home/claude/.claude/channels/discord'],
      },
      agentHookProfile: 'strict',
      networkMode: 'host' as const,
      gitIdentityMount: false,
      fleetMesh: true,
    };
    await render(dir, input);
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      channels: { discord: { enabled: true } },
      docker: {
        packages: input.packages,
        network_mode: input.networkMode,
        fleet_mesh: input.fleetMesh,
      },
    }));

    expect(deriveRenderInputs(configPath, path.join(dir, 'docker-compose.hermit.yml'))).toEqual(input);
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

    const derived = deriveRenderInputs(configPath, path.join(dir, 'docker-compose.hermit.yml'));
    expect(derived?.networkMode).toBe('bridge');
  });

  async function deriveWithGitMount(from: string, to: string) {
    const dir = freshDir();
    await render(dir, { channels: { envLines: [], volumeLines: [] } });
    const composePath = path.join(dir, 'docker-compose.hermit.yml');
    fs.writeFileSync(composePath, compose(dir).replace(from, to));
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      channels: {},
      docker: { packages: [], fleet_mesh: false },
    }));
    return deriveRenderInputs(configPath, composePath);
  }

  test('a custom git identity mount source derives as gitIdentityMount', async () => {
    const derived = await deriveWithGitMount(
      '${HOME}/.gitconfig:/home/claude/.gitconfig:ro',
      '${PWD}/.claude.local/gitconfig:/home/claude/.gitconfig:ro',
    );
    expect(derived?.gitIdentityMount).toBe(true);
  });

  test('two git identity mounts stay underivable', async () => {
    const line = '      - ${HOME}/.gitconfig:/home/claude/.gitconfig:ro\n';
    const derived = await deriveWithGitMount(
      line,
      line + '      - ${PWD}/.claude.local/gitconfig:/home/claude/.gitconfig:ro\n',
    );
    expect(derived).toBeNull();
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
    expect(byKey['docker/Dockerfile.hermit.template']).toContain('state-templates/docker/Dockerfile.hermit.template');
  });

  test('relative project-root argv is resolved to an absolute path', async () => {
    const dir = freshDir();
    const rel = path.relative(process.cwd(), dir);
    const r = await runScript('render-docker-templates.ts', {
      args: [rel], stdin: JSON.stringify(BASE_INPUT),
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    for (const w of out.written) expect(path.isAbsolute(w)).toBe(true);
  });

  test('--to writes only under the requested output directory', async () => {
    const projectRoot = freshDir();
    const outputDir = freshDir();
    const r = await runScript('render-docker-templates.ts', {
      args: [projectRoot, '--to', outputDir], stdin: JSON.stringify(BASE_INPUT),
    });

    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(outputDir, 'Dockerfile.hermit'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'docker-compose.hermit.yml'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'docker-entrypoint.hermit.sh'))).toBe(true);
    expect(fs.readdirSync(projectRoot)).toEqual([]);
  });

  test('a failed render prints {"error"} on stdout and writes nothing', async () => {
    const dir = freshDir();
    const r = await runScript('render-docker-templates.ts', { args: [dir], stdin: 'not json' });
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
  const derived = deriveRenderInputs(configPath, path.join(dir, 'docker-compose.hermit.yml'));
  expect(derived?.channelPlugins).toEqual(channelPlugins);
  expect((await render(dir, { ...derived! })).exitCode).toBe(0);
  expect(dockerfile(dir)).toContain(JSON.stringify({ channelsEnabled: true, allowedChannelPlugins: channelPlugins }));
});

test('official-only channel plugins need no managed approval drop-in', async () => {
  const dir = freshDir();
  expect((await render(dir, { channelPlugins: [{ marketplace: 'claude-plugins-official', plugin: 'discord' }] })).exitCode).toBe(0);
  expect(dockerfile(dir)).not.toContain('hermitd-channels.json');
});
