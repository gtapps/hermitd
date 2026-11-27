import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pinStateDirOrExit } from './lib/cc-compat';
import { senderRole } from './lib/channel-auth';
import { isThreadChannelType, lookupChat } from './lib/channel-chats';
import { homeSeedBlock, isDict } from './lib/channel-config';
import { channelStateDir } from './lib/channel-token';
import { auditConfigChange } from './lib/config-audit';
import { readConfigRaw } from './lib/config-read';
import { persistConfig } from './lib/config-write';
import { writeFileAtomic } from './lib/md-write';
import { failJson, printJson } from './lib/cli';

export const CODE_RE = /^[A-Za-z0-9]{6}$/;
// Dot segments cannot name an approval file or a Discord API path.
export const GROUP_ID_RE = /^(?!\.+$)[\w.~+@;=-]{1,128}$/;

interface GroupEntry {
  requireMention: boolean;
  allowFrom: string[];
}

interface Access {
  dmPolicy?: string;
  allowFrom?: string[];
  pending?: Record<string, { senderId: string; chatId: string; expiresAt: number }>;
  groups?: Record<string, Partial<GroupEntry>>;
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isGroupEntry(group: Partial<GroupEntry>): boolean {
  return isDict(group)
    && (!Object.hasOwn(group, 'requireMention') || typeof group.requireMention === 'boolean')
    && (!Object.hasOwn(group, 'allowFrom') || isStringArray(group.allowFrom));
}

export function readAccess(file: string): Access {
  let access;
  try {
    access = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('no_access_file');
    if (error instanceof SyntaxError) throw new Error('access_format_unsupported');
    throw error;
  }
  if (!isDict(access)
    || !['dmPolicy', 'allowFrom', 'groups', 'pending'].some(key => Object.hasOwn(access, key))
    || (Object.hasOwn(access, 'dmPolicy') && typeof access.dmPolicy !== 'string')
    || (Object.hasOwn(access, 'allowFrom') && !isStringArray(access.allowFrom))
    || (Object.hasOwn(access, 'pending') && !isDict(access.pending))
    || (Object.hasOwn(access, 'groups') && (!isDict(access.groups)
      || !Object.values<Partial<GroupEntry>>(access.groups).every(isGroupEntry)))) {
    throw new Error('access_format_unsupported');
  }
  return access;
}

function writeAccess(dir: string, channel: string, file: string, before: Access, after: Access): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  writeFileAtomic(file, JSON.stringify(after, null, 2) + '\n', 0o600);
  auditConfigChange(dir, before, after, 'channel-access', `${channel}/access.json`);
}

function persistGroupConfig(dir: string, before: unknown, after: unknown): void {
  const result = persistConfig({ hermitDir: dir, before, after, actor: 'channel-access' });
  if (result.newErrors.length > 0) throw new Error('invalid_config');
  for (const warning of result.newWarnings) console.error(`Warning: ${warning}`);
}

function configuredIds(value: unknown): string[] {
  return isStringArray(value) ? value : [];
}

