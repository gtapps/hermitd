#!/usr/bin/env bun
/**
 * Boot script for hermit autonomous sessions.
 *
 * Reads .hermit/config.json and starts Claude Code
 * in a tmux session with the configured channels and options.
 *
 * Usage:
 *     bun scripts/hermitd-start.ts              # from project root
 *     bun scripts/hermitd-start.ts --no-tmux    # run in current terminal
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { acquireLock, releaseLock } from './lib/lockfile';
import { foreignArtifactBackend, readConfigRaw } from './lib/config-read';
import { readJson } from './lib/cli';
import { auditConfigChange } from './lib/config-audit';
import { writeRuntimeJson, readRuntimeJson, readRuntimeState, STATE_DIR, RUNTIME_JSON, RUNTIME_TMP, LIFECYCLE_LOCK } from './lib/runtime';
import { localISOStamp } from './lib/time';
import { tmuxSessionAlive, getSessionName } from './lib/tmux';
import { AuthMode, claudeStateFile, defaultConfigDir, readTokenValue, resolveAuthMode, TOKEN_ENV_VAR } from './lib/setup-token';
import { residentLiveness, otherRuntimeLive, REAL_LIVENESS_DEPS } from './lib/resident-liveness';
import { isContainer } from './lib/container';
import { pyTruthy, isDict, iterChannelConfigs, getEnabledChannels, channelStateDirKey } from './lib/channel-config';
import { cmpSemver } from './lib/semver';
import { sanitizeLanguage } from './lib/operator-language';
import { outputStyleFor } from './lib/voice';
import { automodeAllowEntry, AUTOMODE_ENV_ENTRIES, AUTOMODE_SOFT_DENY_ENTRY, SEALED_SETTINGS_OPS } from './lib/settings/automode-entries';
import { overlayHooks } from './lib/settings/overlay-hooks';
import { registerProject } from './lib/host-registry';
import { writeFileAtomic } from './lib/md-write';
import { renderTemplate } from './lib/render-template';
import { transcriptDirFor } from './lib/cc-compat';

type Json = any;

const CONFIG_PATH = '.hermit/config.json';
const PROFILE_LEVELS: Record<string, number> = { minimal: 0, standard: 1, strict: 2 };

/**
 * Which launch this is. Decided once at `main()` from the tmux flag and tmux's
 * availability, and passed down rather than re-derived — `config.always_on` is
 * not written until much later in the boot, so anything reading that flag to
 * decide launch behavior gets last boot's answer on a first run.
 */
type BootMode = 'interactive' | 'tmux';

/**
 * The hook profile a launch gets when nobody has said otherwise.
 *
 * A managed (tmux) hermit runs unattended, so it defaults to `strict` — the
 * tighter setting for the hooks that read the profile (the dev hermit's
 * git-push-guard), and it is what a Docker hermit has always had via its
 * compose environment block. An interactive launch stays `standard`: the
 * operator is present. The profile no longer gates any permission rule — the
 * config.json / OPERATOR.md / settings guards are native `permissions.deny` /
 * `permissions.ask` entries seeded once at hatch, and those reach every
 * session regardless of profile.
 */
function defaultProfileFor(bootMode: BootMode): string {
  return bootMode === 'tmux' ? 'strict' : 'standard';
}

/**
 * Resolve the hook profile for this launch, and say where it came from.
 *
 * Precedence is ambient > config > mode default. Ambient wins because it is the
 * deployment speaking (Docker's compose block, or an operator's one-off
 * `AGENT_HOOK_PROFILE=… hermitd-start`), which is more specific than a value
 * committed to config.json.
 *
 * Every source is validated and floored the same way. That is a change: the old
 * code computed a profile, then only wrote it to `process.env` when nothing was
 * already there — so an ambient `minimal`, or an ambient typo, bypassed both the
 * validation and the "non-negotiable" always-on floor entirely and became what
 * the session actually ran at. An invalid value falls back to the mode default
 * rather than the global one, so a garbled managed launch fails safe (strict)
 * instead of quietly weakening itself.
 */
function resolveHookProfile(
  config: Json,
  bootMode: BootMode,
): { profile: string; source: 'ambient' | 'config' | 'default'; warning: string | null } {
  const fallback = defaultProfileFor(bootMode);
  const ambient = process.env.AGENT_HOOK_PROFILE;
  const configured = (config?.env ?? {}).AGENT_HOOK_PROFILE;

  let source: 'ambient' | 'config' | 'default' = 'default';
  let raw: unknown = undefined;
  if (ambient !== undefined && ambient !== '') {
    source = 'ambient';
    raw = ambient;
  } else if (configured !== undefined && configured !== null && configured !== '') {
    source = 'config';
    raw = configured;
  }

  let warning: string | null = null;
  let profile = fallback;
  if (source !== 'default') {
    // Normalized the way the hooks themselves read it (hook-input.ts
    // hookProfile()), so an ambient `Strict` resolves to strict rather than
    // being rejected as invalid and silently demoted to the mode default. A
    // non-string config value has no normalized form and so falls through to
    // the warning, rather than being mislabelled as the mode default.
    const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (normalized in PROFILE_LEVELS) {
      profile = normalized;
    } else {
      warning = `[hermit] Warning: invalid AGENT_HOOK_PROFILE=${String(raw)} from ${source}, using ${fallback}`;
      source = 'default';
    }
  }

  // The always-on floor, applied to every source rather than only to config.
  if (bootMode === 'tmux') {
    const floor = 'standard'; // non-negotiable minimum for a managed session
    if (PROFILE_LEVELS[profile] < PROFILE_LEVELS[floor]) {
      warning = `[hermit] Warning: AGENT_HOOK_PROFILE=${profile} below always-on floor, forcing to ${floor}`;
      profile = floor;
    }
  }

  return { profile, source, warning };
}

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');

const DEFAULT_CONFIG: Json = {
  _hermit_versions: {},
  agent_name: null,
  language: null,
  timezone: null,
  escalation: 'balanced',
  operator_profile: 'technical',
  voice: { style: null, prose: null },
  channels: {},
  remote: true,
  auth_mode: null,
  model: 'sonnet',
  effort: null,
  permission_mode: 'auto',
  tmux_session_name: 'hermit-{project_name}',
  auto_session: true,
  always_on: false,
  chrome: false,
  push_notifications: true,
  ask_gate: true,
  routine_max_lateness_minutes: 60,
  routines: [
    { id: 'heartbeat-restart', schedule: '0 4 * * *', skill: 'hermitd:hermit-routines load', enabled: true },
    { id: 'reflect', schedule: '0 9 * * *', skill: 'hermitd:reflect', enabled: true },
    { id: 'weekly-review', schedule: '0 23 * * 0', skill: 'hermitd:weekly-review', enabled: true },
    { id: 'doctor', schedule: '10 9 * * 1', skill: 'hermitd:hermit-doctor --maintainer', model: 'haiku', enabled: true, precheck: 'doctor', precheck_timeout_s: 120 },
  ],
  monitors: [],
  // No AGENT_HOOK_PROFILE here, and none in config.json.template either. Its
  // absence is the signal that the operator has expressed no preference, which
  // is what lets writeSettingsEnv default a managed launch to `strict`. Seeding
  // it would make every hermit look like it had chosen `standard` deliberately.
  env: {
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '65',
    MAX_THINKING_TOKENS: '10000',
  },
  boot_skill: null,
  shutdown_skill: null,
  scheduled_checks: [],
  docker: {
    packages: [],
    recommended_plugins: [],
    fleet_mesh: false,
  },
  tasks: {
    handle_in_dm: false,
    duties_open_records: true,
    queue_nudge_minutes: 60,
  },
  heartbeat: {
    enabled: true,
    every: '30m',
    active_hours: {
      start: '08:00',
      end: '23:00',
    },
    stale_threshold: '2h',
    waiting_timeout: null,
    clean_recheck_cooldown: '6h',
    model: 'sonnet',
  },
  quality_gate: {
    tier: 'budget',
  },
  knowledge: {
    raw_retention_days: 14,
    compiled_budget_chars: 2500,
    working_set_warn: 20,
    usage_stale_days: 30,
    usage_auto_archive: true,
    archive_retention_days: null,
    channel_log_enabled: true,
    channel_log_retention_days: 90,
  },
  // wedge_floor and scheduler_enabled are deliberately template-only, not part of
  // this boot merge: the always-on branch writes the merged config back to disk,
  // and stamping the defaults there on a restart would look like operator-set
  // values (wedge_floor to the upgrade that derives it; scheduler_enabled would
  // freeze the default against future changes). The watchdog and the boot
  // auto-install gate read them through lib/config-read, which supplies the same
  // defaults.
  watchdog: {
    enabled: false,
    stale_factor: 2,
    escalate_after: 3,
    operator_grace: '15m',
  },
  budget: {
    daily_usd: null,
    weekly_usd: null,
    monthly_usd: null,
    action: 'alert',
  },
  telemetry_export: {
    _note: 'Operator-directed health/cost export to your own webhook. Inert until you set destination.url. Never sent to plugin authors.',
    enabled: false,
    destination: { type: 'webhook', url: null, bearer_env: 'HERMIT_TELEMETRY_TOKEN' },
    interval_hours: 24,
    redact_operator_text: true,
  },
  backup: {
    _note: 'Scheduled git snapshot of this hermit\'s own state. Inert until you run `bin/hermitd-run backup setup` from a terminal.',
    enabled: false,
    mode: 'workspace',
    schedule: '0 3 * * *',
    remote: null,
    push: true,
    include: [],
  },
  artifacts: {
    dashboard: true,
    proposals: true,
    weekly_review: false,
    publish_authorized: null,
    backend: 'claude',
  },
  context_hygiene: {
    clear: { enabled: true, quiet: '1h', max_age: '24h', min_tokens: 20000 },
    compact: {
      enabled: true,
      min_context_tokens: 100000,
      min_interval: '4h',
    },
  },
  reflection: {
    graduation_min_sessions: 1,
  },
  routine_wake_lint: {
    max_windows: 6,
  },
  doctor: {
    routine_cost_floor_usd: 2,
  },
  storage_drift: {
    ignore: [],
  },
};

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

