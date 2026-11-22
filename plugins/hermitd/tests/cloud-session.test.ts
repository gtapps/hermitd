import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { start } from '../scripts/cloud-session';
import { readCloudBindings } from '../scripts/lib/cloud-bindings';
import { mutateTask, readTasks, encodeTask } from '../scripts/lib/tasks';
import { runPinnedScript } from './helpers/run';
import { withDir, writeConfig } from './helpers/workdir';

const helper = 'LaptopHelper';
const environment = 'laptop';

function fixture(root: string, remote = true) {
  const dir = path.join(root, '.hermit');
  const promptFile = path.join(root, 'prompt.txt');
  fs.writeFileSync(promptFile, 'Work on this task.');
  writeConfig(root, { remote, remote_environments: { laptop: 'env_Test1' } });
  const task = (mutateTask(dir, 'open', undefined, {
    title: 'Example task title', done: 'Done', requester: 'operator', owner: 'helper:' + helper, 'note-stdin': true,
  }, 'Task record details.') as { id: string }).id;
  fs.writeFileSync(path.join(dir, 'state', 'runtime.json'), JSON.stringify({ peer_name: 'resident-at-home' }));
  const bin = path.join(root, 'fakebin');
  fs.mkdirSync(bin);
  const log = path.join(root, 'launch-argv');
  const killed = path.join(root, 'killed');
  fs.writeFileSync(path.join(bin, 'tmux'), `#!/bin/sh
case "$1" in
  new-session)
    printf '%s\\n' "$@" > "$FAKE_LOG"
    cat "\${12}" > "$FAKE_LOG.prompt"
    cat "\${14}" > "$FAKE_LOG.settings"
    ;;
  has-session) exit 0 ;;
  capture-pane) printf '%s\\n' "$FAKE_PANE" ;;
  kill-session) printf '%s\\n' "$@" > "$FAKE_KILLED" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const env = {
    PATH: bin + path.delimiter + process.env.PATH,
    FAKE_LOG: log, FAKE_KILLED: killed,
    FAKE_PANE: `Created cloud session: ${helper}\nView: https://claude.ai/code/session_Test123`,
  };
  const run = (verb: string, args: string[], overrides: Record<string, string> = {}, stdin?: string) =>
    runPinnedScript('cloud-session.ts', dir, [verb, dir, ...args], { env: { ...env, ...overrides }, cwd: root, stdin });
  const startArgs = ['--environment', environment, '--task', task, '--helper', helper, '--prompt-file', promptFile];
  return { root, dir, task, promptFile, log, killed, env, startArgs, run };
}

test('start refuses disabled remote control and unknown environments before tmux', withDir(async root => {
  const f = fixture(root, false);
  expect(JSON.parse((await f.run('start', f.startArgs)).stdout)).toEqual({ status: 'refused', reason: 'remote_off' });
  writeConfig(root, { remote: true });
  expect(JSON.parse((await f.run('start', f.startArgs)).stdout)).toEqual({ status: 'refused', reason: 'unknown_environment' });
  expect(fs.existsSync(f.log)).toBe(false);
}));

test('start uses argv settings and registers the helper; lookup skips a closed task but keeps its binding', withDir(async root => {
  const f = fixture(root);
  const launched = await f.run('start', [...f.startArgs, '--model', 'opus', '--effort', 'high']);
  expect(launched.stdout).not.toContain('https://');
  expect(JSON.parse(launched.stdout)).toEqual({ status: 'started', session_id: 'session_Test123' });
  const argv = fs.readFileSync(f.log, 'utf8').trimEnd().split('\n');
  const settings = argv[argv.indexOf('--settings') + 1];
  expect(settings).toStartWith(path.join(f.dir, 'state') + path.sep);
  expect(fs.existsSync(settings)).toBe(false);
  expect(fs.existsSync(f.killed)).toBe(true);
  expect(JSON.parse(fs.readFileSync(f.log + '.settings', 'utf8'))).toEqual({ remote: { defaultEnvironmentId: 'env_Test1' } });
  const promptPath = argv[11];
  expect(promptPath).toBe(settings.replace(/\.json$/, '.prompt'));
  expect(fs.existsSync(promptPath)).toBe(false);
  expect(argv.slice(4, 8)).toEqual(['-c', root, '--', 'sh']);
  expect(argv.slice(12)).toEqual(['--settings', settings, '-n', helper, '--model', 'opus', '--effort', 'high', '--cloud']);
  const prompt = fs.readFileSync(f.log + '.prompt', 'utf8');
  expect(prompt).toStartWith('# Helper session\n');
  expect(prompt).toContain('TASK_REPORT <task-id> <result|needs-input|note>');
  expect(prompt).toContain('SendMessage to resident-at-home');
  expect(prompt).toContain('Example task title');
  expect(prompt).toContain('Task record details.');
  expect(prompt).toEndWith('Work on this task.');
  expect(prompt).not.toContain('task report');
  expect(prompt).not.toContain('{{PROJECT_ROOT}}');
  expect(prompt).not.toContain(root);
  expect(argv).not.toContain('--permission-mode');
  const expected = { task: f.task, helper, environment, session_id: 'session_Test123' };
  expect(readCloudBindings(f.dir)).toEqual([{ ...expected, started_at: expect.any(String), ingested: [] }]);
  for (const args of [['--task', f.task], ['--from', 'bridge:session_Test123']]) {
    expect(JSON.parse((await f.run('lookup', args)).stdout)).toEqual(expected);
  }
  expect(JSON.parse((await f.run('lookup', ['--from', 'uds:session_Test123'])).stdout)).toEqual({ status: 'no_match' });
  const task = readTasks(f.dir)[0];
  fs.writeFileSync(path.join(f.dir, 'tasks', f.task + '.md'), encodeTask({
    ...task, status: 'closed', closed_by: 'cancelled', closed_at: new Date().toISOString(),
  }));
  expect(JSON.parse((await f.run('lookup', ['--task', f.task])).stdout)).toEqual({ status: 'no_match' });
  expect(readCloudBindings(f.dir)).toHaveLength(1);
}));

