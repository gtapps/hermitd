#!/usr/bin/env bun
/**
 * Renders the base Docker scaffolding for /docker-setup Step 7b.6.
 *
 * The skill owns every DECISION (auth, channels, packages, networking, plugin
 * resolution) and hands this script the resolved SEMANTIC inputs on stdin; the
 * script derives the `{{PLACEHOLDER}}` strings, renders `Dockerfile.hermit` and
 * `docker-compose.hermit.yml` from the upstream templates, and copies the
 * entrypoint verbatim (it has no placeholders — the session name is resolved
 * from config.json at container startup, so it must be `cp`-copied, never
 * regenerated). All rendering + validation happens in memory; nothing is
 * written unless every file passes the fail-loud placeholder check.
 *
 * Usage: bun render-docker-templates.ts <project-root> [--to <output-dir>]
 *   stdin JSON:
 *     {
 *       "packages": ["libsqlite3-dev", ...],
 *       "auth": "setup-token" | "oauth-token" | "api-key",
 *       "channels": {
 *         "envLines":    ["DISCORD_STATE_DIR=${PWD}/.claude.local/channels/discord", ...],
 *         "volumeLines": ["${PWD}/.claude.local/channels/discord:/home/claude/.claude/channels/discord", ...]
 *       },
 *       "networkMode": "bridge" | "host",
 *       "gitIdentityMount": true,
 *       "fleetMesh": true            // optional; absent == false
 *     }
 *   channels.envLines / volumeLines carry the line BODY (the text after
 *   `      - `); this script owns the compose indentation.
 *
 * Prints JSON to stdout:
 *   { "written": ["/abs/Dockerfile.hermit", "/abs/docker-compose.hermit.yml"],
 *     "entrypoint_copied": true,
 *     "manifest_seed": { "plugin_version": "...", "entries": [...] } }
 * The skill pipes `manifest_seed` straight into manifest-seed.ts — this script
 * does NOT hash anything itself (one writer per file). Its value is that script's
 * stdin payload, so it keeps manifest-seed's input keys.
 *
 * Exit 0 on success. Any validation failure / unsubstituted placeholder →
 * `{"error":"render_failed:<detail>"}`, exit 1, nothing written.
 */

import fs from 'node:fs';
import path from 'node:path';
import { renderTemplate } from './lib/render-template';
import { exitError } from './lib/cli';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');
const TEMPLATES_DIR = path.join(PLUGIN_ROOT, 'state-templates', 'docker');

const ENV_INDENT = '      - ';

export interface Channels {
  envLines?: string[];
  volumeLines?: string[];
}
export interface Inputs {
  packages?: string[];
  auth: 'setup-token' | 'oauth-token' | 'api-key';
  channels?: Channels;
  channelPlugins?: Array<{ marketplace: string; plugin: string }>;
  networkMode: 'bridge' | 'host';
  gitIdentityMount: boolean;
  fleetMesh?: boolean;
}

export interface TemplateSources {
  dockerfile: string;
  compose: string;
}

function packagesBlock(packages: string[]): string {
  if (packages.length === 0) return '';
  return [
    '# Project-specific packages (from config.json docker.packages)',
    '# Rendered at /docker-setup time. To add a package now, put it in the operator',
    '# block below (or run /docker-customize), then rebuild.',
    'RUN apt-get update && apt-get install -y --no-install-recommends \\',
    `      ${packages.join(' ')} && \\`,
    '    rm -rf /var/lib/apt/lists/*',
  ].join('\n');
}

function indentedLines(bodies: string[]): string {
  return bodies.map((b) => ENV_INDENT + b).join('\n');
}

function channelAllowlistBlock(plugins: NonNullable<Inputs['channelPlugins']>): string {
  if (!plugins.some(entry => entry.marketplace !== 'claude-plugins-official')) return '';
  const policy = JSON.stringify({ channelsEnabled: true, allowedChannelPlugins: plugins });
  const quoted = "'" + policy.replaceAll("'", "'\\''") + "'";
  return `RUN mkdir -p /etc/claude-code/managed-settings.d && printf '%s\\n' ${quoted} > /etc/claude-code/managed-settings.d/hermitd-channels.json`;
}

