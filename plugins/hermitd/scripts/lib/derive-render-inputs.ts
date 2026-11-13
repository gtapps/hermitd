import fs from 'node:fs';
import type { Inputs } from '../render-docker-templates';
import { channelStateDirKey, getEnabledChannels, isDict } from './channel-config';

function readJson(file: string): any | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isDict(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function deriveRenderInputs(configPath: string): Inputs | null {
  const config = readJson(configPath);
  if (!config || !isDict(config.docker)) return null;

  const packages = config.docker.packages;
  // `network_mode` is absent from the shipped config template and from every
  // deploy predating it; the renderer and /docker-security both treat absent as
  // "bridge", so rejecting it here would strand those hermits on report-only.
  const networkMode = config.docker.network_mode ?? 'bridge';
  const browser = config.browser?.enabled === undefined ? true : config.browser.enabled;
  if (typeof browser !== 'boolean') return null;
  const browserPort = config.browser?.port ?? undefined;
  if (browserPort !== undefined && (!Number.isInteger(browserPort) || browserPort < 1 || browserPort > 65535)) return null;
  const fleetMesh = config.docker.fleet_mesh ?? false;
  if (!Array.isArray(packages) || packages.some((pkg: unknown) => typeof pkg !== 'string')) return null;
  if (networkMode !== 'bridge' && networkMode !== 'host') return null;
  if (typeof fleetMesh !== 'boolean') return null;
  if (!isDict(config.channels)) return null;

  const envLines: string[] = [];
  const volumeLines: string[] = [];
  for (const channel of getEnabledChannels(config)) {
    // A channel key that is not a shell identifier gets no state-dir wiring; it never blocks the render.
    const envKey = channelStateDirKey(channel);
    if (!envKey) continue;
    const relativeStateDir = `.claude.local/channels/${channel}`;
    envLines.push(`${envKey}=\${PWD}/${relativeStateDir}`);
    volumeLines.push(`\${PWD}/${relativeStateDir}:/home/claude/.claude/channels/${channel}`);
  }

  const gitIdentityMount = config.docker.git_identity_mount ?? true;
  if (typeof gitIdentityMount !== 'boolean') return null;

  return {
    packages: [...packages],
    channels: { envLines, volumeLines },
    // Built-in channels boot from claude-plugins-official whatever their config says (hermitd-start).
    channelPlugins: getEnabledChannels(config).map(key => ['discord', 'telegram', 'imessage'].includes(key)
      ? { marketplace: 'claude-plugins-official', plugin: key }
      : { marketplace: config.channels[key].marketplace ?? 'claude-plugins-official', plugin: config.channels[key].plugin ?? key }),
    networkMode,
    gitIdentityMount,
    fleetMesh,
    browser,
    ...(browserPort !== undefined && config.docker.security?.network?.enabled !== true ? { browserPort } : {}),
  };
}
