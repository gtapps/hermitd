// Back up and retire installed hermit instruction blocks without a plugin inventory.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './lib/md-write';
import { emitJson, exitError } from './lib/cli';

type Unpaired = { file: string; line: number };

type Result = ({ changed: string[]; backup: string; deleted?: string[] }
  | { status: 'noop' }
  | { error: string }
  | { error: string; backup: string; changed: string[]; deleted: string[]; failed: string }) & { unpaired?: Unpaired[] };

function removeBlocks(text: string): { after: string; removed: string; unpaired: number[] } {
  const spans: Array<{ start: number; end: number }> = [];
  const unpairedAt: number[] = [];
  const markers = /^[ \t]*<!-- (\/?)([^:\s]+): ([^\r\n]*?) -->[ \t]*\r?$/gm;
  const matches = [...text.matchAll(markers)].filter(match => match[2].includes('hermit'));
  // A leading frontmatter's closing fence belongs to the operator, not the block.
  // Only text above the first marker can be frontmatter; a later `---` is a block separator.
  const frontmatter = /^---[ \t]*\r?\n[\s\S]*?^---[ \t]*\r?$/m.exec(text.slice(0, matches[0]?.index ?? 0));
  const fenceAt = frontmatter?.index === 0 ? frontmatter[0].lastIndexOf('\n') + 1 : -1;
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const closing = matches[i + 1];
    if (!match[1] && closing?.[1] && match[2] === closing[2] && match[3] === closing[3]) {
      let start = match.index;
      let end = closing.index + closing[0].length;
      if (text[end] === '\n') end++;
      // Retire an immediately preceding separator and its blank lines, preserving
      // the operator's preceding line terminator. Otherwise leave spacing alone.
      const separator = /(?:^|\n)[ \t]*---[ \t]*\r?\n(?:[ \t]*\r?\n)*$/.exec(text.slice(0, start));
      const separatorAt = separator ? separator.index + (separator[0].startsWith('\n') ? 1 : 0) : -1;
      if (separator && separatorAt !== fenceAt) start = separatorAt;
      spans.push({ start, end });
      i++;
    } else {
      unpairedAt.push(match.index);
    }
  }
  const removed = spans.map(span => text.slice(span.start, span.end)).join('\n');
  for (const span of spans.reverse()) text = text.slice(0, span.start) + text.slice(span.end);
  // Line numbers name the rewritten file the operator will edit, after earlier spans are gone.
  const unpaired = unpairedAt.map(index => {
    const shift = spans.filter(span => span.end <= index).reduce((n, span) => n + span.end - span.start, 0);
    return text.slice(0, index - shift).split('\n').length;
  });
  return { after: text, removed, unpaired };
}

export function retireHermitBlocks(hermitDir: string, write = writeFileAtomic, unlink = fs.unlinkSync): Result {
  const root = path.resolve(hermitDir, '..');
  const resident = path.resolve(hermitDir, 'RESIDENT.md');
  const files = [path.join(root, 'CLAUDE.md'), path.join(root, 'CLAUDE.local.md'), resident];
  const changes: Array<{ file: string; before: string; after: string; removed: string }> = [];
  const unpaired: Unpaired[] = [];
  const details = () => unpaired.length ? { unpaired } : {};
  // Read every snapshot before creating a backup or changing any source.
  for (const file of files) {
    let before: string;
    try { before = fs.readFileSync(file, 'utf8'); } catch (error: any) {
      if (error.code === 'ENOENT') continue;
      return { error: 'target_unreadable' };
    }
    // RESIDENT.md is deleted as a whole, including all operator text, so its markers need no parse.
    if (file === resident) {
      changes.push({ file, before, after: '', removed: before });
      continue;
    }
    const parsed = removeBlocks(before);
    unpaired.push(...parsed.unpaired.map(line => ({ file: path.relative(root, file), line })));
    if (parsed.after !== before) changes.push({ file, before, after: parsed.after, removed: parsed.removed });
  }
  if (!changes.length) return { status: 'noop', ...details() };

  const backup = path.resolve(hermitDir, 'state', `removed-hermit-blocks.${new Date().toISOString().replace(/:/g, '-')}.${crypto.randomUUID()}.md`);
  try {
    fs.writeFileSync(backup, changes.map(change => `# ${path.relative(root, change.file)}\n\n${change.removed}`).join('\n\n'), { flag: 'wx' });
  } catch { return { error: 'backup_failed' }; }

  const changed: string[] = [];
  const deleted: string[] = [];
  for (const change of changes) {
    const file = path.relative(root, change.file);
    const failure = (error: string): Result => ({ error, backup, changed, deleted, failed: file, ...details() });
    try {
      if (fs.readFileSync(change.file, 'utf8') !== change.before) return failure('target_changed');
    } catch { return failure('target_changed'); }
    try {
      if (change.file === resident) {
        unlink(change.file);
        deleted.push(file);
      } else {
        write(change.file, change.after);
      }
      changed.push(file);
    } catch { return failure(change.file === resident ? 'delete_failed' : 'replace_failed'); }
  }
  return { changed, backup, ...(deleted.length ? { deleted } : {}), ...details() };
}

if (import.meta.main) {
  if (process.argv.length !== 3) exitError('usage');
  emitJson(retireHermitBlocks(process.argv[2]));
}
