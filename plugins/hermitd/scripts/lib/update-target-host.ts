/**
 * Host adapter for the update sequence: commands run directly in the project
 * folder, and the live agent is the host tmux resident, bounced by stop then start.
 */

import path from 'node:path';
import { readSettledConfig } from './config-read';
import { expandSessionName } from './tmux';
import { UpdateExit, out, err, type PluginRow, type RunOptions, type RunResult, type UpdateTarget } from './update-sequence';

export function hostTarget(projectDir: string): UpdateTarget {
  const session = expandSessionName(readSettledConfig(path.join(projectDir, '.hermit')), projectDir);

  async function run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
    const stdout = opts.stdout ?? 'pipe';
    const stderr = opts.stderr ?? 'ignore';
    let proc;
    try {
      proc = Bun.spawn({
        cmd: argv,
        cwd: projectDir,
        stdin: opts.stdin ?? 'ignore',
        stdout,
        // A piped stderr joins the captured stdout (2>&1).
        stderr,
      });
    } catch {
      return { code: 127, out: '' };
    }
    const [o, e] = await Promise.all([
      stdout === 'pipe' ? new Response(proc.stdout as ReadableStream).text() : '',
      stderr === 'pipe' ? new Response(proc.stderr as ReadableStream).text() : '',
    ]);
    const code = await proc.exited;
    return { code, out: o + e, ...(proc.signalCode ? { signal: proc.signalCode } : {}) };
  }

  const hermitBin = (name: string) => `.hermit/bin/${name}`;

  return {
    trigger: 'hermitd-update',
    mode: 'host-plugins',
    run,

    printPlan(update: PluginRow[], skipped: PluginRow[]) {
      out(`[hermit] Update plan (host, project: ${path.basename(projectDir)}):`);
      if (update.length === 0) {
        out('  Plugins to update: (none)');
      } else {
        out('  Plugins to update (durable pin move):');
        for (const r of update) out(`    - ${r.id} (${r.scope}, v${r.version})`);
      }
      if (skipped.length > 0) {
        out('  Skipped (user scope — shared across projects, update manually if intended):');
        for (const r of skipped) out(`    - ${r.id}  ->  claude plugin update ${r.id} --scope user`);
      }
      out('  A live tmux resident restarts once after reload and evolve.');
      out('  Note: Claude Code itself is updated separately on the host: claude update');
    },

    async live() {
      return (await run(['tmux', 'has-session', '-t', `=${session}`], { stdout: 'ignore' })).code === 0;
    },

    printNotLive() {
      out(`[hermit] No live tmux session '${session}' — pins are moved (durable);`);
      out('[hermit] the next session start picks them up. If the hermit version bumped, type');
      out('[hermit] /hermitd:hermit-evolve in that session (always-on does it automatically).');
    },

    async selfRun() {
      if (!process.env.TMUX) return false;
      const r = await run(['tmux', 'display-message', '-p', '#S']);
      return r.out.trim() === session;
    },

    async bounce() {
      const stop = await run([hermitBin('hermitd-stop')], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
      if (stop.code !== 0) {
        err('[hermit] Stop failed; resident was not restarted.');
        return;
      }
      const start = await run([hermitBin('hermitd-start'), '--resume'], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
      if (start.code !== 0) throw new UpdateExit(start.code);
    },

    async doctor(args: string[]) {
      await run([hermitBin('hermitd-run'), 'hermitd-cli', ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    },

    async installHostCli() {
      // Quiet on success and on the expected container / no-marketplace skips.
      const r = await run([hermitBin('hermitd-run'), 'hermitd-cli', 'install'], { stderr: 'inherit' });
      const o = r.out.trim();
      if (o === 'OK' || o === '{"status":"skip","reason":"container"}' || o === '{"status":"skip","reason":"no_marketplace"}') return;
      err(`[hermit] Host CLI install: ${o}`);
    },
  };
}
