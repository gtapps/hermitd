#!/usr/bin/env bun
/**
 * The one `hermitd update` sequence: move the plugin pins, queue the reload and
 * hermit-evolve, wait for evolve, restart once, run doctor, write the history row.
 * An UpdateTarget adapter says where the agent's commands run and how it bounces:
 * lib/update-target-host.ts for a host tmux resident, lib/update-target-docker.ts
 * for a Docker agent.
 *
 * Usage (from the shell entry points, never a hermitd-run verb):
 *   bun update-sequence.ts host <project-dir> [--dry-run] [--yes]
 *   bun update-sequence.ts docker <project-dir> [--dry-run] [--yes] [--cc-only | --plugins-only]
 *
 * Operator terminal output keeps its `[hermit] ...` line grammar. The process is
 * loaded once at start, so it finishes from the plugin copy it started in even
 * after the pin move installs a new version.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readSettledConfig } from './config-read';
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
}

export interface PluginRow {
  id: string;
  scope: string;
  version: string;
}

type PluginStatus = 'failed' | 'updated' | 'blocked' | 'unchanged';

export interface PluginOutcome {
  id: string;
  scope: string;
  before: string;
  after: string;
  status: PluginStatus;
  error?: string;
}

/** What the update did, for the adapter's history fields and summary. */
export interface UpdateOutcome {
  plugins: PluginOutcome[];
  anyOk: boolean;
  reloadSent: boolean;
  evolveSent: boolean;
  /** The Claude Code minimum moved evolve to the boot after a rebuild. */
  belowFloor: boolean;
  restarted: boolean;
  /** `blocked`: the Claude Code minimum stopped the update before any restart. */
  awaitStatus: 'ready' | 'timeout' | 'blocked';
  awaitReason: string;
}

/** What a Claude Code below an updated plugin's minimum means for this agent. */
export type FloorVerdict = 'ok' | 'block' | 'rebuild';

export interface UpdateTarget {
  /** History `trigger` and `mode`. */
  readonly trigger: string;
  readonly mode: string;
  /** False when this run leaves the plugins alone. */
  readonly updatesPlugins: boolean;
  /** Update user-scope plugins too, instead of listing them as skipped. */
  readonly includeUserScope: boolean;
  /** Stop with "Nothing to update." when no plugin is listed. */
  readonly needsPlugins: boolean;
  /** Stamp the update marker right after the confirm, before the pins move. */
  readonly markerAtStart: boolean;
  /** Run a command where the agent's plugins live, from the project folder. */
  run(argv: string[], opts?: RunOptions): Promise<RunResult>;
  /** Gather what the plan shows; `list` is the plugin list, or [] when plugins are left alone. */
  prepare?(list: unknown[]): Promise<void>;
  /** Print the plan header and rows; `skipped` are rows the update leaves alone. */
  printPlan(update: PluginRow[], skipped: PluginRow[]): void;
  /** Move one pin; 'held' means the running Claude Code is outside the plugin's range. */
  updatePlugin(row: PluginRow): Promise<'ok' | 'held' | 'failed'>;
  /** The state folder for the doctor report and the history row. */
  stateDir(): string;
  /** Write the update marker; throw UpdateExit when it cannot be written safely. */
  stampMarker(): void;
  clearMarker(): void;
  /** Whether a running agent takes the update now. */
  live(anyOk: boolean): Promise<boolean>;
  /** Say that no running agent took the update, so the pins apply at the next start. */
  printNotLive?(): void;
  /** True when the update runs from the resident's own session. */
  selfRun?(): Promise<boolean>;
  /** Decide, and say, what a Claude Code below `floor` (or a held plugin) means here. */
  floorVerdict(floor: string, held: boolean): Promise<FloorVerdict>;
  /** Tell the operator what to do when the reload did not complete. */
  printReloadFailed(batch: boolean): void;
  /** Work between the evolve wait and the restart; a second wait follows it. */
  beforeBounce?(): Promise<void>;
  /** Move a held plugin's pin once the newer Claude Code is in place. */
  updateHeld?(row: PluginRow): Promise<boolean>;
  /** Restart the agent once; true when it restarted. Throw UpdateExit to end with that code. */
  bounce(): Promise<boolean>;
  /** Run doctor on the agent; its exit status is not an error. */
  doctor(args: string[]): Promise<void>;
  /** Adapter fields for the history row. */
  historyFields(o: UpdateOutcome): Promise<Record<string, unknown>>;
  printSummary(o: UpdateOutcome): void;
  /** Make sure the host `hermitd` command points at this install. */
  installHostCli(): Promise<void>;
}

