import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { checkMemorySize, resolvePaths } from '../scripts/doctor-check';
import { transcriptDirFor } from '../scripts/lib/cc-compat';
import { freshDirFactory } from './helpers/workdir';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');
const { freshDir, cleanup } = freshDirFactory('hermit-memory-size-');
afterAll(cleanup);

type Fixture = {
  claude?: string;
  local?: string;
  memory?: string;
  memoryAsDir?: boolean;
  /** Nest the project root under a dotted path, e.g. a checkout inside a hidden dir. */
  dottedRoot?: boolean;
};

function lines(count: number, content = 'x'): string {
  return Array.from({ length: count }, () => content).join('\n');
}

function scenario({ claude, local, memory, memoryAsDir, dottedRoot }: Fixture) {
  const projectRoot = dottedRoot
    ? path.join(freshDir(), '.local', 'src', 'my.project')
    : freshDir();
  const hermitDir = path.join(projectRoot, '.hermit');
  fs.mkdirSync(hermitDir, { recursive: true });

  if (claude !== undefined) fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), claude);
  if (local !== undefined) fs.writeFileSync(path.join(projectRoot, 'CLAUDE.local.md'), local);

  const configDir = freshDir();
  const memoryPath = path.join(transcriptDirFor(projectRoot, configDir), 'memory', 'MEMORY.md');
  if (memory !== undefined || memoryAsDir) {
    fs.mkdirSync(path.dirname(memoryPath), { recursive: true });
    if (memoryAsDir) fs.mkdirSync(memoryPath);
    else fs.writeFileSync(memoryPath, memory!);
  }

  const prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    return checkMemorySize(resolvePaths(hermitDir, PLUGIN_ROOT));
  } finally {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  }
}

describe('doctor memory-size check', () => {
  test('files below every threshold are healthy', () => {
    const result = scenario({
      claude: lines(199),
      local: lines(199),
      memory: lines(159),
    });

    expect(result.status).toBe('ok');
  });

  test('a 250-line CLAUDE.md warns with the file and native trim command', () => {
    const result = scenario({ claude: lines(250) });

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('CLAUDE.md: 250 lines');
    expect(result.detail).toContain('/doctor');
    expect(result.detail).toContain('hermit-doctor');
  });

  test('a 250-line CLAUDE.local.md warns on its own', () => {
    const result = scenario({ local: lines(250) });

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('CLAUDE.local.md: 250 lines');
    expect(result.detail).toContain('/doctor');
    expect(result.detail).toContain('hermit-doctor');
  });

  test('a 21 KB, 60-line MEMORY.md warns on the byte bound', () => {
    const result = scenario({ memory: lines(60, 'x'.repeat(360)) });

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('MEMORY.md');
    expect(result.detail).toContain('20 KB byte threshold');
    expect(result.detail).not.toContain('line threshold');
  });

  test('a 170-line, 5 KB MEMORY.md warns on the line bound', () => {
    const result = scenario({ memory: lines(170, 'x'.repeat(29)) });

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('170 lines');
    expect(result.detail).toContain('160 line threshold');
    expect(result.detail).not.toContain('byte threshold');
  });

  // The threshold has to mean what `wc -l` means. A real file ends in a newline,
  // which a naive split() counts as an extra line and would warn one line early.
  test('a trailing newline does not inflate the line count', () => {
    expect(scenario({ claude: lines(199) + '\n' }).status).toBe('ok');
    expect(scenario({ claude: lines(200) + '\n' }).status).toBe('warn');
  });

  // A '/'-only path key mangles any root holding a dot (a hidden parent dir, a
  // dotted repo name) and would resolve to a directory that never exists,
  // reporting a permanent false ok.
  test('a dotted project path still resolves MEMORY.md', () => {
    const result = scenario({ dottedRoot: true, memory: lines(170) });

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('MEMORY.md');
  });

  test('an absent MEMORY.md with clean CLAUDE files is healthy', () => {
    const result = scenario({ claude: lines(20), local: lines(20) });

    expect(result.status).toBe('ok');
  });

  test('an unreadable memory path degrades to warn without losing other findings', () => {
    const result = scenario({ claude: lines(250), memoryAsDir: true });

    expect(result.status).toBe('warn');
    expect(result.detail).toContain('MEMORY.md: unreadable');
    expect(result.detail).toContain('CLAUDE.md: 250 lines');
  });
});

test('missing resident and legacy core duties do not affect size checks', () => {
  const result = scenario({ claude: '<!-- hermitd: Session Discipline -->\n## Watches\nWatch duties.\n<!-- /hermitd: Session Discipline -->' });
  expect(result.status).toBe('ok');
  expect(result.detail).not.toContain('RESIDENT.md');
  expect(result.detail).not.toContain('legacy resident duties');
});
