#!/usr/bin/env bun
/**
 * The one `hermitd update` sequence: move the plugin pins, queue the reload and
 * hermit-evolve, wait for evolve, restart once, run doctor, write the history row.
 * An UpdateTarget adapter says where the agent's commands run and how it bounces.
 *
 * Usage (from the shell entry points, never a hermitd-run verb):
 *   bun update-sequence.ts host <project-dir> [--dry-run] [--yes]
 *
 * Operator terminal output keeps its `[hermit] ...` line grammar. The process is
 * loaded once at start, so it finishes from the plugin copy it started in even
 * after the pin move installs a new version.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readSettledConfig } from './config-read';
import { cmpSemver } from './semver';
import { utcISOStamp } from './time';

export interface RunOptions {
  /** Where stdout goes; 'pipe' captures it. Default 'pipe'. */
  stdout?: 'pipe' | 'inherit' | 'ignore';
  /** Where stderr goes; 'pipe' appends it to the captured output (2>&1). Default 'ignore'. */
  stderr?: 'pipe' | 'inherit' | 'ignore';
  /** Default 'ignore' (</dev/null). */
  stdin?: 'inherit' | 'ignore';
}

export interface RunResult {
  code: number;
  out: string;
  /** Set when the command was killed by a signal. */
  signal?: string;
}

export interface PluginRow {
  id: string;
  scope: string;
  version: string;
}

export interface UpdateTarget {
  /** History `trigger` and `mode`. */
  readonly trigger: string;
  readonly mode: string;
  /** Run a command where the agent's plugins live, from the project folder. */
  run(argv: string[], opts?: RunOptions): Promise<RunResult>;
  /** Print the plan header and rows; `skipped` are rows the update leaves alone. */
  printPlan(update: PluginRow[], skipped: PluginRow[]): void;
  /** Whether a running agent can take the live reload. */
  live(): Promise<boolean>;
  /** Say that no running agent took the update, so the pins apply at the next start. */
  printNotLive(): void;
  /** True when the update runs from the resident's own session. */
  selfRun(): Promise<boolean>;
  /** Restart the agent once. Throw UpdateExit to end the update with that exit code. */
  bounce(): Promise<void>;
  /** Run doctor on the agent; its exit status is not an error. */
  doctor(args: string[]): Promise<void>;
  /** Make sure the host `hermitd` command points at this install. */
  installHostCli(): Promise<void>;
}

export interface UpdateOptions {
  projectDir: string;
  dryRun: boolean;
  assumeYes: boolean;
  /** Install SIGINT/SIGTERM handlers and exit on interrupt (the CLI does; tests do not). */
  handleSignals?: boolean;
}

/** Operator terminal lines, written synchronously so they interleave with child output in order. */
export const out = (line = '') => { fs.writeSync(1, line + '\n'); };
export const err = (line: string) => { fs.writeSync(2, line + '\n'); };

const SCOPE_RANK: Record<string, number> = { local: 0, project: 1, user: 2 };
const BUILD_SUFFIX = /-[0-9a-f]{12}$/;

/** Enabled plugins of this project, split into rows to update and user-scope rows to skip, core first. */
export function classifyPlugins(list: unknown, projectDir: string): { update: PluginRow[]; skipped: PluginRow[] } {
  const update: PluginRow[] = [];
  const skipped: PluginRow[] = [];
  const isCore = (r: PluginRow) => (r.id.startsWith('hermitd@') ? 0 : 1);
  for (const p of Array.isArray(list) ? list : []) {
    if (p?.enabled !== true || !p.id) continue;
    const row = { id: String(p.id), scope: String(p.scope ?? ''), version: String(p.version ?? '') };
    if ((p.scope === 'project' || p.scope === 'local') && p.projectPath === projectDir) update.push(row);
    else if (p.scope === 'user') skipped.push(row);
  }
  update.sort((a, b) => isCore(a) - isCore(b));
  skipped.sort((a, b) => isCore(a) - isCore(b));
  return { update, skipped };
}

/** The installed core's directory: the enabled core install closest to this project. */
export function coreInstallPath(list: unknown, projectDir: string): string {
  const core = (Array.isArray(list) ? list : [])
    .filter(p => p?.enabled === true && String(p.id).startsWith('hermitd@') && p.installPath
      && (p.scope === 'user' || p.projectPath === projectDir))
    .sort((a, b) => (SCOPE_RANK[a.scope] ?? 3) - (SCOPE_RANK[b.scope] ?? 3))[0];
  return core ? String(core.installPath) : '';
}

