// Tests for archive-raw.ts — retention, skip diagnostics, -latest pinning,
// .json support, filename-date fallback. (bun test port of test-archive-raw.sh)
//
// archive-raw.ts is genuinely executed, so it runs as a subprocess via runScript.
//
// archive-raw.ts uses Date.now() directly; to control "now" we manipulate file
// dates via filenames/frontmatter. We use dates well in the past (2020) to
// guarantee they're expired under any retention window.
//
// Usage: bun test tests/archive-raw.test.ts   (from the plugin root)

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript } from './helpers/run';

const PAST = '2020-01-01';
const RECENT = '2099-12-31';

interface Hermit {
  dir: string;
  cleanup(): void;
}

// Minimal hermit state dir with raw/ and config.json.
function makeHermit(): Hermit {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-archive-raw-'));
  fs.mkdirSync(path.join(dir, '.hermit', 'raw'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.hermit', 'compiled'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.hermit', 'config.json'),
    '{"knowledge":{"raw_retention_days":14}}\n',
  );
  return {
    dir,
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    },
  };
}

const raw = (dir: string, ...p: string[]) =>
  path.join(dir, '.hermit', 'raw', ...p);
const compiled = (dir: string, ...p: string[]) =>
  path.join(dir, '.hermit', 'compiled', ...p);

// Run archive-raw.ts from inside the workdir: its stdout JSON, plus the stderr
// purge log as `stderr`.
async function runArchive(dir: string): Promise<any> {
  const r = await runScript('archive-raw.ts', { args: ['.hermit'], cwd: dir });
  expect(r.exitCode).toBe(0);
  return { ...JSON.parse(r.stdout), stderr: r.stderr };
}

// -------------------------------------------------------
// 1. Empty raw/ — nothing to archive
// -------------------------------------------------------
describe('empty raw/', () => {
  let h: Hermit;
  let out: any;
  beforeAll(async () => {
    h = makeHermit();
    out = await runArchive(h.dir);
  });
  afterAll(() => h.cleanup());

  test('empty raw/: zero counts', () => {
    expect(out).toMatchObject({ archived: 0, retained: 0, skipped: [], pinned: 0, purged: 0 });
  });
});

// -------------------------------------------------------
// 2. Expired dated .md with frontmatter → archived
// -------------------------------------------------------
describe('expired dated .md with frontmatter', () => {
  let h: Hermit;
  let out: any;
  beforeAll(async () => {
    h = makeHermit();
    fs.writeFileSync(raw(h.dir, `note-${PAST}.md`),
      `---\ntitle: Old note\ntype: input\ncreated: ${PAST}T00:00:00Z\ntags: []\n---\nbody\n`);
    out = await runArchive(h.dir);
  });
  afterAll(() => h.cleanup());

  test('md frontmatter: archived (output says 1 archived)', () => {
    expect(out).toMatchObject({ archived: 1, retained: 0, pinned: 0 });
    expect(out.skipped).toHaveLength(0);
  });

  test('md frontmatter: file moved to .archive/', () => {
    expect(fs.existsSync(raw(h.dir, '.archive', `note-${PAST}.md`))).toBe(true);
    expect(fs.existsSync(raw(h.dir, `note-${PAST}.md`))).toBe(false);
  });
});

// -------------------------------------------------------
// 3. Expired dated .json with YYYY-MM-DD in filename, no frontmatter → archived via filename fallback
// -------------------------------------------------------
describe('expired dated .json via filename fallback', () => {
  let h: Hermit;
  let out: any;
  beforeAll(async () => {
    h = makeHermit();
    fs.writeFileSync(raw(h.dir, `snapshot-ha-context-${PAST}.json`), '{"entities":[]}\n');
    out = await runArchive(h.dir);
  });
  afterAll(() => h.cleanup());

  test('json filename-date: archived (output says 1 archived)', () => {
    expect(out).toMatchObject({ archived: 1, retained: 0, pinned: 0 });
    expect(out.skipped).toHaveLength(0);
  });

  test('json filename-date: file moved to .archive/', () => {
    expect(fs.existsSync(raw(h.dir, '.archive', `snapshot-ha-context-${PAST}.json`))).toBe(true);
    expect(fs.existsSync(raw(h.dir, `snapshot-ha-context-${PAST}.json`))).toBe(false);
  });
});