/** Build every rendered file from supplied template sources. */
export function renderSources(
  inputs: Inputs,
  templates: TemplateSources,
): { dockerfile: string; compose: string } {
  const packages = inputs.packages ?? [];
  const channels = inputs.channels ?? {};
  // envLines/volumeLines feed the CHANNEL_ENV_LINES and CHANNEL_VOLUME_LINES
  // placeholders, which are really just "extra env/volume lines" despite the
  // channel-specific name — fleet mesh reuses them instead of adding its own.
  const envLines = [
    ...(channels.envLines ?? []),
    ...(inputs.fleetMesh ? ['XDG_RUNTIME_DIR=/run/hermit-fleet'] : []),
  ];
  const volumeLines = [
    ...(channels.volumeLines ?? []),
    ...(inputs.fleetMesh
      ? [
          'hermit-fleet-sessions:/home/claude/.claude/sessions',
          'hermit-fleet-socks:/run/hermit-fleet',
        ]
      : []),
  ];

  const dockerfileTemplate = templates.dockerfile;
  let composeTemplate = templates.compose;

  // Git identity has no placeholder in the template — it is a fixed bind-mount
  // line the skill removes when the host has no ~/.gitconfig.
  if (!inputs.gitIdentityMount) {
    composeTemplate = composeTemplate.replace(
      '      - ${HOME}/.gitconfig:/home/claude/.gitconfig:ro\n', '');
  }

  const dockerfile = renderTemplate(dockerfileTemplate, {
    PACKAGES_BLOCK: packagesBlock(packages),
    CHANNEL_ALLOWLIST_BLOCK: channelAllowlistBlock(inputs.channelPlugins ?? []),
  });

  // AUTH_ENV_LINE carries a trailing newline (api-key) so CHANNEL_ENV_LINES,
  // which shares the same template line, starts on a fresh line.
  //
  // Only api-key gets an env line. Both subscription modes read their
  // credential from the claude-config volume — and setup-token specifically
  // must NOT be wired through .env: compose applies env_file at container
  // creation only, so an .env-stored token would need a host-side recreate on
  // every renewal, defeating the point of channel-relayed re-auth. hermitd-start
  // exports it from the volume file at process start instead.
  const authEnvLine = inputs.auth === 'api-key'
    ? '      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}\n'
    : '';
  const networkModeLine = inputs.networkMode === 'host'
    ? '    # WARNING: host networking exposes all host-local services to the container.\n    network_mode: host'
    : '';
  // FLEET_MESH_PID_LINE shares a template line with NETWORK_MODE_LINE, so it
  // carries its own leading newline — but only when NETWORK_MODE_LINE is
  // non-empty, otherwise the default bridge case gains a stray blank line.
  const fleetMeshPidLine = inputs.fleetMesh
    ? `${networkModeLine ? '\n' : ''}    pid: "container:hermit-fleet-pidns"`
    : '';
  // Appended straight after "claude-config:" on the same template line.
  const fleetMeshVolumeDeclarations = inputs.fleetMesh
    ? '\n  hermit-fleet-sessions:\n    external: true\n  hermit-fleet-socks:\n    external: true'
    : '';

  const compose = renderTemplate(composeTemplate, {
    AUTH_ENV_LINE: authEnvLine,
    CHANNEL_ENV_LINES: indentedLines(envLines),
    CHANNEL_VOLUME_LINES: indentedLines(volumeLines),
    NETWORK_MODE_LINE: networkModeLine,
    FLEET_MESH_PID_LINE: fleetMeshPidLine,
    FLEET_MESH_VOLUME_DECLARATIONS: fleetMeshVolumeDeclarations,
  });

  return { dockerfile, compose };
}

/** Build every rendered file in memory. Throws on any unsubstituted placeholder. */
export function render(inputs: Inputs): { dockerfile: string; compose: string } {
  return renderSources(inputs, {
    dockerfile: fs.readFileSync(path.join(TEMPLATES_DIR, 'Dockerfile.hermit.template'), 'utf8'),
    compose: fs.readFileSync(path.join(TEMPLATES_DIR, 'docker-compose.hermit.yml.template'), 'utf8'),
  });
}

function pluginVersion(): string {
  const pj = JSON.parse(
    fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  return String(pj.version);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const toIndex = argv.indexOf('--to');
  if (toIndex !== -1 && !argv[toIndex + 1]) exitError();
  const projectRootArg = argv.find(
    (arg, index) => arg !== '--to' && (toIndex === -1 || index !== toIndex + 1),
  );
  const projectRoot = path.resolve(projectRootArg || process.cwd());
  const outputDir = toIndex === -1 ? projectRoot : path.resolve(argv[toIndex + 1]);

  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('error', () => {});
  process.stdin.on('end', () => {
    try {
      const inputs = JSON.parse(raw) as Inputs;

      // Render + validate everything before any write. pluginVersion() reads +
      // parses plugin.json; resolve it here too so a missing/corrupt manifest
      // throws BEFORE any file is written (honours the "nothing written" contract).
      const { dockerfile, compose } = render(inputs);
      const entrypointSrc = path.join(TEMPLATES_DIR, 'docker-entrypoint.hermit.sh.template');
      if (!fs.existsSync(entrypointSrc)) throw new Error(`missing entrypoint template: ${entrypointSrc}`);
      const version = pluginVersion();

      const dockerfilePath = path.join(outputDir, 'Dockerfile.hermit');
      const composePath = path.join(outputDir, 'docker-compose.hermit.yml');
      const entrypointPath = path.join(outputDir, 'docker-entrypoint.hermit.sh');

      // `--to` may name a scratch dir that does not exist yet (evolve's
      // `state/evolve-docker/theirs`). Still after render+validate, so a
      // rendering failure creates nothing.
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(dockerfilePath, dockerfile);
      fs.writeFileSync(composePath, compose);
      fs.copyFileSync(entrypointSrc, entrypointPath);

      const manifestSeed = {
        plugin_version: version,
        entries: [
          { key: 'docker/docker-entrypoint.hermit.sh', file: entrypointPath },
          {
            key: 'docker/docker-compose.hermit.yml.template',
            file: path.join(TEMPLATES_DIR, 'docker-compose.hermit.yml.template'),
          },
          {
            key: 'docker/Dockerfile.hermit.template',
            file: path.join(TEMPLATES_DIR, 'Dockerfile.hermit.template'),
          },
        ],
      };

      console.log(JSON.stringify({
        written: [dockerfilePath, composePath],
        entrypoint_copied: true,
        manifest_seed: manifestSeed,
      }));
      process.exit(0);
    } catch (e: any) {
      exitError(`render_failed:${e.message}`);
    }
  });
}