/** Python shlex.quote: safe chars pass through, everything else single-quoted. */
function shlexQuote(s: string): string {
  if (s === '') return "''";
  if (!/[^A-Za-z0-9_@%+=:,./-]/.test(s)) return s;
  return "'" + s.replaceAll("'", "'\"'\"'") + "'";
}

/** Join args into a shell-safe string using shlexQuote. */
function shlexJoin(args: string[]): string {
  return args.map(shlexQuote).join(' ');
}

/** True when config.json exists but could not be parsed — gates the write-back. */
let configReadFailed = false;

/** Load config.json or return defaults. */
function loadConfig(): Json {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log(`[hermit] No config found at ${CONFIG_PATH}`);
    console.log('[hermit] Run /hermitd:hatch inside Claude Code first.');
    process.exit(1);
  }

  // Malformed JSON no longer aborts the boot: fail open to the defaults merge
  // below (validate-config and doctor surface the corruption). The always-on
  // branch writes config.json back, so record the failure — writing the merged
  // defaults over an unparseable file would destroy the operator's config.
  const raw = readConfigRaw(path.dirname(CONFIG_PATH));
  configReadFailed = raw === null;
  const config: Json = raw ?? {};

  // Merge with defaults — shallow for top-level, deep for nested dicts.
  // This boot-time merge deliberately SEEDS containers (routines, env) for
  // sparse configs — different from lib/config-read's read-path settling,
  // which settles missing containers to empty.
  // Values in config may be null (JSON null), so fall back to {} for spreading.
  const merged: Json = { ...DEFAULT_CONFIG, ...config };
  for (const [key, def] of Object.entries(DEFAULT_CONFIG)) {
    if (isDict(def)) {
      merged[key] = { ...(def as Json), ...(config[key] || {}) };
    }
  }
  // One more level for heartbeat.active_hours
  if ('active_hours' in (DEFAULT_CONFIG.heartbeat ?? {})) {
    const mergedHb = merged.heartbeat ?? {};
    mergedHb.active_hours = {
      ...DEFAULT_CONFIG.heartbeat.active_hours,
      ...((config.heartbeat || {}).active_hours || {}),
    };
    merged.heartbeat = mergedHb;
  }
  return merged;
}

// One-way ratchet: an always-on boot upgrades template-default doctor fields.
// Only exact known defaults move forward; operator-customized schedules and
// skill arguments are left alone. Does not downgrade the schedule on stop; a
// box that reverts to interactive keeps daily doctor, which is harmless.
//
// The set has three entries, not one, because it must recognize schedules from
// every prior template generation: '0 10 * * 1' is the pre-clustering weekly
// default, '10 9 * * 1' is the current (clustered) weekly default, and
// '0 10 * * *' is what THIS ratchet itself already wrote for any hermit that
// went always-on before clustering shipped — those live fleet hermits are the
// primary reason for the entry, since without it they'd read as "custom" and
// never pick up the clustered daily schedule (the CHANGELOG's evolve-time
// migration is the primary path for already-installed hermits; this ratchet is
// the deterministic backstop for installs that skip that step, or that switch
// from interactive to always-on later).
const KNOWN_DEFAULT_SCHEDULES = ['0 10 * * 1', '10 9 * * 1', '0 10 * * *'];
const DOCTOR_DAILY_SCHEDULE = '10 9 * * *';
const LEGACY_DOCTOR_SKILL = 'hermitd:hermit-doctor';
const MAINTAINER_DOCTOR_SKILL = 'hermitd:hermit-doctor --maintainer';

function applyAlwaysOnDoctorSchedule(config: Json): void {
  const routine = Array.isArray(config.routines)
    ? config.routines.find((r: Json) => r?.id === 'doctor')
    : null;
  if (routine && KNOWN_DEFAULT_SCHEDULES.includes(routine.schedule)) {
    routine.schedule = DOCTOR_DAILY_SCHEDULE;
  }
  if (routine?.skill === LEGACY_DOCTOR_SKILL) {
    routine.skill = MAINTAINER_DOCTOR_SKILL;
  }
}

/** Print a notice when the loaded plugin and the applied config stamp disagree.
 *  Which way they disagree decides the remedy, so the direction is compared, never
 *  just equality: plugin newer means an upgrade is pending, plugin OLDER means this
 *  boot resolved a stale copy and evolve is the wrong tool (it would no-op, or
 *  downgrade the applied stamp). Unparseable either side stays silent.
 *
 *  The remedy differs from check-upgrade.sh's on purpose: that one runs from the
 *  SessionStart hook against the installed plugin (a `claude plugin list` entry), while
 *  bin/hermitd-run resolves PLUGIN_ROOT by scanning the marketplace clone, which never
 *  appears in that listing — so this surface points at the marketplace refresh. */
function checkForUpgrade(config: Json): void {
  const pluginJson = path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json');
  try {
    const pluginVer = JSON.parse(fs.readFileSync(pluginJson, 'utf-8')).version ?? '0.0.0';
    const configVer = (config._hermit_versions ?? {})['hermitd'] ?? '0.0.0';
    const rel = cmpSemver(pluginVer, configVer);
    if (rel > 0) {
      console.log(`[hermit] Upgrade available: v${configVer} -> v${pluginVer}`);
      console.log('[hermit] Run /hermitd:hermit-evolve inside Claude Code');
    } else if (rel < 0) {
      console.log(`[hermit] Stale plugin runtime: boot scripts loaded v${pluginVer} from ${PLUGIN_ROOT},`);
      console.log(`[hermit] older than this hermit's applied state v${configVer}. hermit-evolve cannot fix this.`);
      console.log('[hermit] Run: claude plugin marketplace update hermitd');
    }
  } catch {}
}

/** Parse up to the first three dot-separated version parts as integers (null on garbage). */
function parseVersionTuple(v: string): number[] | null {
  const nums: number[] = [];
  for (const p of v.split('.').slice(0, 3)) {
    if (!/^\d+$/.test(p.trim())) return null; // Python int() would raise ValueError
    nums.push(parseInt(p, 10));
  }
  return nums;
}

/** Python tuple comparison: element-wise, shorter prefix sorts first. */
function versionLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a.length < b.length;
}

/** Check that required tools are available. */
function checkPrerequisites(): Json {
  const errors: string[] = [];

  // PATH, not a missing install, is the usual culprit here: a watchdog systemd
  // unit baked before the Environment=PATH fix starts us with a near-empty PATH,
  // so both probes below miss tools that are demonstrably present.

  // Claude Code
  if (!Bun.which('claude')) {
    errors.push(
      'claude: Claude Code CLI not on PATH. Install from https://claude.ai/download, ' +
        'or re-run `hermitd watchdog install` if this started from a systemd unit.',
    );
  }

  // tmux (optional but recommended)
  const hasTmux = Bun.which('tmux') !== null;

  // bun (required runtime for hooks/scripts since the bun migration)
  const hasBun = Bun.which('bun') !== null;
  if (!hasBun) {
    errors.push(
      'bun: required runtime not on PATH. Install with `curl -fsSL https://bun.sh/install | bash`, ' +
        'or re-run `hermitd watchdog install` if this started from a systemd unit.',
    );
  } else {
    // Already running under bun, so Bun.version is a free in-process probe.
    const bunVersion = Bun.version.trim();
    let required = '1.3.0';
    try {
      const metaPath = path.join(PLUGIN_ROOT, '.claude-plugin', 'hermit-meta.json');
      const declared = JSON.parse(fs.readFileSync(metaPath, 'utf-8')).required_bun_version;
      if (pyTruthy(declared)) required = String(declared).replace(/^[>=]+/, '').trim();
    } catch {} // unreadable meta — fall back to the baseline floor
    const cur = parseVersionTuple(bunVersion);
    const req = parseVersionTuple(required);
    // unparseable version — don't block boot on the probe itself
    if (cur && req && versionLess(cur, req)) {
      errors.push(`bun: version ${bunVersion} below required ${required}. Upgrade: bun upgrade`);
    }
  }

  if (errors.length) {
    for (const err of errors) console.log(`[hermit] ERROR: ${err}`);
    process.exit(1);
  }

  return { tmux: hasTmux, bun: hasBun };
}

