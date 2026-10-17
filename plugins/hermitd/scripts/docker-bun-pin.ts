// Pins bun to a target version in a deployed Dockerfile.hermit, converging the
// pre-1.2.0 npm install shape onto the canonical ARG + native-installer block.
//
// Usage: bun docker-bun-pin.ts <hermit-state-dir> <bun-version> <plugin-version>
//
// Verdicts (stdout, one JSON object, exit 0), by `status`:
//   skip (reason absent)         no Dockerfile.hermit
//   already_pinned               ARG BUN_VERSION already at target
//   repinned (from, to)          ARG BUN_VERSION line moved to target
//   converged                    legacy `npm install -g bun` replaced by the block
//   defer (reason unrecognized_bun_install_shape)   file untouched, caller defers
//
// Deploys exist on every template shape since v1.0.0, so the classification is
// the contract — a migration step that assumed one shape is what stranded most
// of the fleet on the 1.2.45 upgrade. Exit is non-zero only for caller error.
//
// The inserted block is READ from the shipped template, never inlined here:
// the template is the single source of truth for what a pinned bun install
// looks like, and a copy here would silently rot the next time it changes.

import fs from 'node:fs';
import path from 'node:path';
import { emitJson, exitError } from './lib/cli';
import { sha256 } from './lib/hash';
import { pinStateDirOrExit } from './lib/cc-compat';
import { writePristineBaselines } from './lib/pristine-baseline';

const MANIFEST_KEY = 'docker/Dockerfile.hermit.template';
const TEMPLATE = path.resolve(
  import.meta.dir,
  '..',
  'state-templates',
  'docker',
  'Dockerfile.hermit.template',
);

function isPlainObject(v: any): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const [stateDirArg, bunVersion, pluginVersion] = process.argv.slice(2);
if (!stateDirArg || !bunVersion || !pluginVersion) {
  exitError();
}
// Same pin as manifest-seed.ts: the state dir is not caller-chosen, and the
// allow-list grant for this script (`Bash(bun */scripts/docker-bun-pin.ts*)`)
// covers every argument.
const stateDir = pinStateDirOrExit(stateDirArg);

// The ENV/RUN half of the canonical install, lifted from the shipped template:
// everything from the `# Bun is the hermit runtime` comment through the
// installer RUN line. The ARG is emitted separately so the insert is
// self-contained wherever it lands.
function canonicalInstallBlock(): string {
  let tmpl: string;
  try {
    tmpl = fs.readFileSync(TEMPLATE, 'utf8');
  } catch {
    exitError('template_unreadable');
  }
  const lines = tmpl.split('\n');
  const start = lines.findIndex((l) => l.startsWith('# Bun is the hermit runtime'));
  const end = lines.findIndex((l) => l.startsWith('RUN curl -fsSL https://bun.sh/install'));
  if (start === -1 || end === -1 || end < start) {
    exitError('template_missing_bun_block');
  }
  return lines.slice(start, end + 1).join('\n');
}

// Read and validate up front, so a corrupt manifest fails the run before the
// Dockerfile is touched. Absent manifest = docker-setup never ran; there is no
// baseline to keep, and one must not be invented.
function readManifest(): { path: string; data: any } | null {
  const manifestPath = path.join(stateDir, 'state', 'template-manifest.json');
  if (!fs.existsSync(manifestPath)) return null;

  let existing: any;
  try {
    existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    exitError('corrupt_manifest:invalid_json');
  }
  if (!isPlainObject(existing) || !isPlainObject(existing.files)) {
    exitError('corrupt_manifest:invalid_files');
  }
  return { path: manifestPath, data: existing };
}

// Re-records the pristine baseline so evolve-plan's drift classifier stops
// flagging Dockerfile.hermit.template. Only for a verdict that leaves the
// deployment matching the shipped template: recording it after a defer would
// clear the drift signal on a hermit whose bun was never pinned, and after a
// converge it would vouch for a pre-1.2.0 scaffold that is several template
// generations behind in everything except the bun block we just spliced in.
function writeBaseline(manifest: { path: string; data: any } | null): void {
  if (!manifest) return;
  const template = fs.readFileSync(TEMPLATE);
  manifest.data.files[MANIFEST_KEY] = {
    sha256: sha256(template),
    plugin_version: pluginVersion,
  };
  const tmp = manifest.path + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(manifest.data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, manifest.path);
  try {
    writePristineBaselines(stateDir, [{ key: MANIFEST_KEY, buf: template }]);
  } catch {
    exitError('pristine_write_failed');
  }
}

function commit(contents: string, result: Record<string, string>): never {
  fs.writeFileSync(dockerfile, contents, 'utf8');
  writeBaseline(manifest);
  emitJson(result);
}

function defer(): never {
  emitJson({ status: 'defer', reason: 'unrecognized_bun_install_shape' });
}

// Anchored on the state dir's parent, the project root `pinStateDirOrExit` just
// validated — never on CWD. A shell that drifted (which persists across calls)
// would otherwise resolve nothing, report the absent skip, and leave the hermit
// silently unpinned: the exact no-op this migration exists to end.
const dockerfile = path.join(path.dirname(stateDir), 'Dockerfile.hermit');
if (!fs.existsSync(dockerfile)) emitJson({ status: 'skip', reason: 'absent' });

const original = fs.readFileSync(dockerfile, 'utf8');
const lines = original.split('\n');

// Validated before touching the Dockerfile: a caller-error exit must leave the
// deployed file exactly as it was.
const manifest = readManifest();

// An ARG line only means "pinned" alongside the installer it feeds. Following
// the 1.2.45 note by hand on a pre-1.2.0 scaffold produces the ARG with npm
// still installing a floating bun below it: a dead ARG, not a pin.
const argIdx = lines.findIndex((l) => /^ARG BUN_VERSION=/.test(l));
const nativeInstall = lines.some((l) => l.includes('https://bun.sh/install'));
if (argIdx !== -1 && nativeInstall) {
  const current = lines[argIdx].slice('ARG BUN_VERSION='.length).trim();
  if (current === bunVersion) {
    writeBaseline(manifest);
    emitJson({ status: 'already_pinned' });
  }
  lines[argIdx] = `ARG BUN_VERSION=${bunVersion}`;
  commit(lines.join('\n'), { status: 'repinned', from: current, to: bunVersion });
}

// Legacy shape: bun rides along in the npm globals line. Also matches a
// hand-applied `bun@1.4.0` pin, which converges rather than being re-nagged.
// A dead ARG is dropped first so the converged file carries exactly one.
const body = argIdx === -1 ? lines : lines.filter((_, i) => i !== argIdx);
const npmIdx = body.findIndex((l) => /^RUN npm install -g bun(@\S+)? /.test(l));
if (npmIdx !== -1) {
  // Splicing into a continued RUN would land the block mid-command and break
  // the build. Defer instead of writing a Dockerfile that cannot be built.
  if (/\\\s*$/.test(body[npmIdx])) defer();
  body[npmIdx] = body[npmIdx].replace(/^(RUN npm install -g )bun(@\S+)? /, '$1');
  body.splice(npmIdx + 1, 0, '', `ARG BUN_VERSION=${bunVersion}`, canonicalInstallBlock());
  // No writeBaseline: see the comment there — a converged scaffold is current
  // in its bun block alone, and the drift nudge on the rest is a true signal.
  fs.writeFileSync(dockerfile, body.join('\n'), 'utf8');
  emitJson({ status: 'converged' });
}

defer();
