import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pinStateDirOrExit } from './lib/cc-compat';
import { homeSeedBlock } from './lib/channel-config';
import { channelStateDir } from './lib/channel-token';
import { auditConfigChange } from './lib/config-audit';
import { readConfigRaw } from './lib/config-read';
import { persistConfig } from './lib/config-write';
import { writeFileAtomic } from './lib/md-write';
import { failJson, printJson } from './lib/cli';

export const CODE_RE = /^[A-Za-z0-9]{6}$/;
export const GROUP_ID_RE = /^-?\d{1,20}$/;

interface GroupEntry {
  requireMention: boolean;
  allowFrom: string[];
}

interface Access {
  dmPolicy: string;
  allowFrom?: string[];
  pending?: Record<string, { senderId: string; chatId: string; expiresAt: number }>;
  groups?: Record<string, GroupEntry>;
  mentionPatterns?: string[];
  ackReaction?: string;
  [key: string]: unknown;
}

export function mergeGroupEntry(access: Access, chatId: string, entry: GroupEntry): Access {
  return {
    ...access,
    groups: { ...access.groups, [chatId]: { ...entry, allowFrom: [...entry.allowFrom] } },
  };
}

function options(args: string[]) {
  const values = new Map<string, string>();
  let ackOff = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--ack-off' && !ackOff) {
      ackOff = true;
    } else if (['--mention', '--allow', '--shared', '--passive', '--nicknames'].includes(flag)
      && !values.has(flag) && args[i + 1] !== undefined) {
      values.set(flag, args[++i]);
    } else throw new Error('invalid_options');
  }
  for (const flag of ['--mention', '--shared', '--passive']) {
    if (!['yes', 'no'].includes(values.get(flag) ?? '')) throw new Error('invalid_options');
  }
  if (!values.has('--allow')) throw new Error('invalid_options');
  const allowFrom = values.get('--allow') === 'none' ? [] : values.get('--allow')!.split(',');
  if (allowFrom.some(id => !GROUP_ID_RE.test(id))) throw new Error('invalid_id');
  const requireMention = values.get('--mention') === 'yes';
  const shared = values.get('--shared') === 'yes';
  const passive = values.get('--passive') === 'yes';
  if (passive && (requireMention || allowFrom.length > 0)) throw new Error('passive_needs_open_group');
  let nicknames: string[] = [];
  if (values.has('--nicknames')) {
    try {
      nicknames = JSON.parse(values.get('--nicknames')!);
    } catch { throw new Error('invalid_options'); }
    if (!Array.isArray(nicknames) || nicknames.some(pat => typeof pat !== 'string')) throw new Error('invalid_options');
    try {
      for (const pat of nicknames) new RegExp(pat, 'i');
    } catch { throw new Error('invalid_regex'); }
  }
  return { entry: { requireMention, allowFrom }, shared, passive, nicknames, ackOff };
}

function readAccess(file: string): Access {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('no_access_file');
    throw error;
  }
}

function writeAccess(dir: string, channel: string, file: string, before: Access, after: Access): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  writeFileAtomic(file, JSON.stringify(after, null, 2) + '\n', 0o600);
  auditConfigChange(dir, before, after, 'channel-access', `${channel}/access.json`);
}

