// Seeds / updates state/template-manifest.json with sha256 baselines for the
// copied template + bin + docker files. Shared by hatch (Step 2), docker-setup
// (Step 7b.6), and hermit-evolve (manifest write). An LLM cannot compute sha256
// reliably; this script makes the pristine-baseline correct by construction.
//
// Usage: bun manifest-seed.ts <hermit-state-dir>     # e.g. .hermit
//   stdin: { "plugin_version": "1.2.9", "entries": [
//     { "key": "templates/PROPOSAL.md.template", "file": "/abs/path/to/file" },
//     { "key_prefix": "bin", "dir": "/abs/state-templates/bin" }
//   ] }
//
// Manifest shape (consumed by evolve-plan.ts):
//   { "version": 1, "files": { "<key>": { "sha256": "<64hex>", "plugin_version": "<v>" } } }
//
// Each seeded key also gets its bytes copied to <state-dir>/state/pristine/<key>,
// the base hermit-evolve diffs an operator-customized file against.
//
// Caller owns which path each `file` points at (upstream template vs on-disk
// rendered output) — the script only hashes what it is given. For `key_prefix`
// entries it enumerates the SOURCE dir handed in, never the project destination
// (which may hold operator/add-on files).
//
// Output: `{"seeded":N,"preserved":N}` (preserved = foreign keys kept), or
// `{"error":"<token>[:detail]"}` with exit 1.
//
// Fail-loud (exit 1, write nothing) on malformed stdin OR a present-but-invalid
// existing manifest — consumers (evolve-plan.ts) treat an invalid manifest as
// fatal, so the seeder must not silently "repair" it and mask that signal.
// This is NOT a hook: it must not fail open. Atomic write via tmp + rename.

import fs from 'node:fs';
import path from 'node:path';
import { pinStateDirOrExit } from './lib/cc-compat';
import { seedTemplateManifest } from './lib/pristine-baseline';
import { emitJson, exitError } from './lib/cli';

const stateDirArg = process.argv[2];
if (!stateDirArg) exitError();
// The state dir is not caller-chosen. Reachable through a pre-approved
// `Bash(bun */scripts/manifest-seed.ts*)` grant that covers every argument, so
// an unvalidated root let one such call seed a manifest into another project's
// hermit state. See lib/cc-compat.ts assertStateDir().
const stateDir = pinStateDirOrExit(stateDirArg);

function apply(raw: string): void {
  if (!raw) exitError('empty_stdin');

  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    exitError('invalid_json');
  }

  const pluginVersion = payload?.plugin_version;
  if (typeof pluginVersion !== 'string' || !pluginVersion.trim()) {
    exitError('invalid_plugin_version');
  }
  const entries = payload?.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    exitError('invalid_entries');
  }

  const toHash: { key: string; file: string }[] = [];
  for (const e of entries) {
    if (e && typeof e.key === 'string' && typeof e.file === 'string') {
      toHash.push({ key: e.key, file: e.file });
    } else if (e && typeof e.key_prefix === 'string' && typeof e.dir === 'string') {
      let names: string[];
      try {
        names = fs
          .readdirSync(e.dir)
          .filter((n) => fs.statSync(path.join(e.dir, n)).isFile())
          .sort();
      } catch {
        exitError(`unreadable_dir:${e.key_prefix}`);
      }
      for (const n of names) toHash.push({ key: `${e.key_prefix}/${n}`, file: path.join(e.dir, n) });
    } else {
      exitError(`invalid_entry:${JSON.stringify(e)}`);
    }
  }

  const pristine: { key: string; buf: Buffer }[] = [];
  for (const { key, file } of toHash) {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(file);
    } catch {
      exitError(`unreadable_file:${key}`);
    }
    pristine.push({ key, buf });
  }

  try { emitJson(seedTemplateManifest(stateDir, pluginVersion, pristine)); }
  catch (error) { exitError(error instanceof Error ? error.message : String(error)); }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
});
process.stdin.on('error', () => {});
process.stdin.on('end', () => {
  apply(buf.trim());
});
