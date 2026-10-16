// Deterministic writer for _hermit_versions in .hermit/config.json.
// Moves the step-9 version bump out of LLM prose into code, so a dropped bump
// surfaces as a blocked report instead of a silent mismatch (issue #426).
//
// NOTE: this is a runner-invoked script, NOT a fail-open hook. It exits non-zero
// on any write/verify failure so the evolve-runner can report `blocked` rather
// than claiming success. Do not apply the hook fail-open (exit 0) pattern here.
//
// Usage:
//   bun evolve-finalize.ts [hermit-dir] --core=<version> --plugin-root=<abs>
//                          [--sibling=<name>=<version> ...]
//   bun evolve-finalize.ts [hermit-dir] snapshot --core=<version>
//
// The `snapshot` mode runs at evolve step 1, before any migration touches
// config.json, and records the config the finalizer later diffs against. It is
// fail-open (always exit 0) — a missing snapshot only costs attribution detail,
// reported back as audit_scope. This script owns both ends of that lifecycle so
// evolve-plan.ts stays read-only and no second script needs sealing.
//
// hermit-dir defaults to .hermit (like evolve-plan.ts).
// --plugin-root cross-checks --core against plugin.json.version, so the stamp written
// here is always the loaded plugin's real version — check-upgrade.sh compares that stamp
// against plugin.json on every session start. Omit only in tests.
//
// The stamp only ever moves forward: see the monotonicity guard in finalize().
//
// Stdout: one JSON object matching FinalizeResult.
// Exit 0: ok:true and core confirmed on-disk.
// Exit 1: any error (no_core_target, no_config, config_json_invalid,
//          config_unreadable, plugin_json_unreadable, core_version_mismatch,
//          core_version_regression, bad_sibling_arg, write_failed, verify_failed,
//          fatal).

import fs from 'node:fs';
import path from 'node:path';
import { assertStateDir, pinStateDirOrExit } from './lib/cc-compat';
import { emitJson } from './lib/cli';
import { auditConfigChange, SNAPSHOT_FILE, SNAPSHOT_MAX_AGE_MS } from './lib/config-audit';
import { cmpSemver } from './lib/semver';
import { utcISOStamp } from './lib/time';
import { applyMissingDefaults, hasPath, isPlainObject } from './lib/evolve-config';

type Json = any;

export interface FinalizeResult {
  ok: boolean;
  core: { requested: string; confirmed: string | null; matched: boolean };
  siblings_confirmed: Record<string, string>;
  siblings_skipped: string[];
  /** Dotted paths this run added from the template, confirmed against the re-read.
   *  Empty when --plugin-root is omitted (no template to diff) or nothing was missing. */
  settings_added: string[];
  /** whole-run: `before` came from a step-1 snapshot, so migration writes are attributed.
   *  version-only: no usable snapshot, so the ledger sees just what finalize() itself wrote. */
  audit_scope: 'whole-run' | 'version-only';
  errors: { code: string; message: string }[];
}

// Pre-migration config snapshot, written at evolve step 1 and consumed here.
// hermit-evolve's step 2b migrations write config.json (through settings-edit)
// long before this script reads it, so a `before` taken here would miss them and
// could only ever show the version stamp and this run's own defaults merge. The
// snapshot moves `before` ahead of those writes, which is what lets the ledger
// answer "why did this setting change during the upgrade?".
// SNAPSHOT_FILE / SNAPSHOT_MAX_AGE_MS live in config-audit.ts so step-time
// writes can detect a live snapshot without importing this script. A snapshot
// older than the window is not trusted: a prior run wrote one and aborted
// before step 9, the operator then edited config by hand, and a later run
// drops the (model-performed) step-1 snapshot: the stale file would attribute
// the operator's own edits to the upgrade. Degrading to version-only is honest;
// a wrong row is not.

function snapshotPath(hermitDir: string): string {
  return path.join(hermitDir, 'state', SNAPSHOT_FILE);
}

/**
 * Write the pre-migration snapshot. Fail-open by contract: a snapshot that can't
 * be written degrades the audit to version-only, and must never block an upgrade.
 * Returns the stdout object: `{path}` on success, a skip status otherwise.
 */
export function writeSnapshot(hermitDir: string, core: string | null): Record<string, string> {
  if (!core || core.trim() === '') return { status: 'skip', reason: 'core_required' };
  try {
    const config = JSON.parse(fs.readFileSync(path.join(hermitDir, 'config.json'), 'utf8'));
    const file = snapshotPath(hermitDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Config carries channel tokens and an env block — same 0600 care the ledger
    // itself takes (lib/config-audit.ts). mode is only honored on create, so chmod
    // the tmp path too in case a previous run left one behind.
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ts: utcISOStamp(), to: core, config }, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    return { path: file };
  } catch (e: any) {
    try { fs.unlinkSync(snapshotPath(hermitDir) + '.tmp'); } catch {}
    return { status: 'skip', reason: 'snapshot_failed', detail: e.message };
  }
}

