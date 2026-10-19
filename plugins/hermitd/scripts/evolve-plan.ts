// Read-only analyzer for the hermit-evolve skill. Computes the deterministic
// comparisons the skill would otherwise do in-context — version gap, the
// bounded CHANGELOG slice, new config keys, and changed templates/bin —
// and emits one JSON "plan" to stdout. The skill
// acts on the plan instead of reading and diffing whole files itself.
//
// Also computes sibling hermit plans (registry-driven from _hermit_versions)
// so Step 7 doesn't rely on in-context LLM detection.
//
// Analyzer with one bounded write: rendered Docker merge inputs are parked in
// the hermit's state tree. Fail-open: always exits 0; problems are recorded in
// the `errors` array (objects of {code, message}), never thrown. No stdin
// (skill-invoked, like doctor-check.ts / resolve-outbound-channel.ts).
//
// Usage: bun evolve-plan.ts [hermit-dir]
//                           [--plugin-list-json=<path>]
//
// --plugin-list-json: inject claude plugin list --json output from a file (for
//   tests / when the main loop pre-resolves it). When absent, the script spawns
//   `claude plugin list --json` itself.

import fs from 'node:fs';
import path from 'node:path';

import { sha256 } from './lib/hash';
import { cmpSemver } from './lib/semver';
import { newConfigKeys, isPlainObject } from './lib/evolve-config';
import { deriveRenderInputs } from './lib/derive-render-inputs';
import { renderSources } from './render-docker-templates';

type Json = any;

type FileClass = 'missing' | 'unmodified' | 'customized-kept' | 'conflict';
interface ClassifiedFile {
  name: string; class: FileClass; boot_critical?: boolean; bootstrap?: boolean;
  // Absolute path to the recorded baseline CONTENT (state/pristine/<key>), when
  // manifest-seed kept one. Docker migration steps diff it against the
  // operator's copy to migrate their hunks.
  base_path?: string;
  theirs_path?: string;
}

interface SiblingPlanEntry {
  name: string;
  install_path: string;
  from: string;
  to: string;
  up_to_date: boolean;
  changelog_slice?: string;
  changelog_versions?: string[];
}

const TEMPLATE_FILES = [
  'PROPOSAL.md.template',
];

function readJSON(p: string): Json {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readTemplateManifestFiles(manifestPath: string): Record<string, { sha256: string }> {
  const raw = readJSON(manifestPath);
  if (!isPlainObject(raw) || !isPlainObject(raw.files)) {
    throw new Error('template-manifest.json: missing or invalid `files` object');
  }
  const badKeys = Object.entries(raw.files).filter(
    ([, v]: [string, any]) => !isPlainObject(v) || typeof v.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.sha256)
  ).map(([k]) => k);
  if (badKeys.length > 0) {
    throw new Error(`template-manifest.json: invalid sha256 in: ${badKeys.join(', ')}`);
  }
  return raw.files as Record<string, { sha256: string }>;
}

// Strip trailing whitespace for equality comparison (a trailing newline must
// not register as a content change).
function normTrailing(s: string): string {
  return s.replace(/\s+$/, '');
}

function resolveChangelogRoot(slice: string, pluginRoot: string): string {
  return slice.replace(/\$\{CLAUDE_PLUGIN_ROOT\}|<plugin_root>/g, () => pluginRoot);
}

// Slice of CHANGELOG.md entries in the half-open range (from, to], oldest-first.
// Headers look like "## [1.1.7] - 2026-05-31". Each entry spans from its header
// to the line before the next header. This is the read that replaces a full
// 47K-token CHANGELOG read and dodges the Read tool's 2000-line truncation.
function changelogSlice(text: string, from: string, to: string | null) {
  const lines = text.split('\n');
  const headerRe = /^## \[(\d+\.\d+\.\d+)\]/;
  const entries: Json[] = [];
  let cur: Json = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headerRe);
    if (m) {
      if (cur) {
        cur.end = i;
        entries.push(cur);
      }
      cur = { version: m[1], start: i, end: lines.length };
    }
  }
  if (cur) entries.push(cur);

  const inRange = entries.filter(
    (e: Json) => cmpSemver(from, e.version) < 0 && (to == null || cmpSemver(e.version, to) <= 0)
  );
  inRange.sort((a: Json, b: Json) => cmpSemver(a.version, b.version));

  const slice = inRange
    .map((e: Json) => normTrailing(lines.slice(e.start, e.end).join('\n')))
    .join('\n\n');
  return { slice, versions: inRange.map((e: Json) => e.version) };
}

