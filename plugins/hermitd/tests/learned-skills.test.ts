import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkWrite, lint, LearnedSkills } from '../scripts/lib/learned-skills';

const draft = (name = 'sample', extra = '', body = 'Steps') => `---\nname: ${name}\ndescription: Example\n${extra}---\n${body}`;
test('write fence checks every deny reason and preserves existing keys', () => {
  for (const key of ['allowed-tools', 'model', 'context', 'agent']) {
    const text = draft('sample', `${key}: test\n`);
    expect(checkWrite('SKILL.md', '', text)).toContain(key);
    expect(checkWrite('SKILL.md', text, text + '\nMore')).toBeNull();
  }
  for (const body of ['!`echo hi`', '```!echo hi\n```']) {
    const text = draft('sample', '', body);
    expect(checkWrite('SKILL.md', '', text)).toContain('shell');
    expect(checkWrite('SKILL.md', text, text)).toBeNull();
  }
  expect(checkWrite('scripts/run.ts', '', '')).toContain('only');
  expect(checkWrite('references/../run.ts', '', '')).toContain('only');
  expect(checkWrite('SKILL.md', '', 'x'.repeat(20001))).toContain('20,000');
  expect(checkWrite('references/guide.md', '', 'Guide')).toBeNull();
  expect(checkWrite('templates/example.md', '', 'Example')).toBeNull();
  expect(checkWrite('SKILL.md', '', draft('sample', 'argument-hint: input\n'))).toBeNull();
});
test('lint checks frontmatter, names, and four warnings', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'learned-'));
  const dir = path.join(temp, 'sample'); fs.mkdirSync(dir);
  try {
    for (const text of ['---\nname: sample', '---\nname: [\n---\n', draft('other'), draft('BAD')]) {
      fs.writeFileSync(path.join(dir, 'SKILL.md'), text);
      expect(lint(dir).errors.length).toBeGreaterThan(0);
    }
    fs.writeFileSync(path.join(dir, 'SKILL.md'), draft('sample', `when_to_use: ${'a'.repeat(1600)}\n`, '[ref](references/missing.md) #1 #2 #3 #4 #5 ' + 'b'.repeat(12001)));
    expect(lint(dir).errors).toEqual([]);
    expect(lint(dir).warnings.length).toBe(4);
  } finally { fs.rmSync(temp, { recursive: true }); }
});
test('history keeps five whole folders; ledger owns learned, pins and archive-once', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'learned-'));
  const lib = new LearnedSkills(path.join(temp, '.hermit'));
  const dir = lib.skillDir('sample'); fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
  try {
    expect(lib.isLearned('sample')).toBe(false);
    lib.record('sample', 'patch'); expect(lib.isLearned('sample')).toBe(false);
    lib.record('sample', 'create'); expect(lib.isLearned('sample')).toBe(true);
    lib.record('sample', 'pin'); expect(lib.pins().has('sample')).toBe(true);
    lib.record('sample', 'unpin'); expect(lib.pins().size).toBe(0);
    for (let n = 0; n < 7; n++) {
      fs.writeFileSync(path.join(dir, 'SKILL.md'), draft());
      fs.writeFileSync(path.join(dir, 'references', 'value'), String(n));
      lib.saveRevision('sample');
    }
    expect(fs.readdirSync(path.join(lib.state, 'skill-history', 'sample')).length).toBe(5);
    fs.writeFileSync(path.join(dir, 'references', 'value'), 'changed');
    expect(lib.restoreRevision('sample')).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'references', 'value'), 'utf8')).toBe('6');
    expect(lib.archive('sample')).toBe(true);
    expect(lib.archivedOnce().has('sample')).toBe(true);
    expect(lib.restore('sample')).toBe(true);
    expect(lib.archivedOnce().has('sample')).toBe(true);
    expect(lib.archive('operator')).toBe(false);
  } finally { fs.rmSync(temp, { recursive: true }); }
});
