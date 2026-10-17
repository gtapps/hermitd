// hatch-report.ts — renders hatch's two operator-facing summaries.
//
//   confirm  (stdin: the answers payload) — the Quick-branch preview shown
//            BEFORE anything is written. It is explicitly a statement of intent,
//            so it renders what the operator chose, phrased as "will apply".
//
//   final    (no stdin) — the end-of-hatch report. It renders what is actually
//            on disk, by looking. It takes no file list from its caller: the
//            report used to be composed by the model, which could claim a file
//            was written that the operator had declined. Everything below is a
//            filesystem observation, so it says "Present"/"Configured" and can
//            only be wrong if the filesystem is.
//
// Usage:
//   bun hatch-report.ts confirm <project-root> < answers.json
//   bun hatch-report.ts final <project-root> --deployment <docker|tmux|interactive>
//
// `--deployment` is passed explicitly because it is wizard-only state: the Quick
// branch asks for it, nothing persists it (neither config.json nor
// hatch-options.json carry it), and the Step-10 next-steps block keys off it.
// Anything else the report needs, it reads.
//
// Output exception: both verbs print markdown, not JSON. It is a display renderer
// the model relays verbatim to the operator; argument errors still print {"error"}.

import fs from 'node:fs';
import path from 'node:path';
import { readStdin, readJson, flagValue, exitError } from './lib/cli';
import { readConfigRaw } from './lib/config-read';

type Json = any;

// Both renders emit GFM for the model to re-print: the transcript collapses raw
// Bash output ("Ran 1 shell command"), so the model's own message is the only
// display surface, and it renders markdown.
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '..');
const TEMPLATE_PATH = path.join(PLUGIN_ROOT, 'state-templates', 'config.json.template');
const CONFIG_REFERENCE_URL =
  'https://github.com/gtapps/hermitd/blob/main/plugins/hermitd/docs/config-reference.md';

const DEPLOYMENTS = ['docker', 'tmux', 'interactive'];
const CLAUDE_MARKER = 'hermitd: Session Discipline';
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
  claudeBlock: 'CLAUDE.md' | 'CLAUDE.local.md' | null;
  gitignore: boolean;
  worktreeinclude: boolean;
  settingsFile: string | null;
  gitRepo: boolean;
  binScripts: string[];
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
    claudeBlock: has(path.join(root, 'CLAUDE.md'), CLAUDE_MARKER) ? 'CLAUDE.md'
      : has(path.join(root, 'CLAUDE.local.md'), CLAUDE_MARKER) ? 'CLAUDE.local.md'
      : null,
    gitignore: has(path.join(root, '.gitignore'), '.hermit'),
    worktreeinclude: has(path.join(root, '.worktreeinclude'), WORKTREE_MARKER),
    settingsFile,
    gitRepo: exists(path.join(root, '.git')),
    binScripts,
  };
}

function channelSummary(config: Json): string {
  const channels = config?.channels ?? {};
  const names = Object.keys(channels).filter(k => k !== 'primary');
  if (!names.length) return 'none';
  const on = names.filter(n => channels[n]?.enabled);
  return on.length ? on.join(', ') : `${names.join(', ')} (not enabled)`;
}

