/**
 * Docker adapter for the update sequence. Agent commands run inside the container
 * through `docker compose exec`, using the host plugin's compose-files.ts (the host
 * never runs files the agent can rewrite). The restart approves the Docker inputs,
 * rebuilds the image with the latest Claude Code unless --plugins-only, then takes
 * the stack down and up. Those steps stay in hermitd-docker.sh as `update-step`.
 *
 * State writes go through the physical project state folder, so a symlink the agent
 * planted there cannot redirect them.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cmpSemver } from './semver';
import { reportHostCliInstall } from './update-target-host';
import {
  UpdateExit, out, err, printPluginLines, spawnCommand,
  type PluginRow, type RunOptions, type UpdateTarget,
} from './update-sequence';

const SERVICE = 'hermit';
const MARKER = 'update-in-progress.json';
const HOST_SCRIPTS = path.resolve(import.meta.dir, '..');

export function dockerTarget(projectDir: string, mode: { ccOnly: boolean; pluginsOnly: boolean }): UpdateTarget {
  const { ccOnly, pluginsOnly } = mode;
  // The approved Docker files; empty until approval, when compose-files.ts finds the applied set.
  let filesSet = '';
  let ccBefore = 'unknown';
  let ccLatest = 'unknown';
  let ccAfter = '';
  // Set when the image is rebuilt.
  let buildVersion = '';
  let countBefore = 0;

  const compose = (args: string[], opts?: RunOptions) =>
    spawnCommand(['bun', path.join(HOST_SCRIPTS, 'lib', 'compose-files.ts'), projectDir, filesSet, ...args], projectDir, opts);
  const run = (argv: string[], opts?: RunOptions) => compose(['exec', '-T', SERVICE, ...argv], opts);
  // Steps that stay in shell; they share the terminal so approval can show its diff and ask.
  const step = (args: string[]) => spawnCommand(['bash', path.join(HOST_SCRIPTS, 'hermitd-docker.sh'), 'update-step', ...args],
    projectDir, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
  const hostCli = (args: string[], opts?: RunOptions) =>
    spawnCommand(['bun', path.join(HOST_SCRIPTS, 'hermitd-cli.ts'), ...args], projectDir, opts);
  const runningCc = async () => (await run(['claude', '--version'])).out.match(/[0-9.]+/)?.[0] || 'unknown';

  /** The physical state folder; refuses a path the agent could have redirected with a symlink. */
  function stateDir(): string {
    const project = fs.realpathSync(projectDir);
    const hermitDir = path.join(project, '.hermit');
    if (fs.realpathSync(hermitDir) !== hermitDir) throw new Error('unsafe_state_dir');
    const dir = path.join(hermitDir, 'state');
    fs.mkdirSync(dir, { recursive: true });
    if (fs.realpathSync(dir) !== dir) throw new Error('unsafe_state_dir');
    return dir;
  }

  return {
    trigger: 'hermitd-docker update',
    mode: ccOnly ? 'cc-only' : pluginsOnly ? 'plugins-only' : 'full',
    updatesPlugins: !ccOnly,
    // The container's config volume is single-tenant, so its user-scope plugins are this agent's.
    includeUserScope: true,
    // A Claude Code rebuild has work to do with no plugin listed.
    needsPlugins: false,
    // The marker tells an update-launched evolve whether this run rebuilds the image.
    markerAtStart: true,
    run,

    async prepare(list: unknown[]) {
      const [running, latest] = await Promise.all([
        runningCc(),
        pluginsOnly ? null : run(['npm', 'view', '@anthropic-ai/claude-code', 'version']),
      ]);
      ccBefore = running;
      if (latest) ccLatest = latest.code === 0 ? latest.out.trim() : 'unknown';
      countBefore = list.length;
    },

    printPlan(update: PluginRow[]) {
      out('[hermit] Update plan:');
      if (!pluginsOnly) out(`  Claude Code:  ${ccBefore} → ${ccLatest} (image rebuild, container bounces)`);
      else out('  Container:    bounces once after the plugin update (no image rebuild)');
      if (ccOnly) return;
      out('  Plugins to update (durable pin move):');
      if (update.length === 0) out('    (none)');
      for (const r of update) out(`    - ${r.id} (${r.scope}, v${r.version})`);
      out('  Apply method: refresh marketplaces, then claude plugin update per plugin (core first), then /reload-plugins + hermit-evolve via tmux');
    },

    async updatePlugin({ id, scope }: PluginRow) {
      const r = await run(['claude', 'plugin', 'update', id, '--scope', scope, '--json'], { stderr: 'inherit' });
      let reply: { message?: unknown; skipReason?: unknown } = {};
      try { reply = JSON.parse(r.out.trim().split('\n').pop() ?? ''); } catch {}
      if (reply.message) err(`[hermit] ${reply.message}`);
      if (r.code === 0) return reply.skipReason === 'engine_range' ? 'held' : 'ok';
      err(`[hermit] Warning: update failed for ${id} — run manually inside the container:`);
      err(`[hermit]          claude plugin update ${id} --scope ${scope}`);
      return 'failed';
    },

    stateDir,
    stampMarker() {
      let dir: string;
      try { dir = stateDir(); } catch {
        err('[hermit] Could not safely write the update marker.');
        throw new UpdateExit(1);
      }
      // `build` tells an update-launched evolve whether this run rebuilds the image.
      const temporary = path.join(dir, `.update-marker-${crypto.randomUUID()}`);
      try {
        fs.writeFileSync(temporary, JSON.stringify({ at: new Date().toISOString(), build: !pluginsOnly }) + '\n', { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporary, path.join(dir, MARKER));
      } catch {
        err('[hermit] Could not safely write the update marker.');
        throw new UpdateExit(1);
      } finally { fs.rmSync(temporary, { force: true }); }
    },
    clearMarker() {
      try { fs.rmSync(path.join(stateDir(), MARKER), { force: true }); } catch {}
    },

    // The container was checked running before the update started.
    live: async () => true,

    // An image rebuild brings the newer Claude Code, so evolve moves to that boot.
    async floorVerdict(floor: string, held: boolean) {
      const below = floor !== '' && ccBefore !== 'unknown' && cmpSemver(ccBefore, floor) < 0;
      if (!held && !below) return 'ok';
      if (pluginsOnly) {
        err(`[hermit] Claude Code ${ccBefore} is below an updated plugin's minimum; rerun \`hermitd update\` without --plugins-only to rebuild the image.`);
        return 'block';
      }
      out(`[hermit] Claude Code ${ccBefore} is below an updated plugin's minimum: rebuilding first; hermit-evolve runs at boot.`);
      return 'rebuild';
    },

    printReloadFailed(batch: boolean) {
      if (batch) err('[hermit]          hermit-evolve did not run; type /hermitd:hermit-evolve after: hermitd attach');
      err('[hermit]          Pins are already updated (durable); run /reload-plugins after: hermitd attach');
    },

    async beforeBounce() {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-update-'));
      try {
        const approved = path.join(scratch, 'files-set');
        if ((await step(['approve', approved])).code !== 0) throw new UpdateExit(1);
        filesSet = fs.readFileSync(approved, 'utf8');
      } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
      if (pluginsOnly) return;
      buildVersion = ['', 'unknown'].includes(ccLatest) ? 'latest' : ccLatest;
      const build = await step(['build', filesSet, buildVersion]);
      if (build.code !== 0) throw new UpdateExit(build.code);
    },

    // A one-off container shares the config volume, so the pin moves on the rebuilt image.
    async updateHeld({ id, scope }: PluginRow) {
      const r = await compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', 'claude', SERVICE,
        'plugin', 'update', id, '--scope', scope], { stdout: 'inherit', stderr: 'inherit' });
      return r.code === 0;
    },

    async bounce() {
      const r = await step(['bounce', filesSet, String(pluginsOnly)]);
      if (r.code !== 0) throw new UpdateExit(r.code);
      return true;
    },

    async doctor(args: string[]) {
      await hostCli(args, { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    },

    async historyFields(o) {
      // Claude Code changes only with a restart, and a pinned rebuild names its version.
      ccAfter = !o.restarted ? ccBefore : buildVersion && buildVersion !== 'latest' ? buildVersion : await runningCc();
      let countAfter = 0;
      if (!ccOnly) {
        try { countAfter = JSON.parse((await run(['claude', 'plugin', 'list', '--json'])).out).length ?? 0; } catch {}
      }
      return {
        restarted: o.restarted,
        image_built: buildVersion !== '',
        await: { status: o.awaitStatus, reason: o.awaitReason || null },
        cc_before: ccBefore,
        cc_after: ccAfter,
        plugins_before_count: countBefore,
        plugins_after_count: countAfter,
      };
    },

    printSummary(o) {
      out();
      if (o.awaitStatus === 'timeout') out('[hermit] Update paused; no restart performed.');
      else if (o.awaitStatus === 'blocked') out(`[hermit] Update blocked: Claude Code ${ccBefore} is below an updated plugin's minimum; rerun \`hermitd update\` without --plugins-only.`);
      else out('[hermit] Update complete.');
      if (!pluginsOnly) out(`  Claude Code: ${ccBefore} → ${ccAfter}`);
      if (!ccOnly && o.plugins.length > 0) printPluginLines(o.plugins);
      if (!ccOnly && o.awaitStatus !== 'blocked') {
        if (o.reloadSent) out('  /reload-plugins sent — plugin updates active in the running session.');
        else if (o.belowFloor) out('  Plugin updates load at boot on the rebuilt image, and hermit-evolve runs there.');
        else if (!o.restarted && o.anyOk) out('  /reload-plugins not sent — attach and run it manually: hermitd attach');
        if (o.evolveSent) out('  hermit-evolve started (unattended).');
      }
      out();
      out('Verify with:  hermitd status');
      out('Attach with:  hermitd attach');
      out();
      out('Note: if the session does not start, the OAuth token may have expired.');
      out('      Run: hermitd docker login');
    },

    async installHostCli() {
      reportHostCliInstall((await hostCli(['install'], { stderr: 'inherit' })).out);
    },
  };
}
