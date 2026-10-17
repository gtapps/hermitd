// Tests for archive-compiled.ts — rotates old compiled artifacts.
// (bun test port of test-archive-compiled.sh)
//
// archive-compiled.ts is genuinely executed, so it runs as a subprocess via runScript.
//
// Usage: bun test tests/archive-compiled.test.ts   (from the plugin root)

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript } from './helpers/run';

interface Hermit {
  dir: string;
  compiled: string;
  cleanup(): void;
}

function makeHermit(): Hermit {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-archive-compiled-'));
  const compiledDir = path.join(dir, '.hermit', 'compiled');
  fs.mkdirSync(compiledDir, { recursive: true });
  return {
    dir,
    compiled: compiledDir,
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

// Minimal compiled artifact with given type, created date, and optional tags.
function writeArtifact(dir: string, name: string, type: string, created: string, tags?: string): void {
  const tagsLine = tags ? `\ntags: [${tags}]` : '';
  fs.writeFileSync(path.join(dir, name), `---\ntype: ${type}\ncreated: ${created}${tagsLine}\n---\nBody content.\n`);
}

async function runArchive(h: Hermit): Promise<string> {
  const r = await runScript('archive-compiled.ts', {
    args: [path.join(h.dir, '.hermit')],
  });
  return r.stdout;
}

// -------------------------------------------------------
// 1. Basic rotation: 3 artifacts of the same type → 1 archived (oldest), 2 retained
// -------------------------------------------------------
describe('basic rotation', () => {
  let h: Hermit;
  let out: string;
  beforeAll(async () => {
    h = makeHermit();
    writeArtifact(h.compiled, 'review-2025-W01.md', 'review', '2025-01-05T00:00:00.000Z');
    writeArtifact(h.compiled, 'review-2025-W02.md', 'review', '2025-01-12T00:00:00.000Z');
    writeArtifact(h.compiled, 'review-2025-W03.md', 'review', '2025-01-19T00:00:00.000Z');
    out = await runArchive(h);
  });
  afterAll(() => h.cleanup());

  test('rotation: oldest archived', () => {
    expect(fs.existsSync(path.join(h.compiled, '.archive', 'review-2025-W01.md'))).toBe(true);
  });

  test('rotation: W02 retained', () => {
    expect(fs.existsSync(path.join(h.compiled, 'review-2025-W02.md'))).toBe(true);
  });

  test('rotation: W03 retained', () => {
    expect(fs.existsSync(path.join(h.compiled, 'review-2025-W03.md'))).toBe(true);
  });

  test('rotation: 1 archived in output', () => {
    expect(JSON.parse(out).archived).toBe(1);
  });

  test('rotation: 2 retained in output', () => {
    expect(JSON.parse(out).retained).toBe(2);
  });
});

// -------------------------------------------------------
// 2. Foundational exemption: foundational artifact is never archived
// -------------------------------------------------------
describe('foundational exemption', () => {
  let h: Hermit;
  let out: string;
  beforeAll(async () => {
    h = makeHermit();
    writeArtifact(h.compiled, 'review-2025-W01.md', 'review', '2025-01-05T00:00:00.000Z');
    writeArtifact(h.compiled, 'review-2025-W02.md', 'review', '2025-01-12T00:00:00.000Z');
    // Oldest date but tagged foundational — must not be archived
    writeArtifact(h.compiled, 'review-old-foundational.md', 'review', '2024-01-01T00:00:00.000Z', 'foundational');
    out = await runArchive(h);
  });
  afterAll(() => h.cleanup());

  test('foundational: not archived', () => {
    expect(fs.existsSync(path.join(h.compiled, 'review-old-foundational.md'))).toBe(true);
  });

  test('foundational: .archive/ not created (nothing else to archive)', () => {
    const archiveDir = path.join(h.compiled, '.archive');
    const empty = !fs.existsSync(archiveDir) || fs.readdirSync(archiveDir).length === 0;
    expect(empty).toBe(true);
  });

  test('foundational: 0 archived in output', () => {
    expect(JSON.parse(out).archived).toBe(0);
  });
});

// -------------------------------------------------------
// 3. Skipped: artifact missing type or created → left in place, counted as skipped
// -------------------------------------------------------
describe('skipped artifacts', () => {
  let h: Hermit;
  let out: string;
  beforeAll(async () => {
    h = makeHermit();
    // Missing type
    fs.writeFileSync(path.join(h.compiled, 'no-type.md'), '---\ncreated: 2025-01-05T00:00:00.000Z\n---\nBody.\n');
    // Missing created
    fs.writeFileSync(path.join(h.compiled, 'no-created.md'), '---\ntype: note\n---\nBody.\n');
    out = await runArchive(h);
  });
  afterAll(() => h.cleanup());

  test('skipped: no-type.md left in place', () => {
    expect(fs.existsSync(path.join(h.compiled, 'no-type.md'))).toBe(true);
  });

  test('skipped: no-created.md left in place', () => {
    expect(fs.existsSync(path.join(h.compiled, 'no-created.md'))).toBe(true);
  });

  test('skipped: 2 skipped in output', () => {
    expect(JSON.parse(out).skipped).toBe(2);
  });
});

// -------------------------------------------------------
// 4. Topic exemption: living pages are never rotated, even past KEEP_PER_TYPE
// -------------------------------------------------------
describe('topic exemption', () => {
  let h: Hermit;
  let out: string;
  beforeAll(async () => {
    h = makeHermit();
    writeArtifact(h.compiled, 'topic-alpha.md', 'topic', '2024-01-01T00:00:00.000Z');
    writeArtifact(h.compiled, 'topic-beta.md', 'topic', '2024-02-01T00:00:00.000Z');
    writeArtifact(h.compiled, 'topic-gamma.md', 'topic', '2024-03-01T00:00:00.000Z');
    writeArtifact(h.compiled, 'topic-delta.md', 'topic', '2024-04-01T00:00:00.000Z');
    out = await runArchive(h);
  });
  afterAll(() => h.cleanup());

  test('topic: nothing archived', () => {
    expect(JSON.parse(out).archived).toBe(0);
  });

  test('topic: all four pages still on disk', () => {
    for (const f of ['topic-alpha.md', 'topic-beta.md', 'topic-gamma.md', 'topic-delta.md']) {
      expect(fs.existsSync(path.join(h.compiled, f))).toBe(true);
    }
  });

  test('topic: 4 retained in output', () => {
    expect(JSON.parse(out).retained).toBe(4);
  });
});

// -------------------------------------------------------
// 5. Mixed: dated notes rotate, topic pages do not
// -------------------------------------------------------
describe('mixed rotation with topics', () => {
  let h: Hermit;
  beforeAll(async () => {
    h = makeHermit();
    writeArtifact(h.compiled, 'note-a.md', 'note', '2025-01-05T00:00:00.000Z');
    writeArtifact(h.compiled, 'note-b.md', 'note', '2025-01-12T00:00:00.000Z');
    writeArtifact(h.compiled, 'note-c.md', 'note', '2025-01-19T00:00:00.000Z');
    writeArtifact(h.compiled, 'topic-old.md', 'topic', '2023-01-01T00:00:00.000Z');
    writeArtifact(h.compiled, 'topic-older.md', 'topic', '2022-01-01T00:00:00.000Z');
    await runArchive(h);
  });
  afterAll(() => h.cleanup());

  test('mixed: oldest note archived', () => {
    expect(fs.existsSync(path.join(h.compiled, '.archive', 'note-a.md'))).toBe(true);
  });

  test('mixed: topic pages untouched despite oldest dates', () => {
    expect(fs.existsSync(path.join(h.compiled, 'topic-old.md'))).toBe(true);
    expect(fs.existsSync(path.join(h.compiled, 'topic-older.md'))).toBe(true);
  });
});

// -------------------------------------------------------
// 6. Fail-open: no state dir → exit 0
// -------------------------------------------------------
test('fail-open: exit 0 with no state dir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-archive-compiled-'));
  try {
    const r = await runScript('archive-compiled.ts', { args: [path.join(dir, 'nonexistent')] });
    expect(r.exitCode).toBe(0);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