export interface UpdateOptions {
  projectDir: string;
  dryRun: boolean;
  assumeYes: boolean;
  /** Install SIGINT/SIGTERM/SIGHUP handlers and exit on interrupt (the CLI does; tests do not). */
  handleSignals?: boolean;
}

/** Operator terminal lines, written synchronously so they interleave with child output in order. */
export const out = (line = '') => { fs.writeSync(1, line + '\n'); };
export const err = (line: string) => { fs.writeSync(2, line + '\n'); };

const SCOPE_RANK: Record<string, number> = { local: 0, project: 1, user: 2 };
const BUILD_SUFFIX = /-[0-9a-f]{12}$/;

/** Ends the update early with this exit code; the marker is still removed. */
export class UpdateExit extends Error {
  constructor(readonly code: number, readonly interrupted = false) { super(`exit ${code}`); }
}

/**
 * Run a command from `cwd`. A command killed by the operator's interrupt ends the
 * update the same way the shell trap did.
 */
export async function spawnCommand(argv: string[], cwd: string, opts: RunOptions = {}): Promise<RunResult> {
  const stdout = opts.stdout ?? 'pipe';
  const stderr = opts.stderr ?? 'ignore';
  let proc;
  try {
    // A piped stderr joins the captured stdout (2>&1).
    proc = Bun.spawn({ cmd: argv, cwd, stdin: opts.stdin ?? 'ignore', stdout, stderr });
  } catch {
    return { code: 127, out: '' };
  }
  const [o, e] = await Promise.all([
    stdout === 'pipe' ? new Response(proc.stdout as ReadableStream).text() : '',
    stderr === 'pipe' ? new Response(proc.stderr as ReadableStream).text() : '',
  ]);
  const code = await proc.exited;
  if (proc.signalCode === 'SIGINT') throw new UpdateExit(130, true);
  if (proc.signalCode === 'SIGTERM') throw new UpdateExit(143, true);
  return { code, out: o + e };
}