/** Check for stale runtime state from a previous run and warn. */
function checkStaleRuntime(config: Json, sessionName: string): void {
  const runtime = readRuntimeJson();
  if (runtime === null) return;

  const mode = runtime.runtime_mode;
  const shutdownCompleted = runtime.shutdown_completed_at;

  if (!shutdownCompleted) {
    if (mode === 'tmux' || mode === 'docker') {
      // Check if the tmux session from the previous run still exists
      const prevTmux = 'tmux_session' in runtime ? runtime.tmux_session : '';
      const verdict = residentLiveness(runtime, prevTmux, REAL_LIVENESS_DEPS());
      if (verdict.state === 'dead' || verdict.state === 'orphan') {
        console.log(
          `[hermit] Warning: Previous session crashed (tmux session "${prevTmux}" is gone).`,
        );
        console.log('[hermit] /resident-start will offer recovery.');
        runtime.last_error = 'unclean_shutdown';
        writeRuntimeJson(runtime);
      }
    } else if (mode === 'interactive' && readJson(path.join(STATE_DIR, 'execution.json'))?.state === 'in_flight') {
      // Interactive exits never stamp shutdown_completed_at; only a turn left running is unclean.
      console.log('[hermit] Warning: Previous interactive session ended during a turn.');
      console.log('[hermit] /resident-start will offer recovery.');
      runtime.last_error = 'unclean_shutdown';
      writeRuntimeJson(runtime);
    }
  }

  if (runtime.last_error === 'session_died_on_boot') {
    console.log('[hermit] Note: previous start failed (tmux session died on boot).');
  }

  // Check for interrupted transitions
  const transition = runtime.transition;
  if (pyTruthy(transition)) {
    const target = 'transition_target' in runtime ? runtime.transition_target : 'unknown';
    console.log(`[hermit] Warning: Interrupted transition detected: ${transition} (target: ${target})`);
    console.log('[hermit] /resident-start will resume or clean up.');
  }
}

/**
 * Clears shutdown_requested_at/shutdown_completed_at on an existing runtime.json
 * before a fresh hermitd-start boot. A deliberate start supersedes any prior
 * shutdown intent. Mutates `existing` in place.
 */
function clearShutdownStampsOnBoot(existing: Json): void {
  existing.shutdown_requested_at = null;
  existing.shutdown_completed_at = null;
}

/**
 * Stamps a fresh per-process nonce at state/.boot-id on every boot.
 * `routines.ts cron-registry` (the hermit-routines diff planner) compares this against the
 * boot_id stored in its state/cron-registry.json mirror: a mismatch means the
 * mirror describes a prior process's CronCreates, which durable:false already
 * killed on exit, so the planner treats every enabled routine as CREATE with no
 * matching DELETE (nothing live to tear down). Written unconditionally, before
 * hermit-routines load's first run, so the very first load after boot always
 * sees a mismatch and does a full (and correct) re-registration.
 */
function writeBootId(): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, '.boot-id'), randomUUID() + '\n');
  } catch {}
}

/** Acquire exclusive lifecycle lock. Exits on contention. */
function acquireLifecycleLock(): void {
  if (process.platform === 'win32') {
    console.log('[hermit] Always-on mode requires Linux, macOS, or WSL2. See https://github.com/gtapps/hermitd/blob/main/plugins/hermitd/docs/faq.md.');
    process.exit(1);
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (!acquireLock(LIFECYCLE_LOCK)) {
    console.log('[hermit] Another lifecycle operation in progress. Aborting.');
    process.exit(1);
  }
  // The Python flock released automatically on process death (and on exec,
  // via O_CLOEXEC). The link-based lock needs an explicit unlink — release
  // it on every exit path, including the process.exit() calls sprinkled
  // through boot.
  process.on('exit', () => releaseLock(LIFECYCLE_LOCK));
}

const CHANNEL_PLUGINS: Record<string, string> = {
  discord: 'plugin:discord@claude-plugins-official',
  telegram: 'plugin:telegram@claude-plugins-official',
  imessage: 'plugin:imessage@claude-plugins-official',
};

/**
 * Return registered marketplaces as [{name: string, repo: string|null}, ...].
 *
 * Returns null when the call fails or the output is unrecognized — caller
 * must treat null as "skip pre-flight" (fail-soft). A returned list (even
 * empty) means the check ran and is authoritative.
 */
function fetchRegisteredMarketplaces(): Json[] | null {
  try {
    const result = spawnSync('claude', ['plugin', 'marketplace', 'list', '--json'], {
      timeout: 10_000,
      encoding: 'utf-8',
    });
    if (result.status !== 0) return null;
    const data = JSON.parse(result.stdout);
    if (!Array.isArray(data)) return null;
    const entries: Json[] = [];
    for (const item of data) {
      if (isDict(item) && typeof item.name === 'string') {
        entries.push({
          name: item.name,
          repo: typeof item.repo === 'string' ? item.repo : null,
        });
      }
    }
    return entries;
  } catch {
    return null;
  }
}

/** Resolve a state_dir path (absolute pass-through, relative against cwd). */
function resolveStateDir(stateDir: string): string {
  return path.isAbsolute(stateDir) ? stateDir : path.join(process.cwd(), stateDir);
}

/** A channel's configured state_dir, or the conventional default. */
function channelStateDir(name: string, cfg: Json): string {
  return pyTruthy(cfg.state_dir) ? cfg.state_dir : path.join('.claude.local', 'channels', name);
}

/** Read one line from stdin (Python input(): prompt to stdout, EOF → ''). */
function inputLine(promptText: string): string {
  process.stdout.write(promptText);
  const buf = Buffer.alloc(1);
  let line = '';
  try {
    while (true) {
      const n = fs.readSync(0, buf, 0, 1, null);
      if (n === 0) break; // EOF
      const ch = buf.toString('utf-8', 0, n);
      if (ch === '\n') break;
      line += ch;
    }
  } catch {
    return ''; // unreadable stdin — Python raises EOFError, caller used ''
  }
  return line;
}

/**
 * The peer name requested via --name: safe for an `@` mention, no quoting
 * needed. This is what we ASK Claude Code to register, computed before the
 * session exists — a collision with a live session of the same name gets
 * silently renamed by Claude Code, which this can't observe or correct.
 *
 * An `agent_name` with no ASCII alphanumerics at all ("ロボ", "🤖") sanitizes to
 * the empty string, so the tmux-session fallback is keyed on the sanitized
 * result, not on `agent_name` being unset — otherwise `--remote-control` would
 * be launched with an empty name. `hermit` is the last resort for the same
 * reason, since `tmux_session_name` is operator-editable and can sanitize away too.
 */
function sanitizePeerName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}

function peerName(config: Json): string {
  return sanitizePeerName(String(config.agent_name ?? ''))
    || sanitizePeerName(getSessionName(config))
    || 'hermit';
}

/** Absolute path to a file in the hermit dir. Resolved per call, not at import:
 *  STATE_DIR is cwd-relative and the boot's cwd is the project root. */
function hermitFile(name: string): string {
  return path.resolve(path.dirname(STATE_DIR), name);
}

function requireResident(): void {
  try {
    fs.readFileSync(hermitFile('RESIDENT.md'), 'utf8');
  } catch {
    console.log('[hermit] RESIDENT.md not found. Run `claude` in this project and ask it to run /hermitd:hermit-evolve, then start again.');
    writeRuntimeJson({ ...(readRuntimeJson() ?? {}), last_start_error: 'resident-missing' });
    process.exit(1);
  }
}

function writeHelperSystemPrompt(residentName: string): void {
  const rendered = renderTemplate(
    fs.readFileSync(path.join(PLUGIN_ROOT, 'state-templates', 'helper-system-prompt.md.template'), 'utf8'),
    {
      PROJECT_ROOT: hermitFile('..'),
      RESIDENT_NAME: residentName,
    },
  );
  writeFileAtomic(path.resolve(STATE_DIR, 'helper-system-prompt.md'), rendered);
}

