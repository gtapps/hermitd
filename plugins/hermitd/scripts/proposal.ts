// Task-backed proposal entry, gates, metrics and routine installation.
import fs from 'node:fs';
import { readConfigRaw } from './lib/config-read';
import path from 'node:path';
import { emit, emitJson, exitError, readStdin } from './lib/cli';
import { pinStateDirOrExit, memoryDirFor } from './lib/cc-compat';
import { appendJsonlLine } from './lib/append-jsonl';
import { auditConfigChange } from './lib/config-audit';
import { writeFileAtomic } from './lib/md-write';
import { slugify } from './lib/prop-id';
import { utcISOStamp } from './lib/time';
import { mutateTask, readTaskInventory } from './lib/tasks';
import { run as runGate } from './lib/proposals/gate';
import { run as runMetrics } from './lib/proposals/metrics';
import { run as runEvent } from './lib/proposals/event';
import { migrate } from './lib/proposals/migrate';
import { run as runQualityGate } from './lib/proposals/quality-gate';

type Json = any;
type Verdict = Record<string, Json>;
function withWarnings(verdict: Verdict, warnings: string[]): Verdict {
  return warnings.length ? { ...verdict, warnings } : verdict;
}

const VALID_CATEGORIES = new Set(['improvement', 'routine', 'capability', 'constraint', 'bug']);

export function grabHeader(header: string, key: string): string | null {
  const m = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(header);
  return m ? m[1].trim() : null;
}

// Returns [] for an absent/blank header, null to signal invalid JSON/shape.
export function parseStringArray(raw: string | null): string[] | null {
  if (raw == null || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(x => typeof x === 'string')) return parsed;
  } catch { /* falls through to null below */ }
  return null;
}

export function verbCreate(stateDir: string, stdin: string): Verdict {
  const sep = /^---[ \t]*$/m.exec(stdin);
  if (!sep) return { error: 'missing_separator' };
  const header = stdin.slice(0, sep.index);
  const body = stdin.slice(sep.index + sep[0].length).replace(/^\r?\n/, '');
  if (!body.trim()) return { error: 'empty_body' };
  const title = grabHeader(header, 'Title');
  if (!title) return { error: 'missing_title' };
  const source = grabHeader(header, 'Source') || 'manual';
  const category = grabHeader(header, 'Category') || 'improvement';
  if (!VALID_CATEGORIES.has(category)) return { error: 'invalid_category' };
  const tags = parseStringArray(grabHeader(header, 'Tags'));
  if (tags === null) return { error: 'invalid_tags' };
  if (parseStringArray(grabHeader(header, 'Related-Sessions')) === null) return { error: 'invalid_related_sessions' };
  if (!fs.existsSync(stateDir)) return { error: 'state_dir_not_found' };
  const selfEvalKey = grabHeader(header, 'Self-Eval-Key');
  let receipt: { id: string; handle: string; created: boolean };
  try {
    receipt = mutateTask(stateDir, 'open', undefined, {
      requester: 'agent', title, done: title, kind: 'proposal',
      'waiting-on': 'admin', decision: JSON.stringify({ purpose: 'consent', authority: 'admin', generation: 1 }),
      'dedupe-key': selfEvalKey ? `self-eval:${selfEvalKey}` : `proposal:${slugify(title)}`,
      source, category, tags: JSON.stringify(tags), 'body-stdin': true,
    }, body) as typeof receipt;
  } catch (error: any) { return { error: error.message }; }
  const warnings: string[] = [];
  if (receipt.created) {
    try {
      const error = appendJsonlLine(path.join(stateDir, 'state', 'proposal-metrics.jsonl'), JSON.stringify({
        ts: utcISOStamp(), type: 'created', proposal_id: receipt.id, source, category, tags,
      }));
      if (error) warnings.push('metrics_append_failed');
    } catch { warnings.push('metrics_append_failed'); }
  }
  return withWarnings({ id: receipt.id, handle: receipt.handle }, warnings);
}

export function proposalDigest(root: string): Verdict {
  const inventory = readTaskInventory(root);
  if (!inventory.ok) return { error: 'inventory_read_failed' };
  const records = inventory.records.filter(record => record.kind === 'proposal');
  return { root, memory_dir: memoryDirFor(path.dirname(root)), total: records.length, omitted: Math.max(0, records.length - 50),
    proposals: records.slice(-50).map(record => ({
      id: record.id, handle: record.handle, title: record.title, source: record.source, category: record.category,
      tags: record.tags, status: record.status, closed_by: record.closed_by, reason: record.closed_reason,
      summary: record.summary, proposal: record.body.slice(0, 1200),
    })),
  };
}

const ROUTINE_REQUIRED_FIELDS = ['id', 'schedule', 'skill', 'enabled'];

export function verbRoutine(stateDir: string, stdin: string): Verdict {
  let entry: Json;
  try { entry = JSON.parse(stdin); } catch { return { error: 'invalid_json' }; }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { error: 'invalid_json' };
  for (const field of ROUTINE_REQUIRED_FIELDS) {
    if (!(field in entry)) return { error: `missing_field:${field}` };
  }
  if (typeof entry.id !== 'string' || !entry.id) return { error: 'missing_field:id' };

  const configPath = path.join(stateDir, 'config.json');
  const config: Json = readConfigRaw(stateDir);
  if (!config) return { error: 'config_unreadable' };

  if (!Array.isArray(config.routines)) config.routines = [];
  const configBefore = structuredClone(config);
  const idx = config.routines.findIndex((r: Json) => r && r.id === entry.id);
  const verdict = idx >= 0 ? 'updated' : 'added';
  if (idx >= 0) config.routines[idx] = entry;
  else config.routines.push(entry);

  try {
    writeFileAtomic(configPath, JSON.stringify(config, null, 2) + '\n');
  } catch {
    return { error: 'config_write_failed' };
  }
  auditConfigChange(stateDir, configBefore, config, 'proposal');

  return { status: verdict, id: entry.id };
}


async function main(): Promise<void> {
  const [verb, dirArg, ...args] = process.argv.slice(2);
  if (verb === 'metrics') {
    const tail = process.argv.slice(3);
    const positional = tail.find(arg => !arg.startsWith('--'));
    if (positional !== undefined) pinStateDirOrExit(positional);
    return runMetrics(tail);
  }
  if (!verb || !dirArg) exitError();
  const dir = pinStateDirOrExit(dirArg);
  switch (verb) {
    case 'migrate': return emitJson(migrate(dir));
    case 'create': return emitJson(verbCreate(dir, await readStdin()));
    case 'routine': return emitJson(verbRoutine(dir, await readStdin()));
    case 'gate': return runGate(dir, args);
    case 'anchor': return emitJson(proposalDigest(dir));
    case 'event': {
      const error = runEvent(dir, args);
      if (error) emitJson(error); else emit('OK');
      return;
    }
    case 'quality-gate': return runQualityGate(dir, args);
    default: return emitJson({ error: 'unknown_verb' });
  }
}
if (import.meta.main) main().catch((error: any) => emitJson({ error: `unexpected:${error?.message ?? 'unknown'}` }));