async function main(): Promise<void> {
  const [argvDir, verb, channel, input, ...args] = process.argv.slice(2);
  let value = input;
  if (!argvDir || !verb) throw new Error('usage');
  const dir = pinStateDirOrExit(argvDir);
  const config = readConfigRaw(dir);
  if (config === null) throw new Error('no_config');
  if (!isDict(config.channels) || !Object.hasOwn(config.channels, channel)
    || !isDict(config.channels[channel])) throw new Error('no_channel_config');
  const file = path.join(channelStateDir(dir, channel, config.channels?.[channel]), 'access.json');

  const homeFile = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'channels', channel, 'access.json');

  if (verb === 'pair') {
    if (!value || !CODE_RE.test(value) || args.length > 0) throw new Error('invalid_code');
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
      stateNext.allowFrom = [...new Set([...(stateAccess.allowFrom ?? []), pending.senderId])];
      writeAccess(dir, channel, file, stateAccess, stateNext);
      approve(file);
      label = 'home+state';
    }
    // Plugins issue codes only in DMs, so this is the operator's own chat. Seeding
    // the home here lets unattended sends reach it before the first inbound message.
    const channelConfig = config.channels?.[channel];
    let home = 'kept';
    if (channelConfig && homeSeedBlock(channelConfig, pending.chatId) === null) {
      const after = structuredClone(config);
      after.channels[channel].default_chat_id = pending.chatId;
      // The code is already consumed, so a failed seed must not fail the pairing;
      // channel-hook still seeds the home on the first inbound reply.
      try {
        const result = persistConfig({ hermitDir: dir, before: config, after, actor: 'channel-access' });
        if (result.newErrors.length > 0) throw new Error('invalid_config');
        for (const warning of result.newWarnings) console.error(`Warning: ${warning}`);
        home = 'set';
      } catch (error) {
        console.error(`Warning: home chat not set: ${(error as Error).message}`);
        home = 'failed';
      }
    }
    try {
      const marker = path.join(dir, 'state', 'first-chat-pending.json');
      // Never create or recreate a marker consumed by a concurrent first chat.
      const fd = fs.openSync(marker, 'r+');
      try {
        const evidence = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (Array.isArray(evidence.private_chats)) {
          evidence.private_chats.push({ channel, chat_id: pending.chatId, sender_id: pending.senderId });
          const text = JSON.stringify(evidence) + '\n';
          fs.writeSync(fd, text, 0, 'utf8');
          fs.ftruncateSync(fd, Buffer.byteLength(text));
        }
      } finally { fs.closeSync(fd); }
    } catch { /* Pairing succeeds even without readable first-chat evidence. */ }
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

  if (verb === 'unpair') {
    if (!value || !GROUP_ID_RE.test(value)) throw new Error('invalid_id');
    if (args.length) throw new Error('invalid_options');
    const access = readAccess(file);
    const previous = access.allowFrom ?? [];
    const allowFrom = previous.filter(id => id !== value);
    let markerRemoved = false;
    try {
      fs.unlinkSync(path.join(path.dirname(file), 'approved', value));
      markerRemoved = true;
      auditConfigChange(dir, { approved: { [value]: true } }, { approved: {} },
        'channel-access', `${channel}/access.json`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (allowFrom.length === previous.length && !markerRemoved) {
      printJson({ changed: false });
      return;
    }
    if (allowFrom.length !== previous.length) writeAccess(dir, channel, file, access, { ...access, allowFrom });
    const warnings = [];
    if (previous.length && !allowFrom.length) warnings.push('last_approver');
    // No chat id: only a listed operator (or first allowed user) counts, never a home or maintainer chat.
    if (senderRole(config, channel, value, null) === 'operator') warnings.push('primary_operator');
    printJson({ changed: true, channel, sender_id: value, warnings });
    return;
  }

  if (!['show', 'group-allow', 'group-remove', 'group-add'].includes(verb)) throw new Error('unknown_verb');
  if ((verb !== 'show' || value !== undefined) && (!value || !GROUP_ID_RE.test(value))) throw new Error('invalid_id');
  if (value && channel === 'discord') {
    const chat = await lookupChat(dir, config, value, false, false);
    if (isThreadChannelType(chat) && chat?.parent_id && GROUP_ID_RE.test(chat.parent_id)) value = chat.parent_id;
  }
  if (verb !== 'group-add') {
    const access = readAccess(file);
    const channelConfig = config.channels[channel];
    const passiveChats = configuredIds(channelConfig.passive_chats);
    const sharedChats = configuredIds(channelConfig.shared_chats);
    const summary = () => ({ channel, approvers: access.allowFrom ?? [], chats: Object.keys(access.groups ?? {}) });
    if ((verb === 'show' || verb === 'group-remove') && args.length) throw new Error('invalid_options');
    if (!value) {
      printJson(summary());
      return;
    }
    const groups = access.groups ?? {};
    const group = Object.hasOwn(groups, value) ? groups[value] : undefined;
    const passive = passiveChats.includes(value);
    const shared = sharedChats.includes(value);
    if (verb === 'group-remove') {
      if (channelConfig.maintainer_channel_id === value) throw new Error('maintainer_chat');
      // A repeat after a partial write can finish removing the config references.
      if (!group && !passive && !shared) throw new Error('chat_not_enrolled');
      if (group) {
        const nextGroups = { ...groups };
        delete nextGroups[value];
        writeAccess(dir, channel, file, access, { ...access, groups: nextGroups });
      }
      if (passive || shared) {
        try {
          const before = readConfigRaw(dir);
          if (before === null) throw new Error('no_config');
          const after = structuredClone(before);
          const nextChannel = after.channels?.[channel];
          if (!isDict(nextChannel)) throw new Error('no_channel_config');
          for (const key of ['passive_chats', 'shared_chats']) {
            if (Array.isArray(nextChannel[key])) nextChannel[key] = nextChannel[key].filter((id: unknown) => id !== value);
          }
          persistGroupConfig(dir, before, after);
        } catch {
          console.error('re-run the same command');
          throw new Error('partial_access_written');
        }
      }
      printJson({ changed: true, channel, chat_id: value });
      return;
    }
    if (!group) throw new Error('chat_not_enrolled');
    const previous = group.allowFrom ?? [];
    if (verb === 'show') {
      printJson({
        ...summary(), chat_id: value, requireMention: group.requireMention ?? true,
        allowFrom: previous.length ? previous : 'anyone', passive, shared,
      });
      return;
    }
    const [option, ids] = args;
    let allowFrom: string[];
    if (option === '--open' && args.length === 1) {
      allowFrom = [];
    } else if ((option === '--add' || option === '--remove') && args.length === 2) {
      const requested = ids.split(',');
      if (requested.some(id => !GROUP_ID_RE.test(id))) throw new Error('invalid_id');
      if (option === '--add') {
        if (passive) throw new Error('passive_chat');
        if (!previous.length) throw new Error('chat_open');
        allowFrom = [...previous, ...new Set(requested.filter(id => !previous.includes(id)))];
      } else {
        allowFrom = previous.filter(id => !requested.includes(id));
        if (previous.length && !allowFrom.length) throw new Error('last_sender');
      }
    } else throw new Error('invalid_options');
    if (allowFrom.length === previous.length) {
      printJson({ changed: false });
      return;
    }
    writeAccess(dir, channel, file, access, {
      ...access, groups: { ...groups, [value]: { ...group, allowFrom } },
    });
    printJson({ changed: true, channel, chat_id: value, allowFrom: allowFrom.length ? allowFrom : 'anyone' });
    return;
  }

  if (!value) throw new Error('invalid_id');
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
  persistGroupConfig(dir, before, after);
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
  await main().catch(failJson);
}
