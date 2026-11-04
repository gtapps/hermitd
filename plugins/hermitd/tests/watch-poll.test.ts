import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCRIPTS_DIR } from './helpers/run';

async function until<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = read();
    if (result !== undefined) return result;
    await Bun.sleep(10);
  }
  throw new Error('readiness condition timed out');
}

async function fixture(run: (project: string) => Promise<void>): Promise<void> {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-poll-'));
  fs.mkdirSync(path.join(project, '.hermit/state'), { recursive: true });
  try { await run(project); } finally { fs.rmSync(project, { recursive: true }); }
}

function start(project: string, check: string, extra: Record<string, string> = {}) {
  const proc = Bun.spawn(['bun', path.join(SCRIPTS_DIR, 'watch-poll.ts'), 'sample', '--', check], {
    cwd: project,
    env: { ...process.env, WATCH_POLL_TEST: '1', WATCH_POLL_EVERY_MS: '25', WATCH_POLL_TIMEOUT_MS: '1000', ...extra },
    stdout: 'pipe', stderr: 'pipe',
  });
  const lines: string[] = [];
  const output = (async () => {
    let pending = '';
    for await (const chunk of proc.stdout) {
      pending += new TextDecoder().decode(chunk);
      const complete = pending.split('\n');
      pending = complete.pop()!;
      lines.push(...complete);
    }
  })();
  const errors = new Response(proc.stderr).text();
  const stop = async () => {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
    expect(await proc.exited).toBe(0);
    await output;
    expect(await errors).toBe('');
  };
  return { proc, lines, stop };
}

function state(project: string): any {
  try { return JSON.parse(fs.readFileSync(path.join(project, '.hermit/state/watch-poll/sample.json'), 'utf8')); }
  catch { return undefined; }
}

test('initial, change, restart and edited checks', () => fixture(async project => {
  fs.writeFileSync(path.join(project, 'value'), 'one');
  const check = 'printf . >> ticks; cat value';
  let watch = start(project, check);
  try {
    await until(() => watch.lines.length === 1 && state(project)?.state === 'one' ? true : undefined);
    await until(() => fs.readFileSync(path.join(project, 'ticks'), 'utf8').length >= 3 ? true : undefined);
    expect(watch.lines).toEqual(['initial: one']);
    fs.writeFileSync(path.join(project, 'value'), 'two');
    await until(() => watch.lines.length === 2 ? true : undefined);
    expect(watch.lines).toEqual(['initial: one', 'changed: two']);
  } finally { await watch.stop(); }
  watch = start(project, check);
  try {
    const ticks = fs.readFileSync(path.join(project, 'ticks'), 'utf8').length;
    await until(() => fs.readFileSync(path.join(project, 'ticks'), 'utf8').length >= ticks + 2 ? true : undefined);
    expect(watch.lines).toEqual([]);
    fs.writeFileSync(path.join(project, 'value'), 'three');
    await until(() => watch.lines.length === 1 ? true : undefined);
    expect(watch.lines).toEqual(['changed: three']);
  } finally { await watch.stop(); }
  watch = start(project, 'cat value; printf "!"');
  try {
    await until(() => watch.lines.length ? true : undefined);
    expect(watch.lines).toEqual(['initial: three!']);
  } finally { await watch.stop(); }
}));

test('pipefail failures keep baseline and recover once', () => fixture(async project => {
  fs.writeFileSync(path.join(project, 'mode'), 'ok');
  const check = 'if [ "$(cat mode)" = ok ]; then echo ready; else false | cat; fi';
  const watch = start(project, check);
  try {
    await until(() => watch.lines.length === 1 ? true : undefined);
    fs.writeFileSync(path.join(project, 'mode'), 'fail');
    await until(() => watch.lines.length === 2 ? true : undefined);
    expect(watch.lines).toEqual(['initial: ready', 'failing: 1']);
    expect(state(project).state).toBe('ready');
    await until(() => state(project)?.failures >= 4 ? true : undefined);
    expect(watch.lines).toHaveLength(2);
    fs.writeFileSync(path.join(project, 'mode'), 'ok');
    await until(() => watch.lines.length === 3 ? true : undefined);
    expect(watch.lines[2]).toBe('recovered: ready');
  } finally { await watch.stop(); }
}));

test('timeout kills the check and over-cap output counts as failure', () => fixture(async project => {
  const timeoutWatch = start(project, '[ -e pid ] || echo $$ > pid; exec tail -f /dev/null', { WATCH_POLL_TIMEOUT_MS: '200' });
  try {
    await until(() => timeoutWatch.lines.includes('failing: timeout') ? true : undefined);
    const pid = Number(fs.readFileSync(path.join(project, 'pid'), 'utf8'));
    await until(() => {
      try { process.kill(pid, 0); return undefined; } catch { return true; }
    });
  } finally { await timeoutWatch.stop(); }
  const large = start(project, 'head -c 65537 /dev/zero');
  try {
    await until(() => large.lines.includes('failing: output_too_large') ? true : undefined);
  } finally { await large.stop(); }
}));

test('empty state, multiline output, and WATCH_LAST_STATE', () => fixture(async project => {
  const watch = start(project, 'printf "%s" "$WATCH_LAST_STATE" > last; cat value');
  fs.writeFileSync(path.join(project, 'value'), '');
  try {
    await until(() => watch.lines.length === 1 ? true : undefined);
    expect(watch.lines).toEqual(['initial: ']);
    fs.writeFileSync(path.join(project, 'value'), 'one\ntwo');
    await until(() => watch.lines.length === 2 ? true : undefined);
    expect(watch.lines[1]).toBe('changed: one\\ntwo');
    await until(() => fs.readFileSync(path.join(project, 'last'), 'utf8') === 'one\ntwo' ? true : undefined);
    expect(state(project).state).toBe('one\ntwo');
  } finally { await watch.stop(); }
}));

test('state write failure reports once and keeps polling with in-memory state', () => fixture(async project => {
  const target = path.join(project, '.hermit/state/watch-poll');
  const watch = start(project, 'if [ ! -e marker ]; then touch .hermit/state/watch-poll marker; fi; printf value');
  try {
    await until(() => watch.lines.includes('failing: state_write') ? true : undefined);
    fs.unlinkSync(target);
    await until(() => state(project)?.state === 'value' ? true : undefined);
    expect(watch.lines).toEqual(['initial: value', 'failing: state_write']);
  } finally { await watch.stop(); }
}));

test('invalid arguments fail with JSON', async () => {
  for (const args of [
    ['../bad', '--', 'true'], ['ok', '--every', '59s', '--', 'true'],
    ['ok', '--timeout', '301', '--', 'true'], ['ok', '--', ''],
  ]) {
    const proc = Bun.spawn(['bun', path.join(SCRIPTS_DIR, 'watch-poll.ts'), ...args], { stdout: 'pipe', stderr: 'pipe' });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(1);
    expect(JSON.parse(stdout).error).toBeString();
  }
});
