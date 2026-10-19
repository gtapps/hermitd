import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './hash';
import { readJson } from './cli';
import { writeFileAtomic } from './md-write';
import { readConfigRaw } from './config-read';

type Json = any;

export function contextPolicyHash(dir: string): string {
  const read = (file: string) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
  // Hash malformed config as text so policy bookkeeping cannot stop recovery.
  let config = readConfigRaw(dir);
  if (!config || typeof config !== 'object') {
    const raw = read(path.join(dir, 'config.json'));
    config = raw ? { raw } : {};
  }
  delete config._hermit_versions;
  for (const channel of Object.values(config.channels ?? {})) {
    if (channel && typeof channel === 'object') {
      delete (channel as Json).default_chat_id;
    }
  }
  return sha256(JSON.stringify([
    read(path.join(dir, 'OPERATOR.md')), read(path.join(dir, 'TASKS.md')),
    read(path.join(path.dirname(dir), 'CLAUDE.local.md')),
    read(path.join(path.dirname(dir), '.claude/settings.json')), config,
  ]));
}

// Only a full resident context load establishes a new policy baseline.
// Preserve clear-trigger bookkeeping and never update runtime liveness here.
export function recordContextPolicy(dir: string): void {
  try {
    const file = path.join(dir, 'state/context-clear.json');
    const previous = readJson(file) ?? {};
    writeFileAtomic(file, JSON.stringify({ ...previous, policy_hash: contextPolicyHash(dir) }) + '\n');
  } catch { /* fail-open: bookkeeping must not suppress startup context */ }
}
