// End-of-hatch report data, observed from disk and printed as one JSON object.
// Usage: bun hatch-report.ts final <project-root> --deployment <docker|tmux|interactive> [--quick]
// Deployment is a wizard choice. Quick also reports the defaults in the written files.

import fs from 'node:fs';
import path from 'node:path';
import { readJson, flagValue, exitError, printJson } from './lib/cli';
import { browserHostPrerequisite } from './lib/browser-runtime';
import { readConfigRaw } from './lib/config-read';
import { settingsFile as settingsFileForTarget } from './lib/domain-hatch/target';
import { readSeedPatterns } from './lib/settings/seed-patterns';

type Json = any;

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '..');
const CONFIG_REFERENCE_URL =
  'https://github.com/gtapps/hermitd/blob/main/plugins/hermitd/docs/config-reference.md';

const DEPLOYMENTS = ['docker', 'tmux', 'interactive'];
const WORKTREE_MARKER = '# >>> hermitd';

function has(file: string, needle: string): boolean {
  try { return fs.readFileSync(file, 'utf8').includes(needle); } catch { return false; }
}

function exists(p: string): boolean {
  try { fs.accessSync(p); return true; } catch { return false; }
}

/** What hatch actually left on disk, observed rather than reported. */
export interface Observed {
  stateDir: boolean;
  config: Json | null;
  hatchOptions: Json | null;
  gitignore: boolean;
  worktreeinclude: boolean;
  settingsFile: string | null;
  gitRepo: boolean;
  binScripts: string[];
  dockerSetUp: boolean;
  browserSetupNeeded?: boolean;
  standardDenyRules: boolean;
}

export function observe(root: string, browserReady = () => browserHostPrerequisite() === null): Observed {
  const hermit = path.join(root, '.hermit');
  const settingsCandidates = ['.claude/settings.local.json', '.claude/settings.json'];
  const settingsFile = settingsCandidates.find(f => has(path.join(root, f), 'hermitd') || has(path.join(root, f), '.hermit/')) ?? null;

  let binScripts: string[] = [];
  try { binScripts = fs.readdirSync(path.join(hermit, 'bin')).sort(); } catch { /* not scaffolded */ }
  // Raw, not settled: a null config here IS the "hatch did not complete" signal.
  const config = readConfigRaw(hermit);
  const hatchOptions = readJson(path.join(hermit, 'state', 'hatch-options.json'));
  const target = hatchOptions?.target;
  const deny = target === 'local' || target === 'committed'
    ? readJson(path.join(root, '.claude', settingsFileForTarget(target)))?.permissions?.deny
    : undefined;
  const { deny: standardDeny } = readSeedPatterns(PLUGIN_ROOT);
  const dockerSetUp = exists(path.join(root, 'docker-compose.hermit.yml'));

  return {
    stateDir: exists(hermit),
    config,
    hatchOptions,
    standardDenyRules: Array.isArray(deny) && standardDeny.length > 0 && standardDeny.every(rule => deny.includes(rule)),
    gitignore: has(path.join(root, '.gitignore'), '.hermit'),
    worktreeinclude: has(path.join(root, '.worktreeinclude'), WORKTREE_MARKER),
    settingsFile,
    gitRepo: exists(path.join(root, '.git')),
    binScripts,
    dockerSetUp,
    browserSetupNeeded: config?.browser?.enabled !== false && !dockerSetUp && !browserReady(),
  };
}

function channels(config: Json): Array<{ name: string; enabled: boolean }> {
  const all = config?.channels ?? {};
  return Object.keys(all).filter(k => k !== 'primary').map(name => ({ name, enabled: !!all[name]?.enabled }));
}

