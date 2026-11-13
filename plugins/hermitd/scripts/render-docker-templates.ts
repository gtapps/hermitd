#!/usr/bin/env bun
import { BROWSER_PINS } from './lib/browser-pins';
/** Render plugin-owned Docker files from project config. */

import fs from 'node:fs';
import path from 'node:path';
import { renderTemplate } from './lib/render-template';
import { emitJson, exitError, printJson } from './lib/cli';
import { writeFileAtomic } from './lib/md-write';
import { deriveRenderInputs } from './lib/derive-render-inputs';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');
const TEMPLATES_DIR = path.join(PLUGIN_ROOT, 'state-templates', 'docker');

const ENV_INDENT = '      - ';

export interface Channels {
  envLines?: string[];
  volumeLines?: string[];
}
export interface Inputs {
  packages?: string[];
  channels?: Channels;
  channelPlugins?: Array<{ marketplace: string; plugin: string }>;
  networkMode: 'bridge' | 'host';
  gitIdentityMount: boolean;
  fleetMesh?: boolean;
  browser?: boolean;
  browserPort?: number;
}

export interface TemplateSources {
  dockerfile: string;
  compose: string;
}

function packagesBlock(packages: string[]): string {
  if (packages.length === 0) return '';
  return [
    '# Project-specific packages (from config.json docker.packages)',
    '# Edit docker.packages and rebuild with hermitd restart --build.',
    'RUN apt-get update && apt-get install -y --no-install-recommends \\',
    `      ${packages.join(' ')} && \\`,
    '    rm -rf /var/lib/apt/lists/*',
  ].join('\n');
}

