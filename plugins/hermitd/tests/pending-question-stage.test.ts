import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { pendingQuestionLine } from '../scripts/lib/prompt-stages/pending-question';
import { runScript } from './helpers/run';
import { setupWorkdir } from './helpers/workdir';

const CHAT = 'discord:400';

function entry(id: string, chat: string | undefined, status = 'pending') {
  return { id, tier: 1, status, question: `q ${id}`, ...(chat ? { chat } : {}) };
}

function withQueue(content: string | object | null, fn: (dir: string) => void): void {
  const wd = setupWorkdir();
  try {
    const hermit = path.join(wd.dir, '.hermit');
    if (content !== null) {
      fs.writeFileSync(path.join(hermit, 'state', 'micro-proposals.json'),
        typeof content === 'string' ? content : JSON.stringify(content));
    }
    fn(hermit);
  } finally {
    wd.cleanup();
  }
}

describe('pending-question stage: line builder', () => {
  test('names a question pending in the same chat', () => {
    withQueue({ pending: [entry('MP-1', CHAT)] }, dir => {
      expect(pendingQuestionLine(dir, CHAT)).toBe(
        '[pending question in this chat: MP-1; a bare reply may answer it: run proposal-micro match first]');
    });
  });

  test('prints nothing for a missing or empty queue', () => {
    withQueue(null, dir => expect(pendingQuestionLine(dir, CHAT)).toBeNull());
    withQueue({ pending: [] }, dir => expect(pendingQuestionLine(dir, CHAT)).toBeNull());
  });

  test('uses match scoping: other chats, thread-suffixed keys, chat-less and resolved entries stay out', () => {
    withQueue({ pending: [
      entry('MP-other', 'discord:401'),
      entry('MP-thread', `${CHAT}~t1`),
      entry('MP-nochat', undefined),
      entry('MP-done', CHAT, 'approved'),
    ] }, dir => {
      expect(pendingQuestionLine(dir, CHAT)).toBeNull();
    });
  });

  test('caps the ids and counts the rest', () => {
    withQueue({ pending: ['a', 'b', 'c', 'd', 'e'].map(n => entry(`MP-${n}`, CHAT)) }, dir => {
      expect(pendingQuestionLine(dir, CHAT)).toStartWith('[pending question in this chat: MP-a, MP-b, MP-c (+2 more);');
    });
  });

  test('says unreadable for a corrupt queue instead of implying none', () => {
    withQueue('{"pending": [', dir => {
      expect(pendingQuestionLine(dir, CHAT)).toBe('[pending question in this chat: unreadable]');
    });
  });
});

describe('pending-question stage: pipeline', () => {
  test('an allowed chat sender gets the line; an operator prompt does not', async () => {
    const wd = setupWorkdir();
    try {
      const hermit = path.join(wd.dir, '.hermit');
      fs.writeFileSync(path.join(hermit, 'config.json'), JSON.stringify({ channels: { discord: { allowed_users: ['u1'] } } }));
      fs.writeFileSync(path.join(hermit, 'state', 'micro-proposals.json'), JSON.stringify({ pending: [entry('MP-1', CHAT)] }));
      const chat = await runScript('user-prompt-pipeline.ts', {
        stdin: JSON.stringify({ prompt: '<channel source="discord" chat_id="400" user="a" user_id="u1">yes</channel>' }), cwd: wd.dir,
      });
      expect(chat.stdout).toContain('[pending question in this chat: MP-1;');
      const terminal = await runScript('user-prompt-pipeline.ts', { stdin: JSON.stringify({ prompt: 'yes' }), cwd: wd.dir });
      expect(terminal.stdout).not.toContain('[pending question');
    } finally {
      wd.cleanup();
    }
  });
});