function main(): void {
  const [argvDir, verb, channel, value, ...args] = process.argv.slice(2);
  if (!argvDir || !verb) throw new Error('usage');
  const dir = pinStateDirOrExit(argvDir);
  if (channel !== 'discord' && channel !== 'telegram') throw new Error('unsupported_channel');
  const config = readConfigRaw(dir);
  if (config === null) throw new Error('no_config');
  const file = path.join(channelStateDir(dir, channel, config.channels?.[channel]), 'access.json');

  const homeFile = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'channels', channel, 'access.json');

  if (verb === 'pair') {
    const restrict = args.length === 1 && args[0] === '--restrict';
    if (!value || !CODE_RE.test(value) || (args.length > 0 && !restrict)) throw new Error('invalid_code');
    let source: 'state' | 'home' = 'state';
    let pairFile = file;
    let access: Access | undefined;
    for (const candidate of [file, homeFile]) {
      try { access = readAccess(candidate); } catch (error) {
        if (!(error instanceof Error) || error.message !== 'no_access_file') throw error;
        access = undefined;
      }
      if (access?.pending?.[value]) {
        pairFile = candidate;
        source = candidate === file ? 'state' : 'home';
        break;
      }
    }
    const pending = access?.pending?.[value];
    if (!access || !pending) throw new Error('code_unknown');
    if (pending.expiresAt < Date.now()) throw new Error('code_expired');
    if (!GROUP_ID_RE.test(pending.senderId) || !GROUP_ID_RE.test(pending.chatId)) throw new Error('invalid_id');
    const next = structuredClone(access);
    next.allowFrom = [...new Set([...(access.allowFrom ?? []), pending.senderId])];
    delete next.pending![value];
    if (restrict) next.dmPolicy = 'allowlist';
    writeAccess(dir, channel, pairFile, access, next);
    const approve = (accessFile: string) => {
      const approved = path.join(path.dirname(accessFile), 'approved');
      fs.mkdirSync(approved, { recursive: true });
      writeFileAtomic(path.join(approved, pending.senderId), pending.chatId, 0o600);
    };
    approve(pairFile);
    let label: string = source;
    // A home code with an existing state file: the hermit reads the state file, and
    // channel-setup only moves the home file when the state file is absent.
    if (source === 'home' && fs.existsSync(file)) {
      const stateAccess = readAccess(file);
      const stateNext = structuredClone(stateAccess);
      if (restrict) stateNext.dmPolicy = 'allowlist';
      stateNext.allowFrom = [...new Set([...(stateAccess.allowFrom ?? []), pending.senderId])];
      writeAccess(dir, channel, file, stateAccess, stateNext);
      approve(file);
      label = 'home+state';
    }
    // Plugins issue codes only in DMs, so this is the operator's own chat. Seeding
    // the home here lets unattended sends reach it before the first inbound message.
    const channelConfig = config.channels?.[channel];
    let home = 'kept';
    if (restrict && !channelConfig) throw new Error('access_config_write_failed');
    if (channelConfig && (restrict || homeSeedBlock(channelConfig, pending.chatId) === null)) {
      const after = structuredClone(config);
      if (homeSeedBlock(channelConfig, pending.chatId) === null) after.channels[channel].default_chat_id = pending.chatId;
      if (restrict) after.channels[channel].allowed_users = [...new Set([...(channelConfig.allowed_users ?? []), pending.senderId])];
      // The code is already consumed, so a failed seed must not fail the pairing;
      // channel-hook still seeds the home on the first inbound reply.
      try {
        const result = persistConfig({ hermitDir: dir, before: config, after, actor: 'channel-access' });
        if (result.newErrors.length > 0) throw new Error('invalid_config');
        for (const warning of result.newWarnings) console.error(`Warning: ${warning}`);
        home = homeSeedBlock(channelConfig, pending.chatId) === null ? 'set' : 'kept';
      } catch (error) {
        if (restrict) throw new Error('access_config_write_failed');
        console.error(`Warning: home chat not set: ${(error as Error).message}`);
        home = 'failed';
      }
    }
    printJson({ channel, sender_id: pending.senderId, file: label, home });
    return;
  }

  if (verb === 'policy') {
    if (!['pairing', 'allowlist', 'disabled'].includes(value) || args.length > 0) throw new Error('invalid_policy');
    let policyFile = file;
    let access: Access;
    try { access = readAccess(policyFile); } catch (error) {
      if (!(error instanceof Error) || error.message !== 'no_access_file') throw error;
      policyFile = homeFile;
      access = readAccess(policyFile);
    }
    writeAccess(dir, channel, policyFile, access, { ...access, dmPolicy: value });
    printJson({ channel, policy: value });
    return;
  }

  if (verb === 'ensure-defaults') {
    if (value !== undefined) throw new Error('invalid_options');
    const access = readAccess(file);
    const kept = Object.hasOwn(access, 'ackReaction');
    if (!kept) writeAccess(dir, channel, file, access, { ...access, ackReaction: '👀' });
    printJson({ ack: kept ? 'kept' : 'set' });
    return;
  }

  if (verb !== 'group-add') throw new Error('unknown_verb');
  if (!value || !GROUP_ID_RE.test(value)) throw new Error('invalid_id');
  const { entry, shared, passive, nicknames, ackOff } = options(args);
  if (config.channels?.[channel]?.maintainer_channel_id === value) throw new Error('maintainer_chat');
  if (readAccess(file).dmPolicy === 'disabled') throw new Error('policy_disabled');
  const before = readConfigRaw(dir);
  if (before === null) throw new Error('no_config');
  const after = structuredClone(before);
  const channelConfig = after.channels?.[channel];
  if (!channelConfig) throw new Error('no_channel_config');
  for (const [key, include] of [['passive_chats', passive], ['shared_chats', shared]] as const) {
    const ids: string[] = channelConfig[key] ?? [];
    channelConfig[key] = include ? [...new Set([...ids, value])] : ids.filter(id => id !== value);
  }
  const result = persistConfig({ hermitDir: dir, before, after, actor: 'channel-access' });
  if (result.newErrors.length > 0) throw new Error('invalid_config');
  for (const warning of result.newWarnings) console.error(`Warning: ${warning}`);
  let next: Access;
  try {
    const access = readAccess(file);
    next = mergeGroupEntry(access, value, entry);
    if (nicknames.length > 0) next.mentionPatterns = [...new Set([...(access.mentionPatterns ?? []), ...nicknames])];
    if (ackOff) next.ackReaction = '';
    writeAccess(dir, channel, file, access, next);
  } catch {
    console.error('re-run the same command');
    throw new Error('partial_config_written');
  }
  printJson({
    channel, chat_id: value, mention: entry.requireMention, allow: entry.allowFrom.length || 'anyone',
    shared, passive, patterns: next.mentionPatterns?.length ?? 0, ack: ackOff ? 'off' : 'kept',
  });
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    failJson(error);
  }
}
