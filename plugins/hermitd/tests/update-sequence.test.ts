import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setupWorkdir, hermit, write } from './helpers/workdir';
import {
  runUpdate, versionGaps, pluginOutcomes, classifyPlugins,
  UpdateExit, type UpdateTarget, type RunResult,
} from '../scripts/lib/update-sequence';

// A recording adapter: every command and adapter step lands in `calls`, in order,
// so the update order is asserted directly instead of read back from stub binaries.
interface Scenario {
  live?: boolean;
  selfRun?: boolean;
  stamped?: string;
  ccVersion?: string;
  ccFloor?: string;
  harness?: object;
  await?: object | null;
  failUpdate?: string;
  startFails?: boolean;
}

function recorder(proj: string, s: Scenario = {}) {
  const calls: string[] = [];
  let lists = 0;
  const install = path.join(proj, 'cache', 'hermitd');
  const list = (version: string) => JSON.stringify([
    { id: 'hermitd-scribe@hermitd', scope: 'project', enabled: true, version: '0.0.5', projectPath: proj },
    { id: 'hermitd@hermitd', scope: 'project', enabled: true, version, projectPath: proj, installPath: install },
    { id: 'shared@other', scope: 'user', enabled: true, version: '1.0.0' },
  ]);
  const reply = (argv: string[]): RunResult => {
    const cmd = argv.join(' ');
    if (cmd === 'claude plugin list --json') return { code: 0, out: list(lists++ === 0 ? '1.2.0' : '1.3.0') };
    if (cmd === 'claude --version') return { code: 0, out: `${s.ccVersion ?? '2.1.400'} (Claude Code)\n` };
    if (argv[0] === 'cat') return { code: 0, out: JSON.stringify({ engines: { 'claude-code': `>=${s.ccFloor ?? '2.1.300'}` } }) };
    if (argv[1] === 'harness-request') return { code: 0, out: JSON.stringify(s.harness ?? { status: 'ok' }) };
    if (argv[1] === 'await-upgrade') return s.await === null ? { code: 1, out: '' } : { code: 0, out: JSON.stringify(s.await ?? { status: 'ready' }) };
    if (argv[1] === 'request-restart') return { code: 0, out: '{"status":"requested","when":"quiet"}' };
    if (argv[2] === 'update' && argv[3] === s.failUpdate) return { code: 1, out: '' };
    if (argv[0] === 'bun') return { code: 0, out: '{"summary":"2 added"}\n' };
    return { code: 0, out: '' };
  };
  const target: UpdateTarget = {
    trigger: 'test', mode: 'test-mode',
    async run(argv) {
      calls.push(argv.join(' '));
      return reply(argv);
    },
    printPlan() { calls.push('plan'); },
    async live() { return s.live ?? true; },
    printNotLive() { calls.push('not-live'); },
    async selfRun() { return s.selfRun ?? false; },
    async bounce() {
      calls.push(`bounce marker=${fs.existsSync(hermit(proj, 'state', 'update-in-progress.json'))}`);
      if (s.startFails) throw new UpdateExit(3);
    },
    async doctor(args) {
      calls.push(`doctor ${args.join(' ')} marker=${fs.existsSync(hermit(proj, 'state', 'update-in-progress.json'))}`);
      write(hermit(proj, 'state', 'doctor-report.json'), JSON.stringify({ ts: new Date().toISOString(), checks: [{ id: 'runtime', status: 'ok' }] }));
    },
    async installHostCli() { calls.push('install-cli'); },
  };
  return { target, calls };
}

async function update(s: Scenario = {}, opts: { dryRun?: boolean } = {}) {
  const wd = setupWorkdir();
  const proj = wd.dir;
  try {
    write(hermit(proj, 'config.json'), JSON.stringify({ _hermit_versions: { hermitd: s.stamped ?? '1.2.0', 'hermitd-scribe': '0.0.5' } }));
    const { target, calls } = recorder(proj, s);
    const code = await runUpdate(target, { projectDir: proj, dryRun: opts.dryRun ?? false, assumeYes: true });
    const historyFile = hermit(proj, 'state', 'update-history.jsonl');
    const history = fs.existsSync(historyFile) ? JSON.parse(fs.readFileSync(historyFile, 'utf8').trim()) : null;
    return { code, calls, history, marker: fs.existsSync(hermit(proj, 'state', 'update-in-progress.json')) };
  } finally { wd.cleanup(); }
}

