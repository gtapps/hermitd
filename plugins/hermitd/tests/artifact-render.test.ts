// bun test for artifact.ts's weekly render verb — weekly-review passthrough.
// Usage: bun test tests/artifact-render.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript } from './helpers/run';

function makeHermitDir(): { hermitDir: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-weekly-artifact-'));
  const hermitDir = path.join(root, '.hermit');
  fs.mkdirSync(path.join(hermitDir, 'compiled'), { recursive: true });
  return { hermitDir, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} } };
}

function withHermitDir(fn: (hermitDir: string) => Promise<void>) {
  return async () => {
    const h = makeHermitDir();
    try { await fn(h.hermitDir); } finally { h.cleanup(); }
  };
}

function writeWeekly(hermitDir: string, week: string, fm: Record<string, string>, body: string): void {
  const yaml = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  fs.writeFileSync(path.join(hermitDir, 'compiled', `review-weekly-${week}.md`), `---\n${yaml}\n---\n${body}\n`);
}

describe('artifact.ts render weekly', () => {
  test('strips frontmatter, keeps the body intact', withHermitDir(async (hermitDir) => {
    writeWeekly(hermitDir, '2026-W27', { week: '2026-W27', total_cost_usd: '3.21' }, '# Weekly Review — 2026-W27\n\nBody content here.');
    const r = await runScript('artifact.ts', { args: ['render', 'weekly', hermitDir] });
    expect(r.exitCode).toBe(0);
    const outPath = path.join(hermitDir, 'state', 'weekly-review-artifact.md');
    const written = fs.readFileSync(outPath, 'utf8');
    expect(written).not.toContain('total_cost_usd');
    expect(written).not.toContain('---');
    expect(written).toContain('# Weekly Review — 2026-W27');
    expect(written).toContain('Body content here.');
  }));

  test('picks the latest week by filename sort', withHermitDir(async (hermitDir) => {
    writeWeekly(hermitDir, '2026-W26', { week: '2026-W26' }, 'Older body.');
    writeWeekly(hermitDir, '2026-W27', { week: '2026-W27' }, 'Newer body.');
    const r = await runScript('artifact.ts', { args: ['render', 'weekly', hermitDir] });
    expect(r.exitCode).toBe(0);
    const written = fs.readFileSync(path.join(hermitDir, 'state', 'weekly-review-artifact.md'), 'utf8');
    expect(written).toContain('Newer body.');
    expect(written).not.toContain('Older body.');
  }));

  test('hash is stable for identical content across runs', withHermitDir(async (hermitDir) => {
    writeWeekly(hermitDir, '2026-W27', { week: '2026-W27' }, 'Stable body.');
    const a = await runScript('artifact.ts', { args: ['render', 'weekly', hermitDir] });
    const b = await runScript('artifact.ts', { args: ['render', 'weekly', hermitDir] });
    const hashA = JSON.parse(a.stdout).hash;
    const hashB = JSON.parse(b.stdout).hash;
    expect(hashA).toBe(hashB);
  }));

  test('hash changes when the compiled report changes', withHermitDir(async (hermitDir) => {
    writeWeekly(hermitDir, '2026-W27', { week: '2026-W27' }, 'Version one.');
    const before = JSON.parse((await runScript('artifact.ts', { args: ['render', 'weekly', hermitDir] })).stdout);
    writeWeekly(hermitDir, '2026-W27', { week: '2026-W27' }, 'Version two.');
    const after = JSON.parse((await runScript('artifact.ts', { args: ['render', 'weekly', hermitDir] })).stdout);
    expect(before.hash).not.toBe(after.hash);
  }));

  test('exits non-zero when no compiled weekly review exists', withHermitDir(async (hermitDir) => {
    const r = await runScript('artifact.ts', { args: ['render', 'weekly', hermitDir] });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: 'render_failed:weekly' });
  }));
});
