#!/usr/bin/env bun
/**
 * Deterministic config.json assembly for /hatch Step 5.
 *
 * Step 5 is otherwise a ~40-line hand-assembly algorithm the LLM follows to merge
 * state-templates/config.json.template with wizard answers — the last hand-transcription
 * surface on hatch. This collapses it into one deterministic call: the wizard still owns
 * every AskUserQuestion, but the template->config transform is code, not prose the model
 * re-derives every run.
 *
 * Usage: bun hatch-config.ts <PROJECT_ROOT> [--reinit]   (answers JSON on stdin)
 *
 * Fresh (no --reinit): base = state-templates/config.json.template. Substitutes
 * {project_name}, then overlays answers.
 *
 * Re-init (--reinit): base = the EXISTING .hermit/config.json (strict read —
 * malformed JSON refuses without touching the file). This is what makes re-init
 * non-destructive: any key the overlay steps below don't touch (custom operator keys,
 * push_notifications, docker settings, monitors, ...) survives untouched because it was
 * never cleared to begin with.
 *
 * _hermit_versions: the core version is read from THIS script's own plugin.json, never
 * from the answers payload — an operator-supplied version could otherwise advance
 * `_hermit_versions["hermitd"]` on re-init and erase the upgrade gap
 * hermit-evolve's evolve-plan.ts reads to discover pending migrations. The core
 * entry is stamped add-if-absent, never bumped — mirrors evolve-finalize.ts's
 * sibling-version contract. Domain plugins stamp themselves from their own hatch.
 *
 * Validation: this script does not re-implement answer validation. It overlays by
 * presence (Object.hasOwn, never truthiness, so `remote:false`/`null` apply) and lets
 * the imported validate(config) reject the assembled output — the same guard the
 * PostToolUse hook runs on every config.json write.
 *
 * Prints `OK` on success, or `{"kept_errors":[...]}` when a re-init leaves errors the
 * config already carried. Failure prints `{"error":"<token>[:detail]"}` (validation:
 * `{"error":"invalid_config","errors":[...]}`) and exits 1 with nothing written.
 */

import fs from 'node:fs';
import path from 'node:path';
import { validate } from './validate-config';
import { persistConfig } from './lib/config-write';
import { configExists, readConfigRaw } from './lib/config-read';
import { emit, emitJson, exitError } from './lib/cli';

type Json = any;

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '..');
const TEMPLATE_PATH = path.join(PLUGIN_ROOT, 'state-templates', 'config.json.template');

// --- CLI args ---
const projectRoot = process.argv[2];
if (!projectRoot) exitError();
const reinit = process.argv.slice(3).some((a) => a === '--reinit' || a === '--reinit=true');

