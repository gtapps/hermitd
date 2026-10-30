import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { mergeGroupEntry } from '../scripts/channel-access';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-channel-access-');
afterAll(cleanup);

const entry = { requireMention: true, allowFrom: [] };
const access = {
  dmPolicy: 'allowlist', allowFrom: ['1'], pending: { ABC123: { senderId: '2', chatId: '3', expiresAt: 1 } },
  mentionPatterns: ['hello'], unknown: { keep: true },
  groups: { '123': entry, '456': entry },
};

test('mergeGroupEntry creates a group without mutating its inputs', () => {
  const original = { dmPolicy: 'pairing' };
  const result = mergeGroupEntry(original, '123', entry);
  expect(result).toEqual({ ...original, groups: { '123': entry } });
  result.groups!['123'].allowFrom.push('7');
  expect(original).toEqual({ dmPolicy: 'pairing' });
  expect(entry.allowFrom).toEqual([]);
});

test('mergeGroupEntry replaces an entry and preserves siblings and other groups', () => {
  const replacement = { requireMention: false, allowFrom: ['9'] };
  expect(mergeGroupEntry(access, '123', replacement)).toEqual({
    ...access, groups: { '123': replacement, '456': entry },
  });
  expect(access.groups['123']).toEqual(entry);
});

function fixture(channel: string) {
  const dir = freshDir();
  const channelDir = path.join(dir, 'channel');
  const home = path.join(dir, 'home');
  fs.mkdirSync(channelDir);
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    permission_mode: 'bypassPermissions',
    channels: { [channel]: { state_dir: channelDir, passive_chats: ['456'], shared_chats: ['456'] } },
  }));
  const file = path.join(channelDir, 'access.json');
  fs.writeFileSync(file, JSON.stringify(access), { mode: 0o644 });
  const run = (verb: string, args: string[] = []) => runScript('channel-access.ts', {
    args: [dir, verb, channel, ...args],
    env: { AGENT_DIR: dir, DISCORD_STATE_DIR: '', TELEGRAM_STATE_DIR: '', CLAUDE_CONFIG_DIR: home },
  });
  return { dir, file, channelDir, home, configFile, run };
}