export function finalData(o: Observed, deployment: string, quick = false): Json {
  // Never claim success the filesystem doesn't support.
  if (!o.stateDir || !o.config) return { status: 'incomplete', reason: 'config_missing' };
  const c = o.config;

  // Compare against the shipped template set, not just "empty": a partial
  // scaffold (missing hermitd-run, hermitd-update, ...) must surface too.
  // Operator add-ons in bin/ are fine; only absences are reported.
  let expectedBin: string[] = [];
  try { expectedBin = fs.readdirSync(path.join(PLUGIN_ROOT, 'state-templates', 'bin')); } catch { /* no template dir, skip the check */ }
  const chans = channels(c);

  // Hatch installs the recommended plugins mid-run, and Claude Code only exposes
  // them to the *current* session after a reload, so this step goes first, ahead
  // of anything that would use them.
  const steps: Array<{ run: string; purpose: string; optional?: true; from?: 'terminal' }> = [{ run: '/reload-plugins', purpose: 'load_new_plugins' }];
  const pair = { run: '/hermitd:channel-setup', purpose: 'set_bot_token_and_pair' };
  // running_after_step names the step that starts the agent.
  let runningAfter: number;
  if (deployment === 'docker') {
    // A re-init of a hermit docker-setup already built only needs the container
    // to pick up the new config.
    steps.push(o.dockerSetUp
      ? { run: '!hermitd restart --fresh', purpose: 'restart_container' }
      : { run: '/hermitd:docker-setup', purpose: 'build_and_start_container' });
    runningAfter = steps.length;
    // docker-setup pairs channels itself; a re-init that adds one pairs it after the restart.
    if (o.dockerSetUp && chans.length) steps.push(pair);
  } else if (deployment === 'tmux') {
    steps.push(chans.length
      ? { run: '/hermitd:channel-setup start', purpose: 'set_credential_start_and_admit' }
      : { run: '!hermitd start', purpose: 'boot_always_on_session' });
    runningAfter = steps.length;
  } else {
    if (chans.length) steps.push(pair);
    steps.push({ run: '/hermitd:resident-start', purpose: 'start_agent' });
    runningAfter = steps.length;
  }

  if (deployment !== 'docker' && o.browserSetupNeeded) {
    steps.push({ run: 'hermitd run browser-host', purpose: 'install_browser_prerequisites', optional: true, from: 'terminal' });
  }

  return {
    agent_name: c.agent_name ?? null,
    ...(quick ? { defaults_applied: {
      permission_mode: c.permission_mode ?? null,
      enabled_routines: (Array.isArray(c.routines) ? c.routines : [])
        .filter((routine: Json) => typeof routine?.id === 'string' && routine.enabled !== false)
        .map((routine: Json) => routine.id),
      heartbeat_every: c.heartbeat?.enabled ? c.heartbeat.every ?? null : null,
      standard_deny_rules: o.standardDenyRules,
    } } : {}),
    // A missing git repo is not reported: existing projects legitimately vary.
    observed: {
      gitignore: o.gitignore,
      worktreeinclude: o.worktreeinclude,
      permissions_file: o.settingsFile,
      missing_bin_scripts: expectedBin.filter(b => !o.binScripts.includes(b)),
    },
    // Nothing chains from here: the operator runs each step in order, and nothing
    // is running before step running_after_step finishes.
    browser: { enabled: c.browser?.enabled !== false, default: c.browser?.default ?? 'agent-browser' },
    next_steps: steps,
    transcription: { enabled: c.transcription?.enabled !== false, echo: c.transcription?.echo !== false },
    running_after_step: runningAfter,
    anytime: [
      { run: '/hermit-settings', purpose: 'change_settings', reference: CONFIG_REFERENCE_URL },
      { run: '/hermitd:hermit-update', purpose: 'update_plugins' },
      { run: '/hermitd:hermit-restart', purpose: 'restart_agent' },
      { run: '/hermit-doctor', purpose: 'troubleshoot' },
      { run: 'hermitd run backup setup', purpose: 'back_up_state_to_git', from: 'terminal' },
    ],
  };
}

function main(): void {
  const [verb, root, ...flags] = process.argv.slice(2);
  if (!verb || !root) exitError();

  if (verb === 'final') {
    const deployment = flagValue(flags, '--deployment') ?? 'interactive';
    if (!DEPLOYMENTS.includes(deployment)) exitError('invalid_deployment');
    printJson(finalData(observe(root), deployment, flags.includes('--quick')));
    return;
  }

  exitError();
}

if (import.meta.main) main();
