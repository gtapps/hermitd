#!/usr/bin/env bun
import path from 'node:path';
import { ENV_VAR_RE } from './lib/channel-config';
import { channelStateDir as resolveChannelStateDir } from './lib/channel-token';
import { printJson, readHidden, readStdin } from './lib/cli';
import { readConfigRaw } from './lib/config-read';
import { isContainer } from './lib/container';
import { privateEnvPath, upsertEnvVar } from './lib/env-file';

async function save(argv: string[]): Promise<object> {
  if (isContainer()) return { error: 'host_only' };
  const [channel, project, name, docker, ...extra] = argv;
  if (!project || !channel || !/^[a-z0-9][a-z0-9_-]*$/i.test(channel)
    || (docker !== undefined && docker !== '--docker') || extra.length) return { error: 'usage' };
  if (!name || !ENV_VAR_RE.test(name)) return { error: 'invalid_var' };

  const hermit = path.resolve(project, '.hermit');
  const stateDir = docker
    ? path.resolve(project, '.claude.local', 'channels', channel)
    : resolveChannelStateDir(hermit, channel, readConfigRaw(hermit)?.channels?.[channel]);
  const destination = path.join(stateDir, '.env');
  if (!privateEnvPath(project, destination)) return { error: 'state_dir_outside_claude_local' };

  let value: string;
  try {
    value = process.stdin.isTTY
      ? await readHidden(`Value for ${name} (not shown): `)
      : (await readStdin()).replace(/\r?\n$/, '');
  } catch {
    return { error: 'cancelled' };
  }
  if (!value.trim() || /[\r\n\0]/.test(value)) return { error: 'bad_value' };

  // Check again after the operator has finished entering the value.
  const file = privateEnvPath(project, destination);
  if (!file) return { error: 'state_dir_outside_claude_local' };
  upsertEnvVar(file, name, value);
  return { status: 'saved', channel, file, length: value.length };
}

if (import.meta.main) {
  try { printJson(await save(process.argv.slice(2))); }
  catch { printJson({ error: 'channel_token_write_failed' }); process.exitCode = 1; }
}
