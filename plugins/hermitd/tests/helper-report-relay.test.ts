import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { readTasks } from '../scripts/lib/tasks';
import { MAX_HOOK_STDIN } from '../scripts/lib/hook-input';
import { openTask } from './helpers/tasks';
import { runScript } from './helpers/run';
import { withDir } from './helpers/workdir';

async function openRecord(dir: string, key: string, owner = 'worker:a1b2c3d4e5f6a7b8c') {
  const opened = await openTask(dir, path.join(dir, '.hermit'),
    ['--owner', owner, '--conversation', key, '--requester', `${key.split(':')[0]}:u1`]);
  expect(opened.exitCode).toBe(0);
  return JSON.parse(opened.stdout).id;
}

async function seed(dir: string, key = 'discord:123') {
  const reports = path.join(dir, '.hermit', 'helper-reports');
  fs.mkdirSync(reports, { recursive: true });
  await openRecord(dir, key);
  fs.writeFileSync(path.join(reports, 'abc123.md'), 'first report');
  return { reports };
}

const payload = (dir: string, text = '[[helper-report TASK abc123]]', tool = 'mcp__discord__reply', event = 'PreToolUse') => ({
  hook_event_name: event, tool_name: tool, tool_input: { chat_id: '123', text: text.replace('TASK', readTasks(path.join(dir, '.hermit'))[0]?.id ?? 'T-20260101-000000'), files: ['/tmp/deliverable'], reply_to: '456' },
});
const run = (dir: string, input: object) => runScript('helper-report-relay.ts', {
  cwd: dir, env: { AGENT_DIR: path.join(dir, '.hermit') }, stdin: JSON.stringify(input),
});

test('ordinary replies and mid-message mentions remain untouched', withDir(async dir => {
  for (const text of ['hello', 'the tag is [[helper-report TASK abc123]]']) {
    expect(await run(dir, payload(dir, text))).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  }
}));

test('refuses a malformed placeholder instead of sending it', withDir(async dir => {
  await seed(dir);
  for (const text of ['[[helper-report abc123]]', '[[helper-report TASK ABC123]]', '[[helper-report TASK abc123]] extra', '[[helper-report TASK abc123]', '[[helper-report TASK abc12]]', `[[helper-report TASK ${'a'.repeat(65)}]]`]) {
    expect(await run(dir, payload(dir, text))).toEqual({
      exitCode: 2, stdout: '', stderr: 'malformed helper-report placeholder: send exactly [[helper-report <task-id> <id>]], <id> 6 to 64 characters of [a-z0-9]\n',
    });
  }
}));

test('substitutes a whitespace-padded placeholder', withDir(async dir => {
  await seed(dir);
  for (const text of [' [[helper-report TASK abc123]]', '[[helper-report TASK abc123]]\n']) {
    expect(JSON.parse((await run(dir, payload(dir, text))).stdout).hookSpecificOutput.updatedInput.text).toBe('first report');
  }
}));

test('substitutes an id longer than 16 characters', withDir(async dir => {
  const { reports } = await seed(dir);
  fs.writeFileSync(path.join(reports, 'capicomposer404v2.md'), 'long id report');
  const result = await run(dir, payload(dir, '[[helper-report TASK capicomposer404v2]]'));
  expect(JSON.parse(result.stdout).hookSpecificOutput.updatedInput.text).toBe('long id report');
}));

test('substitutes only the named report byte-exactly and preserves other input', withDir(async dir => {
  const { reports } = await seed(dir);
  const body = '```ts\nconst café = "世界";  \n```\n'.repeat(100) + 'end  \n';
  fs.writeFileSync(path.join(reports, 'second12.md'), body);
  for (const [id, expected] of [['abc123', 'first report'], ['second12', body]]) {
    const input = payload(dir, `[[helper-report TASK ${id}]]`);
    const result = await run(dir, input);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', updatedInput: { ...input.tool_input, text: expected },
    } });
    expect(Buffer.from(JSON.parse(result.stdout).hookSpecificOutput.updatedInput.text)).toEqual(Buffer.from(expected));
  }
}));

test('a resident-owned record substitutes too', withDir(async dir => {
  fs.mkdirSync(path.join(dir, '.hermit', 'helper-reports'), { recursive: true });
  await openRecord(dir, 'discord:123', 'resident');
  fs.writeFileSync(path.join(dir, '.hermit', 'helper-reports', 'abc123.md'), 'resident report');
  expect(JSON.parse((await run(dir, payload(dir))).stdout).hookSpecificOutput.updatedInput.text).toBe('resident report');
}));

test('a helper-owned record substitutes too', withDir(async dir => {
  fs.mkdirSync(path.join(dir, '.hermit', 'helper-reports'), { recursive: true });
  await openRecord(dir, 'discord:123', 'helper:review');
  fs.writeFileSync(path.join(dir, '.hermit', 'helper-reports', 'abc123.md'), 'helper report');
  const result = await run(dir, payload(dir));
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).hookSpecificOutput.updatedInput.text).toBe('helper report');
}));

