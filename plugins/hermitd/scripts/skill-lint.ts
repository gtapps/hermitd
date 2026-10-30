import fs from 'node:fs';
import path from 'node:path';
import { agentId, hermitDir, sessionId } from './lib/cc-compat';
import { isGuest } from './lib/guest-marker';
import { readHookInput, OVERSIZE } from './lib/hook-input';
import { LearnedSkills, lint } from './lib/learned-skills';
import { skillTarget, writeMarker } from './skill-guard';

const SKILL_CHANGE_CONTEXT = 'Claude Code normally picks up this skill change within a minute, no restart or new session needed. To use it in this reply, follow the file instead of calling Skill, which may fail or load the old version. Frontmatter such as allowed-tools or context only applies through Skill.';
// The hook starts after the command ends.
const BASH_MARGIN_MS = 5000;

function writeContext(lines: string[]): void {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: lines.join('\n') } }) + '\n');
}

async function main(): Promise<void> {
  const payload = await readHookInput();
  if (!payload || payload === OVERSIZE) return;
  const hermit = hermitDir();
  if (agentId(payload) || isGuest(path.join(hermit, 'state'), sessionId(payload))) return;
  if (payload.tool_name === 'Bash') {
    const since = Date.now() - (Number(payload.duration_ms) || 0) - BASH_MARGIN_MS;
    if (new LearnedSkills(hermit).changedSince(since)) writeContext([SKILL_CHANGE_CONTEXT]);
    return;
  }
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
  const lines = [...result.warnings];
  if (target.relative === 'SKILL.md') lines.push(SKILL_CHANGE_CONTEXT);
  if (lines.length) writeContext(lines);
}
main().catch(() => {}).then(() => process.exit(0));
