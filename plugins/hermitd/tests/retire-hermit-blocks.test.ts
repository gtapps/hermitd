import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { retireHermitBlocks } from '../scripts/retire-hermit-blocks';
import { writeFileAtomic } from '../scripts/lib/md-write';
import { withDir } from './helpers/workdir';
import { runScript } from './helpers/run';

const OPEN = '<!-- hermitd: Session Discipline -->';
const CLOSE = '<!-- /hermitd: Session Discipline -->';
const block = `${OPEN}\nOperator-edited rules.\n${CLOSE}\n`;
const sibling = '<!-- custom-hermit: Instructions -->\nSibling rules.\n<!-- /custom-hermit: Instructions -->\n';

for (const newline of ['\n', '\r\n']) {
  test(`retirement preserves surrounding text and removes sibling blocks (${JSON.stringify(newline)})`, withDir(dir => {
    const hermit = path.join(dir, '.hermit');
    const before = `Project text.\n\n---\n\n${block}\n${sibling}\nOperator tail.\n`.replaceAll('\n', newline);
    for (const file of ['CLAUDE.md', 'CLAUDE.local.md', '.hermit/RESIDENT.md']) fs.writeFileSync(path.join(dir, file), before);
    const result = retireHermitBlocks(hermit);
    expect('changed' in result).toBe(true);
    if (!('backup' in result)) throw new Error(JSON.stringify(result));
    expect(result.changed).toEqual(['CLAUDE.md', 'CLAUDE.local.md', '.hermit/RESIDENT.md']);
    const backup = fs.readFileSync(result.backup, 'utf8');
    expect(backup).toContain(`---\n\n${block}`.replaceAll('\n', newline));
    expect(result.deleted).toEqual(['.hermit/RESIDENT.md']);
    expect(fs.existsSync(path.join(hermit, 'RESIDENT.md'))).toBe(false);
    for (const file of ['CLAUDE.md', 'CLAUDE.local.md']) {
      expect(fs.readFileSync(path.join(dir, file), 'utf8')).toBe(`Project text.\n\n\n\nOperator tail.\n`.replaceAll('\n', newline));
    }
    expect(retireHermitBlocks(hermit)).toEqual({ status: 'noop' });
  }));
}

for (const body of [block + block, OPEN + '\nUnclosed', CLOSE + '\n', '<!-- /custom-hermit: Instructions -->\n', `${CLOSE}\n${OPEN}\n`, `${OPEN}\n${sibling}${CLOSE}\n`, `${OPEN}\n<!-- custom-hermit: Instructions -->\n${CLOSE}\n<!-- /custom-hermit: Instructions -->\n`]) {
  test(`invalid markers refuse all writes (${JSON.stringify(body)})`, withDir(dir => {
    const good = path.join(dir, 'CLAUDE.md');
    const bad = path.join(dir, 'CLAUDE.local.md');
    fs.writeFileSync(good, block);
    fs.writeFileSync(bad, body);
    expect(retireHermitBlocks(path.join(dir, '.hermit'))).toEqual({ error: 'invalid_markers' });
    expect(fs.readFileSync(good, 'utf8')).toBe(block);
    expect(fs.readFileSync(bad, 'utf8')).toBe(body);
    expect(fs.readdirSync(path.join(dir, '.hermit/state'))).toEqual([]);
  }));
}

test('without a separator only block bytes are removed and backed up', withDir(dir => {
  const file = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(file, `Before\n\n${block}After\n`);
  const result = retireHermitBlocks(path.join(dir, '.hermit'));
  if (!('backup' in result)) throw new Error(JSON.stringify(result));
  expect(fs.readFileSync(file, 'utf8')).toBe('Before\n\nAfter\n');
  expect(fs.readFileSync(result.backup, 'utf8')).toBe(`# CLAUDE.md\n\n${block}`);
}));

test('a frontmatter closing fence above the block is kept', withDir(dir => {
  const file = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(file, `---\ntitle: Project\n---\n${block}After\n`);
  const result = retireHermitBlocks(path.join(dir, '.hermit'));
  if (!('backup' in result)) throw new Error(JSON.stringify(result));
  expect(fs.readFileSync(file, 'utf8')).toBe('---\ntitle: Project\n---\nAfter\n');
  expect(fs.readFileSync(result.backup, 'utf8')).toBe(`# CLAUDE.md\n\n${block}`);
}));

test('separators above consecutive blocks are retired when the file starts with one', withDir(dir => {
  const file = path.join(dir, 'CLAUDE.local.md');
  fs.writeFileSync(file, `---\n${block}\n---\n${sibling}`);
  expect('changed' in retireHermitBlocks(path.join(dir, '.hermit'))).toBe(true);
  expect(fs.readFileSync(file, 'utf8')).toBe('\n');
}));

test('unbalanced markers in RESIDENT.md do not block retirement', withDir(dir => {
  const hermit = path.join(dir, '.hermit');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), block);
  fs.writeFileSync(path.join(hermit, 'RESIDENT.md'), `${OPEN}\nUnclosed`);
  expect(retireHermitBlocks(hermit)).toMatchObject({ changed: ['CLAUDE.md', '.hermit/RESIDENT.md'], deleted: ['.hermit/RESIDENT.md'] });
  expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('');
}));