/** id<TAB>scope -> joined error codes, for plugins the CLI reports errors on. */
export function pluginErrors(list: unknown, projectDir: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of Array.isArray(list) ? list : []) {
    if (!p?.id) continue;
    const inProj = (p.scope === 'project' || p.scope === 'local') && p.projectPath === projectDir;
    if (!inProj && p.scope !== 'user') continue;
    if (!Array.isArray(p.errors) || p.errors.length === 0) continue;
    const errs = p.errors.map((e: any) => typeof e === 'string' ? e : (e.code || e.message || JSON.stringify(e))).join(';');
    m.set(p.id + '\t' + (p.scope ?? ''), errs);
  }
  return m;
}

/** The first core row's version, as listed. */
export function coreVersion(rows: PluginRow[]): string {
  return rows.find(r => r.id.startsWith('hermitd@'))?.version ?? '';
}

/** `name=version` for every hermit plugin whose installed version differs from the evolve stamp. */
export function versionGaps(rows: PluginRow[], stamped: Record<string, unknown>): string[] {
  const sorted = [...rows].sort((a, b) => (SCOPE_RANK[a.scope] ?? 3) - (SCOPE_RANK[b.scope] ?? 3));
  const seen = new Set<string>();
  const gaps: string[] = [];
  for (const { id, version: listed } of sorted) {
    const version = listed.replace(BUILD_SUFFIX, '');
    if (seen.has(id)) continue;
    seen.add(id);
    const name = id.split('@')[0];
    if (name.includes('hermit') && version && stamped[name] && stamped[name] !== version) gaps.push(`${name}=${version}`);
  }
  return gaps;
}

type PluginStatus = 'failed' | 'updated' | 'blocked' | 'unchanged';

/** Per-plugin outcome rows, keyed by id and scope so duplicate ids keep their own pins. */
export function pluginOutcomes(before: PluginRow[], after: PluginRow[], failed: Set<string>, errors: Map<string, string>) {
  const afterBy = new Map(after.map(r => [r.id + '\t' + r.scope, r]));
  const seen = new Set<string>();
  const rows: { id: string; scope: string; before: string; after: string; status: PluginStatus; error?: string }[] = [];
  for (const { id, scope, version } of before) {
    const key = id + '\t' + scope;
    if (seen.has(key)) continue;
    seen.add(key);
    const afterVer = afterBy.get(key)?.version ?? version;
    const error = errors.get(key);
    let status: PluginStatus;
    if (failed.has(key)) status = 'failed';
    else if (afterVer !== version) status = 'updated';
    else status = error ? 'blocked' : 'unchanged';
    rows.push({ id, scope, before: version, after: afterVer, status, ...(error ? { error } : {}) });
  }
  return rows;
}

