// The read-only verdict a domain hatch acts on.
//
// Replaces five prose copies of the same three steps (core-prereq check,
// idempotency gate, target routing). Four of those copies hardcoded a core
// version floor in skill text — HA 1.0.16, fitness 1.0.26, feed 1.2.22, forge
// 1.1.1 — while every one of those plugins declared `>=1.2.30` in its
// hermit-meta.json, so four hatches would proceed against a core too old for
// them. The floor is read from the manifest here and nowhere else.
//
// Writes nothing. `ensure-target` owns target mutations, so a
// hatch can always ask this what it is looking at before changing anything.

import path from 'node:path';
import { coreScope } from '../../resolve-siblings';
import { readJson } from '../cli';
import { readConfigRaw } from '../config-read';
import { resolvePlugin, isResolveError, pluginList, type ResolvedPlugin } from './resolve';
import { readTargetState, targetFile, type Target, type CoreScope } from './target';

type Json = any;

export type Action =
  | 'bootstrap_core'
  | 'upgrade_core_package'
  | 'upgrade_core_applied'
  | 'full'
  | 'verify';

/** Ordered commands that clear a stale or missing core. */
const NEXT_STEPS: Partial<Record<Action, (pluginId: string) => string[]>> = {
  bootstrap_core: (id) => ['/hermitd:hatch', `/${id}:hatch`],
  upgrade_core_package: (id) => ['hermitd update', '/hermitd:hermit-evolve', `/${id}:hatch`],
  upgrade_core_applied: (id) => ['/hermitd:hermit-evolve', `/${id}:hatch`],
};

export interface Preflight {
  error?: string;
  plugin: string;
  self_version?: string | null;
  stamped_version?: string | null;
  core_floor?: string | null;
  core_installed?: string | null;
  core_applied?: string | null;
  action?: Action;
  /** Ordered commands that clear a stale or missing core, on the upgrade and bootstrap actions only. */
  next_steps?: string[];
  target?: Target | null;
  target_default?: Target;
  target_file?: string;
  core_scope?: CoreScope;
  needs_target_question?: boolean;
}

// `>=1.2.30` and `^1.2.30` both appear in the fleet's manifests. Bun's semver
// handles either; the manual fallback covers only the `>=` form the
// hermit-meta files actually use, and is deliberately conservative — an
// unparseable range fails the check rather than waving it through.
export function satisfiesFloor(version: string | null, range: string | null): boolean {
  if (!range) return true; // nothing declared -> nothing to enforce
  if (!version) return false;
  const anyBun = (globalThis as any).Bun;
  if (anyBun?.semver?.satisfies) {
    try { return anyBun.semver.satisfies(version, range); } catch { /* fall through */ }
  }
  const m = range.match(/^>=\s*(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const want = [Number(m[1]), Number(m[2]), Number(m[3])];
  const got = version.split('.').map((n) => Number(n.replace(/[^\d].*$/, '')));
  for (let i = 0; i < 3; i++) {
    const a = got[i] ?? 0;
    const b = want[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

export interface PreflightInput {
  pluginId: string;
  hermitDir: string;
  projectRoot: string;
  corePluginRoot: string;
  /** Test seam: the plugin-list JSON, so tests never shell out to `claude`. */
  stdinJson?: string;
}

export function preflight(input: PreflightInput): Preflight {
  const { pluginId, hermitDir, projectRoot, corePluginRoot } = input;

  // Raw, not settled: absent/unreadable config IS the bootstrap_core signal.
  const config = readConfigRaw(hermitDir);
  if (config === null) {
    return { plugin: pluginId, action: 'bootstrap_core', next_steps: NEXT_STEPS.bootstrap_core!(pluginId) };
  }

  const list = pluginList(input.stdinJson);

  // Target resolution is computed first and reported unconditionally: none of
  // it depends on resolving the plugin (the stamped file and scope
  // detection do not require resolving the sibling). hermit-evolve takes hatch_target from
  // this verb and has no fallback of its own, so returning early on a plugin
  // list that could not be read would strand it with no target at all.
  const scope = coreScope(list as any, projectRoot);
  const state = readTargetState(hermitDir, scope);
  const targetFields = {
    target: state.target,
    target_default: state.target_default,
    ...(state.target ? { target_file: targetFile(state.target) } : {}),
    core_scope: state.core_scope,
    needs_target_question: state.needs_target_question,
  };

  const resolved = resolvePlugin(list, pluginId, projectRoot, corePluginRoot);
  if (isResolveError(resolved)) {
    return { error: resolved.error, plugin: pluginId, ...targetFields };
  }
  const self: ResolvedPlugin = resolved;

  const coreInstalled: string | null =
    readJson(path.join(corePluginRoot, '.claude-plugin', 'plugin.json'))?.version ?? null;
  const versions = (config._hermit_versions && typeof config._hermit_versions === 'object')
    ? config._hermit_versions
    : {};
  const coreApplied: string | null = versions['hermitd'] ?? null;
  const stamped: string | null = versions[pluginId] ?? null;

  // Two distinct staleness cases with two distinct remedies. `_hermit_versions`
  // is migration state that hermit-evolve advances; the resolved manifest is
  // installed code that only a package update can advance. Telling an operator
  // to run hermit-evolve when the package itself is old sends them to a command
  // that will report up-to-date and change nothing.
  const floor = self.required_core_version;
  const action: Action = !satisfiesFloor(coreInstalled, floor)
    ? 'upgrade_core_package'
    : !satisfiesFloor(coreApplied, floor)
      ? 'upgrade_core_applied'
      : stamped !== null && self.version !== null && stamped === self.version ? 'verify' : 'full';
  const nextSteps = NEXT_STEPS[action]?.(pluginId);

  return {
    plugin: pluginId,
    self_version: self.version,
    stamped_version: stamped,
    core_floor: floor,
    core_installed: coreInstalled,
    core_applied: coreApplied,
    action,
    ...(nextSteps ? { next_steps: nextSteps } : {}),
    ...targetFields,
  };
}