function rows(dir: string): any[] {
  const file = path.join(dir, 'state/settings-audit.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}

const groupArgs = ['123', '--mention', 'no', '--allow', 'none', '--shared', 'no', '--passive', 'yes'];

for (const channel of ['discord', 'telegram']) {
  for (const source of ['state', 'home', 'home+state']) {
    test(`${channel} pairs from ${source}, writes approval and consumes code only once`, async () => {
      const f = fixture(channel);
      const file = source === 'state' ? f.file : path.join(f.home, 'channels', channel, 'access.json');
      if (source === 'home') fs.unlinkSync(f.file);
      if (source === 'home+state') fs.writeFileSync(f.file, JSON.stringify({ ...access, pending: {} }));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ...access, pending: { ABC123: { senderId: '7', chatId: '8', expiresAt: Date.now() + 60000 } } }));
      const result = await f.run('pair', ['ABC123']);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ channel, sender_id: '7', file: source, home: 'set' });
      expect(JSON.parse(fs.readFileSync(f.configFile, 'utf8')).channels[channel]).toEqual({
        state_dir: f.channelDir, passive_chats: ['456'], shared_chats: ['456'], default_chat_id: '8',
      });
      const configBytes = fs.readFileSync(f.configFile);
      const paired = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(paired.allowFrom).toEqual(['1', '7']);
      expect(paired.pending).toEqual({});
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(path.join(path.dirname(file), 'approved/7'), 'utf8')).toBe('8');
      if (source === 'home+state') {
        expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).allowFrom).toEqual(['1', '7']);
        expect(fs.readFileSync(path.join(f.channelDir, 'approved/7'), 'utf8')).toBe('8');
      }
      if (source === 'home') expect(fs.existsSync(f.file)).toBe(false);
      const bytes = fs.readFileSync(file);
      const audit = rows(f.dir);
      expect(audit.length).toBeGreaterThan(0);
      expect(audit.every(row => row.actor === 'channel-access')).toBe(true);
      expect(JSON.parse((await f.run('pair', ['ABC123'])).stdout)).toEqual({ error: 'code_unknown' });
      expect(fs.readFileSync(file)).toEqual(bytes);
      expect(fs.readFileSync(f.configFile)).toEqual(configBytes);
      expect(rows(f.dir)).toEqual(audit);
    });
  }

  for (const [name, existing, expected] of [
    ['an existing home chat', { default_chat_id: '5' }, '5'],
    ['the home chat empty for a maintainer DM', { maintainer_channel_id: '8' }, undefined],
  ] as const) {
    test(`${channel} pair keeps ${name}`, async () => {
      const f = fixture(channel);
      const config = JSON.parse(fs.readFileSync(f.configFile, 'utf8'));
      Object.assign(config.channels[channel], existing);
      fs.writeFileSync(f.configFile, JSON.stringify(config));
      fs.writeFileSync(f.file, JSON.stringify({ ...access, pending: { ABC123: { senderId: '7', chatId: '8', expiresAt: Date.now() + 60000 } } }));
      const configBytes = fs.readFileSync(f.configFile);
      const result = await f.run('pair', ['ABC123']);
      expect(JSON.parse(result.stdout)).toEqual({ channel, sender_id: '7', file: 'state', home: 'kept' });
      expect(JSON.parse(fs.readFileSync(f.configFile, 'utf8')).channels[channel].default_chat_id).toBe(expected);
      expect(fs.readFileSync(f.configFile)).toEqual(configBytes);
    });
  }

  test(`${channel} pair still succeeds when the home chat cannot be written`, async () => {
    const f = fixture(channel);
    fs.mkdirSync(`${f.configFile}.tmp`);
    fs.writeFileSync(f.file, JSON.stringify({ ...access, pending: { ABC123: { senderId: '7', chatId: '8', expiresAt: Date.now() + 60000 } } }));
    const configBytes = fs.readFileSync(f.configFile);
    const result = await f.run('pair', ['ABC123']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ channel, sender_id: '7', file: 'state', home: 'failed' });
    expect(result.stderr).toContain('home chat not set');
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).allowFrom).toEqual(['1', '7']);
    expect(fs.readFileSync(f.configFile)).toEqual(configBytes);
  });

  for (const expired of [false, true]) {
    test(`${channel} refuses ${expired ? 'expired' : 'unknown'} code without writing`, async () => {
      const f = fixture(channel);
      fs.writeFileSync(f.file, JSON.stringify({ ...access, pending: expired ? { ABC123: { senderId: '7', chatId: '8', expiresAt: 1 } } : {} }));
      const bytes = fs.readFileSync(f.file);
      const result = await f.run('pair', ['ABC123']);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({ error: `code_${expired ? 'expired' : 'unknown'}` });
      expect(fs.readFileSync(f.file)).toEqual(bytes);
      expect(rows(f.dir)).toEqual([]);
    });
  }

  for (const policy of ['pairing', 'allowlist', 'disabled']) {
    test(`${channel} policy ${policy} is stable on repeat`, async () => {
      const f = fixture(channel);
      expect(JSON.parse((await f.run('policy', [policy])).stdout)).toEqual({ channel, policy });
      expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).dmPolicy).toBe(policy);
      const bytes = fs.readFileSync(f.file);
      const audit = rows(f.dir);
      expect((await f.run('policy', [policy])).exitCode).toBe(0);
      expect(fs.readFileSync(f.file)).toEqual(bytes);
      expect(rows(f.dir)).toEqual(audit);
    });
  }

  for (const ack of [undefined, '', 'custom']) {
    test(`${channel} defaults preserve ${JSON.stringify(ack)} and repeat without audit`, async () => {
      const f = fixture(channel);
      fs.writeFileSync(f.file, JSON.stringify({ ...access, ackReaction: ack }));
      expect(JSON.parse((await f.run('ensure-defaults')).stdout)).toEqual({ ack: ack === undefined ? 'set' : 'kept' });
      expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).ackReaction).toBe(ack ?? '👀');
      const bytes = fs.readFileSync(f.file);
      const audit = rows(f.dir);
      expect(JSON.parse((await f.run('ensure-defaults')).stdout)).toEqual({ ack: 'kept' });
      expect(fs.readFileSync(f.file)).toEqual(bytes);
      expect(rows(f.dir)).toEqual(audit);
    });
  }

  test(`${channel} replaces group options both ways, unions patterns, keeps siblings and audits leaves`, async () => {
    const f = fixture(channel);
    const args = [...groupArgs, '--nicknames', '["hello","bot"]', '--ack-off'];
    const result = await f.run('group-add', args);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ channel, chat_id: '123', mention: false, allow: 'anyone', shared: false, passive: true, patterns: 2, ack: 'off' });
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toEqual({
      ...access, groups: { ...access.groups, '123': { requireMention: false, allowFrom: [] } },
      mentionPatterns: ['hello', 'bot'], ackReaction: '',
    });
    expect(JSON.parse(fs.readFileSync(f.configFile, 'utf8')).channels[channel]).toMatchObject({ passive_chats: ['456', '123'], shared_chats: ['456'] });
    expect(fs.statSync(f.file).mode & 0o777).toBe(0o600);
    const files = [f.file, f.configFile].map(file => fs.readFileSync(file));
    const audit = rows(f.dir);
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every(row => row.actor === 'channel-access')).toBe(true);
    expect(audit.some(row => row.path === 'groups.123.requireMention')).toBe(true);
    expect((await f.run('group-add', args)).exitCode).toBe(0);
    expect([f.file, f.configFile].map(file => fs.readFileSync(file))).toEqual(files);
    expect(rows(f.dir)).toEqual(audit);
    expect((await f.run('group-add', ['123', '--mention', 'yes', '--allow', '1,-2', '--shared', 'yes', '--passive', 'no'])).exitCode).toBe(0);
    expect(JSON.parse(fs.readFileSync(f.configFile, 'utf8')).channels[channel]).toMatchObject({ passive_chats: ['456'], shared_chats: ['456', '123'] });
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).groups['123']).toEqual({ requireMention: true, allowFrom: ['1', '-2'] });
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).ackReaction).toBe('');
  });

  const failures = [
    { token: 'invalid_policy', verb: 'policy', args: ['open'] },
    { token: 'invalid_id', verb: 'group-add', args: ['abc', ...groupArgs.slice(1)] },
    { token: 'invalid_regex', verb: 'group-add', args: [...groupArgs, '--nicknames', '["["]'] },
    { token: 'invalid_options', verb: 'group-add', args: [...groupArgs, '--nicknames', '[1]'] },
    { token: 'passive_needs_open_group', verb: 'group-add', args: groupArgs.map((v, i) => i === 2 ? 'yes' : v) },
    { token: 'passive_needs_open_group', verb: 'group-add', args: groupArgs.map((v, i) => i === 4 ? '1' : v) },
    ...['--mention', '--allow', '--shared', '--passive'].map(flag => ({ token: 'invalid_options', verb: 'group-add', args: groupArgs.filter((_, i) => i !== groupArgs.indexOf(flag) && i !== groupArgs.indexOf(flag) + 1) })),
  ];
  for (const failure of failures) {
    test(`${channel} refuses ${failure.token} ${failure.args.join(' ')} before writing`, async () => {
      const f = fixture(channel);
      const files = [f.file, f.configFile].map(file => fs.readFileSync(file));
      const result = await f.run(failure.verb, failure.args);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({ error: failure.token });
      expect([f.file, f.configFile].map(file => fs.readFileSync(file))).toEqual(files);
      expect(rows(f.dir)).toEqual([]);
    });
  }

  test(`${channel} refuses maintainer enrolment before writing`, async () => {
    const f = fixture(channel);
    const config = JSON.parse(fs.readFileSync(f.configFile, 'utf8'));
    config.channels[channel].maintainer_channel_id = '123';
    fs.writeFileSync(f.configFile, JSON.stringify(config));
    const bytes = fs.readFileSync(f.configFile);
    expect(JSON.parse((await f.run('group-add', groupArgs)).stdout)).toEqual({ error: 'maintainer_chat' });
    expect(fs.readFileSync(f.configFile)).toEqual(bytes);
    expect(rows(f.dir)).toEqual([]);
  });

  test(`${channel} reports partial config persistence and succeeds on rerun`, async () => {
    const f = fixture(channel);
    const bytes = fs.readFileSync(f.file);
    fs.chmodSync(f.channelDir, 0o500);
    try {
      const result = await f.run('group-add', groupArgs);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({ error: 'partial_config_written' });
      expect(result.stderr).toContain('re-run the same command');
      expect(fs.readFileSync(f.file)).toEqual(bytes);
      expect(JSON.parse(fs.readFileSync(f.configFile, 'utf8')).channels[channel].passive_chats).toEqual(['456', '123']);
    } finally { fs.chmodSync(f.channelDir, 0o700); }
    expect((await f.run('group-add', groupArgs)).exitCode).toBe(0);
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).groups['123'].requireMention).toBe(false);
  });
}

