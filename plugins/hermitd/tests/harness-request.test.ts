import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';
import { claim, finalize, QUEUE_DIR, QUEUE_PROTOCOL } from '../scripts/lib/harness-mod';

const workdirs: Workdir[] = [];
afterAll(() => workdirs.forEach(w => w.cleanup()));
function fixture(loaded = 'resident') {
  const wd = setupWorkdir();
  workdirs.push(wd);
  const dir = path.join(wd.dir, '.hermit');
  fs.writeFileSync(path.join(dir, 'state/runtime.json'), JSON.stringify({ cc_session_id: 'resident', runtime_mode: 'headless' }));
  fs.writeFileSync(path.join(dir, 'state/harness-mod-loaded.json'), JSON.stringify({ session_id: loaded, queue: QUEUE_PROTOCOL }));
  return { wd, dir };
}
const request = (wd: Workdir, args: string[]) => runScript('harness-request.ts', { cwd: wd.dir, env: { AGENT_DIR: path.join(wd.dir, '.hermit') }, args });
const queued = (dir: string) => {
  try { return fs.readdirSync(path.join(dir, 'state', QUEUE_DIR)).map(n => JSON.parse(fs.readFileSync(path.join(dir, 'state', QUEUE_DIR, n), 'utf8'))); } catch { return []; }
};

test('queues a dependent update batch and prints its id', async () => {
  const { wd, dir } = fixture();
  const result = await request(wd, ['/reload-plugins', '--then', '/hermitd:hermit-evolve', 'unattended', '--source', 'update', '--expect-version', '2.0.0']);
  expect(result.exitCode).toBe(0);
  const out = JSON.parse(result.stdout);
  expect(out).toEqual({ status: 'queued', id: expect.any(String) });
  expect(queued(dir)).toEqual([expect.objectContaining({
    id: out.id, source: 'update', expect_version: '2.0.0',
    commands: [{ command: '/reload-plugins', arg: null }, { command: '/hermitd:hermit-evolve', arg: 'unattended' }],
  })]);
});

test('a hermit whose mod has not loaded skips with exit 0', async () => {
  const { wd, dir } = fixture('old');
  const result = await request(wd, ['/reload-plugins', '--wait', '5']);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ status: 'skipped', reason: 'mod_not_loaded' });
  expect(queued(dir)).toEqual([]);
});

for (const [args, error] of [
  [['/rm'], 'invalid_command'],
  [['/advisor'], 'invalid_command'],
  [[], 'missing_command'],
  [['/reload-plugins', '--source', 'chat'], 'invalid_source'],
  [['/reload-plugins', '--wait', 'soon'], 'invalid_wait'],
] as const) {
  test(`refuses ${args.join(' ') || 'no command'}`, async () => {
    const { wd, dir } = fixture();
    const result = await request(wd, [...args]);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ error });
    expect(queued(dir)).toEqual([]);
  });
}

test('--wait is bounded when nothing runs the request', async () => {
  const { wd } = fixture();
  const started = Date.now();
  const result = await request(wd, ['/reload-plugins', '--wait', '1']);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ status: 'unknown', reason: 'wait_timeout' });
  expect(Date.now() - started).toBeLessThan(10_000);
});

for (const status of ['ok', 'failed'] as const) {
  test(`--wait prints the ${status} outcome`, async () => {
    const { wd, dir } = fixture();
    const waiting = request(wd, ['/reload-plugins', '--then', '/hermitd:hermit-evolve', '--wait', '20']);
    let entry = null;
    for (let i = 0; i < 200 && !entry; i++) {
      entry = claim(dir, 'resident', '1.0.0');
      if (!entry) await Bun.sleep(25);
    }
    expect(entry).not.toBeNull();
    finalize(dir, entry!.id, { legs: status === 'ok'
      ? [{ command: '/reload-plugins', status: 'ok', text: 'Reloaded: 1' }, { command: '/hermitd:hermit-evolve', status: 'ok', text: 'submitted' }]
      : [{ command: '/reload-plugins', status: 'failed', text: 'Failed to reload' }] });
    const result = await waiting;
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(status === 'ok' ? { status: 'ok' } : { status: 'failed', reason: 'rejected', text: 'Failed to reload' });
  });
}
