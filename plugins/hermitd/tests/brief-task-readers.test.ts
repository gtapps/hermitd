import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('task-based reader instructions', () => {
  test('brief gates on resident records and includes observed duties', () => {
    const skill = read('skills/brief/SKILL.md');
    expect(skill).toContain('--open --owner resident --json');
    expect(skill).toContain('scripts/duties.ts summary');
    expect(skill).not.toContain('session_state');
    expect(skill).not.toContain('SHELL.md');
    expect(skill).not.toContain('S-*-REPORT.md');
  });

  test('brief builds waiting items from this turn\'s records, never from an earlier brief', () => {
    const skill = read('skills/brief/SKILL.md');
    const ref = read('skills/brief/reference.md');
    expect(ref).toContain('populate `waiting` from `task-list` rows');
    expect(skill).toContain('use `runner.waiting`');
    for (const text of [skill, ref]) {
      expect(text).toContain('`state/last-brief.json`, `compiled/brief-*`');
    }
    expect(read('../hermitd-homeassistant/skills/ha-morning-brief/SKILL.md')).toContain('Pending tasks come only from that list, never from an earlier brief');
  });

  test('reflection and weekly evaluation consume bounded normalized records', () => {
    for (const path of ['skills/reflect/reference.md', 'skills/weekly-review/reference.md']) {
      const text = read(path);
      expect(text).toContain('`task-report` (Commands)');
      expect(read(path.replace('reference.md', 'SKILL.md'))).toContain('task-report.ts .hermit --recent --limit 3');
      expect(text).not.toContain('S-*-REPORT.md');
      expect(text).not.toContain('session_state');
    }
  });

  test('judge receives adapter rows without gaining shell access', () => {
    const judge = read('agents/reflection-judge.md');
    expect(judge).toContain('Task records:');
    expect(judge).toContain('disallowedTools:\n  - Bash');
    expect(judge).not.toContain('<root>/sessions');
    expect(read('skills/reflect/SKILL.md')).toContain('include `Task records:`');
  });

  test('health reads task lessons without legacy fallback', () => {
    const skill = read('skills/hermit-health/SKILL.md');
    expect(skill).toContain('task-report.ts .hermit --limit 5');
    expect(skill).not.toContain('SHELL.md');
    expect(skill).not.toContain('S-*-REPORT.md');
  });
});