test('backup failure leaves all source bytes intact', withDir(dir => {
  const hermit = path.join(dir, '.hermit');
  fs.rmdirSync(path.join(hermit, 'state'));
  fs.writeFileSync(path.join(hermit, 'state'), 'not a directory');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), block);
  expect(retireHermitBlocks(hermit)).toEqual({ error: 'backup_failed' });
  expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe(block);
}));

test('retry after a replacement failure preserves the original backup', withDir(dir => {
  const hermit = path.join(dir, '.hermit');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), block);
  fs.writeFileSync(path.join(dir, 'CLAUDE.local.md'), block);
  let calls = 0;
  const result = retireHermitBlocks(hermit, (file, body) => {
    if (++calls === 2) throw new Error('injected replacement failure');
    writeFileAtomic(file, body);
  });
  expect(result).toMatchObject({ error: 'replace_failed', changed: ['CLAUDE.md'], deleted: [], failed: 'CLAUDE.local.md' });
  const backup = fs.readdirSync(path.join(hermit, 'state'))[0];
  const originalBackup = fs.readFileSync(path.join(hermit, 'state', backup), 'utf8');
  expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('');
  expect(fs.readFileSync(path.join(dir, 'CLAUDE.local.md'), 'utf8')).toBe(block);
  const retry = retireHermitBlocks(hermit);
  expect('changed' in retry).toBe(true);
  expect(fs.readFileSync(path.join(hermit, 'state', backup), 'utf8')).toBe(originalBackup);
}));

test('no blocks means no backup and no rewrite; CLI needs neither git nor a plugin list', withDir(async dir => {
  const file = path.join(dir, 'CLAUDE.md');
  const other = '<!-- my-notes: -->\nMy notes.\n<!-- /my-notes: -->\n';
  fs.writeFileSync(file, other);
  const before = fs.statSync(file);
  const result = await runScript('retire-hermit-blocks.ts', { cwd: dir, args: ['.hermit'], env: { PATH: '' } });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ status: 'noop' });
  expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
  expect(fs.readdirSync(path.join(dir, '.hermit/state'))).toEqual([]);
  fs.writeFileSync(file, block + sibling + other);
  const changed = await runScript('retire-hermit-blocks.ts', { cwd: dir, args: ['.hermit'], env: { PATH: '' } });
  expect(changed.exitCode).toBe(0);
  expect(JSON.parse(changed.stdout).changed).toEqual(['CLAUDE.md']);
  expect(fs.readFileSync(file, 'utf8')).toBe(other);
}));

test('multiple blocks and no final newline', withDir(dir => {
  const file = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(file, block + sibling.trimEnd());
  expect('changed' in retireHermitBlocks(path.join(dir, '.hermit'))).toBe(true);
  expect(fs.readFileSync(file, 'utf8')).toBe('');
}));

test('RESIDENT.md is backed up whole even without blocks', withDir(dir => {
  const hermit = path.join(dir, '.hermit');
  const resident = path.join(hermit, 'RESIDENT.md');
  fs.writeFileSync(resident, 'Operator text.\r\n');
  const result = retireHermitBlocks(hermit);
  if (!('backup' in result) || !result.backup) throw new Error(JSON.stringify(result));
  expect(fs.readFileSync(result.backup, 'utf8')).toBe('# .hermit/RESIDENT.md\n\nOperator text.\r\n');
  expect(result).toMatchObject({ changed: ['.hermit/RESIDENT.md'], deleted: ['.hermit/RESIDENT.md'] });
  expect(fs.existsSync(resident)).toBe(false);
}));

test('concurrent RESIDENT.md change preserves new bytes and reports partial work', withDir(dir => {
  const hermit = path.join(dir, '.hermit');
  const resident = path.join(hermit, 'RESIDENT.md');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), block);
  fs.writeFileSync(resident, sibling);
  const result = retireHermitBlocks(hermit, (file, body) => {
    writeFileAtomic(file, body);
    fs.writeFileSync(resident, 'Concurrent edit');
  });
  expect(result).toMatchObject({ error: 'target_changed', changed: ['CLAUDE.md'], deleted: [], failed: '.hermit/RESIDENT.md' });
  expect(fs.readFileSync(resident, 'utf8')).toBe('Concurrent edit');
}));

test('unlink failure reports the backup and retry preserves it', withDir(dir => {
  const hermit = path.join(dir, '.hermit');
  const resident = path.join(hermit, 'RESIDENT.md');
  fs.writeFileSync(resident, sibling);
  const result = retireHermitBlocks(hermit, writeFileAtomic, () => { throw new Error('injected unlink failure'); });
  expect(result).toMatchObject({ error: 'delete_failed', changed: [], deleted: [], failed: '.hermit/RESIDENT.md' });
  if (!('backup' in result) || !result.backup) throw new Error(JSON.stringify(result));
  const backup = fs.readFileSync(result.backup, 'utf8');
  expect(fs.readFileSync(resident, 'utf8')).toBe(sibling);
  expect(retireHermitBlocks(hermit)).toMatchObject({ deleted: ['.hermit/RESIDENT.md'] });
  expect(fs.readFileSync(result.backup, 'utf8')).toBe(backup);
}));