/** Build the claude launch command from config. */
function buildClaudeCommand(config: Json, tools: Json, opts?: { resume?: string }): string[] {
  const cmd = ['claude'];

  let enabledChannels = getEnabledChannels(config);
  if (enabledChannels.length) {
    // Bun is required for all channel plugins.
    if (!pyTruthy(tools.bun)) {
      const names = enabledChannels.join(', ');
      console.log(`[hermit] WARNING: channels skipped (${names}) — bun is not installed.`);
      console.log('[hermit]   Install bun: https://bun.sh');
      console.log('[hermit]   Then run /hermitd:channel-setup to activate.');
      enabledChannels = [];
    }

    const activeChannels: string[] = [];
    for (const [channel, chCfg] of iterChannelConfigs(config)) {
      if (!enabledChannels.includes(channel)) continue;

      // Warn if the token file is missing — still add the channel so the
      // plugin can surface its own auth error.
      const stateDir = channelStateDir(channel, chCfg);
      if (!fs.existsSync(path.join(resolveStateDir(stateDir), '.env'))) {
        console.log(`[hermit] WARNING: channel "${channel}" has no token configured.`);
        console.log('[hermit]   Run /hermitd:channel-setup to add it.');
      }

      activeChannels.push(channel);
    }

    if (activeChannels.length) {
      const channelCfgs: Json = Object.fromEntries(iterChannelConfigs(config));
      const registered = fetchRegisteredMarketplaces(); // null = skip pre-flight
      const registeredNames = new Set((registered ?? []).map((e: Json) => e.name));

      const channelArgs: string[] = [];
      for (const channel of activeChannels) {
        let pluginId: string | undefined = CHANNEL_PLUGINS[channel];
        if (!pluginId) {
          // Fall back to channels.<name>.marketplace for third-party channel
          // plugins (custom marketplaces, forks, operator-built channels).
          const marketplace = (channelCfgs[channel] ?? {}).marketplace;
          if (pyTruthy(marketplace)) {
            pluginId = `plugin:${channel}@${marketplace}`;
          }
        }

        if (pluginId) {
          if (registered !== null) {
            const at = pluginId.indexOf('@');
            const marketplaceName = at !== -1 ? pluginId.slice(at + 1) : '';
            if (at !== -1 && marketplaceName) {
              if (!registeredNames.has(marketplaceName)) {
                const repoMatch = registered.find((e: Json) => e.repo === marketplaceName) ?? null;
                if (repoMatch) {
                  console.log(
                    `[hermit] WARNING: channel "${channel}" — "${marketplaceName}" is a repo path, not a marketplace name.`,
                  );
                  console.log(`[hermit]   That repo IS registered as "${repoMatch.name}".`);
                  console.log(
                    `[hermit]   Fix: set channels.${channel}.marketplace = "${repoMatch.name}" in config.json`,
                  );
                } else {
                  console.log(
                    `[hermit] WARNING: channel "${channel}" — marketplace "${marketplaceName}" is not registered with claude.`,
                  );
                  console.log('[hermit]   Fix: claude plugin install <plugin> --marketplace <repo> --scope local');
                }
                console.log(
                  `[hermit]   Dropping "${channel}" from --channels to avoid silent boot with no channels active.`,
                );
                continue;
              }
            }
          }
          channelArgs.push(pluginId);
        } else {
          if (channel.startsWith('-')) {
            console.log(
              `[hermit] WARNING: channel "${channel}" starts with "-" — refusing to pass as a bare arg (looks like a CLI flag).`,
            );
            continue;
          }
          console.log(
            `[hermit] WARNING: unrecognized channel "${channel}" — expected discord, telegram, or imessage (or set channels.${channel}.marketplace in config.json)`,
          );
          channelArgs.push(channel);
        }
      }

      if (channelArgs.length) {
        cmd.push('--channels', ...channelArgs);
      }
    }
  }

  const name = peerName(config);

  // Add remote control for web/mobile access (with session name)
  if (pyTruthy('remote' in config ? config.remote : false)) {
    cmd.push('--remote-control', name);
  }

  if (name) {
    cmd.push('--name', name);
  }

  if (pyTruthy(config.chrome)) {
    if (isContainer()) {
      console.log('[hermit] WARNING: chrome=true ignored — browser not available in containers.');
    } else {
      cmd.push('--chrome');
    }
  }

  // The launch overlay carries resident safety gates as well as classifier policy.
  // A resident without its pause gate must not boot.
  const overlay = renderLaunchOverlay(config);
  if (!overlay) process.exit(1);
  writeHelperSystemPrompt(name);
  cmd.push('--settings', overlay);
  cmd.push('--append-system-prompt-file', hermitFile('RESIDENT.md'));

  if (pyTruthy(config.model)) {
    cmd.push('--model', config.model);
  }

  // Re-asserted on every boot for the same reason as --model: a runtime /effort writes
  // through to the user-scope settings default ("saved as your default for new
  // sessions"), and the boot flag outranks it — so a channel-requested effort change
  // reverts on restart instead of silently becoming permanent. NOT the same lever as
  // config.env.CLAUDE_CODE_EFFORT_LEVEL, which pins the session and would make a
  // runtime /effort a no-op (see the how-to-use guide).
  if (pyTruthy(config.effort)) {
    cmd.push('--effort', config.effort);
  }

  const mode = 'permission_mode' in config ? config.permission_mode : 'auto';
  if (mode === 'bypassPermissions') {
    if (!isContainer()) {
      console.log('[hermit] WARNING: bypassPermissions is intended for containers/VMs only.');
      console.log('[hermit] You appear to be running on a host machine.');
      const answer = inputLine('[hermit] Continue anyway? [y/N] ').trim().toLowerCase();
      if (answer !== 'y') {
        console.log('[hermit] Aborted. Change permission_mode in config.json or use a container.');
        process.exit(1);
      }
    }
    cmd.push('--dangerously-skip-permissions');
  } else if (['acceptEdits', 'plan', 'dontAsk', 'auto'].includes(mode)) {
    cmd.push('--permission-mode', mode);
  } else if (mode !== 'default' && mode !== null) {
    console.log(`[hermit] WARNING: unknown permission_mode "${mode}" — skipping (using default)`);
  }

  if (opts?.resume) cmd.push('--resume', opts.resume, '--fork-session');
  return cmd;
}

/**
 * Write config env vars to .claude/settings.local.json.
 *
 * Claude Code reads the `env` key from settings.json and exports those
 * values to hooks and Bash tool calls. It does NOT reach plugin MCP servers
 * (anthropics/claude-code#11927, open), so anything a channel plugin needs is
 * also hydrated into process.env here — see the channel loop below.
 *
 * Auth vars (ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR) are NOT written here —
 * they must be in the shell env before claude launches. OAuth credentials
 * live in .credentials.json (written by `claude /login`).
 */
/**
 * Returns the resolved hook profile so the caller can report it. Returned rather
 * than stashed in a module variable: the launch banner is printed before this
 * runs, so a side-channel global is read while still unset and the line never
 * appears.
 */
function resolveHermitEnv(config: Json): Record<string, string> {
  const env = { ...(config.env ?? {}) };
  delete env.AGENT_HOOK_PROFILE;
  for (const [chName, chCfg] of iterChannelConfigs(config)) {
    const key = channelStateDirKey(chName);
    if (!key) continue;
    env[key] = resolveStateDir(channelStateDir(chName, chCfg));
  }
  for (const key of Object.keys(env)) {
    env[key] = process.env[key] || env[key];
  }
  return env;
}

function writeSettingsEnv(
  config: Json,
  bootMode: BootMode = 'interactive',
): { profile: string; source: string } {
  const settingsPath = '.claude/settings.local.json';
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  // A file that exists but doesn't parse is NOT an empty file. Falling back to
  // {} and writing would rewrite it from scratch and destroy whatever the
  // operator has in it — including their own /config choices, which now live
  // alongside the keys this function writes. Suppress only the WRITE: the rest
  // of this function has process-scoped side effects (AGENT_HOOK_PROFILE and
  // every channel's *_STATE_DIR reach the session through process.env, not
  // through this file), and skipping those would silently drop the always-on
  // hook profile and leave channel MCP servers without a state dir.
  let settings: Json = {};
  let skipWrite = false;
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (!isDict(parsed)) throw new Error('not a JSON object');
      settings = parsed;
    } catch {
      console.log(
        `[hermit] WARNING: ${settingsPath} is not valid JSON — skipping boot settings write so the file is left intact. Fix or remove it, then restart.`,
      );
      skipWrite = true;
    }
  }

  const envVars = resolveHermitEnv(config);
  Object.assign(process.env, envVars);
  const resolved = resolveHookProfile(config, bootMode);
  if (resolved.warning) console.log(resolved.warning);
  process.env.AGENT_HOOK_PROFILE = resolved.profile;

  const removed: string[] = [];
  if (isDict(settings.env)) {
    for (const key of Object.keys(settings.env)) {
      if (key === 'AGENT_HOOK_PROFILE' || key in envVars || key.endsWith('_BOT_TOKEN')
        || (!configReadFailed && key.endsWith('_STATE_DIR'))) {
        delete settings.env[key];
        removed.push(key);
      }
    }
  }
  if ('language' in settings) {
    delete settings.language;
    removed.push('language');
  }
  const style = outputStyleFor(config.voice);
  if (style !== null && settings.outputStyle === style) {
    delete settings.outputStyle;
    removed.push('outputStyle');
  }
  if (removed.length) {
    console.log(`[hermit] Cleaned launch settings from settings.local.json: ${removed.join(', ')}`);
  }

  // hermitd-start does not own sandbox.enabled — that's a hatch/operator decision;
  // hermit-evolve migrates existing installs. Here we only strip the obsolete
  // enableWeakerNestedSandbox key that older versions wrote on container boot.
  let sandbox = settings.sandbox || {};
  if (!isDict(sandbox)) sandbox = {};
  delete sandbox.enableWeakerNestedSandbox;
  if (pyTruthy(sandbox)) {
    settings.sandbox = sandbox;
  } else {
    delete settings.sandbox;
  }

  // Cross-session inbox: the `accept` lives in the launch overlay
  // (renderLaunchOverlay), the only scope that can loosen this key — a
  // project/local file may tighten it, never lower strictness, so an `accept`
  // written here was silently inert. Clean up the one earlier boots wrote, but
  // leave an operator's own `hold`/`refuse`: that direction tightens, so it is a
  // live opt-out rather than our own leftover.
  if (settings.crossSessionInbound === 'accept') delete settings.crossSessionInbound;

  // Messages to a session on ANOTHER machine travel through Anthropic's servers;
  // same-machine peers never do. `remote` is this hermit's own switch for leaving
  // the box, so it decides here too — off means every cross-machine send needs the
  // operator's approval first, even under bypassPermissions. A `true` from any
  // settings scope applies, so this can tighten but never loosen.
  if (!pyTruthy('remote' in config ? config.remote : true)) settings.isolatePeerMachines = true;
  else delete settings.isolatePeerMachines;

  // Turn off `/auto-mode-setup`. Once auto mode has blocked a few actions and the
  // session still has no autoMode.environment entries, Claude Code offers to run it
  // in a dialog at the end of a turn — a modal on a session nobody is watching, which
  // blocks every inbound prompt until the watchdog restarts the hermit. Turning the
  // command off turns the offer off with it.
  //
  // Here rather than the launch overlay: only autoMode is barred from project scope,
  // so skillOverrides can live in the file boot already owns — and this file also
  // covers the sessions the overlay misses (a manual resume, a docker exec attach,
  // a guest session in the same directory), which meet the same dialog.
  //
  // Written only when absent. Nothing else writes this key (Claude Code sets it from
  // the /skills menu or an operator's own edit), so a value here is a deliberate one,
  // and since no settings scope outranks this file it is the operator's only way back
  // to the command.
  let skillOverrides = settings.skillOverrides || {};
  if (!isDict(skillOverrides)) skillOverrides = {};
  if (!('auto-mode-setup' in skillOverrides)) skillOverrides['auto-mode-setup'] = 'off';
  settings.skillOverrides = skillOverrides;

  // Malformed file — warned above, left byte-for-byte intact. The profile is
  // still resolved and exported, so a bad settings file cannot silently drop the
  // session to a weaker set of deny patterns.
  if (skipWrite) return { profile: resolved.profile, source: resolved.source };

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  if (pyTruthy(envVars)) {
    console.log(`[hermit] Env: ${Object.keys(envVars).length} vars exported to the resident process`);
  }

  // Narrowed to the declared shape: `warning` is already consumed above, and
  // handing it back would let a caller print it a second time.
  return { profile: resolved.profile, source: resolved.source };
}

