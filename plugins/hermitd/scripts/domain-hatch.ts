#!/usr/bin/env bun
// domain-hatch.ts — the shared protocol every domain hatch runs, over
// lib/domain-hatch/.
//
// Reached from a domain plugin as:
//   .hermit/bin/hermitd-run domain-hatch <verb> <plugin-id> [args]
// A domain plugin's own ${CLAUDE_PLUGIN_ROOT} is
// <cache>/<marketplace>/<plugin>/<version>/ and cannot resolve core's, so the
// project-resident bin/hermitd-run dispatcher is the route in.
//
// Usage:
//   bun domain-hatch.ts preflight <plugin-id>
//     Read-only. Prints one JSON verdict: which of the two stale-core cases
//     applies (if any), whether this is a full run or a re-verify, the resolved
//     CLAUDE target, and what the CLAUDE-APPEND block needs. An unresolved
//     plugin is `{error:"plugin_*",...}` at exit 1 and still carries the target
//     fields, which hermit-evolve reads either way.
//
//   bun domain-hatch.ts ensure-target <plugin-id> --target <local|committed>
//     Creates or repairs state/hatch-options.json. Core owns this file; the
//     verb exists so domain hatches stop carrying their own copy of the
//     detection and stamping rules.
//
//   bun domain-hatch.ts sync-block <plugin-id> [--rendered-stdin]
//     Appends the plugin's CLAUDE-APPEND block when absent, replaces it only
//     when rendered content is piped in and differs, refuses on a duplicated
//     marker. Version-driven refresh stays hermit-evolve's.
//
// stateDir/projectRoot are always derived from hermitDir(), never argv: this
// script is reachable through a pre-approved
// `Bash(.hermit/bin/hermitd-run domain-hatch <verb> *)` grant that
// covers every argument, so a `--state-dir`/`--project-root` override would
// have let one such call point ensure-target/sync-block at another project's
// state or CLAUDE.md. The plugin list is always live for the same reason: a
// forged list (the removed `--plugin-list-file` test seam) steers
// resolvePlugin() -> installPath -> planBlock(), which reads the CLAUDE-APPEND
// block from that path and writes it into the operator's CLAUDE.md — a forged
// list is attacker-authored content landing in the file that steers the agent.
// Tests exercise this at the library boundary (lib/domain-hatch/*) with
// explicit roots instead of shelling out to this CLI with overrides.
//
// Every verb's argv beyond <plugin-id> is allow-listed below; anything else
// exits 1 with `unexpected_args` rather than being silently ignored.
//
// Verb dispatch is lazy: preflight is the hot path (every hatch run, including
// the re-verify that changes nothing) and has no business loading the block
// writer to do its job.
//
// Output follows the helper convention: one JSON object, exit 1 iff it carries
// `error`.

import path from 'node:path';
import { hermitDir } from './lib/cc-compat';
import { emitJson, exitError, failJson } from './lib/cli';

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '..');

const argv = process.argv.slice(2);
const verb = argv[0];
const pluginId = argv[1];
const rest = argv.slice(2);

async function readStdinIfFlagged(flag: string): Promise<string | undefined> {
  if (!argv.includes(flag)) return undefined;
  let buf = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) buf += chunk;
  return buf;
}

async function main(): Promise<void> {
  if (!verb || !pluginId) exitError('usage');

  // A plugin id is a bare plugin name — reject anything that could be read as a
  // path. hermitd-exec.sh checks the script name but forwards the rest of argv
  // untouched, so this is the only place the identity argument is validated.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(pluginId)) exitError('invalid_plugin_id');

  const stateDir = hermitDir();
  const projectRoot = path.resolve(stateDir, '..');

  if (verb === 'preflight') {
    if (rest.length) exitError('unexpected_args');
    const { preflight } = await import('./lib/domain-hatch/preflight');
    emitJson(preflight({ pluginId, hermitDir: stateDir, projectRoot, corePluginRoot: PLUGIN_ROOT }));
  }

  if (verb === 'ensure-target') {
    if (rest.length !== 2 || rest[0] !== '--target') exitError('unexpected_args');
    const target = rest[1];
    if (target !== 'local' && target !== 'committed') exitError('bad_target');
    const [{ ensureHatchTarget }, { resolvePlugin, isResolveError, pluginList }, { coreScope }] = await Promise.all([
      import('./lib/domain-hatch/target'),
      import('./lib/domain-hatch/resolve'),
      import('./resolve-siblings'),
    ]);
    const list = pluginList();
    // The only thing this verb takes from the resolution is a version string for
    // the stamp, and that already has a fallback. Failing the whole write when
    // `claude plugin list` cannot be read would leave hatch-options.json
    // unwritten and every later consumer re-asking the Visibility question — a
    // far worse outcome than a `0.0.0` stamp. The plugin id is regex-validated
    // above and only ever lands in core's own state dir as a string field.
    const resolved = resolvePlugin(list, pluginId, projectRoot, PLUGIN_ROOT);
    const unresolved = isResolveError(resolved);
    const scope = coreScope(list as any, projectRoot);
    const res = ensureHatchTarget(stateDir, {
      target,
      core_scope: scope.core_scope,
      stampedBy: `${pluginId}:hatch`,
      version: unresolved ? '0.0.0' : (resolved.version ?? '0.0.0'),
    });
    emitJson(unresolved ? { ...res, resolve_warning: resolved.error } : res);
  }

  if (verb === 'sync-block') {
    if (rest.length && rest.join(' ') !== '--rendered-stdin') exitError('unexpected_args');
    const [{ syncBlocks }, { readTargetState, targetFile }, { resolvePlugin, isResolveError, pluginList }, { coreScope }] =
      await Promise.all([
        import('./lib/domain-hatch/block'),
        import('./lib/domain-hatch/target'),
        import('./lib/domain-hatch/resolve'),
        import('./resolve-siblings'),
      ]);
    const list = pluginList();
    const resolved = resolvePlugin(list, pluginId, projectRoot, PLUGIN_ROOT);
    if (isResolveError(resolved)) exitError(resolved.error);

    const state = readTargetState(stateDir, coreScope(list as any, projectRoot), projectRoot);
    if (!state.target) exitError('no_target');

    const rendered = await readStdinIfFlagged('--rendered-stdin');
    const foreign = list
      .map((e: any) => String(e?.id ?? '').split('@')[0])
      .filter((n: string) => n && n !== pluginId);

    const target = path.join(projectRoot, targetFile(state.target));
    emitJson(syncBlocks(resolved.installPath, pluginId, target, path.join(stateDir, 'RESIDENT.md'), foreign, rendered));
  }

  exitError('usage');
}

await main().catch(failJson);
