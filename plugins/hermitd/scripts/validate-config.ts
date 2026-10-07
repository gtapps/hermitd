import fs from 'node:fs';
import { TABLE, type Spec } from './lib/config-read';
import { parseDuration } from './lib/time';
import path from 'node:path';
import { safeForLLM } from './lib/sanitize';
import * as ENUM from './lib/settings/enums';
import { validateExpectArtifact } from './lib/routines/run-record';
import { validatePrecheckValue, validatePrecheckTimeout } from './lib/routines/gate';
import { ENV_VAR_RE } from './lib/channel-config';
import { toPushUrl } from './lib/backup';

type Json = any;

/**
 * PostToolUse hook — validates config.json after any Edit/Write to it.
 * Checks required keys, types, routine time formats, and channel structure.
 * Exit 2 = validation failed, surface errors to agent.
 */

const MAX_STDIN = 64 * 1024;

const REQUIRED_KEYS: Record<string, string[]> = {
  'agent_name': ['string', 'null'],
  'language': ['string', 'null'],
  'timezone': ['string', 'null'],
  'escalation': ['string'],
  'channels': ['object'],
  'env': ['object'],
  'heartbeat': ['object'],
  'routines': ['array'],
  'quality_gate': ['object'],
};

// Enum value sets live in lib/settings/enums.ts so this hook and the
// `/hermit-settings` registry cannot drift apart on what a valid value is.
const VALID_ROUTINE_MODEL = ENUM.ROUTINE_MODEL;
const VALID_TELEMETRY_DEST = ENUM.TELEMETRY_DEST;
const VALID_BACKUP_MODE: readonly string[] = ENUM.BACKUP_MODE;
const VALID_BACKUP_INCLUDE: readonly string[] = ENUM.BACKUP_INCLUDE;
const TIME_RE = /^\d{2}:\d{2}$/;
// Routine ids travel in bracket markers, --ids CSVs, and JSONL output — shared with lib/routines/due.ts.
const ROUTINE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** True for loopback hosts (localhost/127.0.0.1/::1) where a plaintext bearer token stays on-box. */
function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

// --- Cron validation (5-field: minute hour dom month dow) ---
function parseCronField(token: string, lo: number, hi: number): Set<number> {
  const values = new Set<number>();
  for (const part of token.split(',')) {
    if (!part) throw new Error('empty segment in list');
    if (part.includes('/')) {
      const [base, stepStr] = part.split('/', 2);
      const step = Number(stepStr);
      if (!Number.isInteger(step) || step <= 0) throw new Error(`zero or invalid step: ${part}`);
      let start: number, end: number;
      if (base === '*') { start = lo; end = hi; }
      else if (base.includes('-')) { [start, end] = base.split('-', 2).map(Number); }
      else { start = Number(base); end = hi; }
      if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error(`non-numeric: ${part}`);
      if (start < lo || end > hi || start > end) throw new Error(`out of range or reverse: ${part}`);
      for (let i = start; i <= end; i += step) values.add(i);
    } else if (part.includes('-')) {
      const [a, b] = part.split('-', 2).map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error(`non-numeric range: ${part}`);
      if (a < lo || b > hi || a > b) throw new Error(`out of range or reverse range: ${part}`);
      for (let i = a; i <= b; i++) values.add(i);
    } else if (part === '*') {
      for (let i = lo; i <= hi; i++) values.add(i);
    } else {
      const v = Number(part);
      if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`value ${part} out of range [${lo},${hi}]`);
      values.add(v);
    }
  }
  return values;
}

function validateCronSchedule(schedule: string): string | null {
  if (schedule.startsWith('@')) return 'macros not supported';
  const fields = schedule.split(/\s+/);
  if (fields.length !== 5) return `expected 5 fields, got ${fields.length}`;
  for (const f of fields) {
    if (/[a-zA-Z]/.test(f)) return `named values not supported: ${f}`;
  }
  try {
    parseCronField(fields[0], 0, 59);
    parseCronField(fields[1], 0, 23);
    parseCronField(fields[2], 1, 31);
    parseCronField(fields[3], 1, 12);
    parseCronField(fields[4], 0, 7);
  } catch (e: any) {
    return e.message;
  }
  const domRestricted = fields[2] !== '*';
  const dowRestricted = fields[4] !== '*';
  if (domRestricted && dowRestricted) return 'both DOM and DOW restricted — not supported in v1';
  return null;
}

function retiredKeyWarning(key: string): string {
  return `${key} is retired and no longer read; run /hermitd:hermit-evolve to remove it`;
}

// Warning-only and specialized grammars retain their existing validation below.
const LEGACY_OWNED = new Set([
  'context_hygiene', 'heartbeat.model',
  'heartbeat.enabled', 'watchdog.enabled', 'watchdog.scheduler_enabled', 'watchdog.stale_factor',
]);

