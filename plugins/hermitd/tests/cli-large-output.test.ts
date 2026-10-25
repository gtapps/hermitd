import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// emitJson exits right after writing; through a pipe the whole object must still arrive.
const cli = path.resolve(import.meta.dir, '../scripts/lib/cli.ts');

test('leftover-check output past one pipe buffer parses whole', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leftover-large-'));
  try {
    fs.mkdirSync(path.join(root, '.hermit'));
    fs.writeFileSync(path.join(root, '.hermit/config.json'), '{}');
    const subjects = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, terms: [`old${i}`], kind: 'routine_id' }));
    // Quotes double in JSON, so 200 capped candidates plus per-subject context examples pass 64 KiB.
    const quoted = '"q" '.repeat(60);
    const counted = Array.from({ length: 220 }, (_, i) => `routine old${i % 40} ${quoted}`);
    const filtered = subjects.map(s => `${s.terms[0]} ${quoted}`);
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), [...counted, ...filtered].join('\n'));
    const result = Bun.spawnSync(['bun', path.resolve(import.meta.dir, '../scripts/evolve-plan.ts'), '.hermit', 'leftover-check'], {
      cwd: root, stdin: Buffer.from(JSON.stringify({ subjects })), stdout: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(64 * 1024);
    const out = JSON.parse(result.stdout.toString());
    expect(out.candidates).toHaveLength(200);
    expect(out.truncated).toBe(true);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('a whole-history upgrade plan parses whole', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-large-'));
  try {
    fs.mkdirSync(path.join(root, '.hermit'));
    fs.writeFileSync(path.join(root, '.hermit/config.json'), JSON.stringify({ _hermit_versions: { hermitd: '0.0.1' } }));
    fs.writeFileSync(path.join(root, 'plugins.json'), '[]');
    const plugin = path.resolve(import.meta.dir, '..');
    const result = Bun.spawnSync(['bun', path.join(plugin, 'scripts/evolve-plan.ts'), '.hermit', '--plugin-list-json=plugins.json'], {
      cwd: root, stdout: 'pipe', env: { ...process.env, CLAUDE_PLUGIN_ROOT: plugin },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(64 * 1024);
    const plan = JSON.parse(result.stdout.toString());
    expect(plan.errors).toEqual([]);
    expect(plan.changelog_slice.length).toBeGreaterThan(64 * 1024);
  } finally { fs.rmSync(root, { recursive: true }); }
});

// An earlier process.stdout write leaves the pipe non-blocking, so the writer must ride out EAGAIN.
for (const touched of [false, true]) test(`emitJson delivers a multi-megabyte object through a pipe, stdout touched=${touched}`, () => {
  const size = 4 * 1024 * 1024;
  const code = `import { emitJson } from ${JSON.stringify(cli)};${touched ? "process.stdout.write('');" : ''}emitJson({ status: 'ok', s: 'x'.repeat(${size}) });`;
  const result = Bun.spawnSync(['bun', '-e', code], { stdout: 'pipe' });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.length).toBe(size + '{"status":"ok","s":""}\n'.length);
  expect(JSON.parse(result.stdout.toString()).s).toHaveLength(size);
});