/** Enabled plugins of this project, split into rows to update and rows to skip, core first. */
export function classifyPlugins(list: unknown, projectDir: string, includeUserScope = false): { update: PluginRow[]; skipped: PluginRow[] } {
  const update: PluginRow[] = [];
  const skipped: PluginRow[] = [];
  const isCore = (r: PluginRow) => (r.id.startsWith('hermitd@') ? 0 : 1);
  for (const p of Array.isArray(list) ? list : []) {
    if (p?.enabled !== true || !p.id) continue;
    const row = { id: String(p.id), scope: String(p.scope ?? ''), version: String(p.version ?? '') };
    if ((p.scope === 'project' || p.scope === 'local') && p.projectPath === projectDir) update.push(row);
    else if (p.scope === 'user') (includeUserScope ? update : skipped).push(row);
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

/** Per-plugin outcome rows, keyed by id and scope so duplicate ids keep their own pins. */
export function pluginOutcomes(before: PluginRow[], after: PluginRow[], failed: Set<string>, errors: Map<string, string>): PluginOutcome[] {
  const afterBy = new Map(after.map(r => [r.id + '\t' + r.scope, r]));
  const seen = new Set<string>();
  const rows: PluginOutcome[] = [];
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

/** The plugin lines of the update summary. */
export function printPluginLines(plugins: PluginOutcome[]): void {
  out('  Plugins:');
  for (const p of plugins) {
    const tag = p.status === 'failed' ? ' (FAILED: run manually)'
      : p.status === 'updated' ? ''
      : p.error ? ` (blocked — ${p.error})` : ' (unchanged)';
    out(`    ${p.id} (scope ${p.scope}): v${p.before} -> v${p.after}${tag}`);
  }
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

export async function runUpdate(target: UpdateTarget, opts: UpdateOptions): Promise<number> {
  const { projectDir } = opts;
  let markerOwned = false;
  // Before the restart an interrupt tells the operator to rerun; after it, it just exits.
  let interruptMessage = false;

  const removeMarker = () => { if (markerOwned) target.clearMarker(); };
  // The signal handler and a command killed by the same signal can both report it; say it once.
  let interrupted = false;
  const noteInterrupt = () => {
    if (!interrupted && interruptMessage) err('[hermit] Update interrupted before the restart; rerun `hermitd update` to finish.');
    interrupted = true;
  };
  const onSignal = (code: number) => () => { noteInterrupt(); removeMarker(); process.exit(code); };
  const onSigint = onSignal(130);
  const onSigterm = onSignal(143);
  // A closed terminal has nowhere to print; the marker still goes, as the shell's EXIT trap did.
  const onSighup = () => { removeMarker(); process.exit(129); };
  if (opts.handleSignals) {
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    process.on('SIGHUP', onSighup);
    process.on('exit', removeMarker);
  }

  const run = (argv: string[], o?: RunOptions) => target.run(argv, o);
  const listPlugins = async (): Promise<unknown[]> => {
    const r = await run(['claude', 'plugin', 'list', '--json']);
    try {
      const list = JSON.parse(r.out);
      return Array.isArray(list) ? list : [];
    } catch { return []; }
  };
  const stampMarker = () => { markerOwned = true; target.stampMarker(); };

  try {
    const listBefore = target.updatesPlugins ? await listPlugins() : [];
    await target.prepare?.(listBefore);
    const { update: rows, skipped } = classifyPlugins(listBefore, projectDir, target.includeUserScope);
    target.printPlan(rows, skipped);

    if (opts.dryRun) { out('[hermit] --dry-run: no changes made.'); return 0; }
    if (target.needsPlugins && rows.length === 0) { out('[hermit] Nothing to update.'); return 0; }
    if (!opts.assumeYes) {
      const ans = await askLine('Continue? [y/N] ');
      // End of input with no newline fails, as `read` under `set -e` did.
      if (ans === null) return 1;
      if (!/^(y|yes)$/i.test(ans.trim())) { out('[hermit] Aborted.'); return 0; }
    }
    if (target.markerAtStart) {
      stampMarker();
      interruptMessage = true;
    }

    let anyOk = false;
    const failed = new Set<string>();
    const held: PluginRow[] = [];
    let listAfter: unknown[] = [];
    let rowsAfter: PluginRow[] = [];
    let errorsAfter = new Map<string, string>();
    const readPinsAfter = async () => {
      // The pin moves at update time, before any reload, so this read is reliable.
      listAfter = await listPlugins();
      rowsAfter = classifyPlugins(listAfter, projectDir, target.includeUserScope).update;
      errorsAfter = pluginErrors(listAfter, projectDir);
    };

    if (rows.length > 0) {
      // `claude plugin update` moves the pin against the local catalog cache and does not
      // fetch, so each backing marketplace is refreshed first.
      out('[hermit] Refreshing plugin marketplaces...');
      for (const mp of new Set(rows.map(r => r.id.split('@')[1]).filter(Boolean))) {
        const r = await run(['claude', 'plugin', 'marketplace', 'update', mp], { stdout: 'inherit' });
        if (r.code !== 0) err(`[hermit] Warning: could not refresh marketplace ${mp} — updates may resolve against a stale catalog`);
      }
      // Core first, so siblings re-resolve against the new core in the same pass.
      for (const row of rows) {
        out(`[hermit] Updating ${row.id} (scope ${row.scope})...`);
        const result = await target.updatePlugin(row);
        if (result === 'failed') failed.add(row.id + '\t' + row.scope);
        else {
          anyOk = true;
          if (result === 'held') held.push(row);
        }
      }
      await readPinsAfter();
      if (coreVersion(rowsAfter) && coreVersion(rowsAfter) !== coreVersion(rows)) await syncPermissions();
    }

    let reloadSent = false;
    let evolveSent = false;
    let belowFloor = false;
    let restarted = false;
    let selfRun = false;
    let awaitStatus = 'ready' as UpdateOutcome['awaitStatus'];
    let awaitReason = '';
    let awaitNoted = false;

    if (await target.live(anyOk)) {
      selfRun = await target.selfRun?.() ?? false;
      if (!target.markerAtStart && !selfRun) {
        stampMarker();
        interruptMessage = true;
      }
      await applyLive();
    } else {
      target.printNotLive?.();
    }

    // Remove the update deferral before checking the resulting health.
    removeMarker();
    markerOwned = false;
    let doctorStart = 0;
    let doctorEnd = 0;
    if (!selfRun) {
      doctorStart = Math.floor(Date.now() / 1000) * 1000;
      // Report only when the update held evolve back for the Claude Code floor; --fix would queue it.
      await target.doctor(awaitStatus === 'blocked' ? ['doctor'] : ['doctor', '--fix']);
      doctorEnd = (Math.floor(Date.now() / 1000) + 1) * 1000;
    }

    const outcome: UpdateOutcome = {
      plugins: pluginOutcomes(rows, rowsAfter, failed, errorsAfter),
      anyOk, reloadSent, evolveSent, belowFloor, restarted, awaitStatus, awaitReason,
    };
    const fields = await target.historyFields(outcome);
    try {
      const stateDir = target.stateDir();
      const doctor = selfRun ? { status: 'skipped', reason: 'self_run' } : doctorResult(stateDir, doctorStart, doctorEnd);
      if (doctor.status === 'error') err('[hermit] doctor check could not run; run `hermitd doctor`');
      appendHistory(path.join(stateDir, 'update-history.jsonl'), {
        doctor,
        ts: utcISOStamp(),
        trigger: target.trigger,
        mode: target.mode,
        plugins: outcome.plugins,
        reload_plugins_sent: reloadSent,
        evolve_sent: evolveSent,
        ...fields,
      });
    } catch {
      err('[hermit] Warning: could not write update log');
    }

    target.printSummary(outcome);
    await target.installHostCli();
    return 0;

    async function syncPermissions(): Promise<void> {
      // Applied inside this operator-run command, so hermit-evolve never writes it through the classifier.
      const install = coreInstallPath(listAfter, projectDir);
      const r = install ? await run(['bun', `${install}/scripts/update-permissions.ts`], { stderr: 'pipe' }) : null;
      if (!r || r.code !== 0) {
        err(`[hermit] Warning: permission list not applied (${r?.out || 'core install not found'}); hermit-evolve reports the command to run.`);
        return;
      }
      // Captured stderr follows stdout, so the result is the last line that parses.
      for (const line of r.out.trim().split('\n').reverse()) {
        let summary: unknown;
        try { summary = JSON.parse(line).summary; } catch { continue; }
        if (summary) out('[hermit] Permission list: ' + summary);
        break;
      }
    }

    async function applyLive(): Promise<void> {
      const stamped: Record<string, unknown> = readSettledConfig(path.join(projectDir, '.hermit'))._hermit_versions ?? {};
      const expectArgs = versionGaps(rowsAfter, stamped).flatMap(pair => ['--expect', pair]);

      if (anyOk) {
        // hermit-evolve stops on a Claude Code below the new core's minimum, so a queued evolve
        // would never stamp the versions and the wait would time out.
        const verdict = await target.floorVerdict(await coreCcFloor(), held.length > 0);
        if (verdict === 'block') {
          awaitStatus = 'blocked';
          awaitReason = 'cc_below_floor';
          return;
        }
        belowFloor = verdict === 'rebuild';
        if (!belowFloor) await requestReload(expectArgs);
      }

      // Without a version gap this still waits for an evolve turn that stamped the versions earlier.
      if ((evolveSent || !target.beforeBounce) && !await awaitUpgrade(evolveSent ? expectArgs : [])) return;

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

      if (target.beforeBounce) {
        await target.beforeBounce();
        if (held.length > 0 && target.updateHeld) await updateHeld(target.updateHeld.bind(target));
        // A hermit-evolve turn still running, typed during the build or left from an earlier update, ends first.
        if (!await awaitUpgrade([])) return;
      }
      interruptMessage = false;
      restarted = await target.bounce();
    }

    async function requestReload(expectArgs: string[]): Promise<void> {
      const coreFailed = [...failed].some(f => f.startsWith('hermitd@'));
      // The new core version the reloaded mod copy reports, so a reload that replaces the
      // mod is recognised by that copy and the evolve leg still runs once.
      const newCore = coreVersion(rowsAfter).replace(BUILD_SUFFIX, '');
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
        target.printReloadFailed(batch);
      }
    }

    // The rebuilt image's Claude Code meets the held plugins' ranges, so their pins move now.
    async function updateHeld(update: (row: PluginRow) => Promise<boolean>): Promise<void> {
      const coreBefore = coreVersion(rowsAfter);
      for (const row of held) {
        out(`[hermit] Updating ${row.id} (scope ${row.scope}) on the rebuilt image...`);
        if (!await update(row)) {
          failed.add(row.id + '\t' + row.scope);
          err(`[hermit] Warning: update failed for ${row.id}; rerun \`hermitd update\` after the restart.`);
        }
      }
      await readPinsAfter();
      if (coreVersion(rowsAfter) && coreVersion(rowsAfter) !== coreBefore) await syncPermissions();
    }

    async function coreCcFloor(): Promise<string> {
      const install = coreInstallPath(listAfter, projectDir);
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
        awaitStatus = 'timeout';
        awaitReason = reply.reason;
        return false;
      }
      if (!awaitNoted) {
        err('[hermit] Note: await-upgrade unavailable or invalid output; proceeding without its guard.');
        awaitNoted = true;
      }
      return true;
    }
  } catch (e) {
    if (!(e instanceof UpdateExit)) throw e;
    if (e.interrupted) noteInterrupt();
    removeMarker();
    return e.code;
  } finally {
    if (opts.handleSignals) {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      process.off('SIGHUP', onSighup);
    }
  }
}

/**
 * One line from stdin, or null at end of input before a newline. The prompt shows only on
 * a terminal, as `read -p` does, and the read leaves the event loop free so Ctrl-C at the
 * prompt reaches the SIGINT handler.
 */
async function askLine(prompt: string): Promise<string | null> {
  if (process.stdin.isTTY) fs.writeSync(2, prompt);
  const stdin = process.stdin;
  return new Promise(resolve => {
    let buf = '';
    const done = (line: string | null) => {
      stdin.off('data', onData);
      stdin.off('end', onEnd);
      stdin.off('error', onEnd);
      stdin.pause();
      resolve(line);
    };
    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString();
      const i = buf.indexOf('\n');
      if (i >= 0) done(buf.slice(0, i));
    };
    const onEnd = () => done(null);
    stdin.on('data', onData);
    stdin.on('end', onEnd);
    stdin.on('error', onEnd);
  });
}

if (import.meta.main) {
  const [kind, projectDir, ...flags] = process.argv.slice(2);
  if ((kind !== 'host' && kind !== 'docker') || !projectDir) {
    err('[hermit] Usage: update-sequence.ts <host|docker> <project-dir> [--dry-run] [--yes] [--cc-only | --plugins-only]');
    process.exit(2);
  }
  const target = kind === 'host'
    ? (await import('./update-target-host')).hostTarget(projectDir)
    : (await import('./update-target-docker')).dockerTarget(projectDir, {
      ccOnly: flags.includes('--cc-only'),
      pluginsOnly: flags.includes('--plugins-only'),
    });
  const code = await runUpdate(target, {
    projectDir,
    dryRun: flags.includes('--dry-run'),
    assumeYes: flags.includes('--yes'),
    handleSignals: true,
  });
  process.exit(code);
}