const ARTIFACT_LOCAL_SETTINGS = '.claude/settings.local.json';

/**
 * Every settings file the plugin can have put the grant in. `hatch` writes the file
 * its target names, and the allow path below re-ensures the local file on every boot,
 * so a committed-target install ends up carrying the entry in both and a decline has
 * to clear both. An unstamped target leaves the committed file alone: that entry's
 * provenance is unknown, which is why a `null` flag preserves what it finds too.
 */
function artifactRevokeTargets(): string[] {
  const opts = readJson(path.join(STATE_DIR, 'hatch-options.json'));
  return opts?.target === 'committed'
    ? ['.claude/settings.json', ARTIFACT_LOCAL_SETTINGS]
    : [ARTIFACT_LOCAL_SETTINGS];
}

/**
 * Boot-time artifact publish grant. Runs pre-launch in the operator's shell —
 * outside any Claude session, so the auto-mode classifier is not in play. This
 * is the out-of-session executor for the decision a channel reply recorded in
 * config.artifacts.publish_authorized (a channel reply may only flip hermit
 * config, never permissions — this is where the permission write happens).
 * Idempotent and self-healing: sealed set-merges, re-ensured every boot.
 *
 * Scoped to the default backend. What it grants is the native Artifact tool —
 * exactly the tool a hermit on a non-claude artifacts.backend must never call
 * (the artifacts doc's § Non-claude backend deviations forbids that fallback).
 * A standing grant there would pre-approve, prompt-free, the one publish the
 * operator configured a backend to prevent.
 */
function applyArtifactGrant(config: Json): void {
  const revoke = config.artifacts?.publish_authorized === false;
  if (!revoke && !artifactGrantApplies(config)) return;
  const op = revoke ? 'artifact-revoke' : 'artifact-allow';
  const targets = revoke ? artifactRevokeTargets() : [ARTIFACT_LOCAL_SETTINGS];
  const script = path.join(PLUGIN_ROOT, 'scripts', 'apply-settings.ts');
  for (const target of targets) {
    // A declined hermit reaches this on every boot for the rest of its life, and the
    // steady state after the first removal is nothing to do. Checking here keeps that
    // boot free; it also makes the run's own receipt redundant, since an exit 0 on a
    // file that carried the entry removed it.
    if (revoke && readJson(target)?.permissions?.allow?.includes('Artifact') !== true) continue;
    const r = spawnSync('bun', [script, target, op], { stdio: 'pipe', encoding: 'utf-8' });
    if (r.status !== 0) {
      console.log(`[hermit] WARNING: boot grant '${op}' failed: ${(r.stderr || '').trim()}; continuing boot.`);
      continue;
    }
    console.log(`[hermit] Artifact publish grant ${revoke ? 'removed' : 'ensured'} (permissions.allow in ${target})`);
  }
}

/**
 * Render config.voice into the settings key and (for a custom voice) the style
 * file, every boot.
 *
 * config.json is the truth and this is its render, the same relationship
 * config.env has with the settings env block — so an operator who changed their
 * voice from a chat gets it applied at the next restart with nothing else to run.
 * The op no-ops when `voice.style` is unset, which is what leaves an operator's
 * own /config pick alone on an install that never answered the voice question.
 *
 * Runs as a plain OS process before the session exists, so it is outside the
 * auto-mode classifier entirely — the same property applyArtifactGrant relies on.
 */
function applyVoiceRender(config: Json): void {
  // Gate in-process, like applyArtifactGrant does: an unset voice.style is a
  // no-op in the op anyway, and most installs never answer the voice question —
  // no reason to pay a bun startup and a second config read to learn that on
  // every boot. The gate asks the shared resolver, so there is still exactly one
  // place that decides what a voice block means.
  const style = outputStyleFor(config.voice);
  if (style === null) return;
  // The `outputStyle` key itself now rides the launch overlay (renderLaunchOverlay),
  // so the op has work left only for `custom`, where it renders the style file the
  // key points at. A built-in style needs no subprocess to reach the session.
  if (config.voice?.style !== 'custom') {
    console.log(`[hermit] Voice: outputStyle ${style} in the launch overlay`);
    return;
  }
  const script = path.join(PLUGIN_ROOT, 'scripts', 'apply-settings.ts');
  const r = spawnSync('bun', [script, '.claude/settings.local.json', 'voice-render'], { stdio: 'pipe', encoding: 'utf-8' });
  if (r.status !== 0) {
    console.log(`[hermit] WARNING: voice render failed: ${(r.stderr || '').trim()} — continuing boot.`);
    return;
  }
  const out = (r.stdout || '').trim();
  if (out.startsWith('applied:')) {
    console.log(`[hermit] Voice: outputStyle ${out.slice('applied:'.length)} in the launch overlay, style file rendered`);
  }
}

/**
 * Does the artifact publish grant apply — a page enabled, explicit
 * authorization, and the default/claude backend?
 *
 * Gates applyArtifactGrant's boot-time permission write, and nothing else.
 */
function artifactGrantApplies(config: Json): boolean {
  const artifacts = isDict(config.artifacts) ? config.artifacts : {};
  const anyPage = ['dashboard', 'proposals', 'weekly_review'].some((k) => pyTruthy(artifacts[k]));
  if (!anyPage || artifacts.publish_authorized !== true) return false;
  return foreignArtifactBackend(config) === null;
}

/**
 * True when the operator has set `crossSessionInbound` in their own user settings.
 * Unreadable or malformed counts as unset — the same fail-open the rest of boot
 * takes on a settings file it cannot parse.
 */
function userScopeSetsInbound(): boolean {
  try {
    const raw = fs.readFileSync(path.join(defaultConfigDir(), 'settings.json'), 'utf-8');
    return 'crossSessionInbound' in (JSON.parse(raw) ?? {});
  } catch {
    return false;
  }
}

/**
 * Render the per-session auto-mode classifier overlay and return its absolute
 * path (null when it could not be written — boot continues without it).
 *
 * Why a launch-time overlay rather than a settings file: since Claude Code
 * 2.1.207 the classifier reads autoMode only from user scope, managed
 * settings, or --settings. A project-local write is silently ignored
 * (anthropics/claude-code#87545), and a user-scope write would apply this
 * project's policy to every other Claude session on the machine — with no
 * cross-project locking, two hermits booting could also clobber each other's
 * merge. The overlay is per-hermit, rewritten from scratch every boot (so it
 * self-heals and never accumulates drift), and passed only to the session this
 * boot launches.
 *
 * Written via tmp + rename so a crash mid-write can never leave the launch
 * pointing at a half-written file.
 */