// 3-way classify a single file (already-read buffers) against the manifest
// baseline. Returns null when on-disk is byte-identical to upstream (nothing to
// do). dstBuf null -> `missing`. manifestKey is the lookup key in manifestFiles.
function classifyOne(
  name: string,
  srcBuf: Buffer,
  dstBuf: Buffer | null,
  manifestFiles: Record<string, { sha256: string }> | null,
  manifestKey: string,
  bootCritical: boolean,
): ClassifiedFile | null {
  // on-disk absent -> restore unconditionally (deleted wrapper / fresh install)
  if (dstBuf === null) {
    const e: ClassifiedFile = { name, class: 'missing' };
    if (bootCritical) e.boot_critical = true;
    return e;
  }

  // on-disk identical to upstream -> nothing to do
  if (srcBuf.equals(dstBuf)) return null;

  // on-disk differs from upstream -> 3-way classify via manifest baseline
  const baseline = manifestFiles ? manifestFiles[manifestKey] : null;

  let cls: FileClass;
  if (baseline == null) {
    // No manifest entry (bootstrap or file added after last hatch) ->
    // treat baseline as on-disk (seed-as-unmodified): safe to overwrite.
    cls = 'unmodified';
  } else {
    const onDiskHash = sha256(dstBuf);
    const baseHash = baseline.sha256;
    if (onDiskHash === baseHash) {
      cls = 'unmodified';          // operator never touched it; template moved
    } else {
      const upstreamHash = sha256(srcBuf);
      if (upstreamHash === baseHash) {
        cls = 'customized-kept';   // operator edited; template didn't change
      } else {
        cls = 'conflict';          // both sides diverged
      }
    }
  }

  const e: ClassifiedFile = { name, class: cls };
  if (bootCritical) e.boot_critical = true;
  return e;
}

// Classify each managed file against the pristine-baseline manifest.
//
// manifestFiles: the `files` map from state/template-manifest.json, or null
//   when the manifest is absent (bootstrap run — treat baseline as on-disk).
// keyPrefix:     path prefix used as the manifest key ("templates" or "bin").
// bootCritical:  true for bin/ wrappers (stale = broken hermit).
//
// Only files that need attention (on-disk absent or on-disk != upstream) are
// returned. Source missing -> skip (nothing to sync), same as before.
function classifyFiles(
  srcDir: string,
  dstDir: string,
  names: string[],
  manifestFiles: Record<string, { sha256: string }> | null,
  keyPrefix: string,
  bootCritical: boolean,
): ClassifiedFile[] {
  const result: ClassifiedFile[] = [];
  for (const name of names) {
    let srcBuf: Buffer;
    try {
      srcBuf = fs.readFileSync(path.join(srcDir, name));
    } catch {
      continue; // source missing -> nothing to sync
    }

    let dstBuf: Buffer | null;
    try {
      dstBuf = fs.readFileSync(path.join(dstDir, name));
    } catch {
      dstBuf = null;
    }

    const e = classifyOne(name, srcBuf, dstBuf, manifestFiles, `${keyPrefix}/${name}`, bootCritical);
    if (e) result.push(e);
  }
  return result;
}

function readVerifiedPristine(pristinePath: string, recordedHash: string): Buffer | null {
  try {
    const pristine = fs.readFileSync(pristinePath);
    return sha256(pristine) === recordedHash ? pristine : null;
  } catch {
    return null;
  }
}