const idx = (calls: string[], prefix: string) => calls.findIndex(c => c.startsWith(prefix));
const awaits = (calls: string[]) => calls.filter(c => c.includes('await-upgrade'));

describe('update sequence order', () => {
  test('version gap: pins, permissions, reload with evolve, evolve wait, one bounce, then doctor', async () => {
    const r = await update();
    expect(r.code).toBe(0);
    const c = r.calls;
    expect(idx(c, 'claude plugin marketplace update hermitd')).toBeLessThan(idx(c, 'claude plugin update hermitd@hermitd'));
    expect(idx(c, 'claude plugin update hermitd@hermitd')).toBeLessThan(idx(c, 'claude plugin update hermitd-scribe@hermitd'));
    expect(c.some(x => x.includes('shared@other'))).toBe(false);
    expect(idx(c, 'bun ')).toBeGreaterThan(idx(c, 'claude plugin update hermitd-scribe'));
    expect(c.find(x => x.includes('harness-request'))).toBe('.hermit/bin/hermitd-run harness-request /reload-plugins --then /hermitd:hermit-evolve unattended --expect-version 1.3.0 --source update --wait 300 --purpose upgrade');
    expect(awaits(c)).toEqual(['.hermit/bin/hermitd-watchdog await-upgrade --expect hermitd=1.3.0']);
    expect(idx(c, '.hermit/bin/hermitd-run harness')).toBeLessThan(idx(c, '.hermit/bin/hermitd-watchdog'));
    expect(c.filter(x => x.startsWith('bounce'))).toEqual(['bounce marker=true']);
    expect(idx(c, '.hermit/bin/hermitd-watchdog')).toBeLessThan(idx(c, 'bounce'));
    expect(c.filter(x => x.startsWith('doctor'))).toEqual(['doctor doctor --fix marker=false']);
    expect(idx(c, 'bounce')).toBeLessThan(idx(c, 'doctor'));
    expect(c.at(-1)).toBe('install-cli');
    expect(r.marker).toBe(false);
    expect(r.history).toMatchObject({ trigger: 'test', mode: 'test-mode', reload_plugins_sent: true, evolve_sent: true, doctor: { status: 'ran', issues: [] } });
  });

  test('no version gap: reload only, and the wait still holds for a running evolve turn', async () => {
    const r = await update({ stamped: '1.3.0' });
    expect(r.calls.find(x => x.includes('harness-request'))).not.toContain('--then');
    expect(awaits(r.calls)).toEqual(['.hermit/bin/hermitd-watchdog await-upgrade']);
    expect(idx(r.calls, '.hermit/bin/hermitd-watchdog')).toBeLessThan(idx(r.calls, 'bounce'));
    expect(r.history.evolve_sent).toBe(false);
  });

  test('a failed core pin queues the reload without evolve', async () => {
    const r = await update({ failUpdate: 'hermitd@hermitd' });
    expect(r.calls.find(x => x.includes('harness-request'))).not.toContain('--then');
    expect(r.history.plugins[0]).toMatchObject({ id: 'hermitd@hermitd', status: 'failed' });
  });

  test('self-run queues without waiting, asks for a quiet restart, never bounces or runs doctor', async () => {
    const r = await update({ selfRun: true });
    expect(r.calls.find(x => x.includes('harness-request'))).not.toContain('--wait');
    expect(awaits(r.calls)).toEqual([]);
    expect(r.calls).toContain('.hermit/bin/hermitd-run request-restart .hermit --when-quiet --expect hermitd=1.3.0');
    expect(r.calls.some(x => x.startsWith('bounce') || x.startsWith('doctor'))).toBe(false);
    expect(r.history.doctor).toEqual({ status: 'skipped', reason: 'self_run' });
    expect(r.marker).toBe(false);
  });

  test('Claude Code below the core minimum: nothing queued or restarted, doctor without --fix', async () => {
    const r = await update({ ccVersion: '2.1.301', ccFloor: '2.1.308' });
    expect(r.calls.some(x => x.includes('harness-request') || x.includes('await-upgrade') || x.startsWith('bounce'))).toBe(false);
    expect(r.calls.filter(x => x.startsWith('doctor'))).toEqual(['doctor doctor marker=false']);
  });

  test('a reload that does not complete sends no evolve and still waits before the bounce', async () => {
    const r = await update({ harness: { status: 'error', reason: 'busy' } });
    expect(awaits(r.calls)).toEqual(['.hermit/bin/hermitd-watchdog await-upgrade']);
    expect(r.history).toMatchObject({ reload_plugins_sent: false, evolve_sent: false });
    expect(r.calls.filter(x => x.startsWith('bounce'))).toHaveLength(1);
  });

  test('a wait timeout skips the bounce but still runs doctor and writes history', async () => {
    const r = await update({ await: { status: 'timeout', reason: 'evolve_pending' } });
    expect(r.calls.some(x => x.startsWith('bounce'))).toBe(false);
    expect(r.calls.some(x => x.startsWith('doctor'))).toBe(true);
    expect(r.history).not.toBeNull();
    expect(r.marker).toBe(false);
  });

  test('an unreadable wait answer proceeds to the bounce', async () => {
    const r = await update({ await: null });
    expect(r.calls.filter(x => x.startsWith('bounce'))).toHaveLength(1);
  });

  test('a failed start ends the update with its code and removes the marker', async () => {
    const r = await update({ startFails: true });
    expect(r.code).toBe(3);
    expect(r.marker).toBe(false);
    expect(r.history).toBeNull();
  });

  test('no live agent: pins move, nothing is queued, doctor still runs', async () => {
    const r = await update({ live: false });
    expect(r.calls).toContain('not-live');
    expect(r.calls.some(x => x.includes('harness-request') || x.startsWith('bounce'))).toBe(false);
    expect(r.calls.some(x => x.startsWith('doctor'))).toBe(true);
  });

  test('--dry-run prints the plan and changes nothing', async () => {
    const r = await update({}, { dryRun: true });
    expect(r.calls).toEqual(['claude plugin list --json', 'plan']);
    expect(r.history).toBeNull();
  });
});