// --- stdin: answers payload ---
function readStdinSync(): string {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

let answers: Json;
try {
  answers = JSON.parse(readStdinSync() || '{}');
} catch (e: any) {
  exitError(`invalid_answers:${e.message}`);
}

// --- read own plugin version (never from the answers payload — see header) ---
let coreVersion: string;
try {
  const ownPluginJson = JSON.parse(
    fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'),
  );
  coreVersion = ownPluginJson.version;
} catch (e: any) {
  exitError(`plugin_json_unreadable:${e.message}`);
}

// --- load base: template (fresh) or existing config, strictly (re-init) ---
const hermitDir = path.join(projectRoot, '.hermit');
const configPath = path.join(hermitDir, 'config.json');
const exists = fs.existsSync(configPath);

if (reinit && !exists) exitError(`no_config:${configPath}`);
if (!reinit && exists) exitError(`config_exists:${configPath}`);

let config: Json;
// Errors the operator's config already carried before this run. Only relevant on
// re-init, where the base IS their config: blocking on a pre-existing error (a
// pending migration, say) would lock them out of the re-hatch, and re-init is one
// of the things that fixes such a config. Mirrors settings-edit.ts's persist().
let priorErrors: string[] = [];
if (reinit) {
  // Strict read: malformed JSON refuses without writing anything, preserving the
  // file's exact bytes (mirrors apply-settings.ts's readTargetJson, not its
  // permissive readJson which would silently discard the file as `{}`).
  const raw = fs.readFileSync(configPath, 'utf8');
  if (raw.trim() === '') exitError(`config_empty:${configPath}`);
  try {
    config = JSON.parse(raw);
  } catch (e: any) {
    exitError(`config_json_invalid:${e.message}`);
  }
  priorErrors = validate(JSON.parse(raw)).errors;
} else {
  try {
    config = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
  } catch (e: any) {
    exitError(`template_unreadable:${e.message}`);
  }
  if (!answers.project_name) exitError('invalid_answers:project_name');
  config.tmux_session_name = String(config.tmux_session_name).replace('{project_name}', answers.project_name);
}

// --- scalar overlay (present-by-hasOwn, both modes) ---
const SCALAR_KEYS = [
  'agent_name', 'language', 'timezone',
  'escalation', 'remote', 'permission_mode',
];
for (const key of SCALAR_KEYS) {
  if (Object.hasOwn(answers, key)) config[key] = answers[key];
}

// --- routines: upsert/remove morning + evening by id, never touch other routines ---
function timeToCron(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return `${m} ${h} * * *`;
}

if (Object.hasOwn(answers, 'routines')) {
  const routinesAnswer = answers.routines || {};
  config.routines = Array.isArray(config.routines) ? config.routines : [];
  for (const slot of ['morning', 'evening']) {
    const id = `hermitd:${slot}`;
    const time = routinesAnswer[`${slot}_time`];
    if (!routinesAnswer.enabled || !time) {
      config.routines = config.routines.filter((r: Json) => r?.id !== id);
      continue;
    }
    const existing = config.routines.find((r: Json) => r?.id === id);
    if (existing) {
      existing.schedule = timeToCron(time);
      existing.enabled = true;
    } else {
      config.routines.push({ id, schedule: timeToCron(time), skill: `hermitd:brief --${slot}`, enabled: true });
    }
  }
}

// --- _hermit_versions: add-if-absent only, never bump (Finding 1) ---
config._hermit_versions =
  config._hermit_versions && typeof config._hermit_versions === 'object' ? config._hermit_versions : {};

if (!Object.hasOwn(config._hermit_versions, 'hermitd')) {
  config._hermit_versions['hermitd'] = coreVersion;
}
if (Object.hasOwn(answers, 'activated_hermit') && answers.activated_hermit) {
  // slug is hand-built by the model from detected_hermits — refuse a malformed
  // slug rather than let hatch-report.ts carry an undefined hermit_extension.
  // A stray `version` key (older skill text) is ignored; domain plugins stamp
  // `_hermit_versions` from their own hatch.
  const { slug } = answers.activated_hermit;
  if (typeof slug !== 'string' || !slug) exitError('invalid_answers:activated_hermit.slug');
}

// --- channels: field-level merge, preserve learned/unknown state on re-init ---
if (Object.hasOwn(answers, 'channels')) {
  const answerChannels = answers.channels;
  if (!answerChannels || typeof answerChannels !== 'object') exitError('invalid_answers:channels');
  config.channels = config.channels && typeof config.channels === 'object' ? config.channels : {};
  for (const [name, ansRaw] of Object.entries<Json>(answerChannels)) {
    const ans = ansRaw && typeof ansRaw === 'object' ? ansRaw : {};
    const isNewEntry = !(config.channels[name] && typeof config.channels[name] === 'object');
    const existing = isNewEntry ? {} : config.channels[name];
    const merged: Json = { ...existing };
    if (Object.hasOwn(ans, 'enabled')) merged.enabled = ans.enabled;
    else if (!Object.hasOwn(merged, 'enabled')) merged.enabled = true;
    // Pinned proactive home — seeded by channel-hook at first pairing, moved
    // only from the terminal. A configured pin rides the ...existing spread.
    if (!Object.hasOwn(merged, 'default_chat_id')) merged.default_chat_id = null;
    if (Object.hasOwn(ans, 'state_dir')) merged.state_dir = ans.state_dir;
    else if (!Object.hasOwn(merged, 'state_dir')) merged.state_dir = `.claude.local/channels/${name}`;
    if (Object.hasOwn(ans, 'allowed_users')) merged.allowed_users = ans.allowed_users;
    if (Object.hasOwn(ans, 'passive_chats')) {
      merged.passive_chats = ans.passive_chats;
      // An explicit replacement must pass validation even if the old value had the same error.
      priorErrors = priorErrors.filter((e) => !e.startsWith(`channels.${name}.passive_chats:`));
    }
    for (const key of ['isolate_chats', 'shared_chats', 'operators', 'log_chats']) {
      if (Object.hasOwn(ans, key)) {
        merged[key] = ans[key];
        priorErrors = priorErrors.filter((e) => !e.startsWith(`channels.${name}.${key}:`));
      }
    }
    // Outbound-only second destination for maintainer-tier alerts; a freshly
    // answered value must survive re-init (existing values ride the ...existing spread).
    if (Object.hasOwn(ans, 'maintainer_channel_id')) merged.maintainer_channel_id = ans.maintainer_channel_id;
    // morning_brief is a two-way switch: a time enables it, an explicit null/empty
    // time disables it (so re-init can turn off a brief the operator previously set).
    if (Object.hasOwn(ans, 'morning_brief_time')) {
      merged.morning_brief = ans.morning_brief_time
        ? { enabled: true, time: ans.morning_brief_time }
        : { enabled: false };
    }
    config.channels[name] = merged;
  }
  // push_notifications is deliberately never touched here — stays at whatever the
  // base (template default `true`, or the existing re-init value) already carries.
}

// Only errors introduced by this run block persistence.
const preExisting = configExists(hermitDir) ? (readConfigRaw(hermitDir) ?? {}) : undefined;
let result;
try {
  result = persistConfig({ hermitDir, before: preExisting, after: config, actor: 'hatch-config', priorErrors });
} catch (e: any) {
  exitError(`write_failed:${e.message}`);
}
const { newErrors, keptErrors } = result;
if (newErrors.length > 0) emitJson({ error: 'invalid_config', errors: newErrors });
if (keptErrors.length > 0) emitJson({ kept_errors: keptErrors });
emit('OK');
