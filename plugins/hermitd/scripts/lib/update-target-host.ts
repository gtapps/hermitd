/**
 * Host adapter for the update sequence: commands run directly in the project
 * folder, and the live agent is the host tmux resident, bounced by stop then start.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readSettledConfig } from './config-read';
import { cmpSemver } from './semver';
import { expandSessionName } from './tmux';
import {
  UpdateExit, out, err, printPluginLines, spawnCommand,
  type PluginRow, type RunOptions, type UpdateTarget,
} from './update-sequence';

export function hostTarget(projectDir: string): UpdateTarget {
  const session = expandSessionName(readSettledConfig(path.join(projectDir, '.hermit')), projectDir);
  const stateDir = path.join(projectDir, '.hermit', 'state');
  const markerPath = path.join(stateDir, 'update-in-progress.json');
  const run = (argv: string[], opts?: RunOptions) => spawnCommand(argv, projectDir, opts);
  const terminal = { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' } as const;
  const hermitBin = (name: string) => `.hermit/bin/${name}`;

  return {
    trigger: 'hermitd-update',
    mode: 'host-plugins',
    // Moving a user-scope pin from one project would move it for every project.
    updatesPlugins: true,
    includeUserScope: false,
    needsPlugins: true,
    markerAtStart: false,
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

    async updatePlugin({ id, scope }: PluginRow) {
      const r = await run(['claude', 'plugin', 'update', id, '--scope', scope], { stdout: 'inherit', stderr: 'inherit' });
      if (r.code === 0) return 'ok';
      err(`[hermit] Warning: update failed for ${id} — run manually:`);
      err(`[hermit]          claude plugin update ${id} --scope ${scope}`);
      return 'failed';
    },

    stateDir: () => stateDir,
    stampMarker() {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(markerPath, JSON.stringify({ at: new Date().toISOString() }) + '\n');
    },
    clearMarker() { fs.rmSync(markerPath, { force: true }); },

    async live(anyOk: boolean) {
      return anyOk && (await run(['tmux', 'has-session', '-t', `=${session}`], { stdout: 'ignore' })).code === 0;
    },

    printNotLive() {
      out(`[hermit] No live tmux session '${session}' — pins are moved (durable);`);
      out('[hermit] the next session start picks them up. If the hermit version bumped, type');
      out('[hermit] /hermitd:hermit-evolve in that session (always-on does it automatically).');
    },

    async selfRun() {
      if (!process.env.TMUX) return false;
      return (await run(['tmux', 'display-message', '-p', '#S'])).out.trim() === session;
    },

    // Claude Code on the host updates separately, so a Claude Code below the minimum stops here.
    async floorVerdict(floor: string) {
      const have = (await run(['claude', '--version'])).out.match(/[0-9]+(\.[0-9]+)+/)?.[0] ?? '';
      if (!floor || !have || cmpSemver(have, floor) >= 0) return 'ok';
      err(`[hermit] Claude Code ${have} is below hermitd's minimum ${floor}: run \`claude update\`, then \`hermitd restart\`; hermit-evolve runs at boot.`);
      return 'block';
    },

    printReloadFailed(batch: boolean) {
      if (batch) err('[hermit]          hermit-evolve did not run; type /hermitd:hermit-evolve when you attach.');
      err('[hermit]          Pins are already updated (durable); next session start picks them up.');
    },

    async bounce() {
      const stop = await run([hermitBin('hermitd-stop')], terminal);
      if (stop.code !== 0) {
        err('[hermit] Stop failed; resident was not restarted.');
        return false;
      }
      const start = await run([hermitBin('hermitd-start'), '--resume'], terminal);
      if (start.code !== 0) throw new UpdateExit(start.code);
      return true;
    },

    async doctor(args: string[]) {
      await run([hermitBin('hermitd-run'), 'hermitd-cli', ...args], terminal);
    },

    historyFields: async () => ({}),

    printSummary(o) {
      out();
      out(o.awaitStatus === 'blocked'
        ? "[hermit] Update blocked: Claude Code is below hermitd's minimum; run `claude update`, then `hermitd restart`."
        : '[hermit] Update complete.');
      printPluginLines(o.plugins);
      if (o.evolveSent) out('  hermit-evolve auto-started (unattended) — hermit config is upgrading.');
    },

    async installHostCli() {
      const r = await run([hermitBin('hermitd-run'), 'hermitd-cli', 'install'], { stderr: 'inherit' });
      reportHostCliInstall(r.out);
    },
  };
}

/** Quiet on success and on the expected container / no-marketplace skips. */
export function reportHostCliInstall(output: string): void {
  const o = output.trim();
  if (o === 'OK' || o === '{"status":"skip","reason":"container"}' || o === '{"status":"skip","reason":"no_marketplace"}') return;
  err(`[hermit] Host CLI install: ${o}`);
}