for (const token of ['no_access_file', 'policy_disabled', 'no_config', 'unsupported_channel', 'foreign_state_dir']) {
  test(`CLI retains ${token} refusal without writes`, async () => {
    const f = fixture('discord');
    if (token === 'no_access_file') fs.unlinkSync(f.file);
    if (token === 'no_config') fs.unlinkSync(f.configFile);
    if (token === 'policy_disabled') fs.writeFileSync(f.file, JSON.stringify({ ...access, dmPolicy: 'disabled' }));
    const before = fs.existsSync(f.file) ? fs.readFileSync(f.file) : null;
    const result = await runScript('channel-access.ts', {
      args: [token === 'foreign_state_dir' ? path.join(f.dir, 'other') : f.dir, 'group-add', token === 'unsupported_channel' ? 'slack' : 'discord', ...groupArgs],
      env: { AGENT_DIR: f.dir, DISCORD_STATE_DIR: '', TELEGRAM_STATE_DIR: '' },
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ error: token === 'foreign_state_dir' ? `${token}:${f.dir}` : token });
    expect(fs.existsSync(f.file) ? fs.readFileSync(f.file) : null).toEqual(before);
    expect(rows(f.dir)).toEqual([]);
  });
}

for (const channel of ['discord', 'telegram']) {
  test(`${channel} policy after home pairing works before the location move`, async () => {
    const f = fixture(channel);
    fs.unlinkSync(f.file);
    const file = path.join(f.home, 'channels', channel, 'access.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...access, dmPolicy: 'pairing', pending: { ABC123: { senderId: '7', chatId: '8', expiresAt: Date.now() + 60000 } } }));
    expect((await f.run('pair', ['ABC123'])).exitCode).toBe(0);
    expect((await f.run('policy', ['allowlist'])).exitCode).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).dmPolicy).toBe('allowlist');
  });
}

