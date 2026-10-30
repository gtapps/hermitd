import fs from 'node:fs';
import path from 'node:path';
import { appendJsonlLine } from './append-jsonl';
import { writeFileAtomic } from './md-write';

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Resident tool calls while a task is open that make it due for skill review. */
export const REVIEW_CALLS = 10;
const ALLOWED_KEYS = new Set(['name', 'description', 'when_to_use', 'argument-hint', 'arguments', 'paths', 'disable-model-invocation', 'user-invocable', 'metadata']);
export type Lint = { errors: string[]; warnings: string[] };
export type SkillAction = 'create' | 'patch' | 'pin' | 'unpin' | 'rollback' | 'archive' | 'restore';
export type LedgerLine = { ts: string; skill: string; action: SkillAction; origin?: string; lint?: Lint };

function frontmatter(text: string): { raw: string; body: string } {
  if (!/^---\r?\n/.test(text)) throw new Error('Missing frontmatter');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new Error('Unterminated frontmatter');
  return { raw: match[1], body: text.slice(match[0].length) };
}

function keys(text: string): Set<string> {
  let raw: string;
  try { raw = frontmatter(text).raw; } catch { return new Set(); }
  const result = new Set<string>();
  for (const line of raw.split('\n')) {
    const match = /^([^\s:#][^:]*):/.exec(line);
    if (match) result.add(match[1].trim().replace(/^(['"])(.*)\1$/, '$2'));
  }
  // YAML also permits flow mappings and quoted keys. Parsing catches those;
  // raw scanning above still fences ordinary keys in an unfinished draft.
  try {
    const parsed = Bun.YAML.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const key of Object.keys(parsed)) result.add(key);
    }
  } catch { /* lint reports malformed frontmatter after the write */ }
  return result;
}

/** `file` is the path relative to the skill folder. Existing forbidden content may stay. */
export function checkWrite(file: string, current: string, next: string): string | null {
  const relative = file.replaceAll('\\', '/');
  if ((relative !== 'SKILL.md' && !/^(references|templates)\/[^/]/.test(relative))
    || relative.split('/').some(part => part === '..' || part === '.')) {
    return 'Learned skills may contain only SKILL.md, references/** and templates/**';
  }
  if (relative === 'SKILL.md') {
    if (next.length > 20000) return 'SKILL.md exceeds 20,000 characters';
    const previous = keys(current);
    for (const key of keys(next)) {
      if (!ALLOWED_KEYS.has(key) && !previous.has(key)) return `Forbidden frontmatter key: ${key}`;
    }
  }
  const shellBlocks = (text: string): string[] => text.match(/!`[^`]*(?:`|$)|^\s*```![^\n]*/gm) ?? [];
  const previous = shellBlocks(current);
  for (const block of shellBlocks(next)) {
    const index = previous.indexOf(block);
    if (index < 0) return 'Inline shell blocks are forbidden in learned skills';
    previous.splice(index, 1);
  }
  return null;
}

export function lint(skillDir: string): Lint {
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    const text = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const { raw, body } = frontmatter(text);
    const data = Bun.YAML.parse(raw) as Record<string, unknown>;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Unparsable frontmatter');
    // Claude Code defaults a missing name to the folder name.
    const name = data.name ?? path.basename(skillDir);
    if (name !== path.basename(skillDir)) errors.push('Skill name must equal folder name');
    if (typeof name !== 'string' || !SKILL_NAME.test(name)) errors.push('Invalid skill name');
    if (String(data.description ?? '').length + String(data.when_to_use ?? '').length > 1536) warnings.push('Description and when_to_use exceed listing cap (1,536 characters)');
    for (const match of body.matchAll(/\]\((references\/[^)\s#]+)(?:#[^)]*)?\)/g)) {
      if (!fs.existsSync(path.join(skillDir, match[1]))) warnings.push(`Missing reference: ${match[1]}`);
    }
    if ((body.match(/(?:#\d+|(?:issues|pull)\/\d+)/g) ?? []).length >= 5) warnings.push('Dense issue/PR references resemble an incident log');
    if (body.length > 12000) warnings.push('Skill body exceeds 12,000 characters');
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Unparsable frontmatter');
  }
  return { errors, warnings };
}

/** All state belongs to the resident; hermit is its resolved .hermit directory. */
export class LearnedSkills {
  readonly state: string;
  readonly root: string;
  constructor(readonly hermit: string) {
    this.state = path.join(hermit, 'state');
    this.root = path.join(path.dirname(hermit), '.claude', 'skills');
  }
  changedSince(sinceMs: number): boolean {
    let skills: string[];
    try { skills = fs.readdirSync(this.root); } catch { return false; }
    return skills.some(skill => {
      try { return fs.statSync(path.join(this.root, skill, 'SKILL.md')).ctimeMs >= sinceMs; } catch { return false; }
    });
  }
  skillDir(skill: string): string {
    // Keep paths contained even for an invalid draft name: lint must report it.
    if (!skill || skill === '.' || skill === '..' || /[\\/]/.test(skill) || path.isAbsolute(skill)) throw new Error('Invalid skill name');
    return path.join(this.root, skill);
  }
  ledger(): LedgerLine[] {
    try {
      return fs.readFileSync(path.join(this.state, 'skill-ledger.jsonl'), 'utf8').split('\n').flatMap(line => {
        try { return [JSON.parse(line) as LedgerLine]; } catch { return []; }
      });
    } catch { return []; }
  }
  record(skill: string, action: SkillAction, details: Pick<LedgerLine, 'origin' | 'lint'> = {}): void {
    this.skillDir(skill);
    fs.mkdirSync(this.state, { recursive: true });
    const error = appendJsonlLine(path.join(this.state, 'skill-ledger.jsonl'), JSON.stringify({ ts: new Date().toISOString(), skill, action, ...details }));
    if (error) throw new Error(error);
  }
  isLearned(skill: string): boolean { return this.ledger().some(line => line.skill === skill && line.action === 'create'); }
  pins(): Set<string> {
    const result = new Set<string>();
    for (const line of this.ledger()) {
      if (line.action === 'pin') result.add(line.skill);
      if (line.action === 'unpin') result.delete(line.skill);
    }
    return result;
  }
  saveRevision(skill: string): void {
    const source = this.skillDir(skill);
    if (!fs.existsSync(source)) return;
    const history = path.join(this.state, 'skill-history', skill);
    fs.mkdirSync(history, { recursive: true });
    const revision = `${new Date().toISOString().replaceAll(':', '-')}-${process.hrtime.bigint().toString().padStart(24, '0')}`;
    fs.cpSync(source, path.join(history, revision), { recursive: true });
    for (const old of fs.readdirSync(history).sort().slice(0, -5)) fs.rmSync(path.join(history, old), { recursive: true });
  }
  restoreRevision(skill: string): boolean {
    const destination = this.skillDir(skill);
    // An archived skill comes back through restore; rolling it back here would strand the archived copy.
    if (!fs.existsSync(destination)) return false;
    const history = path.join(this.state, 'skill-history', skill);
    let revisions: string[];
    try { revisions = fs.readdirSync(history).sort(); } catch { return false; }
    const latest = revisions.at(-1);
    if (!latest) return false;
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(path.join(history, latest), destination, { recursive: true });
    fs.rmSync(path.join(history, latest), { recursive: true });
    this.record(skill, 'rollback');
    return true;
  }
  archivedOnce(): Set<string> {
    try { return new Set(JSON.parse(fs.readFileSync(path.join(this.state, 'skill-archived.json'), 'utf8'))); } catch { return new Set(); }
  }
  archive(skill: string): boolean {
    const source = this.skillDir(skill);
    const destination = path.join(this.state, 'skill-archive', skill);
    if (!this.isLearned(skill) || !fs.existsSync(source) || fs.existsSync(destination)) return false;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(source, destination);
    const once = this.archivedOnce();
    once.add(skill);
    writeFileAtomic(path.join(this.state, 'skill-archived.json'), JSON.stringify([...once]));
    this.record(skill, 'archive');
    return true;
  }
  restore(skill: string): boolean {
    const destination = this.skillDir(skill);
    const source = path.join(this.state, 'skill-archive', skill);
    if (!fs.existsSync(source) || fs.existsSync(destination)) return false;
    fs.mkdirSync(this.root, { recursive: true });
    fs.renameSync(source, destination);
    this.record(skill, 'restore');
    return true;
  }
}