function renderLaunchOverlay(config: Json): string | null {
  const autoMode: Record<string, string[]> = {
    soft_deny: ['$defaults', AUTOMODE_SOFT_DENY_ENTRY],
  };
  // Unconditional, like the soft_deny above. Neither entry is about artifacts: the
  // environment list names the hermit's own notification domains and state directory,
  // and the allow entry covers apply-settings ops (permissions-plan, permissions-sync,
  // deny, channel-env) that hermit-evolve, hatch, channel-setup and docker-setup all
  // run on hermits that publish nothing. Gating them on the artifact grant left those
  // hermits with an empty environment list, which is both what draws classifier
  // denials on their own channel sends and the condition Claude Code offers
  // /auto-mode-setup on.
  //
  // One op is still gated: `artifact-allow` writes the native Artifact permission,
  // exactly the write applyArtifactGrant refuses on an unauthorized or non-claude
  // backend. Enumerating it unconditionally would pre-clear, prompt-free, the publish
  // an operator configured a backend (or a withheld publish_authorized) to prevent, so
  // it leaves the list where the grant does not apply and stays Self-Modification.
  const ops = artifactGrantApplies(config)
    ? SEALED_SETTINGS_OPS
    : SEALED_SETTINGS_OPS.filter((op) => op !== 'artifact-allow');
  autoMode.allow = ['$defaults', automodeAllowEntry(path.join(defaultConfigDir(), 'plugins'), PLUGIN_ROOT, ops)];
  autoMode.environment = ['$defaults', ...AUTOMODE_ENV_ENTRIES];
  // Cross-session inbox. Claude Code holds an inbound peer message purely on
  // permission class: a prompting receiver (auto/acceptEdits/dontAsk — the hermit
  // default) holds anything from a sender that identifies as bypassPermissions,
  // and a bypassPermissions receiver holds everything that doesn't. A held message
  // opens a dialog nobody is watching on an unattended hermit and is dropped when
  // it expires — including the watchdog's own socket wake. `accept` here is the
  // only scope that can reach it: project and local settings may only TIGHTEN
  // crossSessionInbound, while --settings sits directly below managed policy.
  //
  // Delivery is not authority — a peer message can't answer a permission prompt or
  // change configuration, so accepting one widens what the hermit reads, not what
  // it may do.
  //
  // An operator's own value in user settings wins: writing the key here would
  // silently override the hold or refuse they set for every session on the machine.
  // A project- or local-scope refuse still opts out, since that direction tightens.
  const overlay: Json = { autoMode, env: resolveHermitEnv(config), hooks: overlayHooks(PLUGIN_ROOT) };
  const style = outputStyleFor(config.voice);
  if (style !== null) overlay.outputStyle = style;
  const language = sanitizeLanguage(config.language);
  if (language) overlay.language = language;
  if (!userScopeSetsInbound()) overlay.crossSessionInbound = 'accept';

  const overridePath = hermitFile('claude-settings.json');
  if (fs.existsSync(overridePath)) {
    try {
      const override = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
      if (!isDict(override)) throw new Error('not a JSON object');
      const generated = { ...overlay };
      Object.assign(overlay, override, generated);
      overlay.env = { ...(isDict(override.env) ? override.env : {}), ...generated.env };
      let malformedHooks = false;
      if ('hooks' in override) {
        if (!isDict(override.hooks)) {
          malformedHooks = true;
        } else {
          for (const [event, entries] of Object.entries(override.hooks)) {
            if (!Array.isArray(entries)) {
              malformedHooks = true;
              continue;
            }
            overlay.hooks[event] = [...(generated.hooks[event] ?? []), ...entries];
          }
        }
      }
      if (malformedHooks) {
        console.log('[hermit] WARNING: claude-settings.json `hooks` is not an object of event arrays; ignoring the malformed operator hooks. Its other keys still applied.');
      }
      if (!('crossSessionInbound' in generated)) delete overlay.crossSessionInbound;
    } catch {
      console.log('[hermit] WARNING: claude-settings.json is not a valid JSON object; ignoring the operator override.');
    }
  }

  const file = path.resolve(STATE_DIR, 'claude-settings.overlay.json');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify(overlay, null, 2) + '\n');
    return file;
  } catch (e: any) {
    console.log(`[hermit] launch overlay not written (${e?.message ?? e}): refusing to start without pause-gate, ask-gate, component-privacy and permission-denied-notify`);
    return null;
  }
}

/** Seed once at boot. This is an unsynchronised read-modify-write of Claude Code's live
 *  per-user state, which every session on the machine shares and rewrites wholesale, so
 *  any write landing between the read and the rename is lost — a guest exit is only the
 *  nearest example, not the bound. Accepted because the early return below makes this
 *  write happen about once per project, and no in-session writer is added. */
function seedWorkspaceTrust(): void {
  const file = claudeStateFile();
  const project = process.cwd();
  try {
    let state: Json = {};
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (!isDict(state) || ('projects' in state && !isDict(state.projects))) {
      throw new Error('invalid Claude Code state');
    }
    const projects = state.projects ?? {};
    if (project in projects && !isDict(projects[project])) throw new Error('invalid project state');
    if (projects[project]?.hasTrustDialogAccepted === true) return;
    state.projects = { ...projects, [project]: { ...projects[project], hasTrustDialogAccepted: true } };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify(state, null, 2) + '\n');
  } catch (error: any) {
    console.log(`[hermit] WARNING: workspace trust not seeded (${error?.message ?? error}): continuing boot.`);
  }
}

/**
 * os.execvp replacement: Bun cannot replace the process image, so spawn the
 * command with inherited stdio and exit with its status. The lifecycle lock
 * is released first — Python's flock fd was O_CLOEXEC and released on exec.
 */
function execvp(cmd: string[]): never {
  releaseLock(LIFECYCLE_LOCK);
  const res = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit' });
  process.exit(res.status ?? 1);
}

/**
 * Export an installed setup-token into this process's environment.
 *
 * Both launch paths depend on this running first: the interactive execvp path
 * inherits process.env directly, and the tmux path copies forwardVars into the
 * env-file it sources. An already-set env var wins, matching the CLI's own
 * precedence and letting an operator override the installed token for one boot.
 *
 * The token is read from disk at every process start, which is what makes
 * renewal work without touching the host: write a new token file, bounce the
 * process, done — no container recreate, no .env edit.
 */
export function hydrateSetupTokenEnv(mode: AuthMode = 'token'): void {
  // Login mode: the hermit runs on the stored claude.ai credential, and a
  // setup-token in the environment would take precedence over it for API calls —
  // which is exactly the credential the operator chose to stop using. An inherited
  // one (a stale .env, a parent shell, a leftover compose value) is removed rather
  // than merely not set, since "don't add it" would not undo an inheritance.
  if (mode === 'login') {
    if (process.env[TOKEN_ENV_VAR]) {
      delete process.env[TOKEN_ENV_VAR];
      console.log(`[hermitd-start] auth_mode: login — ignoring ${TOKEN_ENV_VAR} from the environment`);
    }
    return;
  }
  if (mode === 'external') return; // an env credential already outranks both files
  if (process.env[TOKEN_ENV_VAR]) return;
  const token = readTokenValue(defaultConfigDir());
  if (token) process.env[TOKEN_ENV_VAR] = token;
}

/**
 * True when this project's Docker hermit service is running. Fail-soft: a
 * missing compose file, absent docker, timeout, or non-zero status all read as
 * "not running" so a plain host boot is never blocked by the probe itself.
 */
export function dockerHermitRunning(): boolean {
  if (!fs.existsSync('docker-compose.hermit.yml')) return false;
  try {
    const r = spawnSync(
      'docker',
      ['compose', '-f', 'docker-compose.hermit.yml', 'ps', '--status', 'running', '--format', '{{.Service}}'],
      { timeout: 5000, encoding: 'utf-8' },
    );
    if (r.status !== 0 || !r.stdout) return false;
    return r.stdout.split('\n').some((l: string) => l.trim() === 'hermit');
  } catch {
    return false;
  }
}

/**
 * Decide whether to refuse booting a second instance beside a live one for this
 * project — the host↔Docker split-brain guard. Returns an operator-facing reason
 * (multi-line) to refuse, or null to proceed. Pure of side effects so it's unit
 * testable; the process.exit wrapper is refuseIfAnotherInstanceAlive.
 *
 * Same-namespace boots are already serialized by the lifecycle lock the caller
 * holds; the cross-namespace (host vs container) case is covered by the shared
 * liveness signal. Skipped inside a container (the entrypoint owns that guard)
 * and when HERMIT_FORCE_BOOT=1 (split-state recovery).
 */
export function shouldRefuseBoot(bootMode: BootMode): string[] | null {
  if (isContainer() || process.env.HERMIT_FORCE_BOOT === '1') return null;
  if (dockerHermitRunning()) {
    return [
      "This project's Docker hermit is running — a second host instance would fight it for state and channels.",
      'Stop it first: hermitd stop   (attach: hermitd attach)',
      'Override (split-state recovery only): HERMIT_FORCE_BOOT=1',
    ];
  }
  const rt = readRuntimeJson();
  const verdict = residentLiveness(rt, rt?.tmux_session ?? '', REAL_LIVENESS_DEPS());
  const age = otherRuntimeLive(verdict, bootMode);
  if (age !== null) {
    return [
      `A ${rt!.runtime_mode} instance appears to be alive for this project (state activity ${Math.round(age)}s ago).`,
      'Stop it first (hermitd stop), or override with HERMIT_FORCE_BOOT=1.',
    ];
  }
  return null;
}

function refuseIfAnotherInstanceAlive(bootMode: BootMode): void {
  const reason = shouldRefuseBoot(bootMode);
  if (reason) {
    for (const line of reason) console.log(`[hermit] ${line}`);
    process.exit(1);
  }
}

/**
 * Whether a surviving always-on tmux boot should register the watchdog scheduler.
 * Docker is skipped (the entrypoint loop already ticks); an explicit
 * `watchdog.scheduler_enabled: false` is the durable opt-out. Absent or
 * malformed is not `false`, so this only skips for a real opt-out. Pure of
 * side effects so the gate is unit-testable without tmux.
 */
export function shouldInstallWatchdogScheduler(
  runtimeMode: string,
  schedulerEnabled: unknown,
): boolean {
  return runtimeMode !== 'docker' && schedulerEnabled !== false;
}

/**
 * Register the watchdog OS scheduler after a surviving tmux boot. Re-runs install
 * every boot (idempotent, self-repairing); never fails the boot on a child error.
 * Spawn is injectable so tests need no tmux and no real watchdog process.
 */
export function maybeInstallWatchdogScheduler(
  runtimeMode: string,
  schedulerEnabled: unknown,
  spawn: (
    command: string,
    args: string[],
    options: { stdio: 'inherit' },
  ) => unknown = spawnSync,
): void {
  if (!shouldInstallWatchdogScheduler(runtimeMode, schedulerEnabled)) return;
  spawn(
    process.execPath,
    [path.join(import.meta.dir, 'hermitd-watchdog.ts'), 'install'],
    { stdio: 'inherit' },
  );
}

