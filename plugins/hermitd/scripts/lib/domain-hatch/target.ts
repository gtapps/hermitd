// Core-owned read/repair/write of state/hatch-options.json.
//
// This file records the operator's global choice of where hermit blocks go
// (committed CLAUDE.md vs gitignored CLAUDE.local.md) plus the core install
// scope that choice was derived from. It is core state: before this module,
// five domain hatches each carried their own prose copy of the detection and
// stamping rules, one of which (feed) had already dropped the
// `projectPath == project root` qualifier and therefore resolved a
// project-scoped install to the wrong file.
//
// Two behaviours the prose copies did not have:
//   * repair — the write used to be gated on the FILE being absent while the
//     read fell back on the KEY being absent, so a file present without a
//     `target` key silently resolved to committed CLAUDE.md forever. Here a
//     missing/invalid key is a repair case, surfaced to the caller so it can
//     ask rather than assume.
//   * first-stamp preservation for every writer, not just core hatch.

import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from '../md-write';
import { localISOStamp } from '../time';
import { readJson } from '../cli';

type Json = any;

export type Target = 'local' | 'committed';
export type CoreScope = 'local' | 'project' | 'user' | null;

export interface HatchOptions {
  target: Target;
  core_install_scope: CoreScope;
  stamped_at: string;
  stamped_by: string;
  version: string;
  last_updated_at?: string;
  last_updated_by?: string;
}

export interface TargetState {
  /** Resolved target, or null when the file is absent or its key unusable. */
  target: Target | null;
  /** Scope-derived default to offer at position 0 when asking the operator. */
  target_default: Target;
  core_scope: CoreScope;
  /** True when the caller must ask the operator before a write can happen. */
  needs_target_question: boolean;
  /** Present and usable file that merely needs no change. */
  present: boolean;
}

export function optionsPath(hermitDir: string): string {
  return path.join(hermitDir, 'state', 'hatch-options.json');
}

function readOptions(hermitDir: string): Json {
  return readJson(optionsPath(hermitDir));
}

function isTarget(v: unknown): v is Target {
  return v === 'local' || v === 'committed';
}

// Core's own CLAUDE-APPEND marker. Where core already put its block is a
// stronger signal of the operator's intent than re-deriving install scope, so
// it outranks the scope default — this preserves hermit-evolve's fallback
// chain, which checked both files before falling back to detection.
const CORE_MARKER = 'hermitd: Session Discipline';

function fileHasCoreMarker(projectRoot: string, name: string): boolean {
  try { return fs.readFileSync(path.join(projectRoot, name), 'utf8').includes(CORE_MARKER); } catch { return false; }
}

// Full precedence chain, in one place for core hatch, hermit-evolve and every
// domain hatch:
//   1. hatch-options.json `target`
//   2. core's block already in CLAUDE.local.md  -> local
//   3. core's block already in CLAUDE.md        -> committed
//   4. scope-derived default from coreScope()
// Only (1) counts as answered; (2) and (3) inform the default a caller offers
// but still leave the file unstamped, so it gets repaired on the next write.
export function readTargetState(
  hermitDir: string,
  scopeDefault: { core_scope: CoreScope; target: Target },
  projectRoot?: string,
): TargetState {
  const existing = readOptions(hermitDir);
  const usable = existing && isTarget(existing.target);

  let fallback: Target = scopeDefault.target;
  if (!usable && projectRoot) {
    if (fileHasCoreMarker(projectRoot, 'CLAUDE.local.md')) fallback = 'local';
    else if (fileHasCoreMarker(projectRoot, 'CLAUDE.md')) fallback = 'committed';
  }

  return {
    target: usable ? existing.target : null,
    target_default: fallback,
    core_scope: scopeDefault.core_scope,
    needs_target_question: !usable,
    present: !!usable,
  };
}

export interface EnsureResult {
  action: 'created' | 'repaired' | 'updated' | 'unchanged';
  target: Target;
  path: string;
}

// Create, repair, or update the file. `stampedBy` is the caller's skill id
// (e.g. "hermitd-feed:hatch"); `version` is that caller's plugin version.
//
// An existing file keeps its original stamped_at/stamped_by — the first writer
// owns provenance — and records the later writer in last_updated_*. That is
// core hatch's own rule, now applied to every caller rather than restated per
// plugin.
export function ensureHatchTarget(
  hermitDir: string,
  opts: { target: Target; core_scope: CoreScope; stampedBy: string; version: string },
): EnsureResult {
  const p = optionsPath(hermitDir);
  const existing = readOptions(hermitDir);
  const hadFile = existing !== null;
  const hadTarget = hadFile && isTarget(existing.target);
  const now = localISOStamp();

  let next: HatchOptions;
  if (hadFile && typeof existing.stamped_by === 'string' && typeof existing.stamped_at === 'string') {
    next = {
      target: opts.target,
      core_install_scope: opts.core_scope,
      stamped_at: existing.stamped_at,
      stamped_by: existing.stamped_by,
      version: opts.version,
      last_updated_at: now,
      last_updated_by: opts.stampedBy,
    };
  } else {
    next = {
      target: opts.target,
      core_install_scope: opts.core_scope,
      stamped_at: now,
      stamped_by: opts.stampedBy,
      version: opts.version,
    };
  }

  const unchanged =
    hadTarget &&
    existing.target === next.target &&
    existing.core_install_scope === next.core_install_scope &&
    existing.version === next.version;

  let action: EnsureResult['action'];
  if (!hadFile) action = 'created';
  else if (!hadTarget) action = 'repaired';
  else action = unchanged ? 'unchanged' : 'updated';

  if (action !== 'unchanged') {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    writeFileAtomic(p, JSON.stringify(next, null, 2) + '\n');
  }
  return { action, target: next.target, path: p };
}

export function targetFile(target: Target): string {
  return target === 'local' ? 'CLAUDE.local.md' : 'CLAUDE.md';
}

export function settingsFile(target: Target): string {
  return target === 'local' ? 'settings.local.json' : 'settings.json';
}
