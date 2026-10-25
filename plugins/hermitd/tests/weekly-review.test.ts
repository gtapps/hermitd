// bun test for scripts/weekly-review.ts — deliverable enumeration and
// owner-language-safe frontmatter (delivered/open_loops_count fields).
// Usage: bun test tests/weekly-review.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript } from './helpers/run';
import { readFileWithFrontmatter } from '../scripts/lib/frontmatter';
import { costLogPath } from '../scripts/lib/cc-compat';
import { dutySummary } from '../scripts/lib/duty-summary';

function makeHermitDir(): { hermitDir: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-weekly-review-'));
  const hermitDir = path.join(root, '.hermit');
  fs.mkdirSync(path.join(hermitDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(hermitDir, 'proposals'), { recursive: true });
  fs.mkdirSync(path.join(hermitDir, 'compiled'), { recursive: true });
  fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
  return { hermitDir, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} } };
}

function withHermitDir(fn: (hermitDir: string) => Promise<void>) {
  return async () => {
    const h = makeHermitDir();
    try { await fn(h.hermitDir); } finally { h.cleanup(); }
  };
}

async function writeCompletedTask(hermitDir: string, title: string): Promise<void> {
  const run = (verb: string, args: string[], stdin = '') => runScript('task.ts', {
    args: [verb, hermitDir, ...args], stdin, env: { AGENT_DIR: hermitDir },
  });
  const opened = await run('open', ['--title', title, '--requester', 'operator', '--done', 'Verified']);
  expect(opened.exitCode).toBe(0);
  const id = JSON.parse(opened.stdout).id;
  expect((await run('block', [id, '--result-stdin'], 'Ready')).exitCode).toBe(0);
  expect((await run('close', [id, '--by', 'confirmed', '--actor', 'operator', '--result-rev', '1', '--reason-stdin'], 'Accepted')).exitCode).toBe(0);
}

function readReview(hermitDir: string): { fm: Record<string, any>; body: string } {
  const files = fs.readdirSync(path.join(hermitDir, 'compiled')).filter(f => f.startsWith('review-weekly-'));
  expect(files.length).toBe(1);
  const full = path.join(hermitDir, 'compiled', files[0]);
  const { fm, body } = readFileWithFrontmatter(full)!;
  return { fm, body };
}

