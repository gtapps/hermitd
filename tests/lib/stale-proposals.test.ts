import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const roots: string[] = [];
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true }); });
const repo = path.resolve(import.meta.dir, '../..');
const copies = ['.claude', '.agents'].map(dir => path.join(repo, dir, 'skills/stale-proposals/scripts/collect-evidence.ts'));

function collect(script: string, hermitDir: string, out: string) {
  const run = Bun.spawnSync(['bun', script, '--hermit-dir', hermitDir, '--out', out], { cwd: repo, env: { ...process.env, AGENT_DIR: hermitDir }, stdout: 'pipe', stderr: 'pipe' });
  return { code: run.exitCode, out: run.stdout.toString().trim(), err: run.stderr.toString().trim() };
}

for (const script of copies) {
  test(`${path.relative(repo, script)}: a missing proposals folder is an error naming the path`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-proposals-')); roots.push(root);
    const result = collect(script, root, path.join(root, 'bundle.md'));
    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toContain(path.join(root, 'proposals'));
    expect(result.err).toContain('--hermit-dir');
  });

  test(`${path.relative(repo, script)}: an open proposal yields a bundle with a task section`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-proposals-')); roots.push(root);
    fs.mkdirSync(path.join(root, 'proposals'));
    fs.writeFileSync(path.join(root, 'proposals/PROP-900-example.md'), '---\nid: PROP-900\ntitle: Example\nstatus: proposed\ncreated: 2026-11-04T00:00:00Z\n---\n\n## Problem\n\nSomething that needs changing and is described at enough length to excerpt.\n');
    const bundle = path.join(root, 'bundle.md');
    const result = collect(script, root, bundle);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/^OK\|.*\|1\|\d+\|\d+\|2026-11-04\|0$/);
    expect(fs.readFileSync(bundle, 'utf8')).toContain('## Closed task records naming a PROP (0)');
  });
}
