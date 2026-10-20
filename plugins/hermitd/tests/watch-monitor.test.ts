import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectTree } from '../scripts/lib/proc';
import { SCRIPTS_DIR } from './helpers/run';

async function until<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(10);
  }
  throw new Error('readiness condition timed out');
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function fixture(run: (f: {
  project: string;
  dir: string;
  lines: string[];
  configure: (command: string, enabled?: boolean) => void;
  runtime: () => any;
  stop: () => Promise<void>;
}) => Promise<void>): Promise<void> {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-watch-monitor-'));
  const dir = path.join(project, '.hermit');
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  const lines: string[] = [];
  const proc = Bun.spawn(['bun', path.join(SCRIPTS_DIR, 'watch-monitor.ts'), dir], {
    env: {
      ...process.env, WATCH_MONITOR_TEST: '1', WATCH_MONITOR_POLL_MS: '10',
      WATCH_MONITOR_BACKOFF_MS: '20', WATCH_MONITOR_MAX_BACKOFF_MS: '80',
    },
    stdout: 'pipe', stderr: 'pipe',
  });
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
    if (proc.exitCode === null) proc.kill('SIGTERM');
    expect(await proc.exited).toBe(0);
    await output;
  };
  const runtime = () => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'state/watch-monitor.runtime.json'), 'utf8')); }
    catch { return undefined; }
  };
  try {
    await until(() => runtime());
    await run({ project, dir, lines, runtime, stop, configure(command, enabled = true) {
      const file = path.join(dir, 'config.json');
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ monitors: [{ id: 'sample', description: 'Sample watch', command, enabled }] }));
      fs.renameSync(`${file}.tmp`, file);
    } });
  } finally {
    await stop();
    const stderr = await errors;
    fs.rmSync(project, { recursive: true });
    expect(stderr).toBe('');
  }
}

test('watch stdout is tagged, substitutes roots, and runs from the project root', () => fixture(async f => {
  f.configure('printf "%s\\n" "$PWD ${CLAUDE_PROJECT_DIR} ${CLAUDE_PLUGIN_ROOT}"; exec tail -f /dev/null');
  const line = await until(() => f.lines.find(l => l.startsWith('WATCH_EVENT ')));
  // $PWD is the resolved cwd (macOS tmpdir is a /private symlink); substitution keeps the path as given.
  expect(line).toBe(`WATCH_EVENT [hermit-watch:sample] (Sample watch) ${fs.realpathSync(f.project)} ${f.project} ${path.dirname(SCRIPTS_DIR)}`);
  expect(f.lines).toHaveLength(1);
}));

test('exiting watches restart and errors are throttled with the last stderr line', () => fixture(async f => {
  f.configure('printf "first\\nlast\\n\\n" >&2; exit 7');
  const row = await until(() => {
    const w = f.runtime()?.watches[0];
    return w?.restarts >= 3 && w.last_exit_code === 7 ? w : undefined;
  });
  expect(row.restarts).toBeGreaterThanOrEqual(1);
  expect(row.last_stderr_line).toBe('last');
  // stdout reaches the test through an async pipe, so it can trail the runtime file.
  await until(() => f.lines.length ? true : undefined);
  expect(f.lines).toEqual(['WATCH_MONITOR_ERROR: sample exit code 7: last']);
}));

for (const action of ['disable', 'SIGTERM', 'SIGHUP'] as const) {
  test(`${action} stops the watch pipeline without leaving children`, () => fixture(async f => {
    const command = 'tail -f /dev/null | cat';
    f.configure(command);
    const pids = await until(() => {
      const pid = f.runtime()?.watches[0]?.pid;
      if (!pid) return undefined;
      const tree = collectTree([pid]);
      return tree.pids.length >= 3 ? tree.pids : undefined;
    });
    if (action === 'disable') {
      f.configure(command, false);
      await until(() => f.runtime()?.watches.length === 0 ? true : undefined);
    } else if (action === 'SIGTERM') {
      await f.stop();
    } else {
      // The fixture's process is the direct parent of the pipeline's root shell.
      const parent = Number(Bun.spawnSync(['ps', '-o', 'ppid=', '-p', String(pids[0])]).stdout.toString().trim());
      process.kill(parent, 'SIGHUP');
      await until(() => !alive(parent) ? true : undefined);
    }
    await until(() => pids.every(pid => !alive(pid)) ? true : undefined);
    expect(f.lines).toEqual([]);
  }));
}

test('disabling a looping watch does not let the shell relaunch its pipeline', () => fixture(async f => {
  // A fixture-unique file lets pgrep find a leaked pipeline without /proc (absent on macOS).
  const marker = path.join(f.project, 'loop-marker');
  fs.writeFileSync(marker, '');
  const command = `while true; do tail -f ${marker} | cat; done`;
  f.configure(command);
  const root = await until(() => {
    const pid = f.runtime()?.watches[0]?.pid;
    return pid && collectTree([pid]).pids.length >= 3 ? pid : undefined;
  });
  const tails = () => Bun.spawnSync(['pgrep', '-f', `tail -f ${marker}`]).stdout.toString().trim().split('\n').filter(Boolean).map(Number);
  expect(tails().length).toBeGreaterThan(0);
  f.configure(command, false);
  await until(() => f.runtime()?.watches.length === 0 ? true : undefined);
  const leaked = tails();
  expect(alive(root)).toBe(false);
  expect(leaked).toEqual([]);
}));

test('malformed config entries are skipped without stopping valid watches', () => fixture(async f => {
  fs.writeFileSync(path.join(f.dir, 'config.json'), JSON.stringify({ monitors: [
    { id: 'broken', description: 'Broken', enabled: true },
    { id: 'sample', description: 'Sample watch', command: 'echo ok; exec tail -f /dev/null', enabled: true },
  ] }));
  await until(() => f.lines.includes('WATCH_EVENT [hermit-watch:sample] (Sample watch) ok') ? true : undefined);
  expect(f.runtime().watches.map((w: any) => w.id)).toEqual(['sample']);
}));

test('changing a command replaces its child and removing it stops the replacement', () => fixture(async f => {
  f.configure('echo original; exec tail -f /dev/null');
  const oldPid = await until(() => f.lines.length && f.runtime()?.watches[0]?.pid || undefined);
  f.configure('echo replacement; exec tail -f /dev/null');
  await until(() => f.lines.some(l => l.endsWith('replacement')) ? true : undefined);
  expect(alive(oldPid)).toBe(false);
  const newPid = f.runtime().watches[0].pid;
  fs.writeFileSync(path.join(f.dir, 'config.json'), '{"monitors":[]}');
  await until(() => f.runtime()?.watches.length === 0 ? true : undefined);
  expect(alive(newPid)).toBe(false);
}));