test('same chat on distinct sources resolves the matching tool, including plugin prefix', withDir(async dir => {
  await seed(dir);
  await openRecord(dir, 'telegram:123', 'worker:b1b2c3d4e5f6a7b8c');
  for (const tool of ['mcp__telegram__reply', 'mcp__plugin_channel_telegram__reply']) {
    const taskId = readTasks(path.join(dir, '.hermit')).find(task => task.conversation === 'telegram:123')!.id;
    const result = await run(dir, payload(dir, `[[helper-report ${taskId} abc123]]`, tool));
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.updatedInput.text).toBe('first report');
  }
}));

for (const failure of ['missing chat', 'no record', 'wrong source', 'unknown id', 'empty', 'too long', 'escape', 'record error']) {
  test(`refuses ${failure}`, withDir(async dir => {
    const { reports } = await seed(dir);
    const input: any = payload(dir);
    const file = path.join(reports, 'abc123.md');
    if (failure === 'missing chat') delete input.tool_input.chat_id;
    if (failure === 'no record') input.tool_input.chat_id = 'unknown';
    if (failure === 'wrong source') input.tool_name = 'mcp__other__reply';
    if (failure === 'unknown id') input.tool_input.text = payload(dir, '[[helper-report TASK absent12]]').tool_input.text;
    if (failure === 'empty') fs.writeFileSync(file, '');
    if (failure === 'too long') fs.writeFileSync(file, 'x'.repeat(8193));
    if (failure === 'escape') {
      fs.writeFileSync(path.join(dir, 'outside.md'), 'outside');
      fs.unlinkSync(file);
      fs.symlinkSync(path.join(dir, 'outside.md'), file);
    }
    if (failure === 'record error') fs.writeFileSync(path.join(dir, '.hermit/tasks/broken.md'), '---\nid: bad\n---\n');
    const result = await run(dir, input);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr.trim().length).toBeGreaterThan(0);
    expect(result.stderr).not.toContain('malformed');
  }));
}

test('oversize stdin fails open', withDir(async dir => {
  await seed(dir);
  const input: any = payload(dir);
  input.padding = 'x'.repeat(MAX_HOOK_STDIN);
  expect(await run(dir, input)).toEqual({ exitCode: 0, stdout: '', stderr: '' });
}));

test('PostToolUse alarms only on an unsubstituted placeholder', withDir(async dir => {
  const result = await run(dir, payload(dir, undefined, undefined, 'PostToolUse'));
  expect(result).toEqual({ exitCode: 2, stdout: '', stderr: 'helper report was not substituted; delivery failed\n' });
  expect((await run(dir, payload(dir, '[[helper-report TASK abc123]', undefined, 'PostToolUse'))).exitCode).toBe(2);
  expect(await run(dir, payload(dir, 'actual report', undefined, 'PostToolUse'))).toEqual({ exitCode: 0, stdout: '', stderr: '' });
}));


test('two DM records deliver the named task with a current handle label', withDir(async dir => {
  await seed(dir);
  const second = await openRecord(dir, 'discord:123', 'resident');
  fs.writeFileSync(path.join(dir, '.hermit', 'state', 'channel-chats.json'), JSON.stringify({ discord: { chats: { '123': { type: 1 } } } }));
  const record = readTasks(path.join(dir, '.hermit')).find(task => task.id === second)!;
  const result = await run(dir, payload(dir, `[[helper-report ${second} abc123]]`));
  expect(result.exitCode).toBe(0);
  const text = JSON.parse(result.stdout).hookSpecificOutput.updatedInput.text;
  expect(text).toBe(`${record.handle} · ${record.title}: first report`);
  expect(text).not.toMatch(/T-\d{8}-\d{6}/);
  const wrong = payload(dir, `[[helper-report ${second} abc123]]`);
  wrong.tool_input.chat_id = 'elsewhere';
  expect((await run(dir, wrong)).exitCode).toBe(2);
}));

test('mapped thread destination must match the configured reply input attribute', withDir(async dir => {
  const reports = path.join(dir, '.hermit', 'helper-reports');
  fs.mkdirSync(reports);
  fs.writeFileSync(path.join(reports, 'abc123.md'), 'topic report');
  fs.writeFileSync(path.join(dir, '.hermit', 'config.json'), JSON.stringify({ channels: { custom: { attributes: { thread_id: 'thread_ts' } } } }));
  const id = await openRecord(dir, 'custom:123~topic');
  for (const thread of ['topic', 'wrong', undefined]) {
    const input = payload(dir, `[[helper-report ${id} abc123]]`, 'mcp__custom__reply');
    Object.assign(input.tool_input, { thread_ts: thread });
    const result = await run(dir, input);
    expect(result.exitCode).toBe(thread === 'topic' ? 0 : 2);
    if (thread === 'topic') expect(JSON.parse(result.stdout).hookSpecificOutput.updatedInput.text).toBe('topic report');
  }
}));