for (const fail of [false, true]) test(`restricted pairing config persistence failure=${fail}`, async () => {
  const f = fixture('telegram');
  const config = JSON.parse(fs.readFileSync(f.configFile, 'utf8'));
  config.channels.telegram.allowed_users = ['1'];
  fs.writeFileSync(f.configFile, JSON.stringify(config));
  fs.writeFileSync(f.file, JSON.stringify({ ...access, pending: { ABC123: { senderId: '7', chatId: '8', expiresAt: Date.now() + 60000 } } }));
  if (fail) fs.mkdirSync(`${f.configFile}.tmp`);
  const r = await f.run('pair', ['ABC123', '--restrict']);
  expect(r.exitCode).toBe(fail ? 1 : 0);
  if (fail) {
    expect(JSON.parse(r.stdout)).toEqual({ error: 'access_config_write_failed' });
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).pending.ABC123).toBeDefined();
  } else {
    expect(JSON.parse(fs.readFileSync(f.configFile, 'utf8')).channels.telegram).toMatchObject({ allowed_users: ['1', '7'], default_chat_id: '8' });
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).dmPolicy).toBe('allowlist');
  }
});
test('restricted pairing without allowed_users keeps already paired users', async () => {
  const f = fixture('telegram');
  fs.writeFileSync(f.file, JSON.stringify({ ...access, allowFrom: ['1'], pending: { ABC123: { senderId: '7', chatId: '8', expiresAt: Date.now() + 60000 } } }));
  expect((await f.run('pair', ['ABC123', '--restrict'])).exitCode).toBe(0);
  expect(JSON.parse(fs.readFileSync(f.configFile, 'utf8')).channels.telegram.allowed_users).toEqual(['1', '7']);
});
test('restrict refuses an expired pairing code without changing access', async () => {
  const f = fixture('discord');
  const bytes = fs.readFileSync(f.file);
  expect(JSON.parse((await f.run('pair', ['ABC123', '--restrict'])).stdout)).toEqual({ error: 'code_expired' });
  expect(fs.readFileSync(f.file)).toEqual(bytes);
});
