#!/usr/bin/env bun
/**
 * Apply the plugin's sealed permission list as part of `hermitd update`.
 *
 * Usage (project root, the newly installed core's copy): bun <install>/scripts/update-permissions.ts
 *
 * The host and Docker update commands run this right after the core plugin pin
 * moves. The operator runs that command (from a terminal, or behind the native
 * permission prompt when the agent runs it), so no model-issued settings write
 * reaches the auto-mode classifier; hermit-evolve only reports what is still
 * pending. The settings file is the one hermit-evolve resolves: the stamped hatch
 * target, else the install-scope default.
 *
 * Prints apply-settings' plan plus `settings_file` and a one-line `summary`, or
 * {"status":"skipped","reason":"not_hatched"}.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { emitJson } from './lib/cli';
import { readConfigRaw } from './lib/config-read';
import { preflight } from './lib/domain-hatch/preflight';
import { settingsFile } from './lib/domain-hatch/target';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');

const hermitDir = path.resolve('.hermit');
// Hatch asks before it writes this list; before then the install has no version stamp.
if (typeof readConfigRaw(hermitDir)?._hermit_versions?.hermitd !== 'string') emitJson({ status: 'skipped', reason: 'not_hatched' });

const pre = preflight({ pluginId: 'hermitd', hermitDir, projectRoot: process.cwd(), corePluginRoot: PLUGIN_ROOT });
// A readable config always yields the install-scope default when no target is stamped.
const settings_file = `.claude/${settingsFile((pre.target ?? pre.target_default)!)}`;
const r = spawnSync('bun', [path.join(PLUGIN_ROOT, 'scripts', 'apply-settings.ts'), settings_file, 'permissions-sync'], { encoding: 'utf-8' });
let plan: any = null;
try { plan = JSON.parse(r.stdout); } catch { /* reported below */ }
if (r.status !== 0 || !Array.isArray(plan?.missing)) emitJson({ error: `sync_failed:${(r.stdout || r.stderr || '').trim()}` });

const parts = [`${plan.missing.length} added`, `${plan.obsolete.length} retired`];
if (plan.obsolete_deny.length) parts.push(`retired deny rules removed: ${plan.obsolete_deny.join(', ')}`);
if (plan.other_file) {
  const other = [...plan.other_file.obsolete, ...plan.other_file.obsolete_deny];
  parts.push(`removed from ${plan.other_file.settings_file}: ${other.join(', ')}`);
}
emitJson({ settings_file, ...plan, summary: `${settings_file}: ${parts.join('; ')}` });