describe('update sequence helpers', () => {
  test('version gaps drop the build suffix and prefer the closest scope', () => {
    const rows = [
      { id: 'hermitd@hermitd', scope: 'project', version: '1.3.0' },
      { id: 'hermitd@hermitd', scope: 'local', version: '1.2.0-467be32f41fc' },
      { id: 'other@mp', scope: 'local', version: '9.0.0' },
    ];
    expect(versionGaps(rows, { hermitd: '1.2.0' })).toEqual([]);
    expect(versionGaps(rows, { hermitd: '1.1.0' })).toEqual(['hermitd=1.2.0']);
  });

  test('outcomes key by id and scope', () => {
    const before = [{ id: 'a@m', scope: 'local', version: '1' }, { id: 'a@m', scope: 'project', version: '1' }];
    const after = [{ id: 'a@m', scope: 'local', version: '2' }, { id: 'a@m', scope: 'project', version: '1' }];
    expect(pluginOutcomes(before, after, new Set(), new Map([['a@m\tproject', 'no-matching-tag']])).map(p => p.status)).toEqual(['updated', 'blocked']);
  });

  test('classify keeps only this project and user scope, core first', () => {
    const { update, skipped } = classifyPlugins([
      { id: 'x@m', scope: 'project', enabled: true, projectPath: '/p' },
      { id: 'hermitd@m', scope: 'local', enabled: true, projectPath: '/p' },
      { id: 'y@m', scope: 'local', enabled: true, projectPath: '/q' },
      { id: 'u@m', scope: 'user', enabled: true },
      { id: 'off@m', scope: 'project', enabled: false, projectPath: '/p' },
    ], '/p');
    expect(update.map(r => r.id)).toEqual(['hermitd@m', 'x@m']);
    expect(skipped.map(r => r.id)).toEqual(['u@m']);
  });
});
