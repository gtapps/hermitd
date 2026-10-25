import fs from 'node:fs';
import path from 'node:path';
import { agentId, hermitDir, sessionId } from './lib/cc-compat';
import { isGuest } from './lib/guest-marker';
import { MAX_HOOK_STDIN } from './lib/hook-input';
import { checkWrite, LearnedSkills } from './lib/learned-skills';

export function skillTarget(payload: any, hermit: string): { file: string; skill: string; relative: string } | null {
  if (!['Edit', 'Write'].includes(payload?.tool_name) || typeof payload?.tool_input?.file_path !== 'string') return null;
  const root = path.join(path.dirname(hermit), '.claude', 'skills');
  const file = path.resolve(payload.cwd || path.dirname(hermit), payload.tool_input.file_path);
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.includes(path.sep)) return null;
  const [skill, ...rest] = relative.split(path.sep);
  return { file, skill, relative: rest.join('/') };
}

export function writeMarker(payload: any, hermit: string, file: string): string {
  const key = new Bun.CryptoHasher('sha256').update(`${sessionId(payload)}:${payload.tool_use_id ?? ''}:${file}`).digest('hex');
  return path.join(hermit, 'state', `skill-write-${key}.json`);
}

function deny(reason: string): void {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) + '\n');
}

async function main(): Promise<void> {
  const raw = await Bun.stdin.text();
  let payload: any = null;
  if (Buffer.byteLength(raw) <= MAX_HOOK_STDIN) { try { payload = JSON.parse(raw); } catch {} }
  if (!payload) {
    // Without a parsed path, only a payload naming a skill folder fails closed.
    if (/\.claude[\\/]+skills[\\/]/.test(raw)) deny('Cannot inspect oversized or unparseable skill-write payload');
    return;
  }
  const hermit = hermitDir();
  if (isGuest(path.join(hermit, 'state'), sessionId(payload))) return;
  const target = skillTarget(payload, hermit);
  if (!target) return;
  if (agentId(payload)) { deny('Workers hand the procedure to the resident'); return; }
  const lib = new LearnedSkills(hermit);
  const current = fs.existsSync(target.file) ? fs.readFileSync(target.file, 'utf8') : '';
  const input = payload.tool_input;
  let next: string;
  if (payload.tool_name === 'Write' && typeof input.content === 'string') next = input.content;
  else if (payload.tool_name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string' && input.old_string) {
    // A function replacer keeps `$&`, `$'` and `$$` in new_string literal, as the Edit tool writes them.
    next = input.replace_all ? current.replaceAll(input.old_string, () => input.new_string) : current.replace(input.old_string, () => input.new_string);
  } else { deny('Cannot inspect unparseable skill-write payload'); return; }
  const reason = checkWrite(target.relative, current, next);
  if (reason) { deny(reason); return; }
  const existed = fs.existsSync(lib.skillDir(target.skill));
  lib.saveRevision(target.skill);
  fs.mkdirSync(lib.state, { recursive: true });
  fs.writeFileSync(writeMarker(payload, hermit, target.file), JSON.stringify({ action: existed ? 'patch' : 'create' }));
}

if (import.meta.main) main().catch(() => {}).finally(() => process.exit(0));
