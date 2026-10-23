// Read-only candidate discovery. The evolve model decides which references depend on a change.
import fs from 'node:fs';
import path from 'node:path';
import { readConfigRaw } from './config-read';
import { resolveGate } from './routines/gate';

interface Subject { id: string; terms: string[]; kind: 'routine_id' | 'name'; to?: string }
interface Candidate { subject: string; file: string; line: number; text: string; tracked: boolean }

export function parseSubjects(input: string): Subject[] {
  const value = JSON.parse(input);
  if (!Array.isArray(value?.subjects) || value.subjects.some((s: Subject) =>
    !s || typeof s.id !== 'string' || !s.id || !Array.isArray(s.terms) || !s.terms.length ||
    s.terms.some(t => typeof t !== 'string' || !t) || !['routine_id', 'name'].includes(s.kind) ||
    (s.to !== undefined && typeof s.to !== 'string')) ||
    new Set(value.subjects.map((s: Subject) => s.id)).size !== value.subjects.length) throw new Error('bad_subjects');
  return value.subjects;
}

export function consumerScan(hermitDir: string, subjects: Subject[]) {
  const root = fs.realpathSync(path.dirname(path.resolve(hermitDir)));
  const gitRun = (args: string[]) => Bun.spawnSync(['git', '-C', root, ...args]);
  const git = gitRun(['rev-parse', '--show-toplevel']);
  const hasGit = git.exitCode === 0 && git.stdout.toString().trim() === root;
  const listing = hasGit ? gitRun(['ls-files', '-co', '--exclude-standard', '-z']).stdout.toString().split('\0').filter(Boolean) : [];
  const tracked = new Set(hasGit ? gitRun(['ls-files', '-z']).stdout.toString().split('\0') : []);
  const files = new Set<string>();
  const skipped: { file: string; reason: string }[] = [];
  const excluded = (file: string) => file.split('/').some(p => ['node_modules', '.git'].includes(p)) ||
    file.startsWith('.claude/worktrees/') || /(?:\.(?:bak|new|orig)|~)$/.test(file) ||
    /(?:^|[._-])\d{4}-?\d{2}-?\d{2}(?:[T._-]?\d{2}[:._-]?\d{2}(?:[:._-]?\d{2})?)?(?:\.|$)/.test(path.basename(file));
  const nested = (file: string) => {
    let dir = path.dirname(file);
    while (dir !== '.') {
      if (fs.existsSync(path.join(root, dir, '.git'))) return true;
      dir = path.dirname(dir);
    }
    return false;
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
  const pluginRoots = new Set<string>();
  if (hasGit) {
    for (const file of listing) if (file.endsWith('.claude-plugin/plugin.json') && !excluded(file) && !nested(file)) pluginRoots.add(path.dirname(path.dirname(file)));
  } else {
    walk('.', file => { if (file.endsWith('.claude-plugin/plugin.json')) pluginRoots.add(path.dirname(path.dirname(file))); });
  }
  const folders = ['.claude/skills', '.claude/commands', '.claude/agents'];
  for (const plugin of pluginRoots) for (const folder of ['skills', 'commands', 'agents', 'scripts']) folders.push(path.join(plugin, folder));
  if (hasGit) {
    for (const file of listing) if (file === 'CLAUDE.md' || folders.some(folder => file.startsWith(folder + '/'))) add(file);
  } else {
    add('CLAUDE.md');
    for (const folder of folders) walk(folder, add);
  }
  for (const file of ['OPERATOR.md', 'HEARTBEAT.md', 'knowledge-schema.md', 'dashboard-render.ts', 'config.json']) add(path.join(hermitDir, file));
  for (const file of ['CLAUDE.local.md', '.claude/settings.json', '.claude/settings.local.json']) add(file);
  try {
    const config = readConfigRaw(hermitDir);
    if (!config) throw new Error('unreadable_config');
    for (const routine of config.routines ?? []) {
      const gate = resolveGate(routine.precheck, root);
      if (gate.kind === 'script') add(gate.abs);
    }
    for (const monitor of config.monitors ?? []) {
      if (typeof monitor.command !== 'string') continue;
      for (const match of monitor.command.matchAll(/"([^"]+)"|'([^']+)'|([^\s]+)/g)) add(match[1] ?? match[2] ?? match[3]);
    }
  } catch { skipped.push({ file: path.relative(root, path.join(hermitDir, 'config.json')), reason: 'unreadable_config' }); }
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
  for (const subject of subjects) { counts[subject.id] = 0; contextFiltered[subject.id] = 0; examples[subject.id] = []; }
  for (const file of [...files].sort()) {
    const abs = path.join(root, file);
    let data: Buffer;
    try {
      const real = fs.realpathSync(abs);
      if (!real.startsWith(root + path.sep)) { skipped.push({ file, reason: 'outside_project' }); continue; }
      const stat = fs.statSync(real);
      if (!stat.isFile()) continue;
      if (stat.size > 1024 * 1024) { skipped.push({ file, reason: 'oversized' }); continue; }
      data = fs.readFileSync(real);
    } catch { if (fs.existsSync(abs)) skipped.push({ file, reason: 'unreadable' }); continue; }
    if (data.includes(0)) { skipped.push({ file, reason: 'binary' }); continue; }
    filesScanned++;
    data.toString('utf8').split('\n').forEach((text, index) => {
      for (const subject of subjects) {
        const replacements = subject.to ? occurrences(text, subject.to) : [];
        const terms = subject.terms.filter(term => occurrences(text, term).some(pos => !replacements.some(newPos => pos >= newPos && pos + term.length <= newPos + subject.to!.length)));
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
    ...(skipped.length ? { skipped } : {}) };
}
