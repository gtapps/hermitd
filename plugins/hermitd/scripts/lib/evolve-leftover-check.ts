// Candidate discovery for Step 7b. It changes no operator file; the evolve model decides which
// references depend on a change. State carries the declarations from the plan and, per check,
// the subjects and those declarations, so a later Fix re-checks exactly what was asked.
import fs from 'node:fs';
import path from 'node:path';
import { readConfigRaw } from './config-read';
import { resolveGate } from './routines/gate';
import { writeFileAtomic } from './md-write';

interface Subject { id: string; terms: string[]; kind: 'routine_id' | 'name'; to?: string }
interface Candidate { subject: string; file: string; line: number; text: string; tracked: boolean }
interface Declaration { plugin: string; version: string; text: string }

/** `{subjects}` validated and expanded to concrete subjects. */
export function parseSubjects(input: string): Subject[] {
  return validSubjects(JSON.parse(input));
}

function validSubjects(value: any): Subject[] {
  if (!Array.isArray(value?.subjects) || value.subjects.some((s: Subject) =>
    !s || typeof s.id !== 'string' || !s.id || !Array.isArray(s.terms) || !s.terms.length ||
    s.terms.some(t => typeof t !== 'string' || !t) || !['routine_id', 'name'].includes(s.kind) ||
    (s.to !== undefined && typeof s.to !== 'string'))) throw new Error('bad_subjects');
  return expandSubjects(value.subjects);
}

export const CHANGELOG_HEADER = /^## \[(\d+\.\d+\.\d+)\]/;

/** Every `**Leftover check:**` line in each plugin's changelog slice, verbatim, with the version it ships in. */
export function leftoverDeclarations(slices: { plugin: string; slice?: string }[]): Declaration[] {
  const declarations: Declaration[] = [];
  for (const { plugin, slice } of slices) {
    let version = '';
    for (const line of (slice ?? '').split('\n')) {
      version = line.match(CHANGELOG_HEADER)?.[1] ?? version;
      if (/^\s*(?:\d+\.\s+)?\*\*Leftover check:\*\*/.test(line)) declarations.push({ plugin, version, text: line });
    }
  }
  return declarations;
}

const declarationsPath = (hermitDir: string) => path.join(hermitDir, 'state', 'leftover-declarations.json');
export const savedInputPath = (hermitDir: string) => path.join(hermitDir, 'state', 'leftover-check.json');

function writeState(file: string, value: object): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

/** Plan mode records the current gap's declarations; with none, it removes the record so none outlive their plan. */
export function recordDeclarations(hermitDir: string, declarations: Declaration[]): void {
  if (declarations.length) writeState(declarationsPath(hermitDir), { declarations });
  else fs.rmSync(declarationsPath(hermitDir), { force: true });
}

/** A check pairs its concrete subjects with the plan's declarations for a later `--saved` Fix. */
export function saveCheck(hermitDir: string, subjects: Subject[]): void {
  const file = declarationsPath(hermitDir);
  const declarations = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).declarations : [];
  writeState(savedInputPath(hermitDir), { subjects, declarations });
}

export function readSavedCheck(hermitDir: string): { subjects: Subject[]; declarations: Declaration[] } {
  const saved = JSON.parse(fs.readFileSync(savedInputPath(hermitDir), 'utf8'));
  const declarations = saved.declarations;
  if (!Array.isArray(declarations) || declarations.some((d: Declaration) =>
    !d || typeof d.plugin !== 'string' || typeof d.version !== 'string' || typeof d.text !== 'string')) throw new Error('bad_subjects');
  return { subjects: validSubjects(saved), declarations };
}

// A routine rename declared as a pattern (`"to": "<plugin>:<id>"`) is one subject per old id.
function expandSubjects(given: Subject[]): Subject[] {
  const subjects = given.flatMap(s => s.kind === 'routine_id' && s.to?.includes('<id>')
    ? s.terms.map(term => ({ id: `${s.id}/${term}`, terms: [term], kind: s.kind, to: s.to!.replaceAll('<id>', term) }))
    : [s]);
  if (new Set(subjects.map(s => s.id)).size !== subjects.length) throw new Error('bad_subjects');
  return subjects;
}

