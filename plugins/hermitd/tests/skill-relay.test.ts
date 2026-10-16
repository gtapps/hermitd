import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { run } from '../scripts/lib/prompt-stages/skill-relay';
import { readSkillRelay, SKILL_RELAY_TTL_SECS, writeSkillRelay } from '../scripts/lib/harness-command';
import type { StageContext } from '../scripts/lib/prompt-stages/types';
import { withDir } from './helpers/workdir';

function context(dir: string, prompt = '/doctor'): StageContext {
  return {
    dir,
    prompt,
    envelope: null,
    transcriptPath: null,
    config: () => null,
    runtime: () => null,
  };
}

function writeRelay(dir: string, deliveredAt = new Date().toISOString()): void {
  writeSkillRelay(dir, {
    command: '/doctor',
    arg: null,
    by: 'operator',
    reply_to: { source: 'telegram', chat_id: 'chat-123' },
    delivered_at: deliveredAt,
  });
}

describe('skill-relay prompt stage', () => {
  test('matching pane prompt claims the relay and injects its chat target', withDir((projectDir) => {
    const dir = path.join(projectDir, '.hermit');
    writeRelay(dir);

    const result = run(context(dir));

    expect(result?.context).toContain('chat-123');
    expect(result?.context).toContain('Never use AskUserQuestion');
    expect(readSkillRelay(dir)).toBeNull();
  }));

  test('a threaded relay names the mapped thread reply parameter', withDir((projectDir) => {
    const dir = path.join(projectDir, '.hermit');
    writeSkillRelay(dir, {
      command: '/doctor', arg: null, by: 'operator',
      reply_to: { source: 'slack-channel', chat_id: 'C1', thread: '1.2' },
      delivered_at: new Date().toISOString(),
    });
    const ctx = context(dir);
    ctx.config = () => ({ channels: { 'slack-channel': { attributes: { thread_id: 'thread_ts' } } } });

    expect(run(ctx)?.context).toContain('slack-channel chat C1 with reply parameter thread_ts=1.2 through');
  }));

  test('mismatched prompt leaves the relay untouched', withDir((projectDir) => {
    const dir = path.join(projectDir, '.hermit');
    writeRelay(dir);

    expect(run(context(dir, '/compact'))).toBeUndefined();
    expect(readSkillRelay(dir)).not.toBeNull();
  }));

  test('a channel envelope leaves the relay untouched', withDir((projectDir) => {
    const dir = path.join(projectDir, '.hermit');
    writeRelay(dir);
    const ctx = context(dir);
    ctx.envelope = {
      attributes: '',
      thread: null,
      source: 'telegram',
      sourceKey: 'telegram',
      chatId: 'chat-123',
      userId: 'operator',
      userName: 'operator',
      body: '/doctor',
      messageId: null,
      ts: null,
    };

    expect(run(ctx)).toBeUndefined();
    expect(readSkillRelay(dir)).not.toBeNull();
  }));

  test('an expired relay injects no context', withDir((projectDir) => {
    const dir = path.join(projectDir, '.hermit');
    const stale = new Date(Date.now() - (SKILL_RELAY_TTL_SECS + 60) * 1000).toISOString();
    writeRelay(dir, stale);

    expect(run(context(dir))).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'state', 'pending-skill-relay.json'))).toBe(false);
  }));
});
