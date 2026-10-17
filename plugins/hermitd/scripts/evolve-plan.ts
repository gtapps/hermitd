import { splitResident } from './lib/domain-hatch/block';
// Read-only analyzer for the hermit-evolve skill. Computes the deterministic
// comparisons the skill would otherwise do in-context — version gap, the
// bounded CHANGELOG slice, new config keys, changed templates/bin, and the
// CLAUDE-APPEND block diff — and emits one JSON "plan" to stdout. The skill
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
// Usage: bun evolve-plan.ts [hermit-dir] --hatch-target=<local|committed>
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
  resident_changed?: boolean;
  resident_old_block?: string;
  resident_missing?: boolean;
  claude_append_changed?: boolean;
  claude_append_old_block?: string;
  claude_append_needs_render?: boolean;
  claude_append_block_missing?: boolean;
  claude_append_ambiguous?: boolean;
  marker?: string;
}

// Result of diffing a CLAUDE-APPEND block against a target file. `changed` with
// no `old_block` means "append the full template" (marker/file absent — core
// only). `ambiguous` means the marker occurs more than once in the target —
// refuse to touch it. `needs_render` means the template carries mode: markers
// core cannot render — sync is skipped entirely, deferred to the owning
// plugin's own hatch. `missing` (siblings only) means the block isn't
// installed at all — never auto-append a sibling's block.
interface ClaudeAppendDiffResult {
  changed: boolean;
  old_block?: string;
  ambiguous?: boolean;
  needs_render?: boolean;
  missing?: boolean;
}

const MARKER = '<!-- hermitd: Session Discipline -->';
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

// "<!-- name: Title -->" -> "<!-- /name: Title -->"
function closingMarkerFor(marker: string): string {
  return marker.replace(/^<!--\s*/, '<!-- /');
}

// Bounds of a CLAUDE-APPEND block, in strict precedence order:
//   Phase A: fence — never cross into another registered plugin's block (a
//            ceiling, not a candidate end).
//   Phase B1: closing marker, inclusive. Standalone "---" is ignored in this
//             branch — an explicit closing marker always wins over a heuristic.
//   Phase B2: first standalone "---", exclusive (today's behavior; what
//             legacy closing-marker-less blocks rely on).
//   Phase B3: fence/EOF, right-trimmed of trailing blank lines.
// Used on both the template (which skips its own leading "---") and the
// target CLAUDE file, so the two are compared apples-to-apples.
// When marker is omitted, defaults to the core MARKER constant. foreignNames
// are other registered plugin names — their block markers fence this block so
// it can never swallow a sibling's, even without a closing marker.
function markerOnward(text: string, marker?: string, foreignNames: string[] = []): string | null {
  const m = marker ?? MARKER;
  const lines = text.split('\n');
  const start = lines.findIndex(l => l.trim() === m);
  if (start === -1) return null;

  const isForeignMarker = (line: string): boolean => {
    const t = line.trim();
    if (!t.startsWith('<!--') || !t.endsWith('-->')) return false;
    return foreignNames.some(n => t.startsWith(`<!-- ${n}:`) || t.startsWith(`<!-- /${n}:`));
  };

  let limit = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isForeignMarker(lines[i])) { limit = i; break; }
  }

  const close = closingMarkerFor(m);
  for (let i = start + 1; i < limit; i++) {
    if (lines[i].trim() === close) return lines.slice(start, i + 1).join('\n');
  }

  for (let i = start + 1; i < limit; i++) {
    if (lines[i].trim() === '---') return lines.slice(start, i).join('\n');
  }

  let end = limit;
  while (end > start + 1 && lines[end - 1].trim() === '') end--;
  return lines.slice(start, end).join('\n');
}

// Ambiguity guard for a marker block: the marker line must appear at most once,
// and the resolved block must occur exactly once in the target — otherwise a
// replace Edit's old_string wouldn't be unique (could hit the wrong instance),
// and the caller must NOT fall through to append, which would add a third copy.
// Exported because domain-hatch's sync-block applies the same guard: two
// writers touching one block have to agree on when it is safe to replace, or a
// block gets rewritten by one and refused by the other.
function isAmbiguousBlock(targetText: string, marker: string, targetBlock: string): boolean {
  const markerLineCount = targetText.split('\n').filter(l => l.trim() === marker).length;
  const occurrences = targetText.split(targetBlock).length - 1;
  return markerLineCount > 1 || occurrences > 1;
}

