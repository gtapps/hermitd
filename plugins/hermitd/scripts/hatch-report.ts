// hatch-report.ts: the data behind hatch's two operator-facing summaries, as one
// JSON object each; the hatch skill composes the summary from it.
//
//   confirm  (stdin: the answers payload): the Quick-branch preview shown
//            BEFORE anything is written. It is explicitly a statement of intent,
//            so it carries what the operator chose, as "will apply" facts.
//
//   final    (no stdin): the end-of-hatch report data. It carries what is actually
//            on disk, by looking. It takes no file list from its caller: a report
//            composed from the model's memory of the run could claim a file was
//            written that the operator had declined. Everything below is a
//            filesystem observation, so it can only be wrong if the filesystem is.
//
// Usage:
//   bun hatch-report.ts confirm <project-root> < answers.json
//   bun hatch-report.ts final <project-root> --deployment <docker|tmux|interactive>
//
// `--deployment` is passed explicitly because it is wizard-only state: the Quick
// branch asks for it, nothing persists it (neither config.json nor
// hatch-options.json carry it), and the next-steps list keys off it.
// Anything else the report needs, it reads.

import fs from 'node:fs';
import path from 'node:path';
import { readStdin, readJson, flagValue, exitError, printJson } from './lib/cli';
import { readConfigRaw } from './lib/config-read';

type Json = any;

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '..');
const TEMPLATE_PATH = path.join(PLUGIN_ROOT, 'state-templates', 'config.json.template');
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
}

export function observe(root: string): Observed {
  const hermit = path.join(root, '.hermit');
  const settingsCandidates = ['.claude/settings.local.json', '.claude/settings.json'];
  const settingsFile = settingsCandidates.find(f => has(path.join(root, f), 'hermitd') || has(path.join(root, f), '.hermit/')) ?? null;

  let binScripts: string[] = [];
  try { binScripts = fs.readdirSync(path.join(hermit, 'bin')).sort(); } catch { /* not scaffolded */ }

  return {
    stateDir: exists(hermit),
    // Raw, not settled: a null config here IS the "hatch did not complete" signal.
    config: readConfigRaw(hermit),
    hatchOptions: readJson(path.join(hermit, 'state', 'hatch-options.json')),
    gitignore: has(path.join(root, '.gitignore'), '.hermit'),
    worktreeinclude: has(path.join(root, '.worktreeinclude'), WORKTREE_MARKER),
    settingsFile,
    gitRepo: exists(path.join(root, '.git')),
    binScripts,
    dockerSetUp: exists(path.join(root, 'docker-compose.hermit.yml')),
  };
}

function channels(config: Json): Array<{ name: string; enabled: boolean }> {
  const all = config?.channels ?? {};
  return Object.keys(all).filter(k => k !== 'primary').map(name => ({ name, enabled: !!all[name]?.enabled }));
}

// Permissive: an unreadable template degrades the preview to chosen facts
// only, it never blocks the confirm turn.
function readTemplate(): Json {
  return readJson(TEMPLATE_PATH) ?? {};
}

