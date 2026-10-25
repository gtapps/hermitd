// The scalar/enum settings registry — one row per `/hermit-settings <argument>`
// that resolves to a single config.json leaf.
//
// It replaces two drifting copies: a ~45-line *example* settings dump in
// hermit-settings/SKILL.md whose field list went stale every release, and the
// per-argument prose that spelled out each dotted path by hand. `show` renders
// live values from these rows, and the skill's argument table is generated from
// the same rows, so a new setting is one entry here rather than three edits.
//
// Deliberately NOT in here: the arguments whose work is not "write one leaf" —
// `channels`, `routines`, `env`, `compact`, `docker`, `scheduled-checks` (session checks),
// `brief`, `heartbeat`, `watchdog` (arrays, key deletes, multi-field wizards),
// and `quality-gate` / `artifact-authorization` (bounded asks with a channel
// re-entry path). Those keep their prose in the skill. `language` has a row
// because `show` must render it, but the skill keeps its prose too — changing it
// retranslates `state/artifact-strings.json`, which no table can express.

import { PERMISSION_MODE } from './enums';
import { specAt } from '../config-read';

export type Kind = 'string' | 'boolean' | 'enum' | 'int';

export interface Setting {
  /** The `/hermit-settings <arg>` token. */
  arg: string;
  /** Dotted path into config.json. */
  path: string;
  kind: Kind;
  /** Allowed values for `kind: 'enum'`. */
  values?: readonly string[];
  /** Whether 'none'/'clear' is meaningful (maps to null). */
  nullable?: boolean;
  group: 'Identity' | 'Operational' | 'Artifacts';
  label: string;
  /** One line telling the operator what they're choosing. */
  hint: string;
  /** When the change takes effect, if not immediately. */
  applies?: string;
  /** Rendered by `show` but not settable through the table (side effects, or read-only). */
  tableExempt?: boolean;
}

type SettingRow = Omit<Setting, 'kind' | 'values' | 'nullable'> & { values?: readonly string[] };

const ROWS: readonly SettingRow[] = [
  { arg: 'name', path: 'agent_name', group: 'Identity',
    label: 'Agent name', hint: "any string, or 'none' to clear" },
  { arg: 'language', path: 'language', group: 'Identity',
    label: 'Language', hint: 'locale code (en, pt, es, fr)', tableExempt: true,
    applies: 'also regenerates the artifact chrome translation table' },
  { arg: 'timezone', path: 'timezone', group: 'Identity',
    label: 'Timezone', hint: 'IANA tz (UTC, Europe/Lisbon, America/New_York)' },
  { arg: 'escalation', path: 'escalation', group: 'Identity',
    label: 'Escalation', hint: 'how much it acts without asking' },
  // `custom` needs voice.prose written first and renders a file, so the skill keeps
  // its own branch — but the row is real: `show` renders it, and `apply-known voice
  // <style>` is how the branch writes a built-in.
  { arg: 'voice', path: 'voice.style',
    group: 'Identity', label: 'Voice', hint: 'how it talks to you', tableExempt: true,
    applies: 'next session (a terminal run renders it now; boot renders it otherwise)' },

  { arg: 'remote', path: 'remote', group: 'Operational',
    label: 'Remote control', hint: 'connect from claude.ai/code or phone',
    applies: 'next hermitd-start' },
  { arg: 'auth-mode', path: 'auth_mode',
    group: 'Operational', label: 'Auth method',
    hint: "login (claude.ai sign-in, renew ~monthly) or token (long-lived, renew yearly)",
    applies: 'run /relogin to sign in with the new method' },
  { arg: 'model', path: 'model', group: 'Operational',
    label: 'Model', hint: "model name passed straight to --model, or 'none' for the Claude Code default",
    applies: 'next hermitd-start' },
  { arg: 'boot-skill', path: 'boot_skill', group: 'Operational',
    label: 'Boot skill', hint: "operator-selected replacement startup skill; core startup does not run first; 'none' restores /hermitd:resident-start",
    applies: 'next hermitd-start' },
  { arg: 'permissions', path: 'permission_mode', values: PERMISSION_MODE,
    group: 'Operational', label: 'Permission mode', hint: 'how much Claude Code asks before acting',
    applies: 'next hermitd-start' },
  { arg: 'push-notifications', path: 'push_notifications', group: 'Operational',
    label: 'Push notifications', hint: 'doorbell when no channel is reachable' },
  { arg: 'quality-gate', path: 'quality_gate.tier',
    group: 'Operational', label: 'Quality gate', hint: 'cleanup pass after an accepted-proposal build',
    tableExempt: true },
  { arg: 'skills-learning', path: 'skills.learning', group: 'Operational',
    label: 'Skill learning', hint: 'review reusable procedures at task close' },
  { arg: 'skills-notify', path: 'skills.notify', group: 'Operational',
    label: 'Skill notifications', hint: 'off, on, or verbose close replies' },
  { arg: 'reflection', path: 'reflection.graduation_min_sessions', group: 'Operational',
    label: 'Graduation threshold', hint: 'distinct sessions before a pattern becomes a proposal candidate',
    applies: 'next reflect run' },

  { arg: 'artifact-dashboard', path: 'artifacts.dashboard', group: 'Artifacts',
    label: 'Dashboard page', hint: 'status, proposal queue, weekly evolution',
    applies: 'next refresh' },
  { arg: 'artifact-proposals', path: 'artifacts.proposals', group: 'Artifacts',
    label: 'Proposals page', hint: 'full text of open proposals',
    applies: 'next refresh' },
  { arg: 'artifact-weekly-review', path: 'artifacts.weekly_review', group: 'Artifacts',
    label: 'Weekly-review page', hint: 'the compiled weekly report at a stable URL',
    applies: 'next refresh' },
  { arg: 'artifact-backend', path: 'artifacts.backend', group: 'Artifacts',
    label: 'Artifact backend', hint: "'claude', or the name of a connected MCP artifact server",
    applies: 'next refresh' },
];

export const SETTINGS: readonly Setting[] = ROWS.map(row => {
  const spec = specAt(row.path);
  if (!spec || !['string', 'boolean', 'number'].includes(spec.kind)) {
    throw new Error(`Setting ${row.arg} must name a scalar config table leaf: ${row.path}`);
  }
  const values = row.values ?? (spec.kind === 'string' ? spec.enum : undefined);
  const kind: Kind = values ? 'enum' : spec.kind === 'number' ? 'int' : spec.kind as 'string' | 'boolean';
  return { ...row, kind, values, nullable: 'nullable' in spec ? spec.nullable : false };
});

/** Read-only rows `show` renders but no argument sets. */
export const READ_ONLY: ReadonlyArray<{ path: string; group: Setting['group']; label: string }> = [
  { path: 'auto_session', group: 'Operational', label: 'Auto session' },
  { path: 'tmux_session_name', group: 'Operational', label: 'tmux name' },
];

export function byArg(arg: string): Setting | undefined {
  return SETTINGS.find(s => s.arg === arg);
}

/** The rows the skill's argument table is allowed to drive. */
export function tableSettings(): Setting[] {
  return SETTINGS.filter(s => !s.tableExempt);
}
