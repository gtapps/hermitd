import fs from 'node:fs';
import path from 'node:path';
import { hermitDir } from './lib/cc-compat';
import { classifyChat } from './lib/channel-chats';
import { readConfigRaw } from './lib/config-read';
import { safeForLLM } from './lib/sanitize';
import { TASK_ID, threadRecords } from './lib/tasks';
import { runHook } from './lib/hook-input';

function refuse(reason: string): never {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

async function main(payload: any): Promise<void> {
  const input = payload.tool_input;
  if (typeof input?.text !== 'string') return;
  if (!input.text.trimStart().startsWith('[[helper-report')) return;
  if (payload.hook_event_name === 'PostToolUse') {
    refuse('helper report was not substituted; delivery failed');
  }
  if (payload.hook_event_name !== 'PreToolUse') return;
  const match = /^\[\[helper-report (\S+) ([a-z0-9]{6,64})\]\]$/.exec(input.text.trim());
  if (!match || !TASK_ID.test(match[1])) refuse('malformed helper-report placeholder: send exactly [[helper-report <task-id> <id>]], <id> 6 to 64 characters of [a-z0-9]');
  try {
    if (typeof input.chat_id !== 'string' || !input.chat_id) throw new Error('missing chat_id');
    const dir = hermitDir();
    const config = readConfigRaw(dir);
    const records = threadRecords(dir);
    const record = records.find(task => task.id === match[1]);
    if (!record) throw new Error('task is not open');
    const [sourceKey, destination] = record.conversation!.split(':');
    const [chatId, thread] = destination.split('~');
    const tool = payload.tool_name;
    if (chatId !== input.chat_id || typeof tool !== 'string' ||
      !(tool === `mcp__${sourceKey}__reply` || tool.endsWith(`_${sourceKey}__reply`))) throw new Error('task destination does not match reply');
    if (thread !== undefined) {
      const attribute = config?.channels?.[sourceKey]?.attributes?.thread_id;
      if (typeof attribute !== 'string' || input[attribute] !== thread) throw new Error('task thread does not match reply');
    }
    const reports = fs.realpathSync(path.join(dir, 'helper-reports'));
    const file = fs.realpathSync(path.join(reports, `${match[2]}.md`));
    if (!file.startsWith(`${reports}${path.sep}`)) throw new Error('report outside helper-reports');
    const text = fs.readFileSync(file, 'utf8');
    if (!text.length || text.length > 8192) throw new Error('report must contain 1 to 8192 characters');
    const label = records.filter(task => task.conversation === record.conversation).length >= 2
      && await classifyChat(dir, config, sourceKey, chatId, thread) === 'shared'
      ? `${record.handle} · ${safeForLLM(record.title).slice(0, 60)}: ` : '';
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, text: label + text } },
    }));
  } catch (error) {
    refuse(`helper report delivery failed: ${error instanceof Error ? error.message : 'store or file error'}`);
  }
}

runHook(main);
