#!/usr/bin/env bun
// Folder-shared nightly dream state. Export is read-only outside state/dream*;
// finish and undo alone publish restores to the snapshotted targets.
import fs from 'node:fs';
import path from 'node:path';
import { sha256 as hash } from './lib/hash';
import { entryText, isTurnBoundary, isToolResult, toolUseNames, transcriptDirFor, resolvedMemoryDir, pinStateDirOrExit } from './lib/cc-compat';
import { classifySource } from './lib/trigger-source';
import { parseChannelEnvelope } from './lib/channel-envelope';
import { rowAudience } from './lib/channel-auth';
import { writeFileAtomic } from './lib/md-write';
import { appendJsonlLine } from './lib/append-jsonl';
import { parseFrontmatter } from './lib/frontmatter';
import { sendOperatorNotice } from './lib/channel-send';
import { EN } from './lib/messages';
import { readSettledConfig } from './lib/config-read';

type Json = any;
interface State { window_start: string; running: { run_dir: string; started_at: string } | null }
interface Evidence { entry: Json; session: string; agent: string | null; audience: string; prompt?: string }
interface Manifest { memory_dir: string; compiled_dir: string; files: Record<string, string> }
const HOUR = 3_600_000;
// Byte bounds and bytes/4 token accounting are estimates, not model token limits.
export const INPUT_MAX_BYTES = 300_000;
export const NIGHT_MAX_BYTES = 2_000_000;
const statePath = (dir: string) => path.join(dir, 'state/dream.json');
function readJson(file: string): Json { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function jsonLines(file: string): Json[] {
  try {
    // A writer may still own the last line. Do not consume it before its newline.
    return fs.readFileSync(file, 'utf8').split('\n').slice(0, -1).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
}
function names(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
}
function state(dir: string, now: number): State {
  try { return readJson(statePath(dir)); }
  catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    return { window_start: new Date(now - 24 * HOUR).toISOString(), running: null };
  }
}
function saveState(dir: string, value: State): void {
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  writeFileAtomic(statePath(dir), JSON.stringify(value) + '\n', 0o600);
}
function active(value: State, now: number): boolean {
  return !!value.running && now - Date.parse(value.running.started_at) < 2 * HOUR;
}

/** One eligibility walk for export and the zero-token routine gate. */
export function eligibleEntries(dir: string, windowStart: string, runStart: string): Evidence[] {
  const root = transcriptDirFor(path.dirname(dir));
  const config = readSettledConfig(dir);
  const excluded = new Set<string>();
  for (const run of names(path.join(dir, 'state/dream'))) {
    for (const row of jsonLines(path.join(dir, 'state/dream', run, 'agents.jsonl'))) excluded.add(row.agent_id);
  }
  const files: Array<{ session: string; agent: string | null; entries: Json[] }> = [];
  for (const name of names(root)) {
    if (!name.endsWith('.jsonl')) continue;
    const session = name.slice(0, -6);
    files.push({ session, agent: null, entries: jsonLines(path.join(root, name)) });
    const subs = path.join(root, session, 'subagents');
    for (const sub of names(subs)) {
      const match = /^agent-(.+)\.jsonl$/.exec(sub);
      if (match) files.push({ session, agent: match[1], entries: jsonLines(path.join(subs, sub)) });
    }
  }
  const turns: Array<{ file: typeof files[number]; entries: Evidence[]; dropped: boolean; launches: string[] }> = [];
  const parents = new Map<string, typeof turns[number]>();
  for (const file of files) {
    let turn: typeof turns[number] | undefined;
    for (const entry of file.entries) {
      const queued = entry.attachment?.type === 'queued_command' ? entry.attachment.prompt : undefined;
      const prompt = typeof queued === 'string' ? queued : isTurnBoundary(entry) ? entryText(entry) : undefined;
      if (prompt !== undefined) {
        const source = classifySource(prompt);
        const ids = [...prompt.matchAll(/\[hermit-routine:([A-Za-z0-9._:-]+)\]/g)].map(m => m[1]);
        const envelope = parseChannelEnvelope(prompt, config);
        const audience = envelope ? rowAudience(config, envelope.sourceKey, envelope.chatId) : 'shared';
        turn = { file, entries: [], dropped: source === 'heartbeat' || (source.startsWith('routine:') && ids.includes('hermitd:dream')), launches: [] };
        turns.push(turn);
        turn.entries.push({ entry, session: file.session, agent: file.agent, audience, prompt });
      } else if (turn) {
        turn.entries.push({ entry, session: file.session, agent: file.agent, audience: turn.entries[0].audience });
      }
      const result = entry.toolUseResult;
      // Synchronous Agent results carry agentId too; link both so audience and exclusion inherit.
      if (turn && typeof result?.agentId === 'string') {
        turn.launches.push(result.agentId);
        parents.set(result.agentId, turn);
      }
    }
  }
  // A dropped parent may launch a subagent which launches another. Reach a fixed point.
  let changed = true;
  while (changed) {
    changed = false;
    for (const turn of turns) {
      if (!turn.dropped && !(turn.file.agent && excluded.has(turn.file.agent))) continue;
      for (const id of turn.launches) if (!excluded.has(id)) { excluded.add(id); changed = true; }
    }
  }
  function inheritedAudience(turn: typeof turns[number], seen = new Set<string>()): string {
    const id = turn.file.agent;
    if (!id || seen.has(id) || !parents.has(id)) return turn.entries[0].audience;
    seen.add(id);
    return inheritedAudience(parents.get(id)!, seen);
  }
  const start = Date.parse(windowStart), end = Date.parse(runStart);
  return turns.flatMap(turn => {
    if (turn.dropped || (turn.file.agent && excluded.has(turn.file.agent))) return [];
    const audience = inheritedAudience(turn);
    return turn.entries.filter(e => {
      const ts = Date.parse(e.entry.timestamp);
      return ts >= start && ts < end;
    }).map(e => ({ ...e, audience }));
  }).sort((a, b) => Date.parse(a.entry.timestamp) - Date.parse(b.entry.timestamp));
}

function within(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
function protectedPath(value: unknown, memory: string, compiled: string): boolean {
  if (typeof value !== 'string') return false;
  const file = path.resolve(path.dirname(compiled), '..', value);
  return within(file, memory) || within(file, compiled);
}
function omitted(name: string): string { return `(memory content omitted: ${name})`; }
function render(e: Evidence, memory: string, compiled: string, tools: Map<string, { name: string; omit: boolean }>): string {
  const entry = e.entry;
  let out = `SESSION ${e.session}\n`;
  if (e.agent) out += `=== sub-thread ${e.agent}: ${entry.agentType ?? 'agent'} ===\n`;
  // Repeat the audience on continuations, including chunks beginning mid-turn.
  out += `AUDIENCE: ${e.audience}\n`;
  if (e.prompt !== undefined) return out + `USER: ${e.prompt}\n`;
  const attachment = entry.attachment;
  if (attachment && ['edited_text_file', 'file'].includes(attachment.type)) {
    const file = attachment.filename ?? attachment.filePath ?? attachment.file_path ?? attachment.path;
    return out + (protectedPath(file, memory, compiled) ? omitted(path.basename(file)) : JSON.stringify(attachment)) + '\n';
  }
  const content = entry.message?.content;
  if (typeof content === 'string') return out + `${entry.type === 'assistant' ? 'AGENT' : 'USER'}: ${content}\n`;
  if (!Array.isArray(content)) return '';
  const calls = new Map(toolUseNames(entry).map(t => [t.id, t.name]));
  for (const block of content) {
    if (block.type === 'tool_use') {
      const name = calls.get(block.id) ?? block.name;
      const input = block.input ?? {};
      const file = input.file_path ?? input.path;
      const omit = (['Read', 'Grep', 'Glob', 'Write', 'Edit'].includes(name) && protectedPath(file, memory, compiled))
        || (name === 'Skill' && /^hermitd:recall(?:\s|$)/.test(input.skill ?? ''))
        || (name === 'Bash' && /(?:hermitd:recall|hermitd-run\s+recall)/.test(input.command ?? ''));
      tools.set(block.id, { name, omit });
      out += `TOOL CALL ${name}: ${omit ? omitted(typeof file === 'string' ? path.basename(file) : 'hermitd:recall') : JSON.stringify(input)}\n`;
    } else if (block.type === 'tool_result' && isToolResult(entry)) {
      const tool = tools.get(block.tool_use_id);
      out += `TOOL RESULT (${tool?.name ?? 'unknown'}): ${tool?.omit ? omitted(tool.name) : typeof block.content === 'string' ? block.content : JSON.stringify(block.content)}\n`;
    } else if (block.type === 'text') out += `${entry.type === 'assistant' ? 'AGENT' : 'USER'}: ${block.text}\n`;
  }
  return out;
}
function targetFiles(memory: string, compiled: string): Record<string, string> {
  const files: Record<string, string> = {};
  function collect(dir: string, prefix: string): void {
    for (const name of names(dir)) {
      const file = path.join(dir, name), key = `${prefix}/${name}`;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('dream_symlink_target');
      if (stat.isDirectory() && prefix.startsWith('memory')) collect(file, key);
      else if (stat.isFile() && (prefix.startsWith('memory') || /^topic-.*\.md$/.test(name))) files[key] = hash(fs.readFileSync(file));
    }
  }
  collect(memory, 'memory'); collect(compiled, 'compiled');
  return files;
}
function target(manifest: Manifest, key: string): string {
  return path.join(key.startsWith('memory/') ? manifest.memory_dir : manifest.compiled_dir, key.slice(key.indexOf('/') + 1));
}
function restore(run: string, manifest: Manifest): void {
  const current = targetFiles(manifest.memory_dir, manifest.compiled_dir);
  for (const key of Object.keys(current)) if (!(key in manifest.files)) fs.unlinkSync(target(manifest, key));
  for (const key of Object.keys(manifest.files)) {
    const file = target(manifest, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(run, 'before', key), file);
  }
}
interface Change { file: string; kind: 'changed' | 'created' | 'removed'; before: string | null; after: string | null }
function changesFor(manifest: Manifest): Change[] {
  const current = targetFiles(manifest.memory_dir, manifest.compiled_dir);
  return [...new Set([...Object.keys(manifest.files), ...Object.keys(current)])].flatMap(file => {
    const before = manifest.files[file] ?? null, after = current[file] ?? null;
    return before === after ? [] : [{ file, before, after, kind: before === null ? 'created' as const : after === null ? 'removed' as const : 'changed' as const }];
  });
}
function facts(text: string): string[] {
  const body = text.replace(/^---[^]*?\n---(?:\n|$)/, '');
  return body.split('\n').map(line => line.trim().replace(/\s+/g, ' ')).filter(line => line && !line.startsWith('MOVED TO '));
}
function validation(run: string, manifest: Manifest, changes: Change[]): string[] {
  const failures: string[] = [];
  const before = new Map(Object.keys(manifest.files).map(key => [key, fs.readFileSync(path.join(run, 'before', key), 'utf8')]));
  const current = new Map(Object.keys(targetFiles(manifest.memory_dir, manifest.compiled_dir)).map(key => [key, fs.readFileSync(target(manifest, key), 'utf8')]));
  const oldFacts = new Set([...before.values()].flatMap(facts));
  const allFacts = new Set([...current.values()].flatMap(facts));
  const lost = [...oldFacts].filter(line => !allFacts.has(line));
  if (oldFacts.size && lost.length / oldFacts.size > 0.25) failures.push('fact_loss');
  for (const change of changes) {
    if (path.basename(change.file).startsWith('feedback_role_')) failures.push('role_file');
  }
  const index = before.get('memory/MEMORY.md') ?? '';
  const newIndex = current.get('memory/MEMORY.md') ?? '';
  if (index.split('\n').some(line => /\[role [^\]]+\]/.test(line) && !newIndex.split('\n').includes(line))) failures.push('role_index');
  for (const [key, text] of before) {
    if (!key.startsWith('compiled/')) continue;
    const fm = parseFrontmatter(text);
    const after = current.get(key);
    const afterFm = after === undefined ? null : parseFrontmatter(after);
    // A retired stub is exactly `MOVED TO [[slug]]` with no frontmatter; absent audience means shared.
    const retired = after !== undefined && /^MOVED TO \[\[[^\]]+\]\]\s*$/.test(after);
    if (!retired && (fm?.audience ?? 'shared') !== (afterFm?.audience ?? 'shared')) failures.push('audience');
    const tags = fm?.tags;
    if (Array.isArray(tags) && tags.includes('foundational')) {
      const kept = new Set(facts(after ?? ''));
      if (after === undefined || facts(text).some(line => !kept.has(line))) failures.push('foundational');
    }
  }
  return [...new Set(failures)];
}
function retainRuns(dir: string): void {
  const root = path.join(dir, 'state/dream');
  const runs = names(root).filter(name => fs.lstatSync(path.join(root, name)).isDirectory()).sort().reverse();
  for (const run of runs.slice(7)) fs.rmSync(path.join(root, run), { recursive: true });
}
function closeRun(dir: string, value: State, result: Json, abandoned = false): Json {
  const run = value.running!.run_dir;
  const manifest: Manifest = readJson(path.join(run, 'manifest.json'));
  const changes = changesFor(manifest);
  writeFileAtomic(path.join(run, 'changes.json'), JSON.stringify(changes) + '\n', 0o600);
  const failures = abandoned ? ['abandoned'] : validation(run, manifest, changes);
  const exported = readJson(path.join(run, 'export.json'));
  const stops = jsonLines(path.join(run, 'agents.jsonl'));
  const count = (type: string) => new Set(stops.filter(row => row.agent_type === type).map(row => row.agent_id)).size;
  const complete = count('hermitd:dream-analyzer') === exported.inputs.length && count('hermitd:dream-organizer') === 2;
  const status = abandoned ? 'abandoned' : failures.length ? 'restored' : complete ? 'complete' : 'partial';
  if (failures.length) {
    restore(run, manifest);
    // Notice delivery owns its own fallback to Findings. It never changes restore success.
    void sendOperatorNotice(dir, { client: EN.dream_restored, routine: 'hermitd:dream' }).catch(() => {});
  } else if (complete) value.window_start = exported.window_end;
  const digest = { at: new Date().toISOString(), run_dir: run, status, changes: changes.length, failures, complete, result };
  fs.rmSync(path.join(run, 'inputs'), { recursive: true, force: true });
  writeFileAtomic(path.join(run, 'finished.json'), JSON.stringify(digest) + '\n', 0o600);
  appendJsonlLine(path.join(dir, 'state/dream-log.jsonl'), JSON.stringify(digest));
  value.running = null;
  saveState(dir, value);
  retainRuns(dir);
  return digest;
}
export function finishDream(dir: string, result: Json): Json {
  const value = state(dir, Date.now());
  if (!value.running) return { status: 'noop' };
  return closeRun(dir, value, result);
}
export function undoDream(dir: string): Json {
  const root = path.join(dir, 'state/dream');
  // A restored or abandoned run already left its targets as they were; undo the last run that kept changes.
  const run = names(root).sort().reverse().map(name => path.join(root, name)).find(run => {
    try { return !['restored', 'abandoned'].includes(readJson(path.join(run, 'finished.json')).status); }
    catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
  });
  if (!run) return { status: 'empty', restored: [], conflicts: [] };
  const manifest: Manifest = readJson(path.join(run, 'manifest.json'));
  const changes: Change[] = readJson(path.join(run, 'changes.json'));
  const restored: string[] = [], conflicts: string[] = [];
  for (const change of changes) {
    const file = target(manifest, change.file);
    let current: string | null;
    try { current = hash(fs.readFileSync(file)); } catch (error: any) { if (error.code !== 'ENOENT') throw error; current = null; }
    if (current !== change.after) { conflicts.push(change.file); continue; }
    if (change.before === null) fs.unlinkSync(file);
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(path.join(run, 'before', change.file), file);
    }
    restored.push(change.file);
  }
  return { status: 'undone', restored, conflicts };
}