test('start caps bindings by evicting closed tasks and keeps an open task binding', withDir(async root => {
  const f = fixture(root);
  const row = (session_id: string, task: string) =>
    ({ session_id, task, helper, environment, started_at: new Date().toISOString(), ingested: [] });
  const closed = Array.from({ length: 200 }, (_, i) => row('session_Closed' + i, 'T-20000101-000000'));
  fs.writeFileSync(path.join(f.dir, 'state', 'cloud-sessions.json'), JSON.stringify([row('session_Old', f.task), ...closed]));
  expect(JSON.parse((await f.run('start', f.startArgs)).stdout).status).toBe('started');
  const ids = readCloudBindings(f.dir).map(entry => entry.session_id);
  expect(ids).toHaveLength(200);
  expect(ids[0]).toBe('session_Old');
  expect(ids).not.toContain('session_Closed0');
  expect(ids).not.toContain('session_Closed1');
  expect(ids.at(-1)).toBe('session_Test123');
}));

test('start cleans up after a login refusal', withDir(async root => {
  const f = fixture(root);
  expect(JSON.parse((await f.run('start', f.startArgs, { FAKE_PANE: 'please run /login' })).stdout))
    .toEqual({ error: 'not_logged_in' });
  expect(fs.existsSync(f.killed)).toBe(true);
  expect(fs.readdirSync(path.join(f.dir, 'state')).some(name => name.startsWith('hermit-cloud-'))).toBe(false);
}));

test('start times out and cleans up when the pane never reports a session', withDir(async root => {
  const f = fixture(root);
  const saved = { ...process.env };
  Object.assign(process.env, { ...f.env, FAKE_PANE: 'Waiting' });
  try {
    const result = await start(f.dir, { task: f.task, helper, environment, promptFile: f.promptFile }, 100);
    expect(result).toEqual({ error: 'launch_timeout' });
    expect(fs.existsSync(f.killed)).toBe(true);
    expect(readCloudBindings(f.dir)).toEqual([]);
  } finally {
    for (const key of Object.keys(f.env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}));

test('ingest binds the sender and task, posts only a receipt, and ignores the same prompt twice', withDir(async root => {
  const f = fixture(root);
  expect(JSON.parse((await f.run('start', f.startArgs)).stdout).status).toBe('started');
  const socket = path.join(root, 'in');
  const messages: string[] = [];
  const server = net.createServer(connection => {
    let frame = '';
    connection.setEncoding('utf8');
    connection.on('data', chunk => { frame += chunk; });
    connection.on('end', () => { messages.push(JSON.parse(frame).message.content); });
  });
  await once(server.listen(socket), 'listening');
  fs.writeFileSync(path.join(f.dir, 'state', 'runtime.json'), JSON.stringify({ inbox_socket: socket }));

  const body = 'Private report text.';
  const ingest = async (task: string, promptId: string) => {
    const result = await f.run('ingest', ['--from', 'bridge:session_Test123', '--prompt-id', promptId], {},
      `TASK_REPORT ${task} result\n${body}`);
    expect(result.stdout).not.toContain(body);
    return JSON.parse(result.stdout);
  };
  try {
    expect(await ingest('T-20000101-000000', 'wrong')).toEqual({ status: 'failed', reason: 'wrong_task' });
    mutateTask(f.dir, 'note', f.task, { owner: 'resident' }, '');
    expect(await ingest(f.task, 'unowned')).toEqual({ status: 'failed', reason: 'not_owner' });
    mutateTask(f.dir, 'note', f.task, { owner: 'helper:' + helper }, '');
    const before = readTasks(f.dir)[0].result_rev;
    expect(await ingest(f.task, 'first')).toEqual({ status: 'stored' });
    expect(await ingest(f.task, 'first')).toEqual({ status: 'duplicate' });
    const record = readTasks(f.dir)[0];
    expect(record.result_rev).toBe(before + 1);
    expect(fs.readFileSync(path.join(f.dir, 'helper-reports', record.report_id + '.md'), 'utf8')).toBe(body);
    // A report after the task closed still matches its binding and is refused, never passed through.
    fs.writeFileSync(path.join(f.dir, 'tasks', f.task + '.md'), encodeTask({
      ...readTasks(f.dir)[0], status: 'closed', closed_by: 'cancelled', closed_at: new Date().toISOString(),
    }));
    expect(await ingest(f.task, 'late')).toEqual({ status: 'failed', reason: 'closed' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  expect(messages).toEqual([
    `CLOUD_REPORT_FAILED ${f.task} wrong_task`,
    `CLOUD_REPORT_FAILED ${f.task} not_owner`,
    `CLOUD_REPORT_STORED ${f.task}`,
    `CLOUD_REPORT_FAILED ${f.task} closed`,
  ]);
}));