// F1 — classify the deployed docker entrypoint. It is now placeholder-free
// (rendered == upstream byte-for-byte), so it joins the manifest system exactly
// like a boot-critical bin/ wrapper. Upstream is `<name>.template`; on-disk is
// the suffix-stripped file at project root. Returns null when the project has no
// deployed entrypoint (don't create docker files in a non-docker project).
function classifyDockerEntrypoint(
  stDir: string,
  projectRoot: string,
  hermitDir: string,
  manifestFiles: Record<string, { sha256: string }> | null,
): ClassifiedFile | null {
  let srcBuf: Buffer;
  try {
    srcBuf = fs.readFileSync(path.join(stDir, 'docker', 'docker-entrypoint.hermit.sh.template'));
  } catch {
    return null; // no upstream entrypoint template -> nothing to manage
  }
  let dstBuf: Buffer;
  try {
    dstBuf = fs.readFileSync(path.join(projectRoot, 'docker-entrypoint.hermit.sh'));
  } catch {
    return null; // no deployed entrypoint -> project isn't docker-deployed
  }
  const e = classifyOne(
    'docker-entrypoint.hermit.sh', srcBuf, dstBuf,
    manifestFiles, 'docker/docker-entrypoint.hermit.sh', true,
  );
  // Per-file bootstrap: the global manifest can exist (templates/bin seeded) while
  // the docker baseline is absent — it is recorded only by /docker-setup. With no
  // baseline, classifyOne falls back to `unmodified` (would overwrite silently),
  // but we cannot actually tell an operator edit from an old upstream version. Flag
  // it so Step 5c writes a one-time recovery .bak before overwriting. Only matters
  // when on-disk differs from upstream (e !== null); identical files return null.
  const hasBaseline = e !== null && manifestFiles != null
    && manifestFiles['docker/docker-entrypoint.hermit.sh'] != null;
  if (e !== null && !hasBaseline) e.bootstrap = true;

  // Expose the baseline content when manifest-seed kept a copy AND its bytes
  // still hash to the recorded baseline. Without it the runner sees ours and
  // theirs but no base, so it cannot tell an operator line from an old-upstream
  // one and Step 5c stays on the replace + .bak path. An *unverified* copy is
  // worse than none: Step 5c diffs against it and never re-checks the hash, so a
  // stale one (manifest re-seeded, the copy left at the previous version) reads
  // every intervening upstream line as an operator hunk and migrates upstream
  // code into the sidecar. A mismatch — or no manifest entry at all, the
  // `bootstrap` case — falls back to replace + .bak.
  if (e !== null && hasBaseline) {
    const basePath = path.join(
      hermitDir, 'state', 'pristine', 'docker', 'docker-entrypoint.hermit.sh');
    const recorded = manifestFiles!['docker/docker-entrypoint.hermit.sh'].sha256;
    if (readVerifiedPristine(basePath, recorded) !== null) e.base_path = basePath;
  }
  return e;
}

const DOCKER_TEMPLATE_FILES = [
  { tmpl: 'docker-compose.hermit.yml.template', rendered: 'docker-compose.hermit.yml', field: 'compose' },
  { tmpl: 'Dockerfile.hermit.template', rendered: 'Dockerfile.hermit', field: 'dockerfile' },
] as const;

function reportDockerTemplateDrift(
  stDir: string,
  projectRoot: string,
  manifestFiles: Record<string, { sha256: string }> | null,
): Json[] {
  const out: Json[] = [];
  for (const f of DOCKER_TEMPLATE_FILES) {
    let srcBuf: Buffer;
    try {
      srcBuf = fs.readFileSync(path.join(stDir, 'docker', f.tmpl));
    } catch {
      continue;
    }
    if (!fs.existsSync(path.join(projectRoot, f.rendered))) continue;
    const baseline = manifestFiles ? manifestFiles[`docker/${f.tmpl}`] : null;
    if (baseline == null) {
      out.push({ name: f.rendered, status: 'unknown' });
    } else if (sha256(srcBuf) !== baseline.sha256) {
      out.push({ name: f.rendered, status: 'changed' });
    }
  }
  return out;
}