describe('weekly-review Duties', () => {
  for (const id of ['weekly-review', 'operator-review']) {
    test(`labels the open review for routine ${id}`, withHermitDir(async dir => {
      writeConfig(dir, { routines: [{ id, skill: 'hermitd:weekly-review', schedule: '0 23 * * 0', enabled: true }] });
      fs.writeFileSync(path.join(dir, 'state/routine-metrics.jsonl'), [
        { routine_id: id, event: 'fired', ts: '2026-09-20T23:00:00Z' },
        { routine_id: id, event: 'started', ts: new Date().toISOString() },
      ].map(row => JSON.stringify(row)).join('\n') + '\n');
      expect((await runScript('weekly-review.ts', { args: [dir] })).exitCode).toBe(0);
      const { body } = readReview(dir);
      expect(body).toContain('last_woke=2026-09-20T23:00:00Z, last_event=in progress (this review)');
      expect(body).not.toContain('last_event=started@');
    }));
  }

  test('preserves stale review starts and other open routines', withHermitDir(async dir => {
    writeConfig(dir, { routines: [
      { id: 'review', skill: 'hermitd:weekly-review', schedule: '0 23 * * 0', enabled: true },
      { id: 'weekly-review', skill: 'hermitd:reflect', schedule: '0 23 * * 0', enabled: true },
    ] });
    fs.writeFileSync(path.join(dir, 'state/routine-metrics.jsonl'), [
      { routine_id: 'review', event: 'fired', ts: '2026-09-13T23:00:00Z' },
      { routine_id: 'review', event: 'started', ts: '2026-09-20T23:00:00Z' },
      { routine_id: 'weekly-review', event: 'started', ts: new Date().toISOString() },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const lines = dutySummary(dir);
    expect((await runScript('weekly-review.ts', { args: [dir] })).exitCode).toBe(0);
    const { body } = readReview(dir);
    for (const line of lines) expect(body).toContain('- ' + line + '\n');
    expect(body).not.toContain('in progress (this review)');
  }));
});

describe('weekly-review task records', () => {
  test('completed records are delivered and include person and duty sections', withHermitDir(async dir => {
    await writeCompletedTask(dir, 'Investigated the login bug');
    const result = await runScript('weekly-review.ts', { args: [dir] });
    expect(result.exitCode).toBe(0);
    const { fm, body } = readReview(dir);
    expect(fm.tasks_count).toBe('1');
    expect(fm.delivered).toEqual(['Investigated the login bug']);
    expect(body).toContain('### By person');
    expect(body).toContain('### Duties');
  }));
  test('frozen reports do not count as delivered work', withHermitDir(async dir => {
    fs.writeFileSync(path.join(dir, 'sessions/S-001-REPORT.md'), '---\nid: S-001\nstatus: completed\n---\nOld work');
    expect((await runScript('weekly-review.ts', { args: [dir] })).exitCode).toBe(0);
    const { fm, body } = readReview(dir);
    expect(fm.tasks_count).toBe('0');
    expect(fm.delivered).toEqual([]);
    expect(body).not.toContain('### Delivered');
  }));
  test('neutralizes commas in task titles for frontmatter arrays', withHermitDir(async dir => {
    await writeCompletedTask(dir, 'Investigated X, wrote Y');
    expect((await runScript('weekly-review.ts', { args: [dir] })).exitCode).toBe(0);
    expect(readReview(dir).fm.delivered).toEqual(['Investigated X; wrote Y']);
  }));
  test('keeps open-loop counts', withHermitDir(async dir => {
    expect((await runScript('weekly-review.ts', { args: [dir] })).exitCode).toBe(0);
    expect(readReview(dir).fm.open_loops_count).toBe('0');
  }));
  test('week spend comes from cost-log rows even with no closed task', withHermitDir(async dir => {
    writeWeekCostLog(dir);
    expect((await runScript('weekly-review.ts', { args: [dir] })).exitCode).toBe(0);
    const { fm, body } = readReview(dir);
    expect(fm.tasks_count).toBe('0');
    expect(fm.total_cost_usd).toBe('3.75');
    expect(fm.total_tokens).toBe('4000');
    expect(body).toContain('No closed tasks this week. Week spend $3.75');
  }));
  test('week spend stays separate from the cost attributed to closed tasks', withHermitDir(async dir => {
    writeWeekCostLog(dir);
    await writeCompletedTask(dir, 'Unattributed work');
    expect((await runScript('weekly-review.ts', { args: [dir] })).exitCode).toBe(0);
    const { fm, body } = readReview(dir);
    expect(fm.tasks_count).toBe('1');
    expect(fm.total_cost_usd).toBe('3.75');
    expect(fm.avg_task_cost_usd).toBe('0.00');
    expect(body).toContain('1 task closed ($0.00 avg attributed). Week spend $3.75');
  }));
});

// Two rows in the current week ($3.75, 4000 tokens) and one two weeks back that must be ignored.
function writeWeekCostLog(hermitDir: string): void {
  const log = costLogPath(hermitDir);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const now = new Date().toISOString();
  const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString();
  fs.writeFileSync(log, [
    JSON.stringify({ timestamp: now, estimated_cost_usd: 1.25, total_tokens: 1000, source: 'main' }),
    JSON.stringify({ timestamp: now, estimated_cost_usd: 2.5, total_tokens: 3000, source: 'main' }),
    JSON.stringify({ timestamp: twoWeeksAgo, estimated_cost_usd: 100, total_tokens: 999999, source: 'main' }),
  ].join('\n') + '\n');
}

describe('weekly-review Proposals', () => {
  test('prints short ids and lists resolved proposals once, under Recently Resolved', withHermitDir(async dir => {
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'proposals', 'PROP-012-tidy-the-queue-120000.md'),
      `---\nid: PROP-012-tidy-the-queue-120000\ntitle: Tidy the queue\nstatus: resolved\ncreated: ${now}\nresolved_date: ${now}\n---\nBody.\n`);
    expect((await runScript('weekly-review.ts', { args: [dir] })).exitCode).toBe(0);
    const { body } = readReview(dir);
    expect(body).toContain('1 created: PROP-012.');
    expect(body).toContain('1 resolved.');
    expect(body).toContain('- PROP-012: Tidy the queue');
    expect(body).not.toContain('tidy-the-queue');
  }));
});