/**
 * Decide what to do when tmux reports the session already exists: refusal lines,
 * or null to report "already running" and exit 0. Pure of side effects so it's
 * unit testable, like shouldRefuseBoot above.
 *
 * A duplicate means the session predates this invocation, so this process never
 * observed its boot and cannot assume lifecycle state was written. A plain
 * double-run has a healthy runtime.json and is waved through; a hermit whose
 * state was lost underneath it (project dir recreated, state cleaned, a botched
 * migration) is refused — 'invalid' as hard as 'missing', since a corrupt record
 * may hold the only copy of state (see RuntimeRead in lib/runtime.ts).
 * Deliberately rebuilds nothing either way: runtime.json is the declared single
 * source of truth (skills/resident-start/SKILL.md), so a synthesized record would
 * defeat the recovery branches that read it.
 *
 * Parseable is not the same as usable: a stub record (no runtime_mode, or no
 * tmux_session while a session of that name is demonstrably alive) dead-ends
 * bin/hermitd-attach exactly like a missing file does ("Unknown runtime mode" /
 * "No tmux session recorded"). updateRuntimeField() seeds `{}` on a missing
 * read, so an interrupted hermitd-stop leaves precisely that stub behind —
 * checking the fields, not just the JSON, is what keeps the loop broken.
 *
 * Callers must also not mutate config on this path: no boot happened, so
 * always_on / applyAlwaysOnDoctorSchedule() must not fire — the doctor ratchet
 * only takes effect via a new session's `hermit-routines load`, so writing it
 * here would desync config from the scheduler actually running.
 */
export function duplicateSessionRefusal(sessionName: string): string[] | null {
  const runtime = readRuntimeState();
  let detail: string;
  if (runtime.kind === 'missing') {
    detail = 'state/runtime.json is missing';
  } else if (runtime.kind === 'invalid') {
    detail = `state/runtime.json is unusable: ${runtime.reason}`;
  } else if (!pyTruthy(runtime.data.runtime_mode) || !pyTruthy(runtime.data.tmux_session)) {
    detail = 'state/runtime.json records no live session (runtime_mode/tmux_session are empty)';
  } else {
    return null;
  }

  return [
    `ERROR: session "${sessionName}" is running, but ${detail}.`,
    'Lifecycle state cannot be rebuilt from a session already in flight — attach,',
    'the watchdog and session recovery stay degraded until the session restarts.',
    'Recover:',
    '  hermitd stop',
    '  hermitd start',
    `To inspect it first: tmux attach -t ${sessionName}`,
  ];
}

export function resolveResumeTarget(
  runtime: Json,
  projectRoot: string,
  configDir?: string,
): { id: string } | { skip: 'no-session-id' | 'no-transcript' | 'no-user-turn' } {
  const id = runtime?.cc_session_id;
  if (typeof id !== 'string' || !id.trim()) return { skip: 'no-session-id' };
  const dir = transcriptDirFor(projectRoot, configDir);
  const transcript = path.join(dir, `${id}.jsonl`);
  if (path.dirname(transcript) !== dir) return { skip: 'no-transcript' };
  let text: string;
  try {
    text = fs.readFileSync(transcript, 'utf8');
  } catch {
    return { skip: 'no-transcript' };
  }
  const hasUserTurn = text.split('\n').some((line) => {
    try { return JSON.parse(line).type === 'user'; } catch { return false; }
  });
  return hasUserTurn ? { id } : { skip: 'no-user-turn' };
}

export function registerHostProjectOnBoot(project = process.cwd(), root = PLUGIN_ROOT): void {
  try { registerProject(project, root); } catch { /* Registry failure must never prevent startup. */ }
}