// -------------------------------------------------------
// 4. -latest.md and -latest.json → pinned, never archived even when old
// -------------------------------------------------------
describe('-latest alias pinning', () => {
  let h: Hermit;
  let out: any;
  beforeAll(async () => {
    h = makeHermit();
    fs.writeFileSync(raw(h.dir, 'patterns-latest.md'),
      `---\ntitle: Latest patterns\ntype: analysis\ncreated: ${PAST}T00:00:00Z\ntags: []\n---\nbody\n`);
    fs.writeFileSync(raw(h.dir, 'snapshot-ha-normalized-latest.json'), '{"entities":[]}\n');
    out = await runArchive(h.dir);
  });
  afterAll(() => h.cleanup());

  test('latest alias: output says 0 archived', () => {
    expect(out).toMatchObject({ archived: 0 });
  });

  test('latest alias: pinned count = 2', () => {
    expect(out.pinned).toBe(2);
  });

  test('latest alias: patterns-latest.md still in raw/', () => {
    expect(fs.existsSync(raw(h.dir, 'patterns-latest.md'))).toBe(true);
  });

  test('latest alias: snapshot-ha-normalized-latest.json still in raw/', () => {
    expect(fs.existsSync(raw(h.dir, 'snapshot-ha-normalized-latest.json'))).toBe(true);
  });
});

// -------------------------------------------------------
// 5. File with no created: key and no date in filename → skipped with named reason
// -------------------------------------------------------
describe('missing created: key', () => {
  let h: Hermit;
  let out: any;
  beforeAll(async () => {
    h = makeHermit();
    fs.writeFileSync(raw(h.dir, 'no-date.md'), '---\ntype: input\n---\nMissing created field.\n');
    out = await runArchive(h.dir);
  });
  afterAll(() => h.cleanup());

  test('missing created: skipped by name with its reason', () => {
    expect(out.skipped).toEqual([{ file: 'no-date.md', reason: 'missing_created' }]);
  });

  test('missing created: file stays in raw/', () => {
    expect(fs.existsSync(raw(h.dir, 'no-date.md'))).toBe(true);
  });
});

// -------------------------------------------------------
// 6. File with malformed created: value and no date in filename → skipped, unparseable reason
// -------------------------------------------------------
describe('malformed created: value', () => {
  let h: Hermit;
  let out: any;
  beforeAll(async () => {
    h = makeHermit();
    fs.writeFileSync(raw(h.dir, 'bad-date.md'),
      '---\ncreated: not-a-date\ntype: input\n---\nBad date value.\n');
    out = await runArchive(h.dir);
  });
  afterAll(() => h.cleanup());

  test('malformed created: skipped by name, unparseable reason', () => {
    expect(out.skipped).toEqual([{ file: 'bad-date.md', reason: 'unparseable_created' }]);
  });
});

// -------------------------------------------------------
// 7. .json with no date in filename and no frontmatter → skipped
// -------------------------------------------------------
describe('.json with no date anywhere', () => {
  let h: Hermit;
  let out: any;
  beforeAll(async () => {
    h = makeHermit();
    fs.writeFileSync(raw(h.dir, 'nodatefile.json'), '{"state":"unknown"}\n');
    out = await runArchive(h.dir);
  });
  afterAll(() => h.cleanup());

  test('json no-date: output says 1 skipped', () => {
    expect(out).toMatchObject({ archived: 0, retained: 0 });
    expect(out.skipped).toHaveLength(1);
  });

  test('json no-date: file still in raw/', () => {
    expect(fs.existsSync(raw(h.dir, 'nodatefile.json'))).toBe(true);
  });
});