// Find the plugin's own CLAUDE-APPEND opening marker: "<!-- <name>: <Title> -->".
// Name-anchored so an unrelated leading comment (e.g. dev-hermit's
// "<!-- mode:standard-only -->") can never be mistaken for the block marker.
// Cannot match a closing marker, since "<!-- /name:" never matches the
// "<!-- name:" prefix. Returns null if no such comment line is found.
function extractSiblingMarker(text: string, name: string): string | null {
  const prefix = `<!-- ${name}:`;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith(prefix) && t.endsWith('-->')) return t;
  }
  return null;
}

// A template block carrying mode: markers must be rendered by its own plugin
// before install. Core cannot
// render it, so the raw text is neither a valid comparison base nor a valid
// replacement payload, so sync must be skipped entirely for such a block.
function requiresRendering(blockText: string): boolean {
  return /<!--\s*\/?mode:/.test(blockText);
}

// Registered sibling plugin names: the keys of _hermit_versions, minus core
// itself. Shared by computeClaudeAppend (as the fence for core's own block)
// and computeSiblings (as the fence for each sibling's block).
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

// Internal: diff a CLAUDE-APPEND block against what's in the target file.
// tmplText: the template file content (already read by caller).
// marker: the HTML-comment marker line.
// targetFile: path to CLAUDE.local.md or CLAUDE.md.
// opts.foreignNames: other registered plugin names, used to fence block bounds.
// opts.sibling: true when diffing a sibling hermit's block — governs the
//   missing-marker rule below. Core may append its own missing block; a
//   sibling never may, since core cannot render a sibling's template and an
//   un-rendered append would corrupt the target (see requiresRendering).
// Returns null on error (error pushed); a result object on success.
function _diffClaudeAppendByText(
  tmplText: string,
  marker: string,
  targetFile: string,
  errors: Json[],
  codes: { markerMissing: string; targetUnreadable: string },
  opts: { foreignNames?: string[]; sibling?: boolean } = {},
): ClaudeAppendDiffResult | null {
  const foreignNames = opts.foreignNames ?? [];
  const tmplBlock = markerOnward(tmplText, marker, foreignNames);
  if (tmplBlock === null) {
    errors.push({ code: codes.markerMissing, message: `marker "${marker}" not found in template` });
    return null;
  }

  if (requiresRendering(tmplBlock)) {
    return { changed: false, needs_render: true };
  }

  let targetText: string | null = null;
  try {
    targetText = fs.readFileSync(targetFile, 'utf8');
  } catch (e: any) {
    if (e && e.code !== 'ENOENT') {
      errors.push({ code: codes.targetUnreadable, message: `${targetFile} unreadable: ${e.message}` });
      return null;
    }
    // file missing -> append case (targetText stays null)
  }

  const targetBlock = targetText === null ? null : markerOnward(targetText, marker, foreignNames);

  if (targetBlock === null) {
    // file missing or marker absent — append case, no old_block. Siblings
    // never auto-append: core cannot render their template, so it can only
    // report and defer to the sibling's own hatch.
    return opts.sibling ? { changed: true, missing: true } : { changed: true };
  }

  if (isAmbiguousBlock(targetText!, marker, targetBlock)) {
    return { changed: true, ambiguous: true };
  }

  const changed = normTrailing(targetBlock) !== normTrailing(tmplBlock);
  const result: ClaudeAppendDiffResult = { changed };
  if (changed) result.old_block = targetBlock;
  return result;
}

function computeResident(
  plan: Json, template: string, marker: string, hermitDir: string, foreignNames: string[], errors: Json[],
): void {
  const resident = splitResident(template).resident;
  if (!resident) return;
  const target = path.join(hermitDir, 'RESIDENT.md');
  const result = _diffClaudeAppendByText(resident, marker, target, errors, {
    markerMissing: 'resident_marker_missing', targetUnreadable: 'resident_target_unreadable',
  }, { foreignNames });
  if (!result) return;
  // Read again rather than trust `result`: the diff short-circuits on
  // needs_render before it ever opens the target, and a mode-fenced sibling whose
  // resident block was never installed is exactly the case worth reporting.
  // Guarded like the diff's own read — an unreadable RESIDENT.md is one warning,
  // not a throw that collapses the whole plan into a fatal.
  let targetText: string | null = null;
  try {
    targetText = fs.readFileSync(target, 'utf8');
  } catch (e: any) {
    if (e && e.code !== 'ENOENT') {
      errors.push({ code: 'resident_target_unreadable', message: `${target} unreadable: ${e.message}` });
      return;
    }
  }
  plan.resident_missing = targetText === null || markerOnward(targetText, marker, foreignNames) === null;
  plan.resident_changed = result.changed || plan.resident_missing;
  if (result.old_block !== undefined) plan.resident_old_block = result.old_block;
  if (result.ambiguous) plan.resident_ambiguous = true;
}