function validateTable(config: Json, rows: Record<string, Spec>, errors: string[], prefix = ''): void {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return;
  for (const [key, spec] of Object.entries(rows)) {
    if (!Object.prototype.hasOwnProperty.call(config, key) || config[key] === null) continue;
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (LEGACY_OWNED.has(dotted)) continue;
    const value = config[key];
    if (spec.kind === 'shape') {
      validateTable(value, spec.sub, errors, dotted);
      continue;
    }
    if (spec.kind === 'array' || spec.kind === 'map') {
      const valid = spec.kind === 'array' ? Array.isArray(value) : typeof value === 'object' && !Array.isArray(value);
      if (!valid) errors.push(`${dotted}: expected ${spec.kind === 'array' ? 'array' : 'object'}, got ${Array.isArray(value) ? 'array' : typeof value}`);
      continue;
    }
    if (typeof value !== spec.kind) {
      errors.push(`${dotted}: expected ${spec.kind}, got ${typeof value}`);
      continue;
    }
    if (spec.kind === 'string') {
      if (spec.enum && !spec.enum.includes(value)) errors.push(`${dotted}: "${value}" not in [${spec.enum.join(', ')}]`);
      if (spec.pattern === 'duration' && Number.isNaN(parseDuration(value, NaN))) errors.push(`${dotted}: must be a duration string (e.g. "30m")`);
      if (spec.pattern === 'time' && !TIME_RE.test(value)) errors.push(`${dotted}: invalid time "${value}"`);
    }
    if (spec.kind === 'number' && spec.range && (!Number.isFinite(value) || value < spec.range[0] || value > spec.range[1])) {
      errors.push(`${dotted}: must be in [${spec.range.join(', ')}]`);
    }
  }
}