// -------------------------------------------------------
// 8. Malformed frontmatter created but valid date in filename → rescued via filename fallback
// -------------------------------------------------------
describe('filename rescue', () => {
  let h: Hermit;
  let out: any;
  beforeAll(async () => {
    h = makeHermit();
    fs.writeFileSync(raw(h.dir, `snapshot-${PAST}.md`),
      `---\ncreated: not-a-date\ntype: input\n---\nBad frontmatter date, but filename carries ${PAST}.\n`);
    out = await runArchive(h.dir);
  });
  afterAll(() => h.cleanup());

  test('filename rescue: archived despite bad frontmatter', () => {
    expect(out).toMatchObject({ archived: 1 });
  });

  test('filename rescue: file moved to .archive/', () => {
    expect(fs.existsSync(raw(h.dir, '.archive', `snapshot-${PAST}.md`))).toBe(true);
  });
});

// -------------------------------------------------------
// 9. Recent dated .json (not yet expired) → retained
// -------------------------------------------------------
describe('recent dated .json', () => {
  let h: Hermit;
  let out: any;
  beforeAll(async () => {
    h = makeHermit();
    fs.writeFileSync(raw(h.dir, `snapshot-ha-context-${RECENT}.json`), '{"entities":[]}\n');
    out = await runArchive(h.dir);
  });
  afterAll(() => h.cleanup());

  test('json recent: output says 1 retained', () => {
    expect(out).toMatchObject({ archived: 0, retained: 1 });
  });

  test('json recent: file still in raw/', () => {
    expect(fs.existsSync(raw(h.dir, `snapshot-ha-context-${RECENT}.json`))).toBe(true);
  });
});

// -------------------------------------------------------
// 10. Expired .json referenced by a compiled/ artifact → retained (safety check)
// -------------------------------------------------------
describe('compiled-reference safety', () => {
  let h: Hermit;
  let out: any;
  beforeAll(async () => {
    h = makeHermit();
    fs.writeFileSync(raw(h.dir, `snapshot-ha-context-${PAST}.json`), '{"entities":[]}\n');
    fs.writeFileSync(compiled(h.dir, 'briefing-2020-01-05.md'),
      '---\ntitle: Briefing\ntype: briefing\n---\nSee snapshot-ha-context-2020-01-01.json for details.\n');
    out = await runArchive(h.dir);
  });
  afterAll(() => h.cleanup());

  test('json compiled-ref safety: output says 1 retained', () => {
    expect(out).toMatchObject({ archived: 0, retained: 1 });
  });

  test('json compiled-ref safety: file still in raw/', () => {
    expect(fs.existsSync(raw(h.dir, `snapshot-ha-context-${PAST}.json`))).toBe(true);
  });
});

// -------------------------------------------------------
// 11. Mixed bag: expired .md (frontmatter) + expired .json (filename) + -latest.json
//     + missing-created skip → 2 archived, 1 skipped, 1 pinned
// -------------------------------------------------------
describe('mixed bag', () => {
  let h: Hermit;
  let out: any;
  beforeAll(async () => {
    h = makeHermit();
    fs.writeFileSync(raw(h.dir, `audit-${PAST}.md`),
      `---\ntitle: Audit\ntype: audit\ncreated: ${PAST}T00:00:00Z\ntags: []\n---\nbody\n`);
    fs.writeFileSync(raw(h.dir, `snapshot-ha-history-7d-${PAST}.json`), '{"entities":[]}\n');
    fs.writeFileSync(raw(h.dir, 'snapshot-ha-normalized-latest.json'), '{"entities":[]}\n');
    fs.writeFileSync(raw(h.dir, 'no-created.md'), '---\ntype: input\n---\nNo created.\n');
    out = await runArchive(h.dir);
  });
  afterAll(() => h.cleanup());

  test('mixed: output says 2 archived, 0 retained, 1 skipped, 1 pinned', () => {
    expect(out).toMatchObject({ archived: 2, retained: 0, pinned: 1 });
    expect(out.skipped).toHaveLength(1);
  });

  test('mixed: no-created.md named in skip output', () => {
    expect(out.skipped.map((s: any) => s.file)).toEqual(['no-created.md']);
  });

  test('mixed: -latest.json still in raw/', () => {
    expect(fs.existsSync(raw(h.dir, 'snapshot-ha-normalized-latest.json'))).toBe(true);
  });

  test('mixed: dated .md moved to .archive/', () => {
    expect(fs.existsSync(raw(h.dir, '.archive', `audit-${PAST}.md`))).toBe(true);
  });

  test('mixed: dated .json moved to .archive/', () => {
    expect(fs.existsSync(raw(h.dir, '.archive', `snapshot-ha-history-7d-${PAST}.json`))).toBe(true);
  });
});