export function exportDream(dir: string, now = Date.now()): Json {
  const value = state(dir, now);
  if (active(value, now)) return { status: 'skipped', reason: 'run_in_progress' };
  if (value.running) closeRun(dir, value, {}, true);
  const memory = resolvedMemoryDir(dir);
  if (!memory) return { status: 'skipped', reason: 'memory_dir_unresolved' };
  const started = new Date(now).toISOString();
  const entries = eligibleEntries(dir, value.window_start, started);
  if (!entries.length) return { status: 'empty' };
  const compiled = path.join(dir, 'compiled');
  let files: Record<string, string>;
  try { files = targetFiles(memory, compiled); }
  catch (error: any) { if (error.message === 'dream_symlink_target') return { status: 'skipped', reason: 'symlink_target' }; throw error; }
  const run = path.join(dir, 'state/dream', started);
  fs.mkdirSync(path.join(run, 'inputs'), { recursive: true, mode: 0o700 });
  const manifest: Manifest = { memory_dir: memory, compiled_dir: compiled, files };
  for (const key of Object.keys(manifest.files)) {
    const before = path.join(run, 'before', key);
    fs.mkdirSync(path.dirname(before), { recursive: true, mode: 0o700 });
    fs.copyFileSync(target(manifest, key), before);
    fs.chmodSync(before, 0o600);
  }
  writeFileAtomic(path.join(run, 'manifest.json'), JSON.stringify(manifest) + '\n', 0o600);
  const inputs: string[] = [];
  let chunk = '', chunkBytes = 0, total = 0, windowEnd = value.window_start, pending = false;
  const flush = () => {
    if (!chunk) return;
    const file = path.join(run, 'inputs', `${inputs.length + 1}.txt`);
    fs.writeFileSync(file, chunk, { mode: 0o600 });
    inputs.push(file); chunk = ''; chunkBytes = 0;
  };
  const tools = new Map<string, { name: string; omit: boolean }>();
  for (const entry of entries) {
    const text = render(entry, memory, compiled, tools);
    const byteLength = Buffer.byteLength(text);
    // The first entry always exports, so one oversized entry cannot hold the window forever.
    if (total && total + byteLength > NIGHT_MAX_BYTES) { pending = true; break; }
    // Start a fresh input at an entry boundary; split only an entry larger than one input,
    // on codepoint boundaries, repeating its header so every input opens with an audience.
    if (chunk && chunkBytes + byteLength > INPUT_MAX_BYTES) flush();
    const head = text.slice(0, text.indexOf('\n', text.indexOf('\nAUDIENCE: ') + 1) + 1);
    for (const character of text) {
      const size = Buffer.byteLength(character);
      if (chunkBytes + size > INPUT_MAX_BYTES) { flush(); chunk = head; chunkBytes = Buffer.byteLength(head); }
      chunk += character; chunkBytes += size;
    }
    total += byteLength;
    windowEnd = entry.entry.timestamp;
  }
  flush();
  // Without pending work every entry at windowEnd was exported; start after it so the
  // gate does not wake again on the same boundary entry.
  if (!pending && windowEnd !== value.window_start) windowEnd = new Date(Date.parse(windowEnd) + 1).toISOString();
  writeFileAtomic(path.join(run, 'export.json'), JSON.stringify({ window_end: windowEnd, inputs, pending }) + '\n', 0o600);
  value.running = { run_dir: run, started_at: started };
  saveState(dir, value);
  return { status: 'ready', run_dir: run, inputs, memory_dir: memory, compiled_dir: compiled, est_tokens: Math.ceil(total / 4), pending };
}

export function dreamGate(dir: string, now = Date.now()): 'SKIP' | 'WAKE' {
  const value = state(dir, now);
  if (active(value, now) || !resolvedMemoryDir(dir)) return 'SKIP';
  let action: Json;
  try { action = readJson(path.join(dir, 'state/last-operator-action.json')); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  if (action?.at && now - Date.parse(action.at) < 2 * HOUR) return 'SKIP';
  return eligibleEntries(dir, value.window_start, new Date(now).toISOString()).length ? 'WAKE' : 'SKIP';
}

if (import.meta.main) {
  const [verb, requested] = process.argv.slice(2);
  const dir = pinStateDirOrExit(requested);
  if (verb === 'gate') console.log(dreamGate(dir));
  else if (verb === 'export') console.log(JSON.stringify(exportDream(dir)));
  else if (verb === 'finish' && process.argv.includes('--result-stdin')) console.log(JSON.stringify(finishDream(dir, JSON.parse(await Bun.stdin.text()))));
  else if (verb === 'undo') console.log(JSON.stringify(undoDream(dir)));
  else { console.log(JSON.stringify({ error: 'usage:dream.ts gate|export|finish --result-stdin|undo <hermitDir>' })); process.exitCode = 1; }
}
