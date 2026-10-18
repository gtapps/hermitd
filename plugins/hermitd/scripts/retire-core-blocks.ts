// Retire only core's installed instruction blocks, backing up removed bytes first.
// No git checkout or plugin inventory is needed to recognize an installed block.
import fs from 'node:fs';
import path from 'node:path';
import { markerOnward, isAmbiguousBlock, closingMarkerFor } from './evolve-plan';
import { writeFileAtomic } from './lib/md-write';
import { emitJson, exitError } from './lib/cli';

const MARKER = '<!-- hermitd: Session Discipline -->';
const CLOSE = closingMarkerFor(MARKER);

type Result = { changed: string[]; backup: string } | { status: 'noop' } | { error: string };

export function retireCoreBlocks(hermitDir: string, write = writeFileAtomic): Result {
  const root = path.resolve(hermitDir, '..');
  const files = [path.join(root, 'CLAUDE.md'), path.join(root, 'CLAUDE.local.md'), path.resolve(hermitDir, 'RESIDENT.md')];
  const changes: Array<{ file: string; before: string; after: string; removed: string }> = [];
  // Validate all files before creating a backup or replacing any file.
  for (const file of files) {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch (error: any) {
      if (error.code === 'ENOENT') continue;
      return { error: 'target_unreadable' };
    }
    const lines = text.split('\n');
    const opens = lines.filter(line => line.trim() === MARKER).length;
    const closes = lines.filter(line => line.trim() === CLOSE).length;
    if (!opens && !closes) continue;
    if (opens !== 1 || closes !== 1) return { error: 'invalid_markers' };
    // Discover foreign marker names from the file itself; the shared parser owns
    // boundary precedence and prevents crossing an adjacent sibling block.
    const foreignNames = [...text.matchAll(/^\s*<!-- \/?([^:\s]+):[^\n]*-->\s*$/gm)]
      .map(match => match[1]).filter(name => name !== 'hermitd');
    const block = markerOnward(text, MARKER, foreignNames);
    if (!block || isAmbiguousBlock(text, MARKER, block) || !block.trimEnd().endsWith(CLOSE)) {
      return { error: 'invalid_markers' };
    }
    let start = text.indexOf(block);
    let end = start + block.length;
    // Remove the closing line terminator, retaining every following byte.
    if (text[end] === '\n') end++;
    // Retire an immediately preceding separator and its blank lines, preserving
    // the operator's preceding line terminator. Otherwise leave spacing alone.
    const separator = /(?:^|\n)[ \t]*---[ \t]*\r?\n(?:[ \t]*\r?\n)*$/.exec(text.slice(0, start));
    // A leading frontmatter's closing fence belongs to the operator, not the block.
    const frontmatter = /^---[ \t]*\r?\n[\s\S]*?^---[ \t]*\r?$/m.exec(text);
    const fenceAt = frontmatter?.index === 0 ? frontmatter[0].lastIndexOf('\n') + 1 : -1;
    const separatorAt = separator ? separator.index + (separator[0].startsWith('\n') ? 1 : 0) : -1;
    if (separator && separatorAt !== fenceAt) start = separatorAt;
    changes.push({ file, before: text, after: text.slice(0, start) + text.slice(end), removed: text.slice(start, end) });
  }
  if (!changes.length) return { status: 'noop' };

  const backup = path.resolve(hermitDir, 'state', `removed-hermit-blocks.${new Date().toISOString().replace(/:/g, '-')}.md`);
  try {
    // Exclusive creation prevents a retry from overwriting an earlier backup.
    fs.writeFileSync(backup, changes.map(change => `# ${path.relative(root, change.file)}\n\n${change.removed}`).join('\n\n'), { flag: 'wx' });
  } catch { return { error: 'backup_failed' }; }

  try {
    for (const change of changes) {
      // Refuse a concurrent edit instead of replacing the operator's new bytes.
      if (fs.readFileSync(change.file, 'utf8') !== change.before) return { error: 'target_changed' };
      write(change.file, change.after);
    }
  } catch { return { error: 'replace_failed' }; }
  return { changed: changes.map(change => path.relative(root, change.file)), backup };
}

if (import.meta.main) {
  if (process.argv.length !== 3) exitError('usage');
  emitJson(retireCoreBlocks(process.argv[2]));
}