/**
 * Read the snapshot for this upgrade. Returns the snapshotted config only when it
 * is parseable, was taken for this same `--core` target, and is recent.
 *
 * An unusable snapshot is removed on the spot. A usable one is left on disk until
 * the ledger row is actually written (see the unlink after auditConfigChange) —
 * every early return between here and there leaves config.json carrying step-2b's
 * migration writes with no row to explain them, and consuming the snapshot first
 * would make the retry that fixes the failure unable to attribute them either.
 * SNAPSHOT_MAX_AGE_MS contains the case where the retry never comes.
 */
function readSnapshot(hermitDir: string, core: string): Json | undefined {
  const file = snapshotPath(hermitDir);
  const discard = () => { try { fs.unlinkSync(file); } catch {} };
  let snap: Json;
  try {
    snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    discard();
    return undefined;
  }
  if (!isPlainObject(snap) || snap.to !== core || snap.config === undefined) {
    discard();
    return undefined;
  }
  const taken = new Date(snap.ts).getTime();
  if (Number.isNaN(taken) || Date.now() - taken > SNAPSHOT_MAX_AGE_MS) {
    discard();
    return undefined;
  }
  return snap.config;
}

function parseArgs(argv: string[]): {
  hermitDir: string;
  core: string | null;
  pluginRoot: string | null;
  siblings: { name: string; version: string }[];
} {
  let hermitDir = '.hermit';
  let core: string | null = null;
  let pluginRoot: string | null = null;
  const siblings: { name: string; version: string }[] = [];

  for (const a of argv) {
    if (a.startsWith('--core=')) {
      core = a.slice('--core='.length);
    } else if (a.startsWith('--plugin-root=')) {
      pluginRoot = a.slice('--plugin-root='.length);
    } else if (a.startsWith('--sibling=')) {
      const rest = a.slice('--sibling='.length);
      const eq = rest.indexOf('=');
      siblings.push(
        eq === -1
          ? { name: rest, version: '' }                           // malformed — caught in finalize
          : { name: rest.slice(0, eq), version: rest.slice(eq + 1) },
      );
    } else if (!a.startsWith('--') && a !== '') {
      hermitDir = a;
    }
  }
  return { hermitDir, core, pluginRoot, siblings };
}