/** Append one JSON line without following a symlink at the log path. */
export function appendHistory(logFile: string, entry: object): void {
  const { O_WRONLY, O_APPEND, O_CREAT, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  const fd = fs.openSync(logFile, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('unsafe_update_log');
    fs.appendFileSync(fd, JSON.stringify(entry) + '\n');
  } finally { fs.closeSync(fd); }
}

/** The doctor run's verdict, read from the report it wrote inside the run's time window. */
function doctorResult(stateDir: string, start: number, end: number): { status: string; issues?: { id: string; status: string }[] } {
  try {
    const report = JSON.parse(fs.readFileSync(path.join(stateDir, 'doctor-report.json'), 'utf8'));
    const ts = Date.parse(report.ts);
    if (ts >= start && ts <= end && Array.isArray(report.checks)) {
      return { status: 'ran', issues: report.checks.filter((c: any) => c.status !== 'ok').map(({ id, status }: any) => ({ id, status })) };
    }
  } catch {}
  return { status: 'error' };
}

/** Ends the update early with this exit code; the marker is still removed. */
export class UpdateExit extends Error {
  constructor(readonly code: number) { super(`exit ${code}`); }
}

export async function runUpdate(target: UpdateTarget, opts: UpdateOptions): Promise<number> {
  const { projectDir } = opts;
  const stateDir = path.join(projectDir, '.hermit', 'state');
  const markerPath = path.join(stateDir, 'update-in-progress.json');
  let markerOwned = false;
  // Before the restart an interrupt tells the operator to rerun; after it, it just exits.
  let interruptMessage = false;

  const removeMarker = () => { if (markerOwned) fs.rmSync(markerPath, { force: true }); };
  // The signal handler and a command killed by the same signal can both report it; say it once.
  let interrupted = false;
  const noteInterrupt = () => {
    if (!interrupted && interruptMessage) err('[hermit] Update interrupted before the restart; rerun `hermitd update` to finish.');
    interrupted = true;
  };
  const interrupt = (code: number): never => { noteInterrupt(); throw new UpdateExit(code); };
  const onSignal = (code: number) => () => { noteInterrupt(); removeMarker(); process.exit(code); };
  const onSigint = onSignal(130);
  const onSigterm = onSignal(143);
  if (opts.handleSignals) {
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    process.on('exit', removeMarker);
  }

  // A command killed by the operator's interrupt ends the update the same way the shell trap did.
  const run = async (argv: string[], o?: RunOptions) => {
    const r = await target.run(argv, o);
    const code = r.signal && ({ SIGINT: 130, SIGTERM: 143 } as Record<string, number>)[r.signal];
    if (code) interrupt(code);
    return r;
  };
  const listPlugins = async () => {
    const r = await run(['claude', 'plugin', 'list', '--json']);
    try { return JSON.parse(r.out); } catch { return []; }
  };

  try {
    const listBefore = await listPlugins();
    const { update: rows, skipped } = classifyPlugins(listBefore, projectDir);
    target.printPlan(rows, skipped);

    if (opts.dryRun) { out('[hermit] --dry-run: no changes made.'); return 0; }
    if (rows.length === 0) { out('[hermit] Nothing to update.'); return 0; }
    if (!opts.assumeYes) {
      const ans = (await askLine('Continue? [y/N] ')).trim();
      if (!/^(y|yes)$/i.test(ans)) { out('[hermit] Aborted.'); return 0; }
    }

    // `claude plugin update` moves the pin against the local catalog cache and does not
    // fetch, so each backing marketplace is refreshed first.
    out('[hermit] Refreshing plugin marketplaces...');
    for (const mp of new Set(rows.map(r => r.id.split('@')[1]).filter(Boolean))) {
      const r = await run(['claude', 'plugin', 'marketplace', 'update', mp], { stdout: 'ignore' });
      if (r.code !== 0) err(`[hermit] Warning: could not refresh marketplace ${mp} — updates may resolve against a stale catalog`);
    }

    // Core first, so siblings re-resolve against the new core in the same pass.
    let anyOk = false;
    const failed = new Set<string>();
    for (const { id, scope } of rows) {
      out(`[hermit] Updating ${id} (scope ${scope})...`);
      const r = await run(['claude', 'plugin', 'update', id, '--scope', scope], { stdout: 'inherit', stderr: 'inherit' });
      if (r.code === 0) anyOk = true;
      else {
        failed.add(id + '\t' + scope);
        err(`[hermit] Warning: update failed for ${id} — run manually:`);
        err(`[hermit]          claude plugin update ${id} --scope ${scope}`);
      }
    }

    // The pin moves at update time, before any reload, so this read is reliable.
    const listAfter = await listPlugins();
    const rowsAfter = classifyPlugins(listAfter, projectDir).update;
    const coreAfter = coreVersion(rowsAfter);
    if (coreAfter && coreAfter !== coreVersion(rows)) await syncPermissions(listAfter);
    const errorsAfter = pluginErrors(listAfter, projectDir);

    let reloadSent = false;
    let evolveSent = false;
    let ccBlocked = false;
    let selfRun = false;
    let awaitNoted = false;

    if (anyOk && await target.live()) {
      selfRun = await target.selfRun();
      fs.mkdirSync(stateDir, { recursive: true });
      markerOwned = true;
      if (!selfRun) stampMarker();
      interruptMessage = !selfRun;
      await applyLive();
    } else {
      target.printNotLive();
    }

    // Remove the update deferral before checking the resulting health.
    removeMarker();
    markerOwned = false;
    let doctorStart = 0;
    let doctorEnd = 0;
    if (!selfRun) {
      doctorStart = Math.floor(Date.now() / 1000) * 1000;
      // Report only when the update held evolve back for the Claude Code floor; --fix would queue it.
      await target.doctor(ccBlocked ? ['doctor'] : ['doctor', '--fix']);
      doctorEnd = (Math.floor(Date.now() / 1000) + 1) * 1000;
    }

    const plugins = pluginOutcomes(rows, rowsAfter, failed, errorsAfter);
    try {
      const doctor = selfRun ? { status: 'skipped', reason: 'self_run' } : doctorResult(stateDir, doctorStart, doctorEnd);
      if (doctor.status === 'error') err('[hermit] doctor check could not run; run `hermitd doctor`');
      fs.mkdirSync(stateDir, { recursive: true });
      appendHistory(path.join(stateDir, 'update-history.jsonl'), {
        doctor,
        ts: utcISOStamp(),
        trigger: target.trigger,
        mode: target.mode,
        plugins,
        reload_plugins_sent: reloadSent,
        evolve_sent: evolveSent,
      });
    } catch {
      err('[hermit] Warning: could not write update log');
    }

    out();
    out(ccBlocked
      ? "[hermit] Update blocked: Claude Code is below hermitd's minimum; run `claude update`, then `hermitd restart`."
      : '[hermit] Update complete.');
    out('  Plugins:');
    for (const p of plugins) {
      const tag = p.status === 'failed' ? ' (FAILED: run manually)'
        : p.status === 'updated' ? ''
        : p.error ? ` (blocked — ${p.error})` : ' (unchanged)';
      out(`    ${p.id} (scope ${p.scope}): v${p.before} -> v${p.after}${tag}`);
    }
    if (evolveSent) out('  hermit-evolve auto-started (unattended) — hermit config is upgrading.');

    await target.installHostCli();
    return 0;

    async function syncPermissions(list: unknown): Promise<void> {
      // Applied inside this operator-run command, so hermit-evolve never writes it through the classifier.
      const install = coreInstallPath(list, projectDir);
      const r = install ? await run(['bun', `${install}/scripts/update-permissions.ts`], { stderr: 'pipe' }) : null;
      if (!r || r.code !== 0) {
        err(`[hermit] Warning: permission list not applied (${r?.out || 'core install not found'}); hermit-evolve reports the command to run.`);
        return;
      }
      try {
        const summary = JSON.parse(r.out.trim().split('\n').pop() ?? '').summary;
        if (summary) out('[hermit] Permission list: ' + summary);
      } catch {}
    }

    function stampMarker(): void {
      fs.writeFileSync(markerPath, JSON.stringify({ at: new Date().toISOString() }) + '\n');
    }

    async function applyLive(): Promise<void> {
      const stamped: Record<string, unknown> = readSettledConfig(path.join(projectDir, '.hermit'))._hermit_versions ?? {};
      const expectArgs = versionGaps(rowsAfter, stamped).flatMap(pair => ['--expect', pair]);
      const coreFailed = [...failed].some(f => f.startsWith('hermitd@'));
      // The new core version the reloaded mod copy reports, so a reload that replaces the
      // mod is recognised by that copy and the evolve leg still runs once.
      const newCore = coreVersion(rowsAfter).replace(BUILD_SUFFIX, '');

      // hermit-evolve stops on a Claude Code below the new core's minimum, so a queued evolve
      // would never stamp the versions and the wait would time out.
      const floor = await coreCcFloor(listAfter);
      const ccHave = (await run(['claude', '--version'])).out.match(/[0-9]+(\.[0-9]+)+/)?.[0] ?? '';
      if (floor && ccHave && cmpSemver(ccHave, floor) < 0) {
        err(`[hermit] Claude Code ${ccHave} is below hermitd's minimum ${floor}: run \`claude update\`, then \`hermitd restart\`; hermit-evolve runs at boot.`);
        ccBlocked = true;
        return;
      }

      const request = ['/reload-plugins'];
      const batch = expectArgs.length > 0 && !coreFailed;
      if (batch) {
        out('[hermit] Hermit gap detected (core or sibling). Queuing /reload-plugins then hermit-evolve (unattended)...');
        request.push('--then', '/hermitd:hermit-evolve', 'unattended');
      } else {
        out('[hermit] Queuing /reload-plugins...');
      }
      if (newCore) request.push('--expect-version', newCore);
      request.push('--source', 'update');
      if (!selfRun) request.push('--wait', '300');
      request.push('--purpose', 'upgrade');
      // Live commands go to the core mod's queue, which runs them once the resident is idle.
      const reply = await run(['.hermit/bin/hermitd-run', 'harness-request', ...request]);
      let status = 'unknown';
      let reason = 'no_output';
      try {
        const r = JSON.parse(reply.out);
        status = r.status ?? 'unknown';
        reason = (r.reason ?? '') + (r.text ? ` (${r.text})` : '');
      } catch {}
      // A wait timeout leaves the batch queued behind the running turn, so evolve is still awaited.
      if (status === 'queued' || status === 'ok' || reason === 'wait_timeout') {
        reloadSent = true;
        evolveSent = batch;
      } else {
        err(`[hermit] Warning: /reload-plugins did not complete (${status}${reason ? `: ${reason}` : ''}).`);
        if (batch) err('[hermit]          hermit-evolve did not run; type /hermitd:hermit-evolve when you attach.');
        err('[hermit]          Pins are already updated (durable); next session start picks them up.');
      }

      // Without a version gap this still waits for an evolve turn that stamped the versions earlier.
      if (!await awaitUpgrade(evolveSent ? expectArgs : [])) return;

      if (selfRun) {
        out("[hermit] Run from the resident's own session: commands queued for after this turn.");
        if (reloadSent) {
          const restart = ['--when-quiet', ...(evolveSent ? expectArgs : [])];
          const r = await run(['.hermit/bin/hermitd-run', 'request-restart', '.hermit', ...restart]);
          if (r.out.includes('"status":"requested"')) out('[hermit] A restart follows once the agent is quiet.');
          else err('[hermit] Warning: the follow-up restart was not requested; restart the agent when it is idle.');
        }
        return;
      }
      interruptMessage = false;
      await target.bounce();
    }

    async function coreCcFloor(list: unknown): Promise<string> {
      const install = coreInstallPath(list, projectDir);
      if (!install) return '';
      const r = await run(['cat', `${install}/.claude-plugin/plugin.json`]);
      try {
        const m = JSON.parse(r.out).engines?.['claude-code'];
        return typeof m === 'string' ? m.replace(/^>=\s*/, '') : '';
      } catch { return ''; }
    }

    async function awaitUpgrade(expect: string[]): Promise<boolean> {
      // The resident's own turn never reaches a quiet boundary, so a self-run update keeps the immediate path.
      if (selfRun) return true;
      if (expect.length > 0) out('[hermit] Waiting for hermit-evolve (up to 45 min)...');
      // Restamp around each wait so the watchdog's one-hour deferral spans the whole update.
      stampMarker();
      const r = await run(['.hermit/bin/hermitd-watchdog', 'await-upgrade', ...expect]);
      stampMarker();
      let reply: { status?: unknown; reason?: unknown } = {};
      if (r.code === 0) { try { reply = JSON.parse(r.out); } catch {} }
      if (reply.status === 'ready') return true;
      if (reply.status === 'timeout' && typeof reply.reason === 'string') {
        err(`[hermit] Update wait timed out: ${reply.reason}; rerun \`hermitd update\`.`);
        return false;
      }
      if (!awaitNoted) {
        err('[hermit] Note: await-upgrade unavailable or invalid output; proceeding without its guard.');
        awaitNoted = true;
      }
      return true;
    }
  } catch (e) {
    if (e instanceof UpdateExit) { removeMarker(); return e.code; }
    throw e;
  } finally {
    if (opts.handleSignals) {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    }
  }
}

/** One line from stdin; the prompt shows only on a terminal, as `read -p` does. */
async function askLine(prompt: string): Promise<string> {
  if (process.stdin.isTTY) fs.writeSync(2, prompt);
  const buf = Buffer.alloc(1);
  let line = '';
  for (;;) {
    let n = 0;
    try { n = fs.readSync(0, buf, 0, 1, null); } catch { break; }
    if (n === 0 || buf[0] === 0x0a) break;
    line += String.fromCharCode(buf[0]);
  }
  return line;
}

if (import.meta.main) {
  const [kind, projectDir, ...flags] = process.argv.slice(2);
  if (kind !== 'host' || !projectDir) {
    err('[hermit] Usage: update-sequence.ts host <project-dir> [--dry-run] [--yes]');
    process.exit(2);
  }
  const { hostTarget } = await import('./update-target-host');
  const code = await runUpdate(hostTarget(projectDir), {
    projectDir,
    dryRun: flags.includes('--dry-run'),
    assumeYes: flags.includes('--yes'),
    handleSignals: true,
  });
  process.exit(code);
}
