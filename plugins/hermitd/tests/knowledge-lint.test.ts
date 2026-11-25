import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript, PLUGIN_ROOT } from './helpers/run';
import { setupWorkdir, withDir, type Workdir, hermit, write } from './helpers/workdir';
import { isoSec, daysAgo } from './helpers/fixture-dates';

const runLint = (dir: string) =>
  runScript('knowledge-lint.ts', { args: [hermit(dir)] });
// Findings grouped by snake_case type, from the one-object stdout.
const lintFindings = async (dir: string) => {
  const r = await runLint(dir);
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout).findings;
};

describe('knowledge-lint', () => {
  // 4. Empty state — no raw/, no compiled/
  test('knowledge-lint (empty state)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{}');
    const r = await runLint(dir);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ counts: { raw: 0, compiled: 0, archived: 0 }, findings: {} });
  }));

  test('knowledge-lint (--verbose adds schema_present)', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), '{}');
    const r = await runScript('knowledge-lint.ts', { args: [hermit(dir), '--verbose'] });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).schema_present).toBe(false);
  }));

  // 5. Findings: stale, unreferenced, oversized, missing-type
  describe('findings', () => {
    let wd: Workdir;
    let out: any = {};

    beforeAll(async () => {
      wd = setupWorkdir();
      const dir = wd.dir;
      fs.mkdirSync(hermit(dir, 'raw'), { recursive: true });
      fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
      // Pin the budget below the 1500-char fixtures: an absent knowledge block
      // now settles to the template default (2500), which would exempt them.
      write(hermit(dir, 'config.json'), '{"knowledge":{"compiled_budget_chars":1000}}');
      write(hermit(dir, 'raw', 'old-snap.md'),
        '---\ntitle: old\ncreated: 2025-01-01T00:00:00+00:00\n---\ndata');
      write(hermit(dir, 'compiled', 'note.md'),
        '---\ntitle: no type\ncreated: 2026-04-01T00:00:00+00:00\n---\nshort');
      write(hermit(dir, 'compiled', 'big.md'),
        `---\ntitle: big\ntype: briefing\ncreated: 2026-04-10T00:00:00+00:00\n---\n${'x'.repeat(1500)}`);
      out = await lintFindings(dir);
    });
    afterAll(() => wd.cleanup());

    test('knowledge-lint (finds stale, with age and detail)', () => {
      expect(out.stale).toEqual([expect.objectContaining({ file: 'raw/old-snap.md', age: expect.any(Number), detail: expect.any(String) })]);
    });
    test('knowledge-lint (finds oversized, no age)', () => {
      expect(out.oversized[0].file).toBe('compiled/big.md');
      expect(out.oversized[0]).not.toHaveProperty('age');
    });
    test('knowledge-lint (finds missing_type)', () => {
      expect(out.missing_type[0].file).toBe('compiled/note.md');
    });
  });

  // 5a. injection_stub exempts oversized artifact; unstubbed oversized still flagged
  describe('injection_stub exemption', () => {
    let wd: Workdir;
    let out = '';

    beforeAll(async () => {
      wd = setupWorkdir();
      const dir = wd.dir;
      fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
      // Pin the budget below the 1500-char fixtures (see findings suite above).
      write(hermit(dir, 'config.json'), '{"knowledge":{"compiled_budget_chars":1000}}');
      write(hermit(dir, 'compiled', 'context-stubbed.md'),
        `---\ntitle: stubbed\ntype: context\ncreated: 2026-06-01T00:00:00+00:00\ntags: [foundational]\ninjection_stub: House profile stub\n---\n${'x'.repeat(1500)}`);
      write(hermit(dir, 'compiled', 'briefing-big.md'),
        `---\ntitle: big\ntype: briefing\ncreated: 2026-06-01T00:00:00+00:00\n---\n${'x'.repeat(1500)}`);
      const r = await runLint(dir);
      out = r.stdout + r.stderr;
    });
    afterAll(() => wd.cleanup());

    test('knowledge-lint (stub exempts oversized)', () => {
      expect(out).not.toContain('context-stubbed');
    });
    test('knowledge-lint (unstubbed oversized still flagged)', () => {
      expect(JSON.parse(out).findings.oversized[0].file).toBe('compiled/briefing-big.md');
    });
  });

  // 5b. Topic pages — staleness on updated ?? created, all topics checked, missing-updated lint
  describe('topic pages', () => {
    let wd: Workdir;
    let out = '';
    beforeAll(async () => {
      wd = setupWorkdir();
      const dir = wd.dir;
      fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
      write(hermit(dir, 'config.json'), '{}');
      // Old created but fresh updated — must NOT be stale
      write(hermit(dir, 'compiled', 'topic-fresh.md'),
        `---\ntitle: Fresh topic\ntype: topic\ncreated: ${isoSec(daysAgo(90))}\nupdated: ${isoSec(daysAgo(5))}\n---\nbody`);
      // Stale by updated; second stale topic proves the per-type collapse is gone
      write(hermit(dir, 'compiled', 'topic-stale-a.md'),
        `---\ntitle: Stale A\ntype: topic\ncreated: ${isoSec(daysAgo(200))}\nupdated: ${isoSec(daysAgo(90))}\n---\nbody`);
      write(hermit(dir, 'compiled', 'topic-stale-b.md'),
        `---\ntitle: Stale B\ntype: topic\ncreated: ${isoSec(daysAgo(150))}\nupdated: ${isoSec(daysAgo(70))}\n---\nbody`);
      // Missing updated field
      write(hermit(dir, 'compiled', 'topic-no-updated.md'),
        `---\ntitle: No updated\ntype: topic\ncreated: ${isoSec(daysAgo(5))}\n---\nbody`);
      const r = await runLint(dir);
      out = r.stdout + r.stderr;
    });
    afterAll(() => wd.cleanup());

    test('knowledge-lint (fresh updated not stale despite old created)', () => {
      expect(out).not.toContain('topic-fresh');
    });
    test('knowledge-lint (stale topic flagged by updated)', () => {
      expect(out).toContain('topic-stale-a.md');
    });
    test('knowledge-lint (all topic pages stale-checked, not just newest)', () => {
      expect(out).toContain('topic-stale-b.md');
    });
    test('knowledge-lint (topic_missing_updated flagged)', () => {
      expect(JSON.parse(out).findings.topic_missing_updated).toEqual([{ file: 'compiled/topic-no-updated.md', detail: expect.any(String) }]);
    });
  });

  // 6. Clean state — valid files with matching schema, no findings
  test('knowledge-lint (clean state)', withDir(async (dir) => {
    fs.mkdirSync(hermit(dir, 'raw'), { recursive: true });
    fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
    write(hermit(dir, 'config.json'), '{}');
    write(hermit(dir, 'knowledge-schema.md'),
      '## Work Products\n- briefing: daily summary\n\n## Raw Captures\n- source: fetched articles\n');
    write(hermit(dir, 'raw', 'fresh-snap.md'),
      `---\ntitle: fresh\ntype: source\ncreated: ${isoSec(daysAgo(5))}\n---\ndata`);
    write(hermit(dir, 'compiled', 'summary.md'),
      `---\ntitle: summary\ntype: briefing\ncreated: ${isoSec(daysAgo(5))}\n---\nBased on fresh-snap.md data`);
    expect(await lintFindings(dir)).toEqual({});
  }));

  // 6a. Schema-empty finding — template-style schema (all bullets commented)
  test('knowledge-lint (schema-empty emitted without --verbose)', withDir(async (dir) => {
    fs.mkdirSync(hermit(dir, 'raw'), { recursive: true });
    fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
    write(hermit(dir, 'config.json'), '{}');
    // Add a raw artifact so the schema-presence guard fires
    write(hermit(dir, 'raw', 'snap.md'),
      '---\ntitle: snap\ncreated: 2026-04-22T00:00:00+00:00\n---\ndata');
    // Copy the real template (all bullets inside HTML comments) so parseSchema
    // returns null, removing the starter bullets to simulate a pre-upgrade
    // all-comments schema.
    const template = fs.readFileSync(
      path.join(PLUGIN_ROOT, 'state-templates', 'knowledge-schema.md.template'), 'utf-8');
    write(hermit(dir, 'knowledge-schema.md'),
      template.split('\n').filter((l) => !/^- (note|input|review|procedure-brief|topic|capability-brainstorm):/.test(l)).join('\n'));
    expect((await lintFindings(dir)).schema_empty).toHaveLength(1);
  }));

  test('knowledge-lint (template declares capability-brainstorm)', withDir(async (dir) => {
    fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
    write(hermit(dir, 'config.json'), '{}');
    const template = fs.readFileSync(
      path.join(PLUGIN_ROOT, 'state-templates', 'knowledge-schema.md.template'), 'utf-8');
    write(hermit(dir, 'knowledge-schema.md'), template);
    write(hermit(dir, 'compiled', 'capability-brainstorm-2026-10-09-1200.md'),
      `---\ntitle: Capability brainstorm\ntype: capability-brainstorm\ncreated: ${isoSec(daysAgo(1))}\n---\nCreated a proposal.`);
    expect(await lintFindings(dir)).not.toHaveProperty('undeclared_type');
  }));

  // 6b. Schema enforcement — undeclared type warned; declared+matching type clean
  // Both tests write the same compiled/unknown.md path and re-run the linter
  // against it — order-coupled shared file, so both are marked serial.
  describe('schema enforcement', () => {
    let wd: Workdir;

    beforeAll(() => {
      wd = setupWorkdir();
      const dir = wd.dir;
      fs.mkdirSync(hermit(dir, 'raw'), { recursive: true });
      fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
      write(hermit(dir, 'config.json'), '{}');
      // Schema declares 'briefing'; compiled file uses undeclared 'foo'
      write(hermit(dir, 'knowledge-schema.md'),
        '## Work Products\n- briefing: daily summary\n\n## Raw Captures\n- source: fetched articles\n');
    });
    afterAll(() => wd.cleanup());

    test.serial('knowledge-lint (schema: undeclared type warned)', async () => {
      write(hermit(wd.dir, 'compiled', 'unknown.md'),
        '---\ntitle: unknown\ntype: foo\ncreated: 2026-04-14T00:00:00+00:00\n---\ndata');
      expect((await lintFindings(wd.dir)).undeclared_type[0].file).toBe('compiled/unknown.md');
    });

    test.serial('knowledge-lint (schema: declared type is clean)', async () => {
      // Matching type: schema has 'briefing', file has type: briefing
      write(hermit(wd.dir, 'compiled', 'unknown.md'),
        `---\ntitle: summary\ntype: briefing\ncreated: ${isoSec(daysAgo(5))}\n---\ndata`);
      expect(await lintFindings(wd.dir)).toEqual({});
    });
  });

  // 6c. Bold-format schema — `- **type**:` entries are parsed
  test('knowledge-lint (bold schema entries parsed)', withDir(async (dir) => {
    fs.mkdirSync(hermit(dir, 'raw'), { recursive: true });
    fs.mkdirSync(hermit(dir, 'compiled'), { recursive: true });
    write(hermit(dir, 'config.json'), '{}');
    write(hermit(dir, 'knowledge-schema.md'),
      '## Work Products\n- **briefing**: daily summary\n\n## Raw Captures\n- **source**: fetched articles\n');
    write(hermit(dir, 'raw', 'fresh-snap.md'),
      `---\ntitle: fresh\ntype: source\ncreated: ${isoSec(daysAgo(5))}\n---\ndata`);
    write(hermit(dir, 'compiled', 'summary.md'),
      `---\ntitle: summary\ntype: briefing\ncreated: ${isoSec(daysAgo(5))}\n---\nBased on fresh-snap.md data`);
    expect(await lintFindings(dir)).toEqual({});
  }));
});