// F2: classify rendered compose/Dockerfile against a verified, re-rendered
// pristine template. If live inputs cannot be derived, retain the report-only
// output used by older hermits.
function classifyDockerTemplates(
  stDir: string,
  projectRoot: string,
  manifestFiles: Record<string, { sha256: string }> | null,
  hermitDirArg?: string,
): Json[] {
  // Same dir buildPlan was invoked with — never re-derived from a fixed name,
  // so a caller passing an alternate hermit dir still reads its own config.
  const hermitDir = hermitDirArg ?? path.join(projectRoot, '.hermit');
  const inputs = deriveRenderInputs(
    path.join(hermitDir, 'config.json'),
    path.join(projectRoot, 'docker-compose.hermit.yml'),
  );
  if (inputs === null) return reportDockerTemplateDrift(stDir, projectRoot, manifestFiles);

  const out: Json[] = [];
  // Wiped per run: a `base` left by a previous run is rendered from a template
  // that has since moved, and nothing else prunes this scratch tree.
  const renderRoot = path.join(hermitDir, 'state', 'evolve-docker');
  fs.rmSync(renderRoot, { recursive: true, force: true });
  const theirsDir = path.join(renderRoot, 'theirs');
  fs.mkdirSync(theirsDir, { recursive: true });
  const renderScript = path.join(path.dirname(stDir), 'scripts', 'render-docker-templates.ts');
  const rendered = Bun.spawnSync({
    cmd: [process.execPath, renderScript, projectRoot, '--to', theirsDir],
    stdin: Buffer.from(JSON.stringify(inputs)),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (rendered.exitCode !== 0) {
    throw new Error(`render-docker-templates failed: ${rendered.stdout.toString().trim()}`);
  }

  const currentSources = {
    compose: fs.readFileSync(path.join(stDir, 'docker', 'docker-compose.hermit.yml.template'), 'utf8'),
    dockerfile: fs.readFileSync(path.join(stDir, 'docker', 'Dockerfile.hermit.template'), 'utf8'),
  };
  for (const f of DOCKER_TEMPLATE_FILES) {
    let ours: Buffer;
    try {
      ours = fs.readFileSync(path.join(projectRoot, f.rendered));
    } catch {
      continue;
    }
    const theirsPath = path.join(theirsDir, f.rendered);
    const theirs = fs.readFileSync(theirsPath);
    const manifestKey = `docker/${f.tmpl}`;
    const pristinePath = path.join(hermitDir, 'state', 'pristine', 'docker', f.tmpl);
    const recorded = manifestFiles?.[manifestKey]?.sha256;
    let baseRendered: string | null = null;
    if (recorded) {
      const pristine = readVerifiedPristine(pristinePath, recorded);
      if (pristine !== null) {
        const baseSources = { ...currentSources, [f.field]: pristine.toString('utf8') };
        baseRendered = renderSources(inputs, baseSources)[f.field];
      }
    }

    const baseline = baseRendered === null
      ? null
      : { [manifestKey]: { sha256: sha256(Buffer.from(baseRendered)) } };
    const entry = classifyOne(f.rendered, theirs, ours, baseline, manifestKey, false);
    if (entry === null) continue;
    entry.theirs_path = theirsPath;
    if (baseRendered === null) {
      entry.bootstrap = true;
    } else {
      const baseDir = path.join(renderRoot, 'base');
      fs.mkdirSync(baseDir, { recursive: true });
      const basePath = path.join(baseDir, f.rendered);
      fs.writeFileSync(basePath, baseRendered);
      entry.base_path = basePath;
    }
    out.push(entry);
  }
  return out;
}

// Registered sibling names are the registry keys other than core.
function getRegisteredNames(config: Json): string[] {
  const versions: Record<string, string> = isPlainObject(config._hermit_versions)
    ? config._hermit_versions
    : {};
  return Object.keys(versions).filter(n => n !== 'hermitd');
}

// Safe realpath: returns p unchanged if the path can't be resolved (ENOENT etc.)
function safeRealpath(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

// Load the claude plugin list --json inventory.
// pluginListJsonPath: read from file when provided (tests / main-loop injection).
// When absent, spawns `claude plugin list --json` directly.
// Returns {list, error} — list is [] and error is set on any failure.
function loadPluginList(pluginListJsonPath: string | null): { list: any[]; error?: string } {
  if (pluginListJsonPath) {
    try {
      const text = fs.readFileSync(pluginListJsonPath, 'utf8');
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) return { list: [], error: 'plugin-list-json is not a JSON array' };
      return { list: parsed };
    } catch (e: any) {
      return { list: [], error: `failed to read --plugin-list-json: ${e.message}` };
    }
  }

  try {
    const proc = Bun.spawnSync(['claude', 'plugin', 'list', '--json'], {
      env: process.env as Record<string, string>,
    });
    if (proc.exitCode !== 0) {
      const stderr = proc.stderr ? proc.stderr.toString().trim() : '';
      return { list: [], error: `claude plugin list exited ${proc.exitCode}${stderr ? ': ' + stderr : ''}` };
    }
    const text = proc.stdout.toString();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch (e: any) {
      return { list: [], error: `claude plugin list output not valid JSON: ${e.message}` };
    }
    if (!Array.isArray(parsed)) return { list: [], error: 'claude plugin list output is not a JSON array' };
    return { list: parsed };
  } catch (e: any) {
    return { list: [], error: `failed to spawn claude plugin list: ${e.message}` };
  }
}

// Extract the plugin name from a plugin id (format: "name@marketplace").
function _pluginName(id: string): string {
  return id.split('@')[0];
}

// Find the project-effective entry for `name` in a pre-filtered plugin slice.
// Scope precedence: local > project — the same order resolve-siblings.ts applies
// (its header, "local overrides project"), matching Claude Code's own settings
// layering where .local sits on top of the committed layer.
function resolveProjectEffectivePlugin(projectEffective: any[], name: string): any | null {
  const candidates = projectEffective.filter(e => _pluginName(String(e.id || '')) === name);
  const byScope = (scope: string) => candidates.find(e => e.scope === scope);
  return byScope('local') ?? byScope('project') ?? null;
}

// Compute per-sibling plan entries from _hermit_versions and the plugin list.
// Registered siblings (keys in _hermit_versions minus 'hermitd') are
// the authoritative membership set. The plugin list is used for path resolution only.
function computeSiblings(
  config: Json,
  pluginList: any[],
  projectRoot: string,
  siblingWarnings: string[],
): { siblings: SiblingPlanEntry[]; siblings_path_unresolved: string[]; siblings_detected_unregistered: string[] } {
  const siblings: SiblingPlanEntry[] = [];
  const siblings_path_unresolved: string[] = [];
  const siblings_detected_unregistered: string[] = [];

  const versions: Record<string, string> = isPlainObject(config._hermit_versions)
    ? { ...config._hermit_versions }
    : {};
  const registeredNames = getRegisteredNames(config);
  // CHANGELOG 1623 guard: pre-filter once to enabled project/local entries for this project.
  const realRoot = safeRealpath(projectRoot);
  const projectEffective = pluginList.filter(e =>
    e.enabled === true &&
    (e.scope === 'project' || e.scope === 'local') &&
    safeRealpath(String(e.projectPath || '')) === realRoot
  );

  for (const name of registeredNames) {
    const entry = resolveProjectEffectivePlugin(projectEffective, name);
    if (!entry) {
      siblings_path_unresolved.push(name);
      continue;
    }

    const installPath: string = String(entry.installPath || '');
    if (!installPath) {
      siblings_path_unresolved.push(name);
      continue;
    }

    const from = String(versions[name] || '0.0.0');

    // Read sibling's installed version from its plugin.json
    let to: string | null = null;
    try {
      const pj = readJSON(path.join(installPath, '.claude-plugin', 'plugin.json'));
      to = typeof pj.version === 'string' ? pj.version : null;
    } catch {
      siblings_path_unresolved.push(name);
      continue;
    }

    if (to === null) {
      siblings_path_unresolved.push(name);
      continue;
    }

    // Downgrade guard: from > to. Treat as no-gap (don't bump), surface as warning.
    const gap = cmpSemver(from, to);
    const upToDate = gap >= 0; // from >= to -> nothing to upgrade
    if (gap > 0) {
      siblingWarnings.push(`${name}: installed=${to} < config=${from} (downgrade — skipping bump)`);
    }

    const sibling: SiblingPlanEntry = { name, install_path: installPath, from, to, up_to_date: upToDate };

    // CHANGELOG slice — only needed when there's a version gap
    if (!upToDate) {
      try {
        const cl = fs.readFileSync(path.join(installPath, 'CHANGELOG.md'), 'utf8');
        const { slice, versions: vers } = changelogSlice(cl, from, to);
        sibling.changelog_slice = resolveChangelogRoot(slice, installPath);
        sibling.changelog_versions = vers;
      } catch {
        siblingWarnings.push(`${name}: CHANGELOG.md unreadable at ${installPath}`);
      }
    }

    siblings.push(sibling);
  }

  // Detect project-effective hermit plugins not in the registry (opt-in opportunity).
  // "Hermit" = name contains "hermit" but is NOT "hermitd".
  const registeredSet = new Set(registeredNames);
  const effectiveHermitNames = new Set<string>();
  for (const e of projectEffective) {
    const n = _pluginName(String(e.id || ''));
    if (n !== 'hermitd' && n.includes('hermit')) {
      effectiveHermitNames.add(n);
    }
  }
  for (const n of effectiveHermitNames) {
    if (!registeredSet.has(n)) {
      siblings_detected_unregistered.push(n);
    }
  }

  return { siblings, siblings_path_unresolved, siblings_detected_unregistered };
}

function buildPlan({ hermitDir, pluginRoot, pluginListJsonPath }: {
  hermitDir: string;
  pluginRoot: string;
  pluginListJsonPath?: string | null;
}): Json {
  const errors: Json[] = [];
  const plan: Json = { errors };

  const configPath = path.join(hermitDir, 'config.json');
  let config: Json;
  try {
    config = readJSON(configPath);
  } catch (e: any) {
    if (e && e.code === 'ENOENT') {
      errors.push({ code: 'no_config', message: 'config.json not found' });
    } else if (e && e.name === 'SyntaxError') {
      errors.push({ code: 'config_json_invalid', message: `config.json is not valid JSON: ${e.message}` });
    } else {
      errors.push({ code: 'config_unreadable', message: `config.json unreadable: ${e.message}` });
    }
    return plan;
  }

  let to: string | null = null;
  try {
    to = readJSON(path.join(pluginRoot, '.claude-plugin', 'plugin.json')).version || null;
  } catch (e: any) {
    errors.push({ code: 'plugin_json_unreadable', message: e.message });
  }
  const from = (isPlainObject(config._hermit_versions) && config._hermit_versions['hermitd']) || '0.0.0';
  plan.from = from;
  plan.to = to;
  plan.up_to_date = to != null && cmpSemver(from, to) >= 0;
  // Config stamped AHEAD of the loaded plugin: this session loaded a stale install copy,
  // not a hermit awaiting an upgrade. `up_to_date` deliberately collapses "ahead" into
  // "current", so it cannot carry this — and `work_pending` can still be true here via a
  // sibling gap, which would walk the runner into Step 7's
  // migrations and then Step 9, where finalizing with the older `to` would downgrade the
  // applied stamp without reversing anything. Separate blocking field, consumed by the
  // skill's Version check BEFORE any step runs.
  plan.loaded_core_older_than_applied = to != null && cmpSemver(from, to) > 0;

  try {
    const cl = fs.readFileSync(path.join(pluginRoot, 'CHANGELOG.md'), 'utf8');
    const { slice, versions } = changelogSlice(cl, from, to);
    plan.changelog_slice = resolveChangelogRoot(slice, pluginRoot);
    plan.changelog_versions = versions;
  } catch (e: any) {
    errors.push({ code: 'changelog_unreadable', message: e.message });
  }

  try {
    const tmpl = readJSON(path.join(pluginRoot, 'state-templates', 'config.json.template'));
    plan.new_config_keys = newConfigKeys(tmpl, config);
  } catch (e: any) {
    errors.push({ code: 'config_template_unreadable', message: e.message });
  }

  // Read pristine-baseline manifest. Absence = bootstrap run.
  const manifestPath = path.join(hermitDir, 'state', 'template-manifest.json');
  let manifestFiles: Record<string, { sha256: string }> | null = null;
  try {
    manifestFiles = readTemplateManifestFiles(manifestPath);
  } catch (e: any) {
    if (e && e.code === 'ENOENT') {
      plan.manifest_bootstrap = true;
    } else {
      const code = e && e.name === 'SyntaxError' ? 'manifest_parse_error' : 'manifest_invalid';
      errors.push({ code, message: e.message });
      return plan;
    }
  }

  const stDir = path.join(pluginRoot, 'state-templates');
  plan.templates_changed = classifyFiles(stDir, path.join(hermitDir, 'templates'), TEMPLATE_FILES, manifestFiles, 'templates', false);

  const binSrc = path.join(stDir, 'bin');
  let binNames: string[] = [];
  try {
    binNames = fs.readdirSync(binSrc, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name);
  } catch (e) {
    // no bin dir in source -> nothing to sync (not an operator-facing error)
  }
  plan.bin_changed = classifyFiles(binSrc, path.join(hermitDir, 'bin'), binNames, manifestFiles, 'bin', true);

  // Docker drift. F1 manages the placeholder-free entrypoint. F2 reconciles
  // compose/Dockerfile when live render inputs are derivable and reports only otherwise.
  const projectRoot = path.resolve(hermitDir, '..');
  try {
    plan.docker_entrypoint = classifyDockerEntrypoint(stDir, projectRoot, hermitDir, manifestFiles);
  } catch (e: any) {
    plan.docker_entrypoint = null;
    errors.push({ code: 'docker_entrypoint_classify_failed', message: e.message });
  }
  try {
    plan.docker_templates = classifyDockerTemplates(stDir, projectRoot, manifestFiles, hermitDir);
  } catch (e: any) {
    plan.docker_templates = [];
    errors.push({ code: 'docker_templates_classify_failed', message: e.message });
  }


  // Sibling hermit plans — registry-driven from _hermit_versions.
  // Plugin list load failures are non-fatal: core upgrade proceeds; siblings[] will be empty.
  const siblingWarnings: string[] = [];
  const { list: pluginList, error: pluginListError } = loadPluginList(pluginListJsonPath ?? null);
  if (pluginListError) {
    siblingWarnings.push(`plugin-list unavailable: ${pluginListError}`);
  }

  const siblingResult = computeSiblings(config, pluginList, projectRoot, siblingWarnings);
  plan.siblings = siblingResult.siblings;
  plan.siblings_path_unresolved = siblingResult.siblings_path_unresolved;
  plan.siblings_detected_unregistered = siblingResult.siblings_detected_unregistered;
  if (siblingWarnings.length > 0) plan.siblings_warnings = siblingWarnings;

  // Unassessed siblings keep the runner active so it can surface warnings.
  const siblingWorkNeeded = plan.siblings.some((s: SiblingPlanEntry) => !s.up_to_date);
  const siblingsUnassessed =
    plan.siblings_path_unresolved.length > 0 || (plan.siblings_warnings?.length ?? 0) > 0;
  plan.work_pending = !plan.up_to_date || siblingWorkNeeded || siblingsUnassessed;

  return plan;
}

function parseArgs(argv: string[]) {
  let hermitDir: string | null = null;
  let pluginListJsonPath: string | null = null;
  for (const a of argv) {
    if (a.startsWith('--plugin-list-json=')) pluginListJsonPath = a.slice('--plugin-list-json='.length);
    else if (!a.startsWith('--') && hermitDir === null) hermitDir = a;
  }
  return { hermitDir: hermitDir || '.hermit', pluginListJsonPath };
}

export { buildPlan, cmpSemver, changelogSlice, newConfigKeys, classifyFiles, classifyDockerEntrypoint, classifyDockerTemplates };
export type { ClassifiedFile, FileClass };

if (import.meta.main) {
  const { hermitDir, pluginListJsonPath } = parseArgs(process.argv.slice(2));
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '..');
  let plan: Json;
  try {
    plan = buildPlan({ hermitDir: path.resolve(hermitDir), pluginRoot, pluginListJsonPath });
  } catch (e: any) {
    plan = { errors: [{ code: 'fatal', message: e.message }] };
  }
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  process.exit(0);
}
