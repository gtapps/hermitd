import fs from 'node:fs';
import path from 'node:path';
import { agentId, hermitDir, sessionId } from './lib/cc-compat';
import { isGuest } from './lib/guest-marker';
import { readHookInput, OVERSIZE } from './lib/hook-input';
import { LearnedSkills, lint } from './lib/learned-skills';
import { skillTarget, writeMarker } from './skill-guard';

async function main(): Promise<void> {
  const payload = await readHookInput();
  if (!payload || payload === OVERSIZE) return;
  const hermit = hermitDir();
  if (agentId(payload) || isGuest(path.join(hermit, 'state'), sessionId(payload))) return;
  const target = skillTarget(payload, hermit);
  if (!target) return;
  const lib = new LearnedSkills(hermit);
  const marker = writeMarker(payload, hermit, target.file);
  // Only the PreToolUse guard knows whether the skill folder existed.
  const { action } = JSON.parse(fs.readFileSync(marker, 'utf8'));
  fs.unlinkSync(marker);
  const result = lint(lib.skillDir(target.skill));
  lib.record(target.skill, action, { lint: result });
  if (result.errors.length) {
    process.stderr.write(result.errors.join('\n') + '\n');
    process.exit(2);
  }
  if (result.warnings.length) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: result.warnings.join('\n') } }) + '\n');
}
main().catch(() => {}).then(() => process.exit(0));