function browserBlock(): string {
  return [
    '# --- managed browser ---',
    'ARG HERMIT_BROWSER=1',
    'RUN if [ "$HERMIT_BROWSER" = 1 ]; then apt-get update && apt-get install -y --no-install-recommends \\',
    '      tigervnc-standalone-server openbox procps libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 libgtk-3-0 libpangocairo-1.0-0 libpango-1.0-0 libatk1.0-0t64 libcairo-gobject2 libcairo2 libgdk-pixbuf-2.0-0 libxrender1 libasound2t64 libfreetype6 libfontconfig1 libdbus-1-3 libnss3 libnss3-tools libnspr4 libatk-bridge2.0-0t64 libdrm2 libxkbcommon0 libatspi2.0-0t64 libcups2t64 libxshmfence1 libgbm1 fonts-liberation && \\',
    '    rm -r /var/lib/apt/lists/* && \\',
    `    npm install -g --allow-scripts=agent-browser agent-browser@${BROWSER_PINS.agent.version} && \\`,
    '    case "$(dpkg --print-architecture)" in \\',
    `      amd64) platform=linux64; checksum=${BROWSER_PINS.chrome.checksums.linux64} ;; \\`,
    `      arm64) platform=linux-arm64; checksum=${BROWSER_PINS.chrome.checksums['linux-arm64']} ;; \\`,
    '      *) exit 1 ;; esac && \\',
    `    curl -fsSL "https://storage.googleapis.com/chrome-for-testing-public/${BROWSER_PINS.chrome.version}/\${platform}/chrome-\${platform}.zip" -o /tmp/chrome.zip && \\`,
    '    printf "%s  /tmp/chrome.zip\\n" "$checksum" | sha256sum -c - && \\',
    '    unzip -q /tmp/chrome.zip -d /opt && \\',
    '    if [ "$platform" != linux64 ]; then mv "/opt/chrome-${platform}" /opt/chrome-linux64; fi && \\',
    '    rm /tmp/chrome.zip && \\',
    `    curl -fsSL ${BROWSER_PINS.novnc.url} -o /tmp/novnc.tgz && \\`,
    `    echo "${BROWSER_PINS.novnc.checksum}  /tmp/novnc.tgz" | sha256sum -c - && \\`,
    '    mkdir -p /opt/novnc && tar xzf /tmp/novnc.tgz -C /opt/novnc --strip-components=1 && rm /tmp/novnc.tgz && \\',
    "    printf '%s\\n' '#!/bin/sh' 'if [ ! -f \"${HERMIT_PLUGIN_ROOT:-}/scripts/browser-agent.ts\" ]; then echo \"agent-browser: hermit plugin unavailable\" >&2; exit 1; fi' 'exec bun \"${HERMIT_PLUGIN_ROOT}/scripts/browser-agent.ts\" \"$@\"' > /usr/local/bin/agent-browser && \\",
    '    chmod 755 /usr/local/bin/agent-browser && \\',
    "    mkdir -p /etc/hermit && printf 'display=plugin\\n' > /etc/hermit/managed-browser; \\",
    '    fi',
    '# --- end managed browser ---',
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
  if (inputs.browserPort !== undefined && (!Number.isInteger(inputs.browserPort) || inputs.browserPort < 1 || inputs.browserPort > 65535)) throw new Error('invalid_viewer_port');
  const packages = inputs.packages ?? [];
  for (const pkg of packages) {
    if (!/^[a-z0-9][a-z0-9+\-.]+$/.test(pkg)) throw new Error(`invalid_package:${pkg}`);
  }
  const channels = inputs.channels ?? {};
  // envLines/volumeLines feed the CHANNEL_ENV_LINES and CHANNEL_VOLUME_LINES
  // placeholders, which are really just "extra env/volume lines" despite the
  // channel-specific name — fleet mesh reuses them instead of adding its own.
  const envLines = [
    ...(channels.envLines ?? []),
    ...(inputs.fleetMesh ? ['XDG_RUNTIME_DIR=/run/hermit-fleet'] : []),
    ...(inputs.browserPort && inputs.networkMode === 'host' ? [`HERMIT_BROWSER_VIEWER_BIND=127.0.0.1:${inputs.browserPort}`] : []),
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
    PACKAGES_BLOCK: [packagesBlock(packages), browserBlock(),
      '# --- transcription ---\nARG HERMIT_TRANSCRIPTION=1\nRUN if [ "$HERMIT_TRANSCRIPTION" = 1 ]; then apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -r /var/lib/apt/lists/*; fi',
    ].filter(Boolean).join('\n\n'),
    CHANNEL_ALLOWLIST_BLOCK: channelAllowlistBlock(inputs.channelPlugins ?? []),
  });

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
    CHANNEL_ENV_LINES: indentedLines(envLines),
    CHANNEL_VOLUME_LINES: indentedLines(volumeLines),
    NETWORK_MODE_LINE: networkModeLine,
    FLEET_MESH_PID_LINE: fleetMeshPidLine,
    BROWSER_PORT_LINE: inputs.browserPort && inputs.networkMode !== 'host'
      ? `${networkModeLine || fleetMeshPidLine ? '\n' : ''}    ports:\n      - "127.0.0.1:${inputs.browserPort}:6080"` : '', 
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
  try {
    const argv = process.argv.slice(2);
    const projectRoot = path.resolve(argv[0]);
    const toIndex = argv.indexOf('--to');
    if (toIndex !== -1 && !argv[toIndex + 1]) throw new Error('missing_output_dir');
    const outputDir = toIndex === -1 ? projectRoot : path.resolve(argv[toIndex + 1]);
    const version = pluginVersion();
    const dockerfilePath = path.join(outputDir, 'Dockerfile.hermit');
    const composePath = path.join(outputDir, 'docker-compose.hermit.yml');
    if (toIndex === -1 && fs.existsSync(dockerfilePath)) {
      const header = fs.readFileSync(dockerfilePath, 'utf8').split('\n')[0];
      const match = header.match(/Generated by hermitd (\d+\.\d+\.\d+)/);
      if (match && Bun.semver.order(match[1], version) > 0) {
        emitJson({ status: 'skipped', reason: 'newer_renderer' });
      }
      if (!match && !argv.includes('--convert')) {
        emitJson({ status: 'skipped', reason: 'not_converted' });
      }
    }
    const inputs = deriveRenderInputs(path.join(projectRoot, '.hermit', 'config.json'));
    if (!inputs) throw new Error('invalid_config');
    const { dockerfile, compose } = render(inputs);
    const header = `# Generated by hermitd ${version}. Customize docker.packages, docker-build.hermit-local.sh, docker-compose.override.yml, docker-entrypoint.hermit-local.sh.\n`;
    const entrypointPath = path.join(projectRoot, 'docker-entrypoint.hermit.sh');
    const entrypointSrc = path.join(TEMPLATES_DIR, 'docker-entrypoint.hermit.sh.template');
    const entrypointCopied = !fs.existsSync(entrypointPath);
    const entrypoint = entrypointCopied ? fs.readFileSync(entrypointSrc, 'utf8') : null;
    fs.mkdirSync(outputDir, { recursive: true });
    writeFileAtomic(dockerfilePath, header + dockerfile);
    writeFileAtomic(composePath, header + compose);
    if (entrypoint !== null) writeFileAtomic(entrypointPath, entrypoint, 0o755);
    emitJson({
      written: [dockerfilePath, composePath],
      entrypoint_copied: entrypointCopied,
      ...(entrypointCopied ? { manifest_seed: {
        plugin_version: version,
        entries: [{ key: 'docker/docker-entrypoint.hermit.sh', file: entrypointPath }],
      } } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('invalid_package:')) printJson({ error: message });
    else exitError(`render_failed:${message}`);
  }
}
