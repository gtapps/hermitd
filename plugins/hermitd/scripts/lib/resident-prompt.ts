import fs from 'node:fs';
import path from 'node:path';
import { transcriptDirFor } from './cc-compat';

type Json = any;

/** Build the resident prompt without writing state or terminating the caller. */
export function buildResidentPrompt(projectRoot: string, pluginRoot = path.resolve(import.meta.dirname, '../..')): string {
  try {
    const override = fs.readFileSync(path.join(projectRoot, '.hermit/resident-prompt.md'), 'utf8');
    if (override.trim()) return override;
  } catch { /* Absent or unreadable overrides use the shipped prompt. */ }
  const read = (name: string) => fs.readFileSync(path.join(pluginRoot, 'prompts', name), 'utf8');
  return `${read('resident.md')}\n${read('rules.md')}`;
}

export function resolveResumeTarget(
  runtime: Json,
  projectRoot: string,
  configDir?: string,
): { id: string } | { skip: 'no-session-id' | 'no-transcript' | 'no-user-turn' | 'prompt-changed' } {
  const id = runtime?.cc_session_id;
  if (typeof id !== 'string' || !id.trim()) return { skip: 'no-session-id' };
  const dir = transcriptDirFor(projectRoot, configDir);
  const transcript = path.join(dir, `${id}.jsonl`);
  if (path.dirname(transcript) !== dir) return { skip: 'no-transcript' };
  let text: string;
  try {
    text = fs.readFileSync(transcript, 'utf8');
  } catch {
    return { skip: 'no-transcript' };
  }
  const hasUserTurn = text.split('\n').some((line) => {
    try { return JSON.parse(line).type === 'user'; } catch { return false; }
  });
  if (!hasUserTurn) return { skip: 'no-user-turn' };
  try {
    const previous = fs.readFileSync(path.join(projectRoot, '.hermit/state/resident-system-prompt.md'), 'utf8');
    if (previous === buildResidentPrompt(projectRoot)) return { id };
  } catch { /* Missing prompt or source requires a fresh session. */ }
  return { skip: 'prompt-changed' };
}

