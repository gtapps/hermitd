import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './hash';
import { isPlainObject } from './evolve-config';

export interface PristineBaseline {
  key: string;
  buf: Buffer;
}

export function writePristineBaselines(stateDir: string, pristine: PristineBaseline[]): void {
  const pristineRoot = path.join(stateDir, 'state', 'pristine');

  for (const { key } of pristine) {
    const dest = path.join(pristineRoot, key);
    if (!dest.startsWith(pristineRoot + path.sep)) {
      throw new Error(`key '${key}' escapes state/pristine; refusing to write a baseline copy`);
    }
  }

  for (const { key, buf } of pristine) {
    const dest = path.join(pristineRoot, key);
    const destTmp = dest + '.tmp';
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(destTmp, buf);
      fs.renameSync(destTmp, dest);
    } catch (err: any) {
      try { fs.rmSync(dest, { force: true }); } catch { /* best effort */ }
      try { fs.rmSync(destTmp, { force: true }); } catch { /* best effort */ }
      throw new Error(`cannot write pristine baseline for key '${key}': ${err.message}`);
    }
  }
}

/** Preserve foreign manifest keys and refuse corrupt state before writing. */
export function seedTemplateManifest(stateDir: string, pluginVersion: string, pristine: PristineBaseline[]) {
  const seeded: Record<string, { sha256: string; plugin_version: string }> = {};
  for (const { key, buf } of pristine) seeded[key] = { sha256: sha256(buf), plugin_version: pluginVersion };
  const refuse = (reason: string): never => { throw new Error(reason); };
  // A present-but-invalid existing manifest is fatal, matching how evolve-plan.ts
  // treats a corrupt manifest; absent is a fresh base.
  const manifestPath = path.join(stateDir, 'state', 'template-manifest.json');
  let baseFiles: Record<string, any> = {};
  if (fs.existsSync(manifestPath)) {
    let existing: any;
    try {
      existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      refuse('corrupt_manifest:invalid_json');
    }
    if (!isPlainObject(existing) || !isPlainObject(existing.files)) refuse('corrupt_manifest:invalid_files');
    const bad = Object.entries(existing.files)
      .filter(
        ([, v]: [string, any]) =>
          !isPlainObject(v) || typeof v.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.sha256),
      )
      .map(([k]) => k);
    if (bad.length) {
      refuse(`corrupt_manifest:invalid_sha256:${bad.join(',')}`);
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
    refuse('pristine_write_failed');
  }

  return { seeded: Object.keys(seeded).length, preserved };
}
