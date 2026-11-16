// Shared template-default traversal for the evolve path. evolve-plan.ts reports
// what is missing; evolve-finalize.ts applies it inside its single atomic write.
// One traversal, two consumers — a second copy would let the report and the write
// disagree about what "missing" means.

import { machineTimeZone } from './time';

type Json = any;

export function isPlainObject(v: Json): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface MissingKey {
  path: string;
  default: Json;
}

// Deep diff of the template against the project config; reports ONLY keys
// missing from the project (operator values are never reported/overwritten).
// Parent object entirely absent -> emit the parent path with its full default
// subtree. Parent present but children missing -> emit the missing leaves as
// dotted paths. Arrays and scalars are leaves (no element-level merge), so a
// new default routine in a later version rides on Upgrade Instructions, as today.
export function newConfigKeys(tmpl: Json, config: Json, prefix?: string, out?: MissingKey[]): MissingKey[] {
  out = out || [];
  prefix = prefix || '';
  if (!isPlainObject(tmpl)) return out;
  for (const key of Object.keys(tmpl)) {
    const tval = tmpl[key];
    const fullPath = prefix ? `${prefix}.${key}` : key;
    const present = isPlainObject(config) && Object.prototype.hasOwnProperty.call(config, key);
    if (!present) {
      out.push({ path: fullPath, default: tval });
    } else if (isPlainObject(tval) && isPlainObject(config[key])) {
      newConfigKeys(tval, config[key], fullPath, out);
    }
    // present + leaf, or present with a type mismatch -> operator value kept, skip.
  }
  return out;
}

// Does a dotted path resolve to something present? Used to confirm an applied
// default against the re-read of config.json rather than trusting the write.
export function hasPath(obj: Json, dotted: string): boolean {
  let cursor = obj;
  for (const seg of dotted.split('.')) {
    if (!isPlainObject(cursor) || !Object.prototype.hasOwnProperty.call(cursor, seg)) return false;
    cursor = cursor[seg];
  }
  return true;
}

// Apply missing template defaults to `config` IN PLACE, missing-only. Re-derives
// the set against the object handed in, so a key written earlier in the run (a
// migration, or the runner's auto-detected language/timezone) is already present
// and is therefore never revisited. Returns the dotted paths actually added, which
// is what the finalizer reports as settings_added — confirmed, not intended.
export function applyMissingDefaults(config: Json, tmpl: Json): string[] {
  const added: string[] = [];
  for (const { path: dotted, default: value } of newConfigKeys(tmpl, config)) {
    const parts = dotted.split('.');
    let cursor = config;
    // newConfigKeys only emits a path whose ancestors are all present objects
    // (an absent ancestor is emitted as its own entry carrying the whole subtree),
    // so this walk never has to invent an intermediate node.
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (!isPlainObject(cursor[seg])) { cursor = null; break; }
      cursor = cursor[seg];
    }
    if (cursor === null) continue;
    // A missing timezone takes the machine's zone, as hatch does, rather than the template's null.
    cursor[parts[parts.length - 1]] = dotted === 'timezone' ? machineTimeZone() : structuredClone(value);
    added.push(dotted);
  }
  return added;
}