export function confirmData(answers: Json): Json {
  const t = readTemplate();
  const will: Json = {};
  // Keys whose value came from the answers payload; every other will_apply key
  // is a default and is listed as one.
  const chosen = new Set<string>();
  const choose = (k: string, v: Json) => { will[k] = v; chosen.add(k); };

  // Chosen facts: each echoes a wizard answer verbatim, only when it was given.
  for (const k of ['agent_name', 'language', 'timezone', 'deployment', 'channel']) {
    if (answers[k]) choose(k, answers[k]);
  }
  if (answers.activated_hermit?.slug) choose('hermit_extension', answers.activated_hermit.slug);
  if (answers.plugins?.length) choose('plugins', answers.plugins);

  // Defaults: read live from the same template hatch-config.ts overlays, so they
  // track the shipped defaults instead of prose that drifts. Kept to the
  // consequential ones (autonomy/permission/spend posture); cosmetic defaults
  // (model, notifications, artifact pages) are left out.
  if (answers.permission_mode) choose('permission_mode', answers.permission_mode);
  else if (t.permission_mode) will.permission_mode = t.permission_mode;
  if (t.escalation) {
    will.escalation = t.escalation;
    will.remote = !!t.remote;
  }
  // hermitd:heartbeat-restart is plumbing, not something the operator would recognize as
  // "a routine that wakes the agent".
  will.routines = {
    briefs: answers.routines?.enabled === false ? null
      : { morning: answers.routines?.morning_time ?? '08:30', evening: answers.routines?.evening_time ?? '22:30' },
    others: (t.routines ?? [])
      .filter((r: Json) => r.enabled !== false && r.id !== 'hermitd:heartbeat-restart')
      .map((r: Json) => r.id),
    heartbeat: t.heartbeat
      ? { enabled: !!t.heartbeat.enabled, every: t.heartbeat.every ?? null, active_hours: t.heartbeat.active_hours ?? null }
      : null,
  };
  if (answers.routines) chosen.add('routines');
  if (t.budget) {
    will.budget = {
      daily_usd: t.budget.daily_usd ?? null, weekly_usd: t.budget.weekly_usd ?? null,
      monthly_usd: t.budget.monthly_usd ?? null, action: t.budget.action ?? 'alert',
    };
  }
  if (answers.deployment) choose('safety_rules', 'standard');
  will.hatch_target = answers.hatch_target === 'committed' ? 'committed' : 'local';
  if (answers.hatch_target) chosen.add('hatch_target');
  will.git_init = !!answers.git_init;
  if (answers.git_init !== undefined) chosen.add('git_init');

  return { will_apply: will, defaults: Object.keys(will).filter(k => !chosen.has(k)) };
}

export function finalData(o: Observed, deployment: string): Json {
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
  const steps: Array<{ run: string; purpose: string }> = [{ run: '/reload-plugins', purpose: 'load_new_plugins' }];
  const pair = { run: '/hermitd:channel-setup', purpose: 'set_bot_token_and_pair' };
  // running_after_step names the step that actually starts something, not "the
  // last step": on tmux with a channel, pairing comes after the boot.
  let runningAfter: number;
  if (deployment === 'docker') {
    // A re-init of a hermit docker-setup already built only needs the container
    // to pick up the new config.
    steps.push(o.dockerSetUp
      ? { run: '!hermitd restart', purpose: 'restart_container' }
      : { run: '/hermitd:docker-setup', purpose: 'build_and_start_container' });
    runningAfter = steps.length;
    // docker-setup pairs channels itself; a re-init that adds one pairs it after the restart.
    if (o.dockerSetUp && chans.length) steps.push(pair);
  } else if (deployment === 'tmux') {
    // The only shell command here; ! makes it runnable in the current session.
    steps.push({ run: '!hermitd start', purpose: 'boot_always_on_session' });
    runningAfter = steps.length;
    if (chans.length) steps.push(pair);
  } else {
    if (chans.length) steps.push(pair);
    steps.push({ run: '/hermitd:resident-start', purpose: 'start_agent' });
    runningAfter = steps.length;
  }

  return {
    agent_name: c.agent_name ?? null,
    // A missing git repo is not reported: existing projects legitimately vary.
    observed: {
      gitignore: o.gitignore,
      worktreeinclude: o.worktreeinclude,
      permissions_file: o.settingsFile,
      missing_bin_scripts: expectedBin.filter(b => !o.binScripts.includes(b)),
    },
    // Nothing chains from here: the operator runs each step in order, and nothing
    // is running before step running_after_step finishes.
    next_steps: steps,
    running_after_step: runningAfter,
    anytime: [
      { run: '/hermit-settings', purpose: 'change_settings', reference: CONFIG_REFERENCE_URL },
      { run: '/hermit-evolve', purpose: 'after_plugin_updates' },
      { run: '/hermit-doctor', purpose: 'troubleshoot' },
      { run: 'hermitd run backup setup', purpose: 'back_up_state_to_git', from: 'terminal' },
    ],
  };
}

async function main(): Promise<void> {
  const verb = process.argv[2];
  const root = process.argv[3];

  if (!verb || !root) exitError();

  if (verb === 'confirm') {
    const raw = await readStdin();
    let answers: Json = {};
    try { answers = JSON.parse(raw); } catch { exitError('invalid_answers'); }
    printJson(confirmData(answers));
    return;
  }

  if (verb === 'final') {
    const deployment = flagValue(process.argv.slice(4), '--deployment') ?? 'interactive';
    if (!DEPLOYMENTS.includes(deployment)) exitError('invalid_deployment');
    printJson(finalData(observe(root), deployment));
    return;
  }

  exitError();
}

if (import.meta.main) main();