// -------------------------------------------------------------------------
// Usage section — usage-metrics.jsonl → "no tracked use" suggestions.
// Suggest-only: guarded so a young/missing ledger never reads as "unused".
// -------------------------------------------------------------------------

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString();
}

function writeLedgerLines(hermitDir: string, lines: object[]): void {
  const p = path.join(hermitDir, 'state', 'usage-metrics.jsonl');
  fs.writeFileSync(p, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
}

function writeConfig(hermitDir: string, config: object): void {
  fs.writeFileSync(path.join(hermitDir, 'config.json'), JSON.stringify(config, null, 2));
}

function writeCompiledDoc(hermitDir: string, filename: string, fm: Record<string, string>): void {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  const content = `---\n${lines.join('\n')}\n---\nBody.\n`;
  fs.writeFileSync(path.join(hermitDir, 'compiled', filename), content);
}

describe('weekly-review.ts — Usage section', () => {
  // Archiving needs proof the Read hook ever fired; every archiving test seeds a
  // compiled read of an unrelated doc so the ledger has capture evidence.
  const CAPTURE_EVIDENCE = { ts: daysAgoIso(80), kind: 'compiled', name: 'some-other-doc', source: 'read' };

  test('old ledger + stale untouched doc — auto-archived, reported, and counted as handled', withHermitDir(async (hermitDir) => {
    writeLedgerLines(hermitDir, [{ ts: daysAgoIso(90), kind: 'meta', event: 'ledger-start' }, CAPTURE_EVIDENCE]);
    writeCompiledDoc(hermitDir, 'note-old-2026-01-01.md', { type: 'note', created: daysAgoIso(100) });
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { fm, body } = readReview(hermitDir);
    expect(body).toContain('### Usage');
    expect(body).toContain('auto-archived to compiled/.archive/');
    expect(fm.usage_auto_archived).toEqual(['note-old-2026-01-01']);
    // Move-only: gone from compiled/, present in the archive, never deleted.
    expect(fs.existsSync(path.join(hermitDir, 'compiled', 'note-old-2026-01-01.md'))).toBe(false);
    expect(fs.existsSync(path.join(hermitDir, 'compiled', '.archive', 'note-old-2026-01-01.md'))).toBe(true);
    expect(fm.usage_untouched_count).toBe('0');
  }));

  test('usage_auto_archive: false — suggest-only, file stays put', withHermitDir(async (hermitDir) => {
    writeConfig(hermitDir, { knowledge: { usage_auto_archive: false } });
    writeLedgerLines(hermitDir, [{ ts: daysAgoIso(90), kind: 'meta', event: 'ledger-start' }]);
    writeCompiledDoc(hermitDir, 'note-old-2026-01-01.md', { type: 'note', created: daysAgoIso(100) });
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { fm, body } = readReview(hermitDir);
    expect(body).toContain('### Usage');
    expect(body).not.toContain('auto-archived');
    expect(body).toContain('note-old-2026-01-01.md');
    expect(fm.usage_auto_archived).toEqual([]);
    expect(fm.usage_untouched_count).toBe('1');
    expect(fs.existsSync(path.join(hermitDir, 'compiled', 'note-old-2026-01-01.md'))).toBe(true);
  }));

  test('a ledger with no compiled read at all archives nothing — tracking gap, not disuse', withHermitDir(async (hermitDir) => {
    writeLedgerLines(hermitDir, [
      { ts: daysAgoIso(200), kind: 'meta', event: 'ledger-start' },
      { ts: daysAgoIso(3), kind: 'skill', name: 'hermitd:brief', source: 'skill-tool' },
    ]);
    writeCompiledDoc(hermitDir, 'note-old-2026-01-01.md', { type: 'note', created: daysAgoIso(100) });
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { fm, body } = readReview(hermitDir);
    expect(body).toContain('Nothing was auto-archived');
    expect(fm.usage_auto_archived).toEqual([]);
    expect(fm.usage_untouched_count).toBe('1');
    expect(fs.existsSync(path.join(hermitDir, 'compiled', 'note-old-2026-01-01.md'))).toBe(true);
  }));

  test('a doc the operator restored is not archived again', withHermitDir(async (hermitDir) => {
    writeLedgerLines(hermitDir, [{ ts: daysAgoIso(90), kind: 'meta', event: 'ledger-start' }, CAPTURE_EVIDENCE]);
    writeCompiledDoc(hermitDir, 'note-old-2026-01-01.md', { type: 'note', created: daysAgoIso(100) });
    fs.writeFileSync(
      path.join(hermitDir, 'state', 'usage-archived.json'),
      JSON.stringify({ stems: ['note-old-2026-01-01'] }),
    );
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { fm } = readReview(hermitDir);
    expect(fm.usage_auto_archived).toEqual([]);
    expect(fs.existsSync(path.join(hermitDir, 'compiled', 'note-old-2026-01-01.md'))).toBe(true);
  }));

  test('at most 10 docs move per run — the rest carry over as suggestions', withHermitDir(async (hermitDir) => {
    writeLedgerLines(hermitDir, [{ ts: daysAgoIso(200), kind: 'meta', event: 'ledger-start' }, CAPTURE_EVIDENCE]);
    for (let i = 0; i < 12; i++) {
      writeCompiledDoc(hermitDir, `note-${i}.md`, { type: 'note', created: daysAgoIso(150 - i) });
    }
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { fm } = readReview(hermitDir);
    expect(fm.usage_auto_archived.length).toBe(10);
    expect(fm.usage_untouched_count).toBe('2');
    const left = fs.readdirSync(path.join(hermitDir, 'compiled')).filter(f => f.startsWith('note-'));
    expect(left.length).toBe(2);
    // The record survives for the next run's restore check.
    const recorded = JSON.parse(fs.readFileSync(path.join(hermitDir, 'state', 'usage-archived.json'), 'utf-8'));
    expect(recorded.stems.length).toBe(10);
  }));

  test('usage_auto_archive: null disables archiving like false', withHermitDir(async (hermitDir) => {
    writeConfig(hermitDir, { knowledge: { usage_auto_archive: null } });
    writeLedgerLines(hermitDir, [{ ts: daysAgoIso(90), kind: 'meta', event: 'ledger-start' }, CAPTURE_EVIDENCE]);
    writeCompiledDoc(hermitDir, 'note-old-2026-01-01.md', { type: 'note', created: daysAgoIso(100) });
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { fm } = readReview(hermitDir);
    expect(fm.usage_auto_archived).toEqual([]);
    expect(fs.existsSync(path.join(hermitDir, 'compiled', 'note-old-2026-01-01.md'))).toBe(true);
  }));

  test('usage_stale_days override widens the window — a 100d doc is not yet stale at 200d', withHermitDir(async (hermitDir) => {
    writeConfig(hermitDir, { knowledge: { usage_stale_days: 200 } });
    writeLedgerLines(hermitDir, [{ ts: daysAgoIso(300), kind: 'meta', event: 'ledger-start' }]);
    writeCompiledDoc(hermitDir, 'note-old-2026-01-01.md', { type: 'note', created: daysAgoIso(100) });
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { body } = readReview(hermitDir);
    expect(body).not.toContain('### Usage');
    expect(fs.existsSync(path.join(hermitDir, 'compiled', 'note-old-2026-01-01.md'))).toBe(true);
  }));

  test('foundational-tagged doc is exempt from the Usage section', withHermitDir(async (hermitDir) => {
    writeLedgerLines(hermitDir, [{ ts: daysAgoIso(90), kind: 'meta', event: 'ledger-start' }]);
    writeCompiledDoc(hermitDir, 'note-old-2026-01-01.md', {
      type: 'note', created: daysAgoIso(100), tags: '[foundational]',
    });
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { fm, body } = readReview(hermitDir);
    expect(body).not.toContain('### Usage');
    expect(fm.usage_untouched_count).toBe('0');
  }));

  test('topic pages are exempt from the Usage section', withHermitDir(async (hermitDir) => {
    writeLedgerLines(hermitDir, [{ ts: daysAgoIso(90), kind: 'meta', event: 'ledger-start' }]);
    writeCompiledDoc(hermitDir, 'topic-rota.md', { type: 'topic', created: daysAgoIso(100) });
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { body } = readReview(hermitDir);
    expect(body).not.toContain('### Usage');
  }));

  test('a young ledger suppresses the Usage section even with a stale doc', withHermitDir(async (hermitDir) => {
    writeLedgerLines(hermitDir, [{ ts: daysAgoIso(5), kind: 'meta', event: 'ledger-start' }]);
    writeCompiledDoc(hermitDir, 'note-old-2026-01-01.md', { type: 'note', created: daysAgoIso(100) });
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { fm, body } = readReview(hermitDir);
    expect(body).not.toContain('### Usage');
    expect(fm.usage_untouched_count).toBe('0');
  }));

  test('no ledger at all — no Usage section', withHermitDir(async (hermitDir) => {
    writeCompiledDoc(hermitDir, 'note-old-2026-01-01.md', { type: 'note', created: daysAgoIso(100) });
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { body } = readReview(hermitDir);
    expect(body).not.toContain('### Usage');
  }));

  test('a doc read within the staleness window is excluded even if old', withHermitDir(async (hermitDir) => {
    writeLedgerLines(hermitDir, [
      { ts: daysAgoIso(90), kind: 'meta', event: 'ledger-start' },
      { ts: daysAgoIso(10), kind: 'compiled', name: 'note-old-2026-01-01', source: 'read' },
    ]);
    writeCompiledDoc(hermitDir, 'note-old-2026-01-01.md', { type: 'note', created: daysAgoIso(100) });
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { body } = readReview(hermitDir);
    expect(body).not.toContain('### Usage');
  }));

  test('skill rows in the ledger produce no Usage section — skills are not tracked for dormancy', withHermitDir(async (hermitDir) => {
    writeLedgerLines(hermitDir, [
      { ts: daysAgoIso(90), kind: 'meta', event: 'ledger-start' },
      { ts: daysAgoIso(75), kind: 'skill', name: 'hermitd:migrate', source: 'skill-tool' },
    ]);
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const { fm, body } = readReview(hermitDir);
    expect(body).not.toContain('### Usage');
    expect(fm.usage_untouched_count).toBe('0');
  }));

  test('ledger compaction: collapses stale (>180d) duplicate events to the newest per name, keeps meta and recent events', withHermitDir(async (hermitDir) => {
    const tsNewestStale = daysAgoIso(190);
    writeLedgerLines(hermitDir, [
      { ts: daysAgoIso(300), kind: 'meta', event: 'ledger-start' },
      { ts: daysAgoIso(200), kind: 'skill', name: 'x:foo', source: 'skill-tool' },
      { ts: daysAgoIso(195), kind: 'skill', name: 'x:foo', source: 'skill-tool' },
      { ts: tsNewestStale, kind: 'skill', name: 'x:foo', source: 'skill-tool' },
      { ts: daysAgoIso(10), kind: 'skill', name: 'x:bar', source: 'skill-tool' },
    ]);
    const r = await runScript('weekly-review.ts', { args: [hermitDir] });
    expect(r.exitCode).toBe(0);
    const ledgerPath = path.join(hermitDir, 'state', 'usage-metrics.jsonl');
    const events = fs.readFileSync(ledgerPath, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    expect(events.filter(e => e.kind === 'meta')).toHaveLength(1);
    const fooEvents = events.filter(e => e.name === 'x:foo');
    expect(fooEvents).toHaveLength(1);
    expect(fooEvents[0].ts).toBe(tsNewestStale);
    expect(events.some(e => e.name === 'x:bar')).toBe(true);
  }));
});


test('reflect cost matches configured reflect routine ids exactly', withHermitDir(async dir => {
  writeConfig(dir, { routines: [
    { id: 'hermitd:reflect', skill: 'hermitd:reflect', schedule: '0 9 * * *', enabled: true },
    { id: 'operator-check', skill: 'hermitd:reflect --check-id custom --check example:audit', schedule: '0 9 * * *', enabled: true },
  ] });
  const log = costLogPath(dir);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, ['hermitd:reflect', 'operator-check', 'reflect-unrelated', 'hermitd:reflect-extra'].map((id, i) =>
    JSON.stringify({ timestamp: new Date().toISOString(), source: `routine:${id}`, estimated_cost_usd: i < 2 ? 1 : 100 }),
  ).join('\n') + '\n');
  expect((await runScript('weekly-review.ts', { args: [dir] })).exitCode).toBe(0);
  expect(readReview(dir).fm.reflect_cost_usd).toBe('2.00');
}));

describe('weekly learned-skill retirement', () => {
  function seedSkills(dir: string, count: number, capture: boolean) {
    const configDir = path.join(dir, 'test-claude'); fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'state/runtime.json'), JSON.stringify({ config_dir: configDir }));
    const old = new Date(Date.now() - 40 * 86400000).toISOString();
    const skillUsage: Record<string, any> = capture ? { 'capture-evidence': { lastUsedAt: Date.now() } } : {};
    const rows = [];
    for (let n = 0; n < count; n++) {
      const skill = `learned-${String(n).padStart(2, '0')}`;
      const folder = path.join(path.dirname(dir), '.claude/skills', skill); fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'SKILL.md'), `---\nname: ${skill}\n---\nSteps`);
      rows.push({ ts: old, skill, action: 'create' });
      skillUsage[skill] = { lastUsedAt: Date.parse(old) };
    }
    fs.writeFileSync(path.join(dir, 'state/skill-ledger.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({ skillUsage }));
  }
  test('no capture evidence leaves suggestions', withHermitDir(async dir => {
    seedSkills(dir, 1, false);
    expect((await runScript('weekly-review.ts', { args: [dir] })).exitCode).toBe(0);
    expect(readReview(dir).fm.skills_archived).toBe('0');
    expect(readReview(dir).body).toContain('no recent skillUsage capture evidence');
  }));
  test('cap, pins, routine names, recent patches and operator skills stay protected', withHermitDir(async dir => {
    seedSkills(dir, 16, true);
    writeConfig(dir, { routines: [{ skill: 'learned-01 --arg' }] });
    fs.appendFileSync(path.join(dir, 'state/skill-ledger.jsonl'), JSON.stringify({ ts: new Date().toISOString(), skill: 'learned-00', action: 'pin' }) + '\n' + JSON.stringify({ ts: new Date().toISOString(), skill: 'learned-02', action: 'patch' }) + '\n');
    const operator = path.join(path.dirname(dir), '.claude/skills/operator'); fs.mkdirSync(operator); fs.writeFileSync(path.join(operator, 'SKILL.md'), 'Operator');
    expect((await runScript('weekly-review.ts', { args: [dir] })).exitCode).toBe(0);
    expect(readReview(dir).fm.skills_archived).toBe('10');
    for (const name of ['learned-00', 'learned-01', 'learned-02', 'operator']) expect(fs.existsSync(path.join(path.dirname(dir), '.claude/skills', name))).toBe(true);
    expect(readReview(dir).body).toContain('dormant suggestion');
    const rows = fs.readFileSync(path.join(dir, 'state/skill-ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.filter(row => row.action === 'archive').length).toBe(10);
  }));
  test('restored skills are never archived again', withHermitDir(async dir => {
    seedSkills(dir, 1, true);
    expect((await runScript('weekly-review.ts', { args: [dir] })).exitCode).toBe(0);
    const name = 'learned-00';
    fs.renameSync(path.join(dir, 'state/skill-archive', name), path.join(path.dirname(dir), '.claude/skills', name));
    expect((await runScript('weekly-review.ts', { args: [dir] })).exitCode).toBe(0);
    expect(readReview(dir).fm.skills_archived).toBe('0');
    expect(fs.existsSync(path.join(path.dirname(dir), '.claude/skills', name))).toBe(true);
  }));
});
