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
import { sha256 } from './lib/hash';
import { pinStateDirOrExit } from './lib/cc-compat';
import { writePristineBaselines } from './lib/pristine-baseline';
import { emitJson, exitError } from './lib/cli';

function isPlainObject(v: any): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

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

  const seeded: Record<string, { sha256: string; plugin_version: string }> = {};
  const pristine: { key: string; buf: Buffer }[] = [];
  for (const { key, file } of toHash) {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(file);
    } catch {
      exitError(`unreadable_file:${key}`);
    }
    seeded[key] = { sha256: sha256(buf), plugin_version: pluginVersion };
    pristine.push({ key, buf });
  }

  // A present-but-invalid existing manifest is fatal, matching how evolve-plan.ts
  // treats a corrupt manifest; absent is a fresh base.
  const manifestPath = path.join(stateDir, 'state', 'template-manifest.json');
  let baseFiles: Record<string, any> = {};
  if (fs.existsSync(manifestPath)) {
    let existing: any;
    try {
      existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      exitError('corrupt_manifest:invalid_json');
    }
    if (!isPlainObject(existing) || !isPlainObject(existing.files)) exitError('corrupt_manifest:invalid_files');
    const bad = Object.entries(existing.files)
      .filter(
        ([, v]: [string, any]) =>
          !isPlainObject(v) || typeof v.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.sha256),
      )
      .map(([k]) => k);
    if (bad.length) {
      exitError(`corrupt_manifest:invalid_sha256:${bad.join(',')}`);
    }
    baseFiles = existing.files;
  }

  // Merge: foreign keys preserved, re-seeded keys overwritten.
  for (const key of ['templates/SHELL.md.template', 'templates/SESSION-REPORT.md.template']) {
    delete baseFiles[key];
    delete seeded[key];
  }
  const preserved = Object.keys(baseFiles).filter((k) => !(k in seeded)).length;
  const out = { version: 1, files: { ...baseFiles, ...seeded } };

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const tmp = manifestPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, manifestPath);

  // Keep the baseline CONTENT next to its hash. The hash tells hermit-evolve
  // *that* a file diverged; only the bytes tell it *how*, which is what the
  // Step 5c sidecar migration diffs against. Written after the manifest rename
  // so a crash mid-write can only leave a missing pristine copy (evolve falls
  // back to today's replace + .bak), never one that disagrees with the hash —
  // tmp + rename per file, since a truncated baseline would silently feed a
  // wrong diff to the migration, which never re-checks the hash.
  try {
    writePristineBaselines(stateDir, pristine);
  } catch {
    exitError('pristine_write_failed');
  }

  emitJson({ seeded: Object.keys(seeded).length, preserved });
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