const DEPLOYMENT_LABELS: Record<string, string> = {
  docker: 'Docker always-on', tmux: 'tmux always-on', interactive: 'Interactive',
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Permissive: an unreadable template degrades the preview to chosen rows
// only, it never blocks the confirm turn.
function readTemplate(): Json {
  return readJson(TEMPLATE_PATH) ?? {};
}

export function renderConfirm(answers: Json): string {
  const t = readTemplate();
  // Free-text answers (Other) can carry `|` or newlines, which would split the
  // GFM table into extra cells/rows — neutralize just those two.
  const cell = (v: string) => v.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const row = (label: string, value: string) => `| **${label}** | ${cell(value)} |`;
  const def = (label: string, value: string) => row(label, `${value} *(default)*`);
  const out: string[] = ['## Hatch preview', '', '| | |', '|---|---|'];

  // Chosen rows — each echoes a wizard answer verbatim, only when it was given.
  if (answers.agent_name) {
    out.push(row('🪪 Name', answers.agent_name));
  }
  const locale = [answers.language, answers.timezone].filter(Boolean).join(' · ');
  if (locale) out.push(row('🌍 Language / Timezone', locale));
  if (answers.activated_hermit?.slug) out.push(row('🧩 Hermit extension', answers.activated_hermit.slug));
  if (answers.plugins?.length) out.push(row('🧩 Plugins', answers.plugins.join(' · ')));
  if (answers.deployment) out.push(row('🚀 Deployment', DEPLOYMENT_LABELS[answers.deployment] ?? answers.deployment));
  if (answers.channel) {
    out.push(row('💬 Chat', answers.channel === 'none'
      ? 'Claude app (for now)' : `${cap(answers.channel)} — pairing comes after setup`));
  }

  // Default rows — read live from the same template hatch-config.ts overlays,
  // so they track the shipped defaults instead of prose that drifts. Kept to
  // the consequential ones (autonomy/permission/spend posture); cosmetic
  // defaults (model, notifications, artifact pages) are trimmed.
  const permission = answers.permission_mode ?? t.permission_mode;
  if (permission) {
    out.push(permission === t.permission_mode
      ? def('Permission mode', `\`${permission}\``)
      : row('Permission mode', `\`${permission}\``));
  }
  if (t.escalation) out.push(def('Autonomy', `${t.escalation} · remote control ${t.remote ? 'on' : 'off'}`));
  // heartbeat-restart is plumbing, not something the
  // operator would recognize as "a routine that wakes the agent".
  const infra = (t.routines ?? [])
    .filter((r: Json) => r.enabled !== false && r.id !== 'heartbeat-restart')
    .map((r: Json) => r.id.replace(/-/g, ' '));
  const briefs = answers.routines?.enabled === false ? []
    : [`briefs ${answers.routines?.morning_time ?? '08:30'} + ${answers.routines?.evening_time ?? '22:30'}`];
  const heartbeatLine = t.heartbeat
    ? [t.heartbeat.enabled
        ? `heartbeat every ${t.heartbeat.every}${t.heartbeat.active_hours ? `, ${t.heartbeat.active_hours.start}–${t.heartbeat.active_hours.end}` : ''}`
        : 'heartbeat off']
    : [];
  if (briefs.length || infra.length || heartbeatLine.length) out.push(row('Routines', [...briefs, ...infra, ...heartbeatLine].join(' · ')));
  if (t.budget) {
    const caps = ['daily_usd', 'weekly_usd', 'monthly_usd'].filter(k => t.budget[k] != null);
    out.push(def('Budget caps', caps.length ? caps.map(k => `${k.replace('_usd', '')} $${t.budget[k]}`).join(' · ') : `none, ${t.budget.action ?? 'alert'}-only`));
  }
  if (answers.deployment) {
    out.push(row('Safety rules', 'standard (safety denies + approval prompts)'));
  }
  out.push(row('Files', (answers.hatch_target === 'committed' ? 'committed files' : '`.local` (gitignored)')
    + (answers.git_init ? ' · git repo initialized' : '')));

  out.push('');
  out.push('Nothing has been written yet. Every *(default)* is tunable later with `/hermit-settings`.');
  return out.join('\n');
}

export function renderFinal(o: Observed, deployment: string): string {
  const c = o.config ?? {};
  const out: string[] = [];

  if (!o.stateDir || !o.config) {
    // Never claim success the filesystem doesn't support.
    return 'Hatch did not complete — .hermit/config.json is not present.\n' +
      'Re-run /hermitd:hatch; nothing below would be accurate.';
  }

  out.push(`## 🐣 ${c.agent_name ?? 'Your agent'} is hatched`);

  // Warn-only disk audit: the happy path shows nothing, but a declined or
  // failed write surfaces — the operator is still in the hatch session, so the
  // fix is one message away. (Filesystem-observed, never a remembered file
  // list; git repo absence is not warned — existing projects legitimately vary.)
  const missing: string[] = [];
  // Compare against the shipped template set, not just "empty": a partial
  // scaffold (missing hermitd-run, hermitd-update, ...) must surface too.
  // Operator add-ons in bin/ are fine — only absences are reported.
  let expectedBin: string[] = [];
  try { expectedBin = fs.readdirSync(path.join(PLUGIN_ROOT, 'state-templates', 'bin')); } catch { /* no template dir — skip the check */ }
  const missingBin = expectedBin.filter(b => !o.binScripts.includes(b));
  if (missingBin.length) missing.push(`\`.hermit/bin/\` scripts (${missingBin.join(', ')})`);
  if (!o.claudeBlock) missing.push('CLAUDE session-discipline block');
  if (!o.gitignore) missing.push('`.gitignore` hermit entries');
  if (!o.worktreeinclude) missing.push('`.worktreeinclude` managed block');
  if (!o.settingsFile) missing.push('hermit permissions in `.claude/` settings');
  if (missing.length) {
    out.push('');
    for (const m of missing) out.push(`⚠ Not present: ${m} — tell me to fix it and I will.`);
  }

  out.push('');
  // Nothing chains from here — the operator runs each of these. Numbered because
  // the order is load-bearing, closed by a consequence line spelling out what is
  // still not running.
  out.push('**Next — nothing is running yet:**');
  // Hatch installs the recommended plugins mid-run, and Claude Code only exposes
  // them to the *current* session after a reload — so this line goes first, ahead
  // of anything that would use them.
  const steps: string[] = ['`/reload-plugins` — load newly installed plugins in this session'];
  let consequence: string;
  // The consequence names the step that actually starts something, not "the last
  // step" — on tmux with a channel, pairing comes after the boot, so the hermit is
  // already awake by the time the list ends.
  if (deployment === 'docker') {
    steps.push('`/hermitd:docker-setup` — build and start the container');
    consequence = `No container exists until step ${steps.length} finishes.`;
  } else if (deployment === 'tmux') {
    // This is the only shell command here; ! makes it runnable in the current session.
    steps.push('`!hermitd start` — boot the always-on session');
    consequence = `The agent is not awake until step ${steps.length} finishes.`;
    if (channelSummary(c) !== 'none') steps.push('`/hermitd:channel-setup` — set the bot token and pair');
  } else {
    if (channelSummary(c) !== 'none') steps.push('`/hermitd:channel-setup` — set the bot token and pair');
    steps.push('`/hermitd:resident-start` — start the agent');
    consequence = `The agent is not running until step ${steps.length} finishes.`;
  }
  steps.forEach((s, i) => out.push(`${i + 1}. ${s}`));
  out.push('');
  out.push(consequence);
  out.push('');
  out.push(`Anytime: \`/hermit-settings\` to change settings ([full reference](${CONFIG_REFERENCE_URL})), \`/hermit-evolve\` after plugin updates, \`/hermit-doctor\` to troubleshoot, \`hermitd run backup setup\` (from a terminal) to back up hermit state to git. Refine OPERATOR.md by telling me what changed.`);

  return out.join('\n');
}

async function main(): Promise<void> {
  const verb = process.argv[2];
  const root = process.argv[3];

  if (!verb || !root) exitError();

  if (verb === 'confirm') {
    const raw = await readStdin();
    let answers: Json = {};
    try { answers = JSON.parse(raw); } catch { exitError('invalid_answers'); }
    process.stdout.write(renderConfirm(answers) + '\n');
    return;
  }

  if (verb === 'final') {
    const deployment = flagValue(process.argv.slice(4), '--deployment') ?? 'interactive';
    if (!DEPLOYMENTS.includes(deployment)) exitError('invalid_deployment');
    process.stdout.write(renderFinal(observe(root), deployment) + '\n');
    return;
  }

  exitError();
}

if (import.meta.main) main();