function validate(config: Json): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  validateTable(config, TABLE, errors);
  if (config.tasks !== undefined && (!config.tasks || typeof config.tasks !== 'object' || Array.isArray(config.tasks))) {
    errors.push('tasks: expected object');
  }

  for (const [key, types] of Object.entries(REQUIRED_KEYS)) {
    if (!(key in config)) {
      errors.push(`Missing required key: ${key}`);
      continue;
    }
    const val = config[key];
    const actualType = val === null ? 'null' : Array.isArray(val) ? 'array' : typeof val;
    if (!types.includes(actualType)) {
      errors.push(`${key}: expected ${types.join('|')}, got ${actualType}`);
    }
  }

  if (config.settings_permissions !== undefined) {
    warnings.push(retiredKeyWarning('settings_permissions'));
  }

  // permission_mode's valid set is Claude Code's, not the hermit's — hermitd-start.ts
  // warns-and-falls-back on unknown values at runtime rather than hard-failing, so
  // only type-check here; an enum would reject values Claude Code adds later.
  if (config.permission_mode !== undefined && config.permission_mode !== null) {
    if (typeof config.permission_mode !== 'string') {
      errors.push(`permission_mode: expected string, got ${typeof config.permission_mode}`);
    }
  }

  // `voice.style` decides what apply-settings' voice-render op writes; `custom`
  // additionally names voice.prose as the body it renders. A `custom` with no prose
  // is refused here rather than at render time: the render runs unattended at every
  // boot, where an exit 1 is a warning line nobody reads.
  if (config.voice !== undefined && config.voice !== null) {
    if (typeof config.voice !== 'object' || Array.isArray(config.voice)) {
      errors.push(`voice: expected object, got ${Array.isArray(config.voice) ? 'array' : typeof config.voice}`);
    } else {
      const style = config.voice.style;
      const prose = config.voice.prose;
      if (style === 'custom' && (typeof prose !== 'string' || prose.trim() === '')) {
        errors.push('voice.style: "custom" needs voice.prose — set the prose first, then the style');
      }
    }
  }

  if (config.routine_max_lateness_minutes !== undefined && config.routine_max_lateness_minutes !== null) {
    const minutes = config.routine_max_lateness_minutes;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      errors.push('routine_max_lateness_minutes must be an integer from 1 to 1440');
    }
  }

  if (Array.isArray(config.routines)) {
    const ids = new Set();
    // Two enabled routines writing the same declared artifact is a same-day
    // clobber: whichever finishes last wins, and the other's `finish` may read
    // the wrong file as proof of its own success. Only covers routines that
    // opted in — it cannot establish ownership over undeclared writers.
    const artifacts = new Map<string, number>();
    config.routines.forEach((r: Json, i: number) => {
      if (!r.id) errors.push(`routines[${i}]: missing id`);
      else if (!ROUTINE_ID_RE.test(r.id)) {
        errors.push(`routines[${i}]: id "${r.id}" must match ^[A-Za-z0-9._-]{1,64}$ — routine ids travel in bracket markers, --ids CSVs, and JSONL output`);
      }
      if (!r.skill) errors.push(`routines[${i}]: missing skill`);
      if (r.time !== undefined) {
        errors.push(`routines[${i}]: legacy "time" field found — migrate to "schedule" (5-field cron)`);
      }
      if (r.days !== undefined) {
        errors.push(`routines[${i}]: legacy "days" field found — migrate to "schedule" (5-field cron)`);
      }
      if (!r.schedule) {
        errors.push(`routines[${i}]: missing schedule`);
      } else {
        const cronErr = validateCronSchedule(r.schedule);
        if (cronErr) {
          errors.push(`routines[${i}]: invalid schedule "${r.schedule}" — ${cronErr}`);
        } else if (r.id === 'heartbeat-restart' && r.schedule.split(/\s+/).slice(2).some((f: string) => f !== '*')) {
          // The anchor's re-arm keeps the routine CronCreates inside CC's 7-day expiry
          // and arm.ts's 26h anchor-age window; both assume it fires every day.
          warnings.push(`routines[${i}]: "heartbeat-restart" schedule "${r.schedule}" is not daily — the re-arm anchor's expiry and age windows assume a daily fire`);
        }
      }
      if (typeof r.enabled !== 'boolean') {
        warnings.push(`routines[${i}]: "enabled" should be boolean`);
      }
      if (r.id && ids.has(r.id)) {
        warnings.push(`routines[${i}]: duplicate id "${r.id}"`);
      }
      if (r.id) ids.add(r.id);
      if (r.model !== undefined && r.model !== null) {
        if (typeof r.model !== 'string' || !VALID_ROUTINE_MODEL.includes(r.model)) {
          errors.push(`routines[${i}]: model "${r.model}" not in [${VALID_ROUTINE_MODEL.join(', ')}] (omit to use session model)`);
        } else if (r.id === 'heartbeat-restart') {
          warnings.push(`routines[${i}]: model on "heartbeat-restart" is ignored — re-arm must run in the session`);
        }
      }
      if (r.precheck !== undefined && r.precheck !== null) {
        const preErr = validatePrecheckValue(r.precheck);
        if (preErr) {
          errors.push(`routines[${i}]: precheck ${preErr}`);
        } else if (r.id === 'heartbeat-restart') {
          warnings.push(`routines[${i}]: precheck on "heartbeat-restart" is ignored — the re-arm anchor never runs through the routine monitor`);
        }
      }
      if (r.precheck_timeout_s !== undefined && r.precheck_timeout_s !== null) {
        const toErr = validatePrecheckTimeout(r.precheck_timeout_s);
        if (toErr) {
          errors.push(`routines[${i}]: precheck_timeout_s ${toErr}`);
        } else if (r.precheck === undefined || r.precheck === null) {
          warnings.push(`routines[${i}]: precheck_timeout_s has no effect without "precheck"`);
        }
      }
      if (r.reflect_after === true && r.id === 'heartbeat-restart') {
        warnings.push(`routines[${i}]: reflect_after on "heartbeat-restart" is ignored — the anchor short-circuits before finish on a healthy check`);
      }
      if (r.expect_artifact !== undefined && r.expect_artifact !== null) {
        const artErr = validateExpectArtifact(r.expect_artifact);
        if (artErr) {
          errors.push(`routines[${i}]: expect_artifact ${artErr}`);
        } else if (r.enabled !== false) {
          const key = String(r.expect_artifact).trim();
          const prior = artifacts.get(key);
          if (prior !== undefined) {
            errors.push(`routines[${i}]: expect_artifact "${key}" is already declared by routines[${prior}] — two enabled routines cannot own the same artifact`);
          } else {
            artifacts.set(key, i);
          }
        }
      }
    });
  }

  // Session checks share routine id grammar for markers and JSONL.
  if (config.scheduled_checks !== undefined && !Array.isArray(config.scheduled_checks)) {
    errors.push(`scheduled_checks: expected array, got ${config.scheduled_checks === null ? 'null' : typeof config.scheduled_checks}`);
  } else if (Array.isArray(config.scheduled_checks)) {
    const checkIds = new Set();
    config.scheduled_checks.forEach((c: Json, i: number) => {
      if (!c || typeof c !== 'object' || Array.isArray(c)) {
        errors.push(`scheduled_checks[${i}]: must be an object`);
        return;
      }
      if (!c.id) errors.push(`scheduled_checks[${i}]: missing id`);
      else if (typeof c.id !== 'string' || !ROUTINE_ID_RE.test(c.id)) {
        errors.push(`scheduled_checks[${i}]: id "${c.id}" must match ^[A-Za-z0-9._-]{1,64}$`);
      }
      if (!c.skill) errors.push(`scheduled_checks[${i}]: missing skill`);
      else if (typeof c.skill !== 'string') {
        errors.push(`scheduled_checks[${i}]: skill must be a string, got ${typeof c.skill}`);
      }
      if (c.trigger === 'interval') {
        errors.push(`scheduled_checks[${i}]: legacy "interval" trigger found, migrate to routines with a cron schedule`);
      }
      if (c.interval_days !== undefined) {
        errors.push(`scheduled_checks[${i}]: legacy "interval_days" field found, migrate to routines with a cron schedule`);
      }
      // Only `trigger: "session"` entries are invoked (session skill step 4b) or
      // listed by `/hermit-settings scheduled-checks`, so anything else sits in the
      // config doing nothing and shows nowhere. Warn rather than error: an error
      // here would block the very edits that fix the entry.
      else if (c.trigger !== 'session' && c.trigger !== 'interval') {
        warnings.push(`scheduled_checks[${i}]: trigger is ${c.trigger === undefined ? 'missing' : `"${c.trigger}"`}, not "session" — the entry is never invoked and is not listed by /hermit-settings`);
      }
      if (c.plugin !== undefined && typeof c.plugin !== 'string') {
        errors.push(`scheduled_checks[${i}]: plugin must be a string, got ${typeof c.plugin}`);
      }
      if (c.enabled !== undefined && typeof c.enabled !== 'boolean') {
        warnings.push(`scheduled_checks[${i}]: "enabled" should be boolean`);
      }
      if (c.id && checkIds.has(c.id)) {
        warnings.push(`scheduled_checks[${i}]: duplicate id "${c.id}"`);
      }
      if (c.id) checkIds.add(c.id);
    });
  }

  // _hermit_versions is the applied-migration record hermit-evolve reads to
  // compute the upgrade gap. A non-string value there makes that comparison
  // meaningless, and the failure would only surface at upgrade time.
  if (config._hermit_versions !== undefined) {
    const hv = config._hermit_versions;
    if (!hv || typeof hv !== 'object' || Array.isArray(hv)) {
      errors.push(`_hermit_versions: expected object, got ${hv === null ? 'null' : Array.isArray(hv) ? 'array' : typeof hv}`);
    } else {
      for (const [plugin, v] of Object.entries(hv)) {
        if (typeof v !== 'string') {
          errors.push(`_hermit_versions.${plugin}: expected string version, got ${v === null ? 'null' : typeof v}`);
        }
      }
    }
  }

  if (config.channels && typeof config.channels === 'object') {
    for (const [name, ch] of Object.entries<Json>(config.channels)) {
      // channels.primary is a magic string key (preferred-channel pointer), not a
      // channel-config object. Skip object-shape validation here; the primary-specific
      // checks below handle it.
      if (name === 'primary') continue;
      if (typeof ch !== 'object' || ch === null) {
        errors.push(`channels.${name}: must be an object`);
        continue;
      }
      if (ch.allowed_users !== undefined) {
        if (!Array.isArray(ch.allowed_users)) {
          errors.push(`channels.${name}.allowed_users: must be an array`);
        } else if (!ch.allowed_users.every((u: unknown) => typeof u === 'string')) {
          errors.push(
            `channels.${name}.allowed_users: every entry must be a string (a numeric ID breaks the string-based sender allow-list check)`,
          );
        }
      }
      if (ch.passive_chats !== undefined) {
        if (!Array.isArray(ch.passive_chats)) {
          errors.push(`channels.${name}.passive_chats: must be an array`);
        } else if (!ch.passive_chats.every((id: unknown) => typeof id === 'string')) {
          errors.push(`channels.${name}.passive_chats: every entry must be a string`);
        }
      }
      for (const key of ['isolate_chats', 'log_chats']) {
        if (ch[key] !== undefined && typeof ch[key] !== 'boolean') {
          errors.push(`channels.${name}.${key}: must be a boolean`);
        }
      }
      for (const key of ['shared_chats', 'operators']) {
        if (ch[key] !== undefined) {
          if (!Array.isArray(ch[key])) errors.push(`channels.${name}.${key}: must be an array`);
          else if (!ch[key].every((id: unknown) => typeof id === 'string')) {
            errors.push(`channels.${name}.${key}: every entry must be a string`);
          }
        }
      }
      if (Array.isArray(ch.shared_chats) && ch.shared_chats.includes(ch.maintainer_channel_id)) {
        warnings.push(`channels.${name}.shared_chats: includes the maintainer_channel_id`);
      }
      if (Array.isArray(ch.operators) && Array.isArray(ch.allowed_users)
        && ch.operators.some((id: string) => !ch.allowed_users.includes(id))) {
        warnings.push(`channels.${name}.operators: includes an id absent from allowed_users`);
      }
      if (ch.dm_channel_id !== undefined && ch.dm_channel_id !== null && typeof ch.dm_channel_id !== 'string') {
        errors.push(`channels.${name}.dm_channel_id: must be string or null`);
      }
      if (ch.maintainer_channel_id !== undefined && ch.maintainer_channel_id !== null && typeof ch.maintainer_channel_id !== 'string') {
        errors.push(`channels.${name}.maintainer_channel_id: must be string or null`);
      }
      if (ch.default_chat_id !== undefined && ch.default_chat_id !== null && typeof ch.default_chat_id !== 'string') {
        errors.push(`channels.${name}.default_chat_id: must be string or null`);
      }
      if (ch.settings_policy !== undefined) {
        warnings.push(retiredKeyWarning(`channels.${name}.settings_policy`));
      }
      // The pinned proactive home must not be the maintainer chat: unlike
      // dm_channel_id, nothing re-learns this field, so a collision here sends
      // every briefing to the maintainer chat until the operator rebinds from
      // the terminal. It also collapses control authority (isTrustedController)
      // onto the outbound-routing chat. Warn (like the dm collision below) so
      // doctor reports it.
      if (ch.default_chat_id != null && ch.maintainer_channel_id != null &&
          String(ch.default_chat_id) === String(ch.maintainer_channel_id)) {
        warnings.push(
          `channels.${name}.default_chat_id equals maintainer_channel_id — proactive sends are pinned to the maintainer chat and it now carries control authority too; re-point it with /hermitd:hermit-settings at the terminal`,
        );
      }
      // If the maintainer chat also sits in dm_channel_id the primary DM binding
      // was clobbered (fixed in channel-hook's persistDmChannelId) or was
      // configured to the same chat — either way that chat now satisfies the
      // DM-bound operator-trust check too and pairing will never self-correct
      // until a real DM arrives. Surface it so doctor's config check reports it.
      if (ch.dm_channel_id != null && ch.maintainer_channel_id != null &&
          String(ch.dm_channel_id) === String(ch.maintainer_channel_id)) {
        warnings.push(
          `channels.${name}.dm_channel_id equals maintainer_channel_id — the maintainer chat is bound as the operator DM, so it carries control authority too; send a message from the real DM chat to re-pair`,
        );
      }
    }
    if (config.channels.primary !== undefined) {
      const primary = config.channels.primary;
      if (typeof primary !== 'string') {
        errors.push('channels.primary: must be a string channel name');
      } else {
        const referenced = config.channels[primary];
        if (referenced === undefined) {
          errors.push(`channels.primary: references unknown channel "${primary}"`);
        } else if (typeof referenced !== 'object' || referenced === null || Array.isArray(referenced)) {
          errors.push(`channels.primary: "${primary}" must reference a channel-config object`);
        }
      }
    }
  }

  // A non-technical profile with no maintainer channel silently diverts every
  // technical alert to state/watchdog-events.jsonl — the failure mode a client install
  // would hit unnoticed. Surface it as a warning (doctor's config check reads these).
  if (config.operator_profile === 'non-technical') {
    const channels = config.channels && typeof config.channels === 'object' ? config.channels : {};
    const hasMaintainer = Object.entries(channels).some(([name, ch]: [string, any]) =>
      name !== 'primary' && ch && typeof ch === 'object' && ch.enabled !== false &&
      typeof ch.maintainer_channel_id === 'string' && ch.maintainer_channel_id.length > 0);
    if (!hasMaintainer) {
      warnings.push(
        'operator_profile is "non-technical" but no enabled channel sets maintainer_channel_id — technical alerts will be diverted to state/watchdog-events.jsonl',
      );
    }
  }

  if (config.heartbeat && typeof config.heartbeat === 'object') {
    const hb = config.heartbeat;
    if (hb.enabled !== undefined && typeof hb.enabled !== 'boolean') {
      warnings.push('heartbeat.enabled: should be boolean');
    }
    if (hb.model !== undefined && hb.model !== null) {
      if (typeof hb.model !== 'string' || !VALID_ROUTINE_MODEL.includes(hb.model)) {
        errors.push(`heartbeat.model: "${hb.model}" not in [${VALID_ROUTINE_MODEL.join(', ')}] (omit for haiku default; set null to use session model)`);
      }
    }
  }

  if (config.doctor && typeof config.doctor === 'object') {
    const floor = config.doctor.routine_cost_floor_usd;
    if (floor !== undefined && (typeof floor !== 'number' || floor < 0)) {
      errors.push(`doctor.routine_cost_floor_usd: expected non-negative number, got ${JSON.stringify(floor)}`);
    }
  }

  if (config.watchdog && typeof config.watchdog === 'object') {
    const wd = config.watchdog;
    if (typeof wd.enabled !== 'boolean') {
      warnings.push('watchdog.enabled: should be boolean');
    }
    if (wd.scheduler_enabled !== undefined && typeof wd.scheduler_enabled !== 'boolean') {
      warnings.push('watchdog.scheduler_enabled: should be boolean');
    }
    if (wd.stale_factor !== undefined) {
      if (typeof wd.stale_factor !== 'number' || wd.stale_factor <= 0) {
        warnings.push('watchdog.stale_factor: should be a positive number');
      }
    }
    if (wd.escalate_after !== undefined) {
      if (!Number.isInteger(wd.escalate_after) || wd.escalate_after < 1) {
        errors.push('watchdog.escalate_after: must be a positive integer');
      }
    }
  }

  if (config.budget && typeof config.budget === 'object') {
    const b = config.budget;
    for (const capKey of ['daily_usd', 'weekly_usd', 'monthly_usd']) {
      if (b[capKey] !== undefined && b[capKey] !== null) {
        if (typeof b[capKey] !== 'number' || b[capKey] <= 0) {
          errors.push(`budget.${capKey}: must be a positive number or null (null disables that cap)`);
        }
      }
    }
  }

  if (config.context_hygiene !== undefined) {
    if (typeof config.context_hygiene !== 'object' || config.context_hygiene === null) {
      errors.push('context_hygiene: must be an object');
    } else if (config.context_hygiene.compact !== undefined) {
      const c = config.context_hygiene.compact;
      if (typeof c !== 'object' || c === null) {
        errors.push('context_hygiene.compact: must be an object');
      } else {
        if (c.enabled !== undefined && typeof c.enabled !== 'boolean') {
          errors.push('context_hygiene.compact.enabled: must be a boolean');
        }
        if (c.min_context_tokens !== undefined) {
          if (typeof c.min_context_tokens !== 'number' || c.min_context_tokens <= 0) {
            errors.push('context_hygiene.compact.min_context_tokens: must be a positive number');
          }
        }
        if (c.min_interval !== undefined && typeof c.min_interval !== 'string') {
          warnings.push('context_hygiene.compact.min_interval: should be a duration string (e.g. "4h")');
        }
      }
    }
  }

  if (config.telemetry_export !== undefined) {
    if (typeof config.telemetry_export !== 'object' || config.telemetry_export === null || Array.isArray(config.telemetry_export)) {
      errors.push('telemetry_export: must be an object');
    } else {
      const t = config.telemetry_export;
      if (t.enabled !== undefined && typeof t.enabled !== 'boolean') {
        errors.push('telemetry_export.enabled: must be a boolean');
      }
      if (t.redact_operator_text !== undefined && typeof t.redact_operator_text !== 'boolean') {
        errors.push('telemetry_export.redact_operator_text: must be a boolean');
      }
      if (t.interval_hours !== undefined) {
        if (typeof t.interval_hours !== 'number' || t.interval_hours <= 0) {
          errors.push('telemetry_export.interval_hours: must be a positive number');
        }
      }
      const dest = t.destination;
      if (dest !== undefined) {
        if (typeof dest !== 'object' || dest === null || Array.isArray(dest)) {
          errors.push('telemetry_export.destination: must be an object');
        } else {
          if (dest.type !== undefined && !VALID_TELEMETRY_DEST.includes(dest.type)) {
            errors.push(`telemetry_export.destination.type: "${dest.type}" not in [${VALID_TELEMETRY_DEST.join(', ')}]`);
          }
          if (dest.url !== undefined && dest.url !== null && typeof dest.url !== 'string') {
            errors.push('telemetry_export.destination.url: must be a string or null');
          }
          if (typeof dest.url === 'string' && dest.url.trim() && !dest.url.startsWith('https://')) {
            // A plaintext http:// endpoint would leak the bearer token in the clear. Hard-fail
            // that combination for non-loopback hosts; http:// stays a warning for local receivers.
            const hasBearer = typeof dest.bearer_env === 'string' && dest.bearer_env.length > 0;
            if (hasBearer && !isLoopbackUrl(dest.url)) {
              errors.push('telemetry_export.destination.url: must be https:// when destination.bearer_env is set — a plaintext http:// endpoint would leak the token (http:// is allowed only for loopback receivers)');
            } else {
              warnings.push('telemetry_export.destination.url: should be an https:// URL');
            }
          }
          if (dest.bearer_env !== undefined && dest.bearer_env !== null) {
            if (typeof dest.bearer_env !== 'string') {
              errors.push('telemetry_export.destination.bearer_env: must be a string or null');
            } else if (!ENV_VAR_RE.test(dest.bearer_env)) {
              warnings.push('telemetry_export.destination.bearer_env: should look like an env var name (e.g. "HERMIT_TELEMETRY_TOKEN")');
            }
          }
        }
        if (t.enabled === true && (typeof dest?.url !== 'string' || !dest.url.trim())) {
          errors.push('telemetry_export.destination.url: required (non-empty string) when telemetry_export.enabled is true');
        }
      } else if (t.enabled === true) {
        errors.push('telemetry_export.destination: required when telemetry_export.enabled is true');
      }
    }
  }

  if (config.backup !== undefined) {
    if (typeof config.backup !== 'object' || config.backup === null || Array.isArray(config.backup)) {
      errors.push('backup: must be an object');
    } else {
      const b = config.backup;
      if (b.enabled !== undefined && typeof b.enabled !== 'boolean') {
        errors.push('backup.enabled: must be a boolean');
      }
      if (b.push !== undefined && typeof b.push !== 'boolean') {
        errors.push('backup.push: must be a boolean');
      }
      if (b.mode !== undefined && !VALID_BACKUP_MODE.includes(b.mode)) {
        errors.push(`backup.mode: "${b.mode}" not in [${VALID_BACKUP_MODE.join(', ')}]`);
      }
      if (b.schedule !== undefined) {
        if (typeof b.schedule !== 'string') {
          errors.push('backup.schedule: must be a string');
        } else {
          const err = validateCronSchedule(b.schedule);
          if (err) errors.push(`backup.schedule: invalid "${b.schedule}" — ${err}`);
        }
      } else if (b.enabled === true) {
        errors.push('backup.schedule: required when backup.enabled is true');
      }
      if (b.remote !== undefined && b.remote !== null) {
        if (typeof b.remote !== 'string') {
          errors.push('backup.remote: must be a string or null');
        } else if (b.remote.trim() && !toPushUrl(b.remote)) {
          errors.push(`backup.remote: "${b.remote}" is not a pushable remote — use https://, git@host:path, ssh://, file:// or an absolute path`);
        }
      }
      if (b.include !== undefined) {
        if (!Array.isArray(b.include)) {
          errors.push('backup.include: must be an array');
        } else {
          for (const v of b.include) {
            if (!VALID_BACKUP_INCLUDE.includes(v)) {
              errors.push(`backup.include: "${v}" not in [${VALID_BACKUP_INCLUDE.join(', ')}]`);
            }
          }
        }
      }
    }
  }

  if (config.env && typeof config.env === 'object') {
    for (const [k, v] of Object.entries(config.env)) {
      if (typeof v !== 'string') {
        warnings.push(`env.${k}: value should be a string, got ${typeof v}`);
      }
    }
  }

  if (config.knowledge !== undefined) {
    if (typeof config.knowledge !== 'object' || config.knowledge === null) {
      errors.push('knowledge: must be an object');
    } else {
      const k = config.knowledge;
      if (k.raw_retention_days !== undefined) {
        if (!Number.isInteger(k.raw_retention_days) || k.raw_retention_days <= 0) {
          errors.push('knowledge.raw_retention_days: must be a positive integer');
        }
      }
      if (k.compiled_budget_chars !== undefined) {
        if (!Number.isInteger(k.compiled_budget_chars) || k.compiled_budget_chars < 500 || k.compiled_budget_chars > 6000) {
          errors.push('knowledge.compiled_budget_chars: must be an integer between 500 and 6000');
        }
      }
      if (k.working_set_warn !== undefined) {
        if (!Number.isInteger(k.working_set_warn) || k.working_set_warn <= 0) {
          errors.push('knowledge.working_set_warn: must be a positive integer');
        }
      }
      if (k.usage_stale_days !== undefined) {
        if (!Number.isInteger(k.usage_stale_days) || k.usage_stale_days <= 0) {
          errors.push('knowledge.usage_stale_days: must be a positive integer');
        }
      }
      if (k.usage_auto_archive !== undefined) {
        // A string "false" would settle back to the `true` default and archive
        // the docs the operator was trying to protect — flag it rather than
        // silently coerce.
        if (k.usage_auto_archive !== null && typeof k.usage_auto_archive !== 'boolean') {
          errors.push('knowledge.usage_auto_archive: must be a boolean or null');
        }
      }
      if (k.archive_retention_days !== undefined) {
        if (k.archive_retention_days !== null && (!Number.isInteger(k.archive_retention_days) || k.archive_retention_days <= 0)) {
          errors.push('knowledge.archive_retention_days: must be a positive integer or null');
        }
      }
      if (k.channel_log_enabled !== undefined) {
        if (typeof k.channel_log_enabled !== 'boolean') {
          errors.push('knowledge.channel_log_enabled: must be a boolean');
        }
      }
      if (k.channel_log_retention_days !== undefined) {
        if (!Number.isInteger(k.channel_log_retention_days) || k.channel_log_retention_days <= 0) {
          errors.push('knowledge.channel_log_retention_days: must be a positive integer');
        }
      }
    }
  }

  if (config.monitors !== undefined && !Array.isArray(config.monitors)) {
    errors.push('monitors: must be an array');
  } else if (Array.isArray(config.monitors)) {
    const ids = new Set();
    config.monitors.forEach((m: Json, i: number) => {
      if (!m.id || typeof m.id !== 'string') {
        errors.push(`monitors[${i}]: missing or invalid id`);
      } else {
        if (ids.has(m.id)) warnings.push(`monitors[${i}]: duplicate id "${m.id}"`);
        ids.add(m.id);
      }
      if (!m.description || typeof m.description !== 'string') errors.push(`monitors[${i}]: missing description`);
      if (!m.command || typeof m.command !== 'string') errors.push(`monitors[${i}]: missing command`);
      if (m.persistent !== undefined && typeof m.persistent !== 'boolean') warnings.push(`monitors[${i}]: "persistent" should be boolean`);
      if (m.enabled !== undefined && typeof m.enabled !== 'boolean') warnings.push(`monitors[${i}]: "enabled" should be boolean`);
      if (m.class !== undefined && !['stream', 'poll'].includes(m.class)) errors.push(`monitors[${i}]: class must be "stream" or "poll"`);
      if (m.timeout_ms !== undefined && (typeof m.timeout_ms !== 'number' || m.timeout_ms < 1000)) errors.push(`monitors[${i}]: timeout_ms must be a number >= 1000`);
    });
  }

  if (config.push_notifications !== undefined && typeof config.push_notifications !== 'boolean') {
    errors.push('push_notifications: must be a boolean');
  }

  if (config.ask_gate !== undefined && typeof config.ask_gate !== 'boolean') {
    errors.push('ask_gate: must be a boolean');
  }

  if (config.settings_from_chat !== undefined) {
    warnings.push(retiredKeyWarning('settings_from_chat'));
  }

  if (config.artifacts !== undefined) {
    if (typeof config.artifacts !== 'object' || config.artifacts === null || Array.isArray(config.artifacts)) {
      errors.push('artifacts: must be an object');
    } else {
      if (config.artifacts.dashboard !== undefined && typeof config.artifacts.dashboard !== 'boolean') {
        errors.push('artifacts.dashboard: must be a boolean');
      }
      if (config.artifacts.proposals !== undefined && typeof config.artifacts.proposals !== 'boolean') {
        errors.push('artifacts.proposals: must be a boolean');
      }
      if (config.artifacts.weekly_review !== undefined && typeof config.artifacts.weekly_review !== 'boolean') {
        errors.push('artifacts.weekly_review: must be a boolean');
      }
      if (
        config.artifacts.publish_authorized !== undefined &&
        config.artifacts.publish_authorized !== null &&
        typeof config.artifacts.publish_authorized !== 'boolean'
      ) {
        errors.push('artifacts.publish_authorized: must be a boolean or null');
      }
      // Backstop, not the primary guard: settings-edit.ts refuses an empty value at
      // write time, but it writes through fs and so never trips the validate-config
      // PostToolUse hook — a hand-edited config.json would otherwise reach the publish
      // path with an empty string as the backend name.
      if (config.artifacts.backend !== undefined) {
        if (typeof config.artifacts.backend !== 'string') {
          errors.push('artifacts.backend: must be a string');
        } else if (config.artifacts.backend.trim() === '') {
          errors.push('artifacts.backend: must not be empty or whitespace-only');
        }
      }
    }
  }

  if (config.reflection !== undefined) {
    if (typeof config.reflection !== 'object' || config.reflection === null) {
      errors.push('reflection: must be an object');
    } else if (config.reflection.graduation_min_sessions !== undefined &&
        (!Number.isInteger(config.reflection.graduation_min_sessions) || config.reflection.graduation_min_sessions < 1)) {
      errors.push('reflection.graduation_min_sessions: must be a positive integer (≥1)');
    }
  }

  const clear = config.context_hygiene?.clear;
  if (clear !== undefined) {
    if (!clear || typeof clear !== 'object' || Array.isArray(clear)) errors.push('context_hygiene.clear: must be an object');
    else {
      if (clear.enabled !== undefined && typeof clear.enabled !== 'boolean') errors.push('context_hygiene.clear.enabled: must be a boolean');
      if (clear.min_tokens !== undefined && (typeof clear.min_tokens !== 'number' || !Number.isFinite(clear.min_tokens) || clear.min_tokens <= 0)) errors.push('context_hygiene.clear.min_tokens: must be a positive number');
      for (const key of ['quiet', 'max_age']) {
        if (clear[key] !== undefined && (typeof clear[key] !== 'string' || !/^\d+(?:\.\d+)?[smhd]$/.test(clear[key]))) errors.push(`context_hygiene.clear.${key}: must be a duration string`);
      }
    }
  }

  return { errors, warnings };
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    raw += chunk;
    if (raw.length > MAX_STDIN) process.exit(0);
  });
  process.stdin.on('end', () => {
    try {
      // Fast reject: skip if stdin doesn't mention config.json at all
      if (!raw.includes('config.json')) process.exit(0);

      const event = JSON.parse(raw);
      const filePath = (event.tool_input || {}).file_path || (event.tool_input || {}).path || '';

      if (path.basename(filePath) !== 'config.json' || !filePath.includes('.hermit')) {
        process.exit(0);
      }

      let config: Json;
      try {
        config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e: any) {
        process.stderr.write(`[config-validate] FAIL: config.json is not valid JSON — ${safeForLLM(e.message)}\n`);
        process.exit(2);
      }

      const { errors, warnings } = validate(config);

      if (warnings.length > 0) {
        process.stderr.write(`[config-validate] Warnings:\n`);
        warnings.forEach(w => process.stderr.write(`  WARN  ${safeForLLM(w)}\n`));
      }

      if (errors.length > 0) {
        process.stderr.write(`[config-validate] Errors:\n`);
        errors.forEach(e => process.stderr.write(`  FAIL  ${safeForLLM(e)}\n`));
        process.stderr.write(`[config-validate] Config validation failed — fix before proceeding\n`);
        process.exit(2);
      }

      else {
        process.stderr.write(`[config-validate] OK\n`);
      }
    } catch (e) {
      // Don't block the agent on parse errors
    }
  });
}

// Allow tests to import individual functions
export { parseCronField, validateCronSchedule, validate, isLoopbackUrl, ROUTINE_ID_RE, ENV_VAR_RE };

if (import.meta.main) {
  main();
}
