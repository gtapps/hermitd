import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setupWorkdir, hermit, write } from './helpers/workdir';
import {
  runUpdate, versionGaps, pluginOutcomes, classifyPlugins,
  UpdateExit, type UpdateTarget, type RunResult, type FloorVerdict,
} from '../scripts/lib/update-sequence';

// A recording adapter: every command and adapter step lands in `calls`, in order,
// so the update order is asserted directly instead of read back from stub binaries.
// `docker` gives it the Docker adapter's shape: marker before the pins, user scope
// included, and approve/build between the evolve wait and the restart.
interface Scenario {
  docker?: boolean;
  live?: boolean;
  selfRun?: boolean;
  stamped?: string;
  verdict?: FloorVerdict;
  harness?: object;
  await?: object | null;
  failUpdate?: string;
  held?: string;
  startFails?: boolean;
  approveFails?: boolean;
}

function recorder(proj: string, s: Scenario = {}) {
  const calls: string[] = [];
  let lists = 0;
  const marker = hermit(proj, 'state', 'update-in-progress.json');
  const hasMarker = () => fs.existsSync(marker);
  const install = path.join(proj, 'cache', 'hermitd');
  const list = (version: string) => JSON.stringify([
    { id: 'hermitd-scribe@hermitd', scope: 'project', enabled: true, version: '0.0.5', projectPath: proj },
    { id: 'hermitd@hermitd', scope: 'project', enabled: true, version, projectPath: proj, installPath: install },
    { id: 'shared@other', scope: 'user', enabled: true, version: '1.0.0' },
  ]);
  const reply = (argv: string[]): RunResult => {
    const cmd = argv.join(' ');
    if (cmd === 'claude plugin list --json') return { code: 0, out: list(lists++ === 0 ? '1.2.0' : '1.3.0') };
    if (argv[0] === 'cat') return { code: 0, out: JSON.stringify({ engines: { 'claude-code': '>=2.1.300' } }) };
    if (argv[1] === 'harness-request') return { code: 0, out: JSON.stringify(s.harness ?? { status: 'ok' }) };
    if (argv[1] === 'await-upgrade') return s.await === null ? { code: 1, out: '' } : { code: 0, out: JSON.stringify(s.await ?? { status: 'ready' }) };
    if (argv[1] === 'request-restart') return { code: 0, out: '{"status":"requested","when":"quiet"}' };
    if (argv[0] === 'bun') return { code: 0, out: '{"summary":"2 added"}\n' };
    return { code: 0, out: '' };
  };
  const run: UpdateTarget['run'] = async argv => {
    calls.push(argv.join(' '));
    return reply(argv);
  };
  const target: UpdateTarget = {
    trigger: 'test',
    mode: 'test-mode',
    updatesPlugins: true,
    includeUserScope: !!s.docker,
    needsPlugins: !s.docker,
    markerAtStart: !!s.docker,
    run,
    printPlan() { calls.push('plan'); },
    async updatePlugin({ id, scope }) {
      await run(['claude', 'plugin', 'update', id, '--scope', scope, `marker=${hasMarker()}`]);
      return id === s.failUpdate ? 'failed' : id === s.held ? 'held' : 'ok';
    },
    stateDir: () => hermit(proj, 'state'),
    stampMarker() { write(marker, '{}'); },
    clearMarker() { fs.rmSync(marker, { force: true }); },
    async live(anyOk) { return s.live ?? (s.docker ? true : anyOk); },
    printNotLive() { calls.push('not-live'); },
    async selfRun() { return s.selfRun ?? false; },
    async floorVerdict(floor, held) {
      calls.push(`floor ${floor} held=${held}`);
      return s.verdict ?? (held ? 'rebuild' : 'ok');
    },
    printReloadFailed() { calls.push('reload-failed'); },
    async bounce() {
      calls.push(`bounce marker=${hasMarker()}`);
      if (s.startFails) throw new UpdateExit(3);
      return true;
    },
    async doctor(args) {
      calls.push(`doctor ${args.join(' ')} marker=${hasMarker()}`);
      write(hermit(proj, 'state', 'doctor-report.json'), JSON.stringify({ ts: new Date().toISOString(), checks: [{ id: 'runtime', status: 'ok' }] }));
    },
    historyFields: async o => ({ restarted: o.restarted, await: o.awaitStatus }),
    printSummary() { calls.push('summary'); },
    async installHostCli() { calls.push('install-cli'); },
  };
  if (s.docker) {
    target.beforeBounce = async () => {
      calls.push('before-bounce');
      if (s.approveFails) throw new UpdateExit(1);
    };
    target.updateHeld = async ({ id }) => { calls.push(`update-held ${id}`); return true; };
  }
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

describe('update sequence order (host shape)', () => {
  test('version gap: pins, permissions, reload with evolve, evolve wait, one bounce, then doctor', async () => {
    const r = await update();
    expect(r.code).toBe(0);
    const c = r.calls;
    expect(idx(c, 'claude plugin marketplace update hermitd')).toBeLessThan(idx(c, 'claude plugin update hermitd@hermitd'));
    expect(idx(c, 'claude plugin update hermitd@hermitd')).toBeLessThan(idx(c, 'claude plugin update hermitd-scribe@hermitd'));
    // The marker goes down only once a live agent takes the update.
    expect(c.find(x => x.startsWith('claude plugin update hermitd@'))).toContain('marker=false');
    expect(c.some(x => x.includes('shared@other'))).toBe(false);
    expect(idx(c, 'bun ')).toBeGreaterThan(idx(c, 'claude plugin update hermitd-scribe'));
    expect(c.find(x => x.includes('harness-request'))).toBe('.hermit/bin/hermitd-run harness-request /reload-plugins --then /hermitd:hermit-evolve unattended --expect-version 1.3.0 --source update --wait 300 --purpose upgrade');
    expect(awaits(c)).toEqual(['.hermit/bin/hermitd-watchdog await-upgrade --expect hermitd=1.3.0']);
    expect(idx(c, '.hermit/bin/hermitd-run harness')).toBeLessThan(idx(c, '.hermit/bin/hermitd-watchdog'));
    expect(c.filter(x => x.startsWith('bounce'))).toEqual(['bounce marker=true']);
    expect(idx(c, '.hermit/bin/hermitd-watchdog')).toBeLessThan(idx(c, 'bounce'));
    expect(c.filter(x => x.startsWith('doctor'))).toEqual(['doctor doctor --fix marker=false']);
    expect(idx(c, 'bounce')).toBeLessThan(idx(c, 'doctor'));
    expect(c.slice(-2)).toEqual(['summary', 'install-cli']);
    expect(r.marker).toBe(false);
    expect(r.history).toMatchObject({ trigger: 'test', mode: 'test-mode', reload_plugins_sent: true, evolve_sent: true, restarted: true, doctor: { status: 'ran', issues: [] } });
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

  test('a blocking Claude Code minimum: nothing queued or restarted, doctor without --fix', async () => {
    const r = await update({ verdict: 'block' });
    expect(r.calls).toContain('floor 2.1.300 held=false');
    expect(r.calls.some(x => x.includes('harness-request') || x.includes('await-upgrade') || x.startsWith('bounce'))).toBe(false);
    expect(r.calls.filter(x => x.startsWith('doctor'))).toEqual(['doctor doctor marker=false']);
    expect(r.history).toMatchObject({ restarted: false, await: 'blocked' });
  });

  test('a reload that does not complete sends no evolve and still waits before the bounce', async () => {
    const r = await update({ harness: { status: 'error', reason: 'busy' } });
    expect(r.calls).toContain('reload-failed');
    expect(awaits(r.calls)).toEqual(['.hermit/bin/hermitd-watchdog await-upgrade']);
    expect(r.history).toMatchObject({ reload_plugins_sent: false, evolve_sent: false });
    expect(r.calls.filter(x => x.startsWith('bounce'))).toHaveLength(1);
  });

  test('a wait timeout skips the bounce but still runs doctor and writes history', async () => {
    const r = await update({ await: { status: 'timeout', reason: 'evolve_pending' } });
    expect(r.calls.some(x => x.startsWith('bounce'))).toBe(false);
    expect(r.calls.some(x => x.startsWith('doctor'))).toBe(true);
    expect(r.history).toMatchObject({ restarted: false, await: 'timeout' });
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

describe('update sequence order (Docker shape)', () => {
  test('version gap: marker before the pins, evolve wait, approve and build, a second wait, one bounce', async () => {
    const r = await update({ docker: true });
    const c = r.calls;
    expect(c.find(x => x.startsWith('claude plugin update hermitd@'))).toContain('marker=true');
    expect(c.some(x => x.startsWith('claude plugin update shared@other'))).toBe(true);
    expect(awaits(c)).toEqual([
      '.hermit/bin/hermitd-watchdog await-upgrade --expect hermitd=1.3.0',
      '.hermit/bin/hermitd-watchdog await-upgrade',
    ]);
    expect(c.findIndex(x => x.includes('await-upgrade --expect'))).toBeLessThan(idx(c, 'before-bounce'));
    expect(idx(c, 'before-bounce')).toBeLessThan(c.findLastIndex(x => x.includes('await-upgrade')));
    expect(c.findLastIndex(x => x.includes('await-upgrade'))).toBeLessThan(idx(c, 'bounce'));
    expect(c.filter(x => x.startsWith('bounce'))).toEqual(['bounce marker=true']);
    expect(r.marker).toBe(false);
  });

  test('no version gap: no wait before approve and build, one wait before the bounce', async () => {
    const r = await update({ docker: true, stamped: '1.3.0' });
    expect(awaits(r.calls)).toEqual(['.hermit/bin/hermitd-watchdog await-upgrade']);
    expect(idx(r.calls, 'before-bounce')).toBeLessThan(idx(r.calls, '.hermit/bin/hermitd-watchdog'));
  });

  test('a held plugin rebuilds first: no reload, its pin moves on the rebuilt image before the bounce', async () => {
    const r = await update({ docker: true, held: 'hermitd@hermitd' });
    const c = r.calls;
    expect(c).toContain('floor 2.1.300 held=true');
    expect(c.some(x => x.includes('harness-request'))).toBe(false);
    expect(idx(c, 'before-bounce')).toBeLessThan(idx(c, 'update-held hermitd@hermitd'));
    expect(idx(c, 'update-held hermitd@hermitd')).toBeLessThan(idx(c, '.hermit/bin/hermitd-watchdog'));
    expect(awaits(c)).toEqual(['.hermit/bin/hermitd-watchdog await-upgrade']);
    expect(c.filter(x => x.startsWith('bounce'))).toHaveLength(1);
  });

  test('a blocked Claude Code minimum stops before approve, build and bounce', async () => {
    const r = await update({ docker: true, verdict: 'block' });
    expect(r.calls.some(x => x === 'before-bounce' || x.startsWith('bounce') || x.includes('await-upgrade'))).toBe(false);
    expect(r.calls.filter(x => x.startsWith('doctor'))).toEqual(['doctor doctor marker=false']);
  });

  test('a refused approval ends with exit 1, removes the marker and writes no history', async () => {
    const r = await update({ docker: true, approveFails: true });
    expect(r.code).toBe(1);
    expect(r.calls.some(x => x.startsWith('bounce'))).toBe(false);
    expect(r.marker).toBe(false);
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

  test('classify keeps this project and user scope, core first; user scope is skipped unless included', () => {
    const list = [
      { id: 'x@m', scope: 'project', enabled: true, projectPath: '/p' },
      { id: 'hermitd@m', scope: 'local', enabled: true, projectPath: '/p' },
      { id: 'y@m', scope: 'local', enabled: true, projectPath: '/q' },
      { id: 'u@m', scope: 'user', enabled: true },
      { id: 'off@m', scope: 'project', enabled: false, projectPath: '/p' },
    ];
    const host = classifyPlugins(list, '/p');
    expect(host.update.map(r => r.id)).toEqual(['hermitd@m', 'x@m']);
    expect(host.skipped.map(r => r.id)).toEqual(['u@m']);
    expect(classifyPlugins(list, '/p', true).update.map(r => r.id)).toEqual(['hermitd@m', 'x@m', 'u@m']);
  });
});