async function main(): Promise<void> {
  const noTmuxFlag = process.argv.includes('--no-tmux');
  const resumeIndex = process.argv.indexOf('--resume');

  // Config first: which credential to hydrate is a config question now, and the
  // answer decides whether a token file is read at all.
  const config = loadConfig();
  hydrateSetupTokenEnv(resolveAuthMode(config, defaultConfigDir()));
  acquireLifecycleLock();
  checkForUpgrade(config);
  const tools = checkPrerequisites();

  // Singleton guard (under the lifecycle lock): don't boot a second instance
  // beside a live one for this project. Boot mode mirrors the tmux/interactive
  // branch chosen further down.
  const bootMode = noTmuxFlag || !pyTruthy(tools.tmux) ? 'interactive' : 'tmux';
  refuseIfAnotherInstanceAlive(bootMode);

  let resumeId: string | undefined;
  if (resumeIndex !== -1) {
    if (bootMode === 'interactive') {
      console.log('[hermit] --resume applies to always-on boots only');
    } else {
      const runtime = readRuntimeJson() ?? {};
      const arg = process.argv[resumeIndex + 1];
      const target = resolveResumeTarget(
        arg && !arg.startsWith('--') ? { ...runtime, cc_session_id: arg } : runtime,
        process.cwd(),
        runtime.config_dir,
      );
      if ('id' in target) resumeId = target.id;
      else console.log(`[hermit] resume skipped: ${target.skip}`);
    }
  }

  const sessionName = getSessionName(config);

  // Setup-mode gate: docker-setup touches this marker before first boot so channel
  // pairing commands land on an idle REPL prompt rather than racing the bootstrap turn.
  // Consumed (deleted) here — one-shot, so a crashed setup doesn't suppress bootstrap permanently.
  const setupMarker = path.join(STATE_DIR, '.setup-mode');
  const setupMode = fs.existsSync(setupMarker);
  if (setupMode) {
    try {
      fs.unlinkSync(setupMarker);
    } catch {}
    console.log('[hermit] Setup mode — skipping bootstrap prompt (one-shot)');
  }

  // send-keys races the TUI init on slow boots — argv does not.
  const hb = 'heartbeat' in config ? config.heartbeat : {};
  const autoSession = pyTruthy('auto_session' in config ? config.auto_session : true);
  const hbEnabled = pyTruthy('enabled' in hb ? hb.enabled : false);
  const hasRoutines = pyTruthy(config.routines);
  // Domain hermits (e.g. homeassistant-hermit) declare a boot_skill that
  // wraps /hermitd:resident-start plus their own domain setup.
  // When set, it replaces the core session skill in the bootstrap — the
  // domain skill is responsible for calling resident-start itself.
  const bootSkill = config.boot_skill || '/hermitd:resident-start';

  const steps: string[] = [];
  // `hermit-routines load` arms both monitors, so the heartbeat skill is a boot
  // step only where no routine load will run.
  if (hbEnabled && !hasRoutines) steps.push('/hermitd:heartbeat start');
  if (hasRoutines) steps.push('/hermitd:hermit-routines load');
  if (autoSession) steps.push(bootSkill);

  // Bootstrap fires only in always-on mode; interactive runs are operator-driven.
  const isAlwaysOn = !noTmuxFlag && pyTruthy(tools.tmux);
  const willBootstrap = steps.length > 0 && !setupMode && isAlwaysOn;
  const resume = willBootstrap ? resumeId : undefined;
  requireResident();
  const cmd = buildClaudeCommand(config, tools, { resume });
  if (willBootstrap) {
    let bootstrap: string;
    if (steps.length === 1) {
      bootstrap = steps[0];
    } else {
      const numbered = steps.map((s, i) => `(${i + 1}) ${s}`).join(', ');
      bootstrap = `Always-on bootstrap. Invoke these skills in order: ${numbered}.`;
    }
    cmd.push(bootstrap);
  }

  checkStaleRuntime(config, sessionName);

  console.log(`[hermit] Resume: ${resume ?? 'fresh'}`);

  // Print launch info
  const agentName = config.agent_name;
  const language = config.language;
  const timezone = config.timezone;
  if (pyTruthy(agentName)) {
    const identityParts = [agentName];
    if (pyTruthy(language)) identityParts.push(language);
    if (pyTruthy(timezone)) identityParts.push(timezone);
    console.log(`[hermit] Agent: ${identityParts.join(', ')}`);
  } else {
    console.log('[hermit] Agent: (unnamed)');
  }
  console.log(`[hermit] Project: ${path.basename(process.cwd())}`);
  console.log(`[hermit] Model: ${config.model || 'default'}`);
  console.log(`[hermit] Effort: ${config.effort || 'default'}`);
  console.log(`[hermit] Channels: ${getEnabledChannels(config).join(', ') || 'none'}`);
  console.log(`[hermit] Remote: ${pyTruthy(config.remote) ? 'enabled' : 'disabled'}`);
  console.log(`[hermit] Chrome: ${pyTruthy(config.chrome) ? 'enabled' : 'disabled'}`);
  console.log(`[hermit] Permissions: ${config.permission_mode || 'auto'}`);

  const hookProfile = writeSettingsEnv(config, bootMode);
  // Named at launch because it decides which deny patterns enforce, and a hermit
  // that silently resolved a weaker profile than the operator expected is
  // otherwise invisible until something gets through that should not have.
  console.log(`[hermit] Hook profile: ${hookProfile.profile} (${hookProfile.source})`);
  // After writeSettingsEnv — both write .claude/settings.local.json, and the
  // render must land on the file that call already rewrote, not be overwritten by it.
  applyVoiceRender(config);
  applyArtifactGrant(config);
  seedWorkspaceTrust();

  if (noTmuxFlag || !pyTruthy(tools.tmux)) {
    if (!noTmuxFlag && !pyTruthy(tools.tmux)) {
      console.log('[hermit] tmux not found — running in current terminal.');
      console.log('[hermit] Install tmux for persistent sessions.');
    }
    // Fresh boot marker for hermit-routines' cron-registry diff (see helper).
    writeBootId();
    // Create or update runtime.json for interactive mode
    const existing = readRuntimeJson();
    if (existing === null) {
      writeRuntimeJson({
        version: 1,
        session_id: null,
        created_at: localISOStamp(),
        runtime_mode: 'interactive',
        tmux_session: null,
        peer_name: peerName(config),
        transition: null,
        transition_target: null,
        transition_started_at: null,
        shutdown_requested_at: null,
        shutdown_completed_at: null,
        last_error: null,
        last_shell_snapshot_at: null,
      });
    } else {
      // Preserve lifecycle fields for resident-start recovery.
      existing.version = 1;
      existing.runtime_mode = 'interactive';
      existing.tmux_session = null;
      existing.peer_name = peerName(config);
      clearShutdownStampsOnBoot(existing);
      writeRuntimeJson(existing);
    }
    console.log(`[hermit] Running: ${shlexJoin(cmd)}`);
    writeRuntimeJson({ ...(readRuntimeJson() ?? {}), last_start_error: null, last_start_error_notified: null });
    delete process.env.HERMIT_MANAGED;
    process.env.HERMIT_RESIDENT = '1';
    execvp(cmd);
  }

  // Start tmux session (handles "already exists" as a graceful exit)
  //
  // tmux starts a new shell that does NOT inherit the caller's environment.
  // Auth vars must be in shell env before claude launches.
  // *_STATE_DIR vars must be OS env because MCP servers (channel plugins)
  // inherit shell env but don't read settings.local.json.
  const forwardVars = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', TOKEN_ENV_VAR, 'AGENT_HOOK_PROFILE', ...Object.keys(resolveHermitEnv(config))];
  const envFile = path.join('/tmp', `.hermit-env-${sessionName}`);
  // CLAUDE_PLUGIN_ROOT is not injected into the tmux shell by the harness;
  // set it explicitly so Bash tool calls in skills work in cron-triggered sessions.
  let envContent = `export CLAUDE_PLUGIN_ROOT=${shlexQuote(PLUGIN_ROOT)}\n`;
  // HERMIT_MANAGED marks this as THE unattended managed session — the one path
  // ask-gate.ts denies AskUserQuestion on. It rides the process-scoped env-file
  // only (sourced then rm'd by the tmux shell below), never settings.local.json
  // or the docker-compose env block, so a hand-launched `claude` in the same
  // always_on project — or a `docker exec` maintenance shell — never inherits it
  // and is correctly treated as attended.
  envContent += `export HERMIT_MANAGED=1\nexport HERMIT_RESIDENT=1\n`;
  for (const v of forwardVars) {
    const val = process.env[v];
    if (val !== undefined) {
      envContent += `export ${v}=${shlexQuote(val)}\n`;
    }
  }
  // Unlink-then-create-0600 rather than write-then-chmod: this file now carries
  // the long-lived setup-token alongside any API key, it sits on a predictable
  // path in a world-writable tmpdir, and write-then-chmod leaves it briefly
  // world-readable. 'wx' also refuses to follow a pre-planted symlink.
  fs.rmSync(envFile, { force: true });
  fs.writeFileSync(envFile, envContent, { flag: 'wx', mode: 0o600 });
  fs.chmodSync(envFile, 0o600);

  const shellCmd = `. ${shlexQuote(envFile)} && rm -f ${shlexQuote(envFile)} && ${shlexJoin(cmd)}`;
  const result = spawnSync('tmux', ['new-session', '-d', '-s', sessionName, shellCmd], {
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    // The env file's only cleanup is the `rm -f` inside shellCmd, which runs in
    // the session tmux was asked to create. No session, no cleanup — so a failed
    // launch would strand a 0600 file holding the forwarded API key / setup token
    // on a predictable path in a world-writable tmpdir. Remove it on every
    // failure path before deciding what to report.
    fs.rmSync(envFile, { force: true });

    const stderrMsg = result.stderr ? result.stderr.trim() : '';
    if (stderrMsg.includes('duplicate session')) {
      const refusal = duplicateSessionRefusal(sessionName);
      if (refusal) {
        for (const line of refusal) console.log(`[hermit] ${line}`);
        process.exit(1);
      }
      console.log(`[hermit] Session "${sessionName}" already running (always-on).`);
      console.log(`[hermit] Attach: hermitd attach  (or: tmux attach -t ${sessionName})`);
      console.log('[hermit] Send tasks via channel, or run hermitd stop to shut down.');
      process.exit(0);
    } else {
      console.log('[hermit] ERROR: tmux new-session failed.');
      if (stderrMsg) console.log(`[hermit]   tmux: ${stderrMsg}`);
      process.exit(1);
    }
  }

  console.log(`[hermit] Started tmux session: ${sessionName}`);

  // Detect runtime mode
  const runtimeMode = isContainer() ? 'docker' : 'tmux';
  if (runtimeMode === 'tmux') registerHostProjectOnBoot();

  // Fresh boot marker for hermit-routines' cron-registry diff (see helper).
  writeBootId();

  // Create or update runtime.json as the single source of lifecycle truth
  const existing = readRuntimeJson();
  if (existing === null) {
    writeRuntimeJson({
      version: 1,
      session_id: null,
      created_at: localISOStamp(),
      runtime_mode: runtimeMode,
      tmux_session: sessionName,
      peer_name: peerName(config),
      transition: null,
      transition_target: null,
      transition_started_at: null,
      shutdown_requested_at: null,
      shutdown_completed_at: null,
      last_error: null,
      last_shell_snapshot_at: null,
    });
  } else {
    // Preserve lifecycle fields for resident-start recovery.
    existing.version = 1;
    existing.runtime_mode = runtimeMode;
    existing.tmux_session = sessionName;
    existing.peer_name = peerName(config);
    existing.last_start_error = null;
    existing.last_start_error_notified = null;
    clearShutdownStampsOnBoot(existing);
    writeRuntimeJson(existing);
  }

  // Mark as always-on mode in config
  const alwaysOnBefore = structuredClone(config);
  config.always_on = true;
  applyAlwaysOnDoctorSchedule(config);
  // Skipped when the on-disk config was unparseable: `config` is then pure
  // DEFAULT_CONFIG, and writing it would silently replace the operator's
  // identity, channels, routines and budget with template defaults.
  if (!configReadFailed) {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
      auditConfigChange(path.dirname(CONFIG_PATH), alwaysOnBefore, config, 'hermitd-start');
    } catch {}
  }

  // Verify the session survived the boot period
  await sleep(3); // Wait for Claude to boot — increase if on slow hardware
  if (!tmuxSessionAlive(sessionName)) {
    console.log(`[hermit] ERROR: tmux session "${sessionName}" died after creation.`);
    console.log('[hermit] The shell command inside tmux likely failed.');
    console.log('[hermit] Common causes: `claude` not in PATH, missing ANTHROPIC_API_KEY.');
    console.log('[hermit] To debug: tmux new-session -s hermit-debug then run `claude` manually.');
    console.log('[hermit] Falling back to interactive mode...');
    // Same secret-hygiene reason as the spawn-failure branch above: tmux created
    // the session, but a shell that died before reaching `rm -f` (a non-POSIX
    // default shell, a failed `.`) leaves the 0600 env file behind — and execvp
    // below never returns to clean it up.
    fs.rmSync(envFile, { force: true });
    const stale = readRuntimeJson();
    stale.runtime_mode = 'interactive';
    stale.tmux_session = null;
    stale.last_error = 'session_died_on_boot';
    writeRuntimeJson(stale);
    writeRuntimeJson({ ...(readRuntimeJson() ?? {}), last_start_error: null, last_start_error_notified: null });
    delete process.env.HERMIT_MANAGED;
    process.env.HERMIT_RESIDENT = '1';
    execvp(cmd);
  }

  maybeInstallWatchdogScheduler(
    runtimeMode,
    config.watchdog?.scheduler_enabled,
  );

  if (!hbEnabled) {
    console.log('[hermit] Heartbeat: disabled');
  } else {
    const every = 'every' in hb ? hb.every : '30m';
    if (!hasRoutines) {
      console.log(`[hermit] Bootstrap: /hermitd:heartbeat start queued (every ${every})`);
    } else {
      console.log(`[hermit] Heartbeat: armed by the routine load (every ${every})`);
    }
  }
  if (hasRoutines) {
    console.log('[hermit] Bootstrap: /hermitd:hermit-routines load queued');
  }
  if (autoSession) {
    console.log(`[hermit] Bootstrap: ${bootSkill} queued`);
  }

  console.log('[hermit] Mode: always-on (session stays open between tasks)');
  console.log(`[hermit] Attach: hermitd attach  (or: tmux attach -t ${sessionName})`);
  console.log('[hermit] Stop: hermitd stop');
}

export {
  CONFIG_PATH,
  STATE_DIR,
  RUNTIME_JSON,
  RUNTIME_TMP,
  LIFECYCLE_LOCK,
  PROFILE_LEVELS,
  DEFAULT_CONFIG,
  CHANNEL_PLUGINS,
  loadConfig,
  applyAlwaysOnDoctorSchedule,
  checkForUpgrade,
  checkPrerequisites,
  isContainer,
  writeRuntimeJson,
  readRuntimeJson,
  readRuntimeState,
  checkStaleRuntime,
  clearShutdownStampsOnBoot,
  writeBootId,
  acquireLifecycleLock,
  fetchRegisteredMarketplaces,
  iterChannelConfigs,
  getEnabledChannels,
  resolveStateDir,
  buildClaudeCommand,
  peerName,
  requireResident,
  renderLaunchOverlay,
  seedWorkspaceTrust,
  resolveHermitEnv,
  writeSettingsEnv,
  applyVoiceRender,
  applyArtifactGrant,
  shlexQuote,
  shlexJoin,
  main,
};

if (import.meta.main) {
  await main();
}
