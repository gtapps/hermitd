import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { retireCoreBlocks } from '../scripts/retire-core-blocks';
import { writeFileAtomic } from '../scripts/lib/md-write';
import { withDir } from './helpers/workdir';
import { runScript } from './helpers/run';

const OPEN = '<!-- hermitd: Session Discipline -->';
const CLOSE = '<!-- /hermitd: Session Discipline -->';
const block = `${OPEN}\nOperator-edited rules.\n${CLOSE}\n`;
const sibling = '<!-- custom-hermit: Instructions -->\nSibling rules.\n<!-- /custom-hermit: Instructions -->\n';

for (const newline of ['\n', '\r\n']) {
  test(`retirement preserves surrounding text and sibling bytes (${JSON.stringify(newline)})`, withDir(dir => {
    const hermit = path.join(dir, '.hermit');
    const before = `Project text.\n\n---\n\n${block}\n${sibling}\nOperator tail.\n`.replaceAll('\n', newline);
    for (const file of ['CLAUDE.md', 'CLAUDE.local.md', '.hermit/RESIDENT.md']) fs.writeFileSync(path.join(dir, file), before);
    const result = retireCoreBlocks(hermit);
    expect('changed' in result).toBe(true);
    if (!('backup' in result)) throw new Error(JSON.stringify(result));
    expect(result.changed).toEqual(['CLAUDE.md', 'CLAUDE.local.md', '.hermit/RESIDENT.md']);
    const backup = fs.readFileSync(result.backup, 'utf8');
    expect(backup).toContain(`---\n\n${block}`.replaceAll('\n', newline));
    for (const file of result.changed) {
      expect(fs.readFileSync(path.join(dir, file), 'utf8')).toBe(`Project text.\n\n\n${sibling}\nOperator tail.\n`.replaceAll('\n', newline));
    }
    expect(retireCoreBlocks(hermit)).toEqual({ status: 'noop' });
  }));
}

for (const body of [block + block, OPEN + '\nUnclosed', CLOSE + '\n', `${CLOSE}\n${OPEN}\n`, `${OPEN}\n${sibling}${CLOSE}\n`]) {
  test(`invalid markers refuse all writes (${JSON.stringify(body)})`, withDir(dir => {
    const good = path.join(dir, 'CLAUDE.md');
    const bad = path.join(dir, 'CLAUDE.local.md');
    fs.writeFileSync(good, block);
    fs.writeFileSync(bad, body);
    expect(retireCoreBlocks(path.join(dir, '.hermit'))).toEqual({ error: 'invalid_markers' });
    expect(fs.readFileSync(good, 'utf8')).toBe(block);
    expect(fs.readFileSync(bad, 'utf8')).toBe(body);
    expect(fs.readdirSync(path.join(dir, '.hermit/state'))).toEqual([]);
  }));
}

test('without a separator only block bytes are removed and backed up', withDir(dir => {
  const file = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(file, `Before\n\n${block}After\n`);
  const result = retireCoreBlocks(path.join(dir, '.hermit'));
  if (!('backup' in result)) throw new Error(JSON.stringify(result));
  expect(fs.readFileSync(file, 'utf8')).toBe('Before\n\nAfter\n');
  expect(fs.readFileSync(result.backup, 'utf8')).toBe(`# CLAUDE.md\n\n${block}`);
}));

test('a frontmatter closing fence above the block is kept', withDir(dir => {
  const file = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(file, `---\ntitle: Project\n---\n${block}After\n`);
  const result = retireCoreBlocks(path.join(dir, '.hermit'));
  if (!('backup' in result)) throw new Error(JSON.stringify(result));
  expect(fs.readFileSync(file, 'utf8')).toBe('---\ntitle: Project\n---\nAfter\n');
  expect(fs.readFileSync(result.backup, 'utf8')).toBe(`# CLAUDE.md\n\n${block}`);
}));

test('backup failure leaves all source bytes intact', withDir(dir => {
  const hermit = path.join(dir, '.hermit');
  fs.rmdirSync(path.join(hermit, 'state'));
  fs.writeFileSync(path.join(hermit, 'state'), 'not a directory');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), block);
  expect(retireCoreBlocks(hermit)).toEqual({ error: 'backup_failed' });
  expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe(block);
}));

test('retry after a replacement failure preserves the original backup', withDir(dir => {
  const hermit = path.join(dir, '.hermit');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), block);
  fs.writeFileSync(path.join(dir, 'CLAUDE.local.md'), block);
  let calls = 0;
  const result = retireCoreBlocks(hermit, (file, body) => {
    if (++calls === 2) throw new Error('injected replacement failure');
    writeFileAtomic(file, body);
  });
  expect(result).toEqual({ error: 'replace_failed' });
  const backup = fs.readdirSync(path.join(hermit, 'state'))[0];
  const originalBackup = fs.readFileSync(path.join(hermit, 'state', backup), 'utf8');
  expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('');
  expect(fs.readFileSync(path.join(dir, 'CLAUDE.local.md'), 'utf8')).toBe(block);
  // A filename collision is a safe backup refusal; the next invocation retries.
  const retry = retireCoreBlocks(hermit);
  if ('error' in retry) expect(retry.error).toBe('backup_failed');
  else expect('changed' in retry).toBe(true);
  expect(fs.readFileSync(path.join(hermit, 'state', backup), 'utf8')).toBe(originalBackup);
}));

test('no blocks means no backup and no rewrite; CLI needs neither git nor a plugin list', withDir(async dir => {
  const file = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(file, sibling);
  const before = fs.statSync(file);
  const result = await runScript('retire-core-blocks.ts', { cwd: dir, args: ['.hermit'], env: { PATH: '' } });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ status: 'noop' });
  expect(fs.statSync(file).mtimeMs).toBe(before.mtimeMs);
  expect(fs.readdirSync(path.join(dir, '.hermit/state'))).toEqual([]);
  fs.writeFileSync(file, block + sibling);
  const changed = await runScript('retire-core-blocks.ts', { cwd: dir, args: ['.hermit'], env: { PATH: '' } });
  expect(changed.exitCode).toBe(0);
  expect(JSON.parse(changed.stdout).changed).toEqual(['CLAUDE.md']);
  expect(fs.readFileSync(file, 'utf8')).toBe(sibling);
}));
