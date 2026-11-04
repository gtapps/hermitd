// Subprocess runner for hook contract tests.
// Spawning is intentional here — these tests exercise the process boundary
// Claude Code sees (stdin in, exit code/stdout/stderr out, fail-open).
// Do not convert a caller to an in-process import unless the assertion is
// purely about a pure exported decision helper (e.g. doctor-check's
// `cidrOverlap`); anything that depends on stdin parsing, env plumbing, the
// stdin cap, or the exit code stays a spawn.

import fs from 'node:fs';
import path from 'node:path';

export const PLUGIN_ROOT = path.resolve(import.meta.dir, '../..');
export const SCRIPTS_DIR = path.join(PLUGIN_ROOT, 'scripts');
export const MONOREPO_ROOT = path.resolve(PLUGIN_ROOT, '../..');

// Recursively collect file paths under `root` whose name satisfies `match`.
// Entries (file or directory) named in `skipDirs` are pruned entirely.
// Missing `root` returns [].
export function walkFiles(
  root: string,
  match: (name: string) => boolean,
  skipDirs: ReadonlySet<string> = new Set(),
): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skipDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (match(entry.name)) out.push(full);
    }
  }
  return out;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  stdin?: string;
  /**
   * Leave stdin an open pipe that never reaches EOF (the shape the Bash tool
   * hands a script). A child that waits on 'end' is killed after 2s, so a
   * regression shows as a non-zero exit with empty stdout, not a suite hang.
   */
  openStdin?: boolean;
  env?: Record<string, string>;
  cwd?: string;
  args?: string[];
}

/**
 * Invoke scripts/proposal.ts against a scratch state dir.
 *
 * proposal.ts pins its state dir to hermitDir(), which in a test would resolve
 * to this repo's own `.hermit`, not the scratch fixture. An
 * absolute AGENT_DIR is the sanctioned override, so it is set here rather than
 * at ~75 call sites — one place enforces it and tests cannot drift back.
 *
 * `args` is [verb, ...rest]; the resolved state dir is injected after the verb.
 * Tests that deliberately pass a foreign or missing state dir call runScript
 * directly instead.
 */
export async function runProposal(
  stateDir: string,
  args: string[],
  opts: Omit<RunOptions, 'args'> = {},
): Promise<RunResult> {
  const abs = path.resolve(stateDir);
  return runScript('proposal.ts', {
    ...opts,
    args: [args[0], abs, ...args.slice(1)],
    env: { AGENT_DIR: abs, ...opts.env },
  });
}

/**
 * Invoke a script that pins its state-dir argv via cc-compat's
 * assertStateDir()/assertUnderStateDir() — manifest-seed.ts, reflect-precheck.ts,
 * update-reflection-state.ts, generate-summary.ts (CLI mode). Those scripts pin
 * to hermitDir(), which in a test would resolve to this repo's own
 * `.hermit`, not the scratch fixture — an absolute AGENT_DIR is the
 * sanctioned override (same rationale as runProposal above), set here once so
 * call sites cannot drift back to redeclaring it individually.
 *
 * `stateDir` is the project's own hermit root even when `args` passes a subdir
 * or file within it (update-reflection-state.ts's state file,
 * generate-summary.ts's `<hermit>/state`) — AGENT_DIR always pins to the root;
 * `args` is passed through untouched since each script's own positional shape
 * differs. Tests that deliberately pass a foreign or missing state dir call
 * runScript directly instead.
 */
export async function runPinnedScript(
  script: string,
  stateDir: string,
  args: string[],
  opts: Omit<RunOptions, 'args'> = {},
): Promise<RunResult> {
  return runScript(script, {
    ...opts,
    args,
    env: { AGENT_DIR: path.resolve(stateDir), ...opts.env },
  });
}

export async function runScript(script: string, opts: RunOptions = {}): Promise<RunResult> {
  // Browser health reads in CLI tests must never consult the operator's install.
  const browserEnv = ['doctor-check.ts', 'hatch-report.ts'].includes(script)
    ? { CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(opts.cwd ?? path.resolve(opts.args?.[1] ?? opts.args?.[0] ?? '/tmp'), '.test-browser-cache') }
    : {};
  const proc = Bun.spawn({
    cmd: [process.execPath, path.join(SCRIPTS_DIR, script), ...(opts.args ?? [])],
    cwd: opts.cwd,
    // Pin the plugin root to the tree under test: a Claude Code session exports
    // CLAUDE_PLUGIN_ROOT for the installed plugin, whose templates may differ.
    env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...browserEnv, ...opts.env },
    stdin: opts.openStdin ? 'pipe' : Buffer.from(opts.stdin ?? ''),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = opts.openStdin ? setTimeout(() => proc.kill(), 2000) : undefined;
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr };
}

/** True when a process whose full command line is exactly `cmd` is running. */
export function processRunning(cmd: string): boolean {
  const ps = Bun.spawnSync(['ps', '-eo', 'pid=,cmd=']);
  if (ps.exitCode !== 0) throw new Error('ps failed');
  return ps.stdout.toString().split('\n').some(line => line.trim().replace(/^\d+\s+/, '') === cmd);
}