export function finalize(opts: {
  hermitDir: string;
  core: string | null;
  pluginRoot: string | null;
  siblings: { name: string; version: string }[];
}): FinalizeResult {
  const errors: { code: string; message: string }[] = [];
  const siblingsSkipped: string[] = [];

  // Every rejection below returns the same shape: nothing confirmed, nothing added,
  // version-only attribution, carrying whatever has been pushed to `errors` and
  // `siblingsSkipped` by then (both captured by reference, so this reads their state
  // at call time). Push the error, then `return fail()`.
  const fail = (): FinalizeResult => ({
    ok: false,
    core: { requested: opts.core ?? '', confirmed: null, matched: false },
    siblings_confirmed: {},
    siblings_skipped: siblingsSkipped,
    settings_added: [],
    audit_scope: 'version-only',
    errors,
  });

  if (!opts.core || opts.core.trim() === '') {
    errors.push({ code: 'no_core_target', message: '--core=<version> is required' });
    return fail();
  }

  // Validate sibling args. Malformed entries go to siblings_skipped (not errors) —
  // the runner always constructs valid args so a bad arg is a programming fault, not
  // a bump failure. It does not affect ok or block reporting.
  const validSiblings: { name: string; version: string }[] = [];
  for (const s of opts.siblings) {
    if (!s.name || s.version === '') {
      siblingsSkipped.push(`[bad-arg:${s.name || ''}]`);
    } else {
      validSiblings.push(s);
    }
  }

  // Cross-check --core against plugin.json.version: the stamp must be the loaded plugin's
  // real version, which is what check-upgrade.sh compares against at session start.
  // (Direction is a separate invariant — see the monotonicity guard below.)
  if (opts.pluginRoot) {
    let pluginVer: string | null = null;
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(opts.pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
      pluginVer = typeof pj.version === 'string' ? pj.version : null;
    } catch (e: any) {
      errors.push({ code: 'plugin_json_unreadable', message: e.message });
      return fail();
    }
    if (pluginVer === null) {
      errors.push({ code: 'plugin_json_unreadable', message: 'plugin.json missing .version field' });
      return fail();
    }
    if (pluginVer !== opts.core) {
      errors.push({ code: 'core_version_mismatch', message: `--core="${opts.core}" does not match plugin.json version="${pluginVer}"` });
      return fail();
    }
  }

  // Read live config from disk (after step 2b's migrations, which write via settings-edit)
  const configPath = path.join(opts.hermitDir, 'config.json');
  let config: Json;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e: any) {
    const code = e && e.code === 'ENOENT' ? 'no_config'
      : e && e.name === 'SyntaxError' ? 'config_json_invalid'
      : 'config_unreadable';
    errors.push({ code, message: e.message });
    return fail();
  }
  // The audit `before`. Prefer the step-1 snapshot: it predates hermit-evolve's
  // step 2b migrations and step 9 merge, so one diff covers everything the upgrade
  // did to config.json. Without it, fall back to the live read — which by then
  // already contains those writes, so the ledger can only show the version stamp.
  // Either way `config` is mutated in place from here on, hence the clone.
  const snapshotBefore = readSnapshot(opts.hermitDir, opts.core);
  const hasSnapshot = snapshotBefore !== undefined;
  const auditScope: 'whole-run' | 'version-only' = hasSnapshot ? 'whole-run' : 'version-only';
  const configBefore = hasSnapshot ? snapshotBefore : structuredClone(config);

  // Monotonicity guard. The stamp records which migrations have been APPLIED, so moving
  // it backwards claims migrations were reversed when nothing reversed them. That state
  // is reachable without this guard: when the session loads a stale (older) plugin copy,
  // the cross-check above passes (--core does equal that copy's plugin.json) and evolve
  // can still be running for sibling work, so step 9 would stamp the older version.
  // evolve-plan's `loaded_core_older_than_applied` blocks this upstream; this is the
  // backstop for any caller that skips the planner. Rejecting BEFORE any mutation is what
  // leaves config.json byte-identical and the sibling writes below unreached.
  //
  // Strictly-older only. Equal must pass: the documented sibling-only run re-stamps the
  // same version by design, and so does a re-run after a crash. An absent or unparseable
  // on-disk stamp also passes — absent is bootstrap (the object is created below), and
  // cmpSemver reads garbage as equal, which lets this sole writer REPAIR a hand-mangled
  // stamp instead of wedging evolve with no in-band recovery.
  const onDiskCore = isPlainObject(config._hermit_versions)
    ? config._hermit_versions['hermitd']
    : undefined;
  if (typeof onDiskCore === 'string' && cmpSemver(opts.core, onDiskCore) < 0) {
    errors.push({
      code: 'core_version_regression',
      message: `--core="${opts.core}" is older than the applied version "${onDiskCore}" in _hermit_versions — refusing to downgrade the stamp (migrations are not reversed by lowering it). The loaded plugin is likely a stale install copy.`,
    });
    return fail();
  }

  // Missing template defaults, applied here rather than by the runner in prose.
  // Derived against the config just read from disk, so anything an Upgrade
  // Instruction or the runner's own auto-detect (language/timezone) already wrote
  // is present and therefore never revisited — missing-only, operator values safe.
  // Riding in the single write below is what keeps a half-merged config impossible.
  // No --plugin-root (tests, and only tests, omit it), or no template under it,
  // means nothing to diff against — the version bump is this script's contract and
  // proceeds either way. A template
  // that exists but is malformed throws to main()'s handler as `fatal`, before the
  // write below, so config.json is left byte-identical.
  let settingsAdded: string[] = [];
  const tmplPath = opts.pluginRoot
    ? path.join(opts.pluginRoot, 'state-templates', 'config.json.template')
    : null;
  if (tmplPath && fs.existsSync(tmplPath)) {
    settingsAdded = applyMissingDefaults(config, JSON.parse(fs.readFileSync(tmplPath, 'utf8')));
  }

  // Core is the install marker so it's safe to create the object if absent.
  // Unconditional bump covers the step-10 deferred-migration caveat (always forward or
  // equal — the guard above has already rejected the backward direction).
  if (!isPlainObject(config._hermit_versions)) {
    config._hermit_versions = {};
  }
  config._hermit_versions['hermitd'] = opts.core;

  // Never add a new sibling key — only update keys already present.
  // Sibling versions arrive from a runner-assembled command line and get no plugin.json
  // cross-check, so apply the same no-downgrade rule here. A bad sibling arg is a skip,
  // never a failure: the file's existing posture (see [bad-arg:…] above) is that one
  // malformed sibling must not report an otherwise-good core bump as blocked.
  const appliedSiblingNames: string[] = [];
  for (const s of validSiblings) {
    if (Object.prototype.hasOwnProperty.call(config._hermit_versions, s.name)) {
      const existing = config._hermit_versions[s.name];
      if (typeof existing === 'string' && cmpSemver(s.version, existing) < 0) {
        siblingsSkipped.push(`[regression:${s.name}]`);
        continue;
      }
      config._hermit_versions[s.name] = s.version;
      appliedSiblingNames.push(s.name);
    } else {
      siblingsSkipped.push(s.name);
    }
  }

  // Atomic write: serialize → .tmp → rename (mirrors lib/cost-log.ts:60-62)
  const tmp = configPath + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, configPath);
  } catch (e: any) {
    try { fs.unlinkSync(tmp); } catch {}
    errors.push({ code: 'write_failed', message: e.message });
    return fail();
  }
  // Re-read from disk to confirm (the fix's whole point — catches a write that didn't land)
  let onDisk: Json;
  try {
    onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e: any) {
    errors.push({ code: 'verify_failed', message: `re-read after write failed: ${e.message}` });
    return fail();
  }

  const coreOnDisk: string = (isPlainObject(onDisk._hermit_versions) ? onDisk._hermit_versions['hermitd'] : null) ?? '';
  const coreMatched = coreOnDisk === opts.core;
  if (!coreMatched) {
    errors.push({ code: 'verify_failed', message: `on-disk _hermit_versions["hermitd"]="${coreOnDisk}" but expected "${opts.core}"` });
  }

  // Audit against `onDisk` — the re-read — not the in-memory object. That is what
  // keeps the ledger honest in the exact case this verification exists to catch: a
  // write that reported success but did not land leaves the old value in `onDisk`,
  // so the diff emits no _hermit_versions row on its own. Gating the whole call on
  // coreMatched would be wrong under a whole-run snapshot — it would suppress the
  // upgrade's real migration rows whenever the version bump failed, which is
  // backwards. The re-read succeeding is the only precondition.
  auditConfigChange(
    opts.hermitDir,
    configBefore,
    onDisk,
    auditScope === 'whole-run' ? 'hermit-evolve' : 'evolve-finalize',
  );
  // Single-use, consumed only now that the row it feeds exists. Retained above so a
  // run that dies before this point can be retried with attribution intact.
  if (hasSnapshot) { try { fs.unlinkSync(snapshotPath(opts.hermitDir)); } catch {} }

  const siblingsConfirmed: Record<string, string> = {};
  for (const name of appliedSiblingNames) {
    siblingsConfirmed[name] = onDisk._hermit_versions[name] ?? '';
  }

  return {
    ok: errors.length === 0 && coreMatched,
    core: { requested: opts.core, confirmed: coreOnDisk, matched: coreMatched },
    siblings_confirmed: siblingsConfirmed,
    siblings_skipped: siblingsSkipped,
    // Confirmed against the re-read, same rule as core/siblings above: report what
    // is on disk, never what we intended to write.
    settings_added: settingsAdded.filter((p) => hasPath(onDisk, p)),
    audit_scope: auditScope,
    errors,
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  // `snapshot` is a bare word, so strip it before parseArgs — which treats any
  // non-`--` argument as the hermit dir.
  const snapshotMode = argv.includes('snapshot');
  const { hermitDir, core, pluginRoot, siblings } = parseArgs(argv.filter((a) => a !== 'snapshot'));

  if (snapshotMode) {
    // Fail-open, unlike the finalize path below: a missing snapshot degrades the
    // audit to version-only (reported as audit_scope), and must never stop an upgrade.
    // Same state-dir pin — the sealed grant covers every argument to this script —
    // but a foreign dir skips instead of exiting 1: declining to write is already the
    // outcome the pin exists to force, and a non-zero exit here would read to the
    // runner as an upgrade failure.
    const pinned = assertStateDir(hermitDir);
    emitJson(pinned
      ? writeSnapshot(pinned, core)
      : { status: 'skip', reason: 'foreign_state_dir', detail: `state dir must be this project's; got ${hermitDir}` });
  }

  let result: FinalizeResult;
  try {
    // The hermit dir is not caller-chosen. Reachable through a pre-approved
    // `Bash(bun */scripts/evolve-finalize.ts*)` grant that covers every
    // argument, and this script rewrites config.json wholesale — an
    // unvalidated root let one such call stamp _hermit_versions into another
    // project's config. See lib/cc-compat.ts assertStateDir().
    result = finalize({ hermitDir: pinStateDirOrExit(hermitDir, 'evolve-finalize'), core, pluginRoot, siblings });
  } catch (e: any) {
    result = {
      ok: false,
      core: { requested: core ?? '', confirmed: null, matched: false },
      siblings_confirmed: {},
      siblings_skipped: [],
      settings_added: [],
      audit_scope: 'version-only',
      errors: [{ code: 'fatal', message: e.message }],
    };
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.ok ? 0 : 1);
}