// -------------------------------------------------------
// 12. Exit code is always 0 (fail-open)
// -------------------------------------------------------
test('fail-open: exit 0 with missing state dir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-archive-raw-'));
  try {
    const r = await runScript('archive-raw.ts', {
      args: [path.join(dir, 'nonexistent-hermit')],
    });
    expect(r.exitCode).toBe(0);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

// -------------------------------------------------------
// 13. Purge: archive_retention_days set → deletes old .archive entries
// -------------------------------------------------------
describe('purge: archive_retention_days set, expired .archive entry deleted', () => {
  let h: Hermit;
  let out: any;

  beforeAll(async () => {
    h = makeHermit();
    // Seed config with archive_retention_days: 90
    fs.writeFileSync(
      path.join(h.dir, '.hermit', 'config.json'),
      '{"knowledge":{"raw_retention_days":14,"archive_retention_days":90}}\n',
    );
    // Place an already-archived file older than 90d
    fs.mkdirSync(raw(h.dir, '.archive'), { recursive: true });
    fs.writeFileSync(
      raw(h.dir, '.archive', `note-${PAST}.md`),
      `---\ncreated: ${PAST}\n---\nold archive entry`,
    );
    out = await runArchive(h.dir);
  });
  afterAll(() => h.cleanup());

  test('purge: expired .archive entry deleted', () => {
    expect(fs.existsSync(raw(h.dir, '.archive', `note-${PAST}.md`))).toBe(false);
  });
  test('purge: output says 1 purged', () => {
    expect(out.purged).toBe(1);
  });
  test('purge: deletion logged to stderr', () => {
    expect(out.stderr).toContain(`purged note-${PAST}.md`);
  });
});

// -------------------------------------------------------
// 14. Purge: archive_retention_days null → nothing deleted
// -------------------------------------------------------
describe('purge: archive_retention_days null → no deletion', () => {
  let h: Hermit;
  let out: any;

  beforeAll(async () => {
    h = makeHermit();
    // Default config has archive_retention_days: null (implicit — key absent is treated as null)
    fs.mkdirSync(raw(h.dir, '.archive'), { recursive: true });
    fs.writeFileSync(
      raw(h.dir, '.archive', `note-${PAST}.md`),
      `---\ncreated: ${PAST}\n---\nold archive entry`,
    );
    out = await runArchive(h.dir);
  });
  afterAll(() => h.cleanup());

  test('purge: null retention keeps the .archive entry', () => {
    expect(fs.existsSync(raw(h.dir, '.archive', `note-${PAST}.md`))).toBe(true);
  });
});

// -------------------------------------------------------
// 15. Purge: -latest pin survives even with archive_retention_days set
// -------------------------------------------------------
describe('purge: -latest pin in .archive survives purge', () => {
  let h: Hermit;

  beforeAll(async () => {
    h = makeHermit();
    fs.writeFileSync(
      path.join(h.dir, '.hermit', 'config.json'),
      '{"knowledge":{"raw_retention_days":14,"archive_retention_days":1}}\n',
    );
    fs.mkdirSync(raw(h.dir, '.archive'), { recursive: true });
    fs.writeFileSync(
      raw(h.dir, '.archive', `snapshot-${PAST}-latest.md`),
      `---\ncreated: ${PAST}\n---\nlatest alias`,
    );
    fs.writeFileSync(
      raw(h.dir, '.archive', `note-${PAST}.md`),
      `---\ncreated: ${PAST}\n---\nregular old entry`,
    );
    await runArchive(h.dir);
  });
  afterAll(() => h.cleanup());

  test('purge: -latest alias in .archive is not deleted', () => {
    expect(fs.existsSync(raw(h.dir, '.archive', `snapshot-${PAST}-latest.md`))).toBe(true);
  });
  test('purge: regular expired .archive entry is deleted', () => {
    expect(fs.existsSync(raw(h.dir, '.archive', `note-${PAST}.md`))).toBe(false);
  });
});
