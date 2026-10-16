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

function readCompose(file: string): any | null {
  try {
    const parsed = Bun.YAML.parse(fs.readFileSync(file, 'utf8'));
    return isDict(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function deriveRenderInputs(configPath: string, composePath: string): Inputs | null {
  const config = readJson(configPath);
  const compose = readCompose(composePath);
  if (!config || !compose || !isDict(config.docker)) return null;

  const packages = config.docker.packages;
  // `network_mode` is absent from the shipped config template and from every
  // deploy predating it; the renderer and /docker-security both treat absent as
  // "bridge", so rejecting it here would strand those hermits on report-only.
  const networkMode = config.docker.network_mode ?? 'bridge';
  const fleetMesh = config.docker.fleet_mesh ?? false;
  if (!Array.isArray(packages) || packages.some((pkg: unknown) => typeof pkg !== 'string')) return null;
  if (networkMode !== 'bridge' && networkMode !== 'host') return null;
  if (typeof fleetMesh !== 'boolean') return null;
  if (!isDict(config.channels)) return null;

  const envLines: string[] = [];
  const volumeLines: string[] = [];
  for (const channel of getEnabledChannels(config)) {
    const envKey = channelStateDirKey(channel);
    if (!envKey) return null;
    const relativeStateDir = `.claude.local/channels/${channel}`;
    envLines.push(`${envKey}=\${PWD}/${relativeStateDir}`);
    volumeLines.push(`\${PWD}/${relativeStateDir}:/home/claude/.claude/channels/${channel}`);
  }

  const hermit = compose.services?.hermit;
  if (!isDict(hermit) || !Array.isArray(hermit.environment) || !Array.isArray(hermit.volumes)) return null;
  if (hermit.environment.some((line: unknown) => typeof line !== 'string')) return null;
  if (hermit.volumes.some((line: unknown) => typeof line !== 'string')) return null;

  const authLines = hermit.environment.filter((line: string) => line.startsWith('ANTHROPIC_API_KEY='));
  if (authLines.length > 1) return null;

  let auth: Inputs['auth'];
  if (authLines.length === 0) {
    auth = 'oauth-token';
  } else if (authLines[0] === 'ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}') {
    auth = 'api-key';
  } else {
    return null;
  }

  // Any source counts: base and theirs render the template's default line, so
  // the 3-way merge keeps an operator-chosen source as an ordinary local edit.
  const gitIdentityMounts = hermit.volumes.filter(
    (line: string) => /:\/home\/claude\/\.gitconfig(:|$)/.test(line),
  );
  if (gitIdentityMounts.length > 1) return null;
  const gitIdentityMount = gitIdentityMounts.length === 1;

  return {
    packages: [...packages],
    auth,
    channels: { envLines, volumeLines },
    agentHookProfile: 'strict',
    networkMode,
    gitIdentityMount,
    fleetMesh,
  };
}