function computeClaudeAppend(plan: Json, pluginRoot: string, hermitDir: string, hatchTarget: string, config: Json, errors: Json[]) {
  let tmplText: string;
  try {
    tmplText = fs.readFileSync(path.join(pluginRoot, 'state-templates', 'CLAUDE-APPEND.md'), 'utf8');
  } catch (e: any) {
    errors.push({ code: 'claude_append_template_unreadable', message: e.message });
    return;
  }

  const projectRoot = path.resolve(hermitDir, '..');
  const targetFile = path.join(projectRoot, hatchTarget === 'local' ? 'CLAUDE.local.md' : 'CLAUDE.md');
  const foreignNames = getRegisteredNames(config);

  computeResident(plan, tmplText, MARKER, hermitDir, foreignNames, errors);
  const result = _diffClaudeAppendByText(splitResident(tmplText).shared, MARKER, targetFile, errors, {
    markerMissing: 'claude_append_marker_missing',
    targetUnreadable: 'claude_target_unreadable',
  }, { foreignNames });
  if (result === null) return;
  plan.claude_append_changed = result.changed;
  if (result.changed && result.old_block !== undefined) {
    plan.claude_append_old_block = result.old_block;
  }
  if (result.needs_render) plan.claude_append_needs_render = true;
  if (result.ambiguous) plan.claude_append_ambiguous = true;
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
  hermitDir: string,
  hatchTarget: string,
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

  const targetFile = path.join(projectRoot, hatchTarget === 'local' ? 'CLAUDE.local.md' : 'CLAUDE.md');

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

    // CLAUDE-APPEND drift — computed for all siblings so no-gap drift can be
    // reported as advisory (block-drifted). Edit is only applied on a version gap.
    const claudeAppendPath = path.join(installPath, 'state-templates', 'CLAUDE-APPEND.md');
    let tmplText: string | null = null;
    try {
      tmplText = fs.readFileSync(claudeAppendPath, 'utf8');
    } catch {
      // No CLAUDE-APPEND.md for this sibling — skip block comparison
    }

    if (tmplText !== null) {
      const marker = extractSiblingMarker(tmplText, name);
      if (marker !== null) {
        sibling.marker = marker;
        const localErrors: Json[] = [];
        const foreignNames = ['hermitd', ...registeredNames.filter(n => n !== name)];
        computeResident(sibling, tmplText, marker, hermitDir, foreignNames, localErrors);
        const diffResult = _diffClaudeAppendByText(splitResident(tmplText).shared, marker, targetFile, localErrors, {
          markerMissing: `sibling_${name}_marker_missing`,
          targetUnreadable: `sibling_${name}_target_unreadable`,
        }, { foreignNames, sibling: true });
        if (localErrors.length > 0) {
          siblingWarnings.push(...localErrors.map((e: Json) => `${name}: ${e.message}`));
        }
        if (diffResult !== null) {
          sibling.claude_append_changed = diffResult.changed;
          if (diffResult.changed && diffResult.old_block !== undefined) {
            sibling.claude_append_old_block = diffResult.old_block;
          }
          if (diffResult.needs_render) sibling.claude_append_needs_render = true;
          if (diffResult.missing) sibling.claude_append_block_missing = true;
          if (diffResult.ambiguous) sibling.claude_append_ambiguous = true;
        }
      } else {
        siblingWarnings.push(
          `${name}: no "<!-- ${name}: … -->" marker in state-templates/CLAUDE-APPEND.md — block sync skipped`
        );
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

function buildPlan({ hermitDir, pluginRoot, hatchTarget, pluginListJsonPath }: {
  hermitDir: string;
  pluginRoot: string;
  hatchTarget: string | null;
  pluginListJsonPath?: string | null;
}): Json {
  const errors: Json[] = [];
  const plan: Json = { errors };

  if (hatchTarget !== 'local' && hatchTarget !== 'committed') {
    errors.push({ code: 'no_hatch_target', message: '--hatch-target=<local|committed> is required' });
    return plan;
  }
  plan.hatch_target = hatchTarget;

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
  // sibling gap or CLAUDE-APPEND drift, which would walk the runner into Step 7's
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

  computeClaudeAppend(plan, pluginRoot, hermitDir, hatchTarget, config, errors);

  // Sibling hermit plans — registry-driven from _hermit_versions.
  // Plugin list load failures are non-fatal: core upgrade proceeds; siblings[] will be empty.
  const siblingWarnings: string[] = [];
  const { list: pluginList, error: pluginListError } = loadPluginList(pluginListJsonPath ?? null);
  if (pluginListError) {
    siblingWarnings.push(`plugin-list unavailable: ${pluginListError}`);
  }

  const siblingResult = computeSiblings(config, pluginList, hermitDir, hatchTarget, projectRoot, siblingWarnings);
  plan.siblings = siblingResult.siblings;
  plan.siblings_path_unresolved = siblingResult.siblings_path_unresolved;
  plan.siblings_detected_unregistered = siblingResult.siblings_detected_unregistered;
  if (siblingWarnings.length > 0) plan.siblings_warnings = siblingWarnings;

  // work_pending: true when core or any sibling needs attention (version gap or
  // CLAUDE-APPEND drift). Drives the short-circuit in SKILL.md Step 1 —
  // "already up to date" only when nothing to do for core OR any registered sibling.
  // Siblings we could not fully assess (path-unresolved, or a plugin-list/CHANGELOG
  // warning) also keep work_pending true so the skill runs Step 7 and surfaces them
  // instead of silently reporting "up to date".
  // `claude_append_needs_render` is deliberately NOT part of this test: it is a
  // static property of the sibling's template (dev-hermit's always carries mode:
  // markers), not evidence of pending work. Including it would pin work_pending
  // true forever for every project with dev-hermit registered, so hermit-evolve
  // could never report "up to date" again. On a real version gap `!s.up_to_date`
  // already fires — the only case where Step 7 acts on the flag.
  const siblingWorkNeeded = plan.siblings.some(
    (s: SiblingPlanEntry) =>
      !s.up_to_date || s.claude_append_changed || s.claude_append_ambiguous || s.resident_changed || s.resident_missing
  );
  const siblingsUnassessed =
    plan.siblings_path_unresolved.length > 0 || (plan.siblings_warnings?.length ?? 0) > 0;
  // Core's own block can drift or become ambiguous even when the version stamp is
  // current (e.g. a stray duplicate left by a prior bad sync) — mirror the sibling
  // check above so that case isn't swallowed by the "already up to date" short-circuit.
  const coreAppendWorkNeeded =
    plan.claude_append_changed === true || plan.claude_append_ambiguous === true || plan.resident_changed === true || plan.resident_missing === true;
  plan.work_pending = !plan.up_to_date || coreAppendWorkNeeded || siblingWorkNeeded || siblingsUnassessed;

  return plan;
}

function parseArgs(argv: string[]) {
  let hermitDir: string | null = null;
  let hatchTarget: string | null = null;
  let pluginListJsonPath: string | null = null;
  for (const a of argv) {
    if (a.startsWith('--hatch-target=')) hatchTarget = a.slice('--hatch-target='.length);
    else if (a.startsWith('--plugin-list-json=')) pluginListJsonPath = a.slice('--plugin-list-json='.length);
    else if (!a.startsWith('--') && hermitDir === null) hermitDir = a;
  }
  return { hermitDir: hermitDir || '.hermit', hatchTarget, pluginListJsonPath };
}

export { buildPlan, cmpSemver, changelogSlice, newConfigKeys, markerOnward, extractSiblingMarker, closingMarkerFor, isAmbiguousBlock, requiresRendering, classifyFiles, classifyDockerEntrypoint, classifyDockerTemplates };
export type { ClassifiedFile, FileClass };

if (import.meta.main) {
  const { hermitDir, hatchTarget, pluginListJsonPath } = parseArgs(process.argv.slice(2));
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '..');
  let plan: Json;
  try {
    plan = buildPlan({ hermitDir: path.resolve(hermitDir), pluginRoot, hatchTarget, pluginListJsonPath });
  } catch (e: any) {
    plan = { errors: [{ code: 'fatal', message: e.message }] };
  }
  process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  process.exit(0);
}