export function leftoverCheck(hermitDir: string, subjects: Subject[]) {
  const root = fs.realpathSync(path.dirname(path.resolve(hermitDir)));
  const walked = ['.claude/skills', '.claude/commands', '.claude/agents', '.claude/rules'];
  const files = new Set<string>();
  const skipped: { file: string; reason: string }[] = [];
  const excluded = (file: string) => file.split('/').some(p => ['node_modules', '.git'].includes(p)) ||
    file.startsWith('.claude/worktrees/') || /(?:\.(?:bak|new|orig)|~)$/.test(file) ||
    /(?:^|[._-])\d{4}-?\d{2}-?\d{2}(?:[T._-]?\d{2}[:._-]?\d{2}(?:[:._-]?\d{2})?)?(?:\.|$)/.test(path.basename(file));
  const repoDirs = new Map<string, boolean>();
  const nested = (file: string): boolean => {
    const dir = path.dirname(file);
    if (dir === '.') return false;
    let hit = repoDirs.get(dir);
    if (hit === undefined) repoDirs.set(dir, hit = fs.existsSync(path.join(root, dir, '.git')) || nested(dir));
    return hit;
  };
  const add = (file: string) => {
    const relative = path.relative(root, path.resolve(root, file));
    if (relative && !relative.startsWith('../') && !path.isAbsolute(relative) && !excluded(relative) && !nested(relative)) files.add(relative);
  };
  const walk = (dir: string, visit: (file: string) => void) => {
    if (excluded(dir) || nested(path.join(dir, '_'))) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (excluded(file)) continue;
      if (entry.isDirectory()) walk(file, visit);
      else visit(file);
    }
  };
  for (const folder of walked) walk(folder, add);
  for (const file of ['OPERATOR.md', 'HEARTBEAT.md', 'knowledge-schema.md', 'dashboard-render.ts', 'config.json']) add(path.join(hermitDir, file));
  for (const file of ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md', '.claude/settings.json', '.claude/settings.local.json']) add(file);
  let routineIds: Set<string> | null = null;
  try {
    const config = readConfigRaw(hermitDir);
    if (!config) throw new Error('unreadable_config');
    routineIds = new Set((config.routines ?? []).map((routine: { id?: string }) => routine?.id));
    for (const routine of config.routines ?? []) {
      const gate = resolveGate(routine.precheck, root);
      if (gate.kind === 'script') add(gate.abs);
    }
    for (const monitor of config.monitors ?? []) {
      if (typeof monitor.command !== 'string') continue;
      for (const match of monitor.command.matchAll(/"([^"]+)"|'([^']+)'|([^\s]+)/g)) add(match[1] ?? match[2] ?? match[3]);
    }
  } catch { skipped.push({ file: path.relative(root, path.join(hermitDir, 'config.json')), reason: 'unreadable_config' }); }
  // Symlinked directories inside the project (a shared skill folder) are walked once; Set iteration sees added entries.
  const linkedDirs = new Set<string>();
  for (const file of files) {
    try {
      const abs = path.join(root, file);
      if (!fs.lstatSync(abs).isSymbolicLink()) continue;
      const real = fs.realpathSync(abs);
      if (!real.startsWith(root + path.sep) || !fs.statSync(real).isDirectory() || linkedDirs.has(real)) continue;
      linkedDirs.add(real);
      walk(file, add);
    } catch {}
  }
  // Git marks shared files (paths are relative to root, so a project inside a larger repo works too) and drops
  // ignored files under the walked folders; the fixed files above are often ignored on purpose and stay.
  const listed = Bun.spawnSync(['git', '--literal-pathspecs', '-C', root, 'ls-files', '-z', '--', ...files]);
  const hasGit = listed.exitCode === 0;
  const tracked = new Set(hasGit ? listed.stdout.toString().split('\0') : []);
  if (hasGit) {
    const walkedFiles = [...files].filter(file => walked.some(folder => file.startsWith(folder + '/')));
    const ignored = Bun.spawnSync(['git', '-C', root, 'check-ignore', '--stdin', '-z'], { stdin: Buffer.from(walkedFiles.join('\0')) });
    for (const file of ignored.stdout.toString().split('\0')) files.delete(file);
  }
  const counts: Record<string, number> = {};
  const contextFiltered: Record<string, number> = {};
  const examples: Record<string, Candidate[]> = {};
  const candidates: Candidate[] = [];
  let filesScanned = 0;
  const token = /[\p{L}\p{N}_-]/u;
  const occurrences = (line: string, term: string) => {
    const positions: number[] = [];
    for (let start = 0; start < line.length;) {
      const index = line.indexOf(term, start);
      if (index < 0) break;
      if ((!index || !token.test(line[index - 1])) && (index + term.length === line.length || !token.test(line[index + term.length]))) positions.push(index);
      start = index + term.length;
    }
    return positions;
  };
  // A routine rename is live only once its new id is a routine in current config.
  const isLive = (s: Subject) => !routineIds || s.kind !== 'routine_id' || s.to === undefined || routineIds.has(s.to);
  const live = subjects.filter(isLive);
  const notLive = subjects.filter(s => !isLive(s)).map(s => s.id);
  // Any live subject's new form on a line is already migrated, whichever subject's term it contains.
  const newForms = [...new Set(live.flatMap(s => s.to ? [s.to] : []))];
  for (const subject of live) { counts[subject.id] = 0; contextFiltered[subject.id] = 0; examples[subject.id] = []; }
  const configFile = path.join(path.basename(path.resolve(hermitDir)), 'config.json');
  const scannedReal = new Set<string>();
  for (const file of [...files].sort()) {
    const abs = path.join(root, file);
    let data: Buffer;
    try {
      const real = fs.realpathSync(abs);
      if (!real.startsWith(root + path.sep)) { skipped.push({ file, reason: 'outside_project' }); continue; }
      if (scannedReal.has(real)) continue;
      scannedReal.add(real);
      const stat = fs.statSync(real);
      if (!stat.isFile()) continue;
      if (stat.size > 1024 * 1024) { skipped.push({ file, reason: 'oversized' }); continue; }
      data = fs.readFileSync(real);
    } catch { if (fs.existsSync(abs)) skipped.push({ file, reason: 'unreadable' }); continue; }
    if (data.includes(0)) { skipped.push({ file, reason: 'binary' }); continue; }
    filesScanned++;
    data.toString('utf8').split('\n').forEach((text, index) => {
      let spans: [number, number][] | null = null;
      for (const subject of live) {
        if (!subject.terms.some(term => text.includes(term))) continue;
        spans ??= newForms.flatMap(form => occurrences(text, form).map((start): [number, number] => [start, start + form.length]));
        const hits = subject.terms.map(term => ({ term, positions: occurrences(text, term).filter(pos => !spans!.some(([start, end]) => pos >= start && pos + term.length <= end)) }));
        if (!hits.some(hit => hit.positions.length)) continue;
        // In a routine's reflect wrapper, `--check-id <old-id>` is a check key that stays bare on purpose, not a routine id.
        const checkKey = (pos: number) => file === configFile && subject.kind === 'routine_id' && (text.endsWith('--check-id ', pos) || text.endsWith('--check-id=', pos));
        const terms = hits.filter(hit => hit.positions.some(pos => !checkKey(pos))).map(hit => hit.term);
        if (!terms.length) continue;
        const candidate = { subject: subject.id, file, line: index + 1, text: text.slice(0, 200), tracked: tracked.has(file) };
        if (subject.kind === 'routine_id' && terms.every(term => !term.includes('-')) && !/routine/i.test(text)) {
          contextFiltered[subject.id]++;
          if (examples[subject.id].length < 5) examples[subject.id].push(candidate);
        } else {
          counts[subject.id]++;
          if (candidates.length < 200) candidates.push(candidate);
        }
      }
    });
  }
  return { status: 'ok', git: hasGit, files_scanned: filesScanned, counts, context_filtered: contextFiltered,
    context_filtered_examples: examples, candidates, truncated: Object.values(counts).reduce((a, b) => a + b, 0) > candidates.length,
    ...(notLive.length ? { not_live: notLive } : {}),
    ...(skipped.length ? { skipped } : {}) };
}
