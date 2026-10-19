import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateProject } from '../scripts/migrate-from-claude-code-hermit';
import { sha256 } from '../scripts/lib/hash';

const roots: string[] = [];
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true }); });
function write(file: string, text: string) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermitd-migrate-')); roots.push(root);
  const state = path.join(root, '.hermit');
  write(path.join(state, 'config.json'), JSON.stringify({ _hermit_versions: { 'claude-code-hermit': '1.4.8' }, boot_skill: '/claude-code-hermit:resident-start' }));
  write(path.join(state, 'state/hatch-options.json'), JSON.stringify({ target: 'local' }));
  write(path.join(state, 'state/template-manifest.json'), JSON.stringify({ version: 1, files: { 'bin/hermit-run': { sha256: sha256('original'), plugin_version: '1.4.8' } } }));
  write(path.join(state, 'bin/hermit-run'), 'customized wrapper');
  write(path.join(root, '.claude/agent-memory/claude-code-hermit-proposal-triage/MEMORY.md'), 'memory');
  write(path.join(root, '.claude/settings.local.json'), JSON.stringify({ permissions: { allow: ['Edit(.claude-code-hermit/**)'], deny: ['Edit(*.claude-code-hermit/tasks/**)'], ask: ['Edit(*.claude-code-hermit/config.json)', 'Bash(ssh *)'] } }));
  write(path.join(state, 'state/hypotheses.jsonl'), JSON.stringify({ id: 'later-1', state: 'pending', cmd: '.claude-code-hermit/bin/hermit-run status' }) + '\n');
  return { root, state };
}
function snapshot(root: string): Record<string, { bytes: string; mtime: number; mode: number }> {
  const result: Record<string, { bytes: string; mtime: number; mode: number }> = {};
  for (const name of fs.readdirSync(root, { recursive: true }) as string[]) {
    const file = path.join(root, name); const stat = fs.statSync(file);
    if (stat.isFile()) result[name] = { bytes: fs.readFileSync(file).toString('base64'), mtime: stat.mtimeMs, mode: stat.mode };
  }
  return result;
}
test('1.4.8 customized wrapper, memory, ledger, and no-write rerun', () => {
  const f = fixture();
  const ledger = fs.readFileSync(path.join(f.state, 'state/hypotheses.jsonl'), 'utf8');
  const report = migrateProject(f.root);
  expect(report.join('\n')).toContain('re-arm these');
  expect(report.join('\n')).toContain('Customized file saved');
  expect(fs.readFileSync(path.join(f.state, 'bin/hermit-run.bak'), 'utf8')).toBe('customized wrapper');
  expect(fs.existsSync(path.join(f.state, 'bin/hermit-run'))).toBe(false);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.state, 'state/template-manifest.json'), 'utf8'));
  expect(Object.keys(manifest.files).every(key => key.startsWith('bin/hermitd-'))).toBe(true);
  expect(fs.readFileSync(path.join(f.root, '.claude/agent-memory/hermitd-proposal-triage/MEMORY.md'), 'utf8')).toBe('memory');
  expect(fs.readFileSync(path.join(f.state, 'state/hypotheses.jsonl'), 'utf8')).toBe(ledger);
  const settings = JSON.parse(fs.readFileSync(path.join(f.root, '.claude/settings.local.json'), 'utf8'));
  expect(settings.permissions.allow).toContain('Edit(.hermit/**)');
  expect(settings.permissions.allow).not.toContain('Edit(.claude-code-hermit/**)');
  expect(settings.permissions.deny).toEqual(['Edit(*.hermit/tasks/**)']);
  expect(settings.permissions.ask).toEqual(['Edit(*.hermit/config.json)', 'Bash(ssh *)']);
  expect(fs.existsSync(path.join(f.root, '.claude/settings.json'))).toBe(false);
  const before = snapshot(f.root);
  migrateProject(f.root);
  expect(snapshot(f.root)).toEqual(before);
  expect(fs.existsSync(path.join(f.root, '.gitignore'))).toBe(false);
  expect(fs.existsSync(path.join(f.root, '.worktreeinclude'))).toBe(false);
});
test('an unstamped project with old blocks in CLAUDE.local.md syncs the local settings file', () => {
  const f = fixture();
  fs.rmSync(path.join(f.state, 'state/hatch-options.json'));
  write(path.join(f.root, 'CLAUDE.local.md'), '<!-- claude-code-hermit: Session Discipline -->\nrules\n<!-- /claude-code-hermit: Session Discipline -->\n');
  migrateProject(f.root);
  expect(fs.existsSync(path.join(f.root, '.claude/settings.json'))).toBe(false);
  expect(JSON.parse(fs.readFileSync(path.join(f.root, '.claude/settings.local.json'), 'utf8')).permissions.allow.length).toBeGreaterThan(1);
});
test('workspace backup ignore policy stays tracked', () => {
  const f = fixture();
  write(path.join(f.root, '.gitignore'), '# .claude-code-hermit state is tracked here (backup: workspace mode)\n.env\n');
  write(path.join(f.root, '.worktreeinclude'), '# >>> claude-code-hermit >>>\n.claude-code-hermit/bin/hermit-run\n# <<< claude-code-hermit <<<\n');
  migrateProject(f.root);
  expect(fs.readFileSync(path.join(f.root, '.gitignore'), 'utf8')).toBe('# .hermit state is tracked here (backup: workspace mode)\n.env\n');
  expect(fs.readFileSync(path.join(f.root, '.worktreeinclude'), 'utf8')).toContain('.hermit/bin/hermitd-run');
});
test('Docker entrypoint is refreshed with backup and custom-session notice', () => {
  const f = fixture();
  write(path.join(f.root, 'docker-compose.hermit.yml'), 'services: {}');
  write(path.join(f.root, 'docker-entrypoint.hermit.sh'), 'custom entrypoint');
  const config = JSON.parse(fs.readFileSync(path.join(f.state, 'config.json'), 'utf8')); config.tmux_session_name = 'custom';
  write(path.join(f.state, 'config.json'), JSON.stringify(config));
  expect(migrateProject(f.root).join('\n')).toContain('unhealthy until');
  expect(fs.readFileSync(path.join(f.root, 'docker-entrypoint.hermit.sh.bak'), 'utf8')).toBe('custom entrypoint');
  const before = snapshot(f.root); migrateProject(f.root); expect(snapshot(f.root)).toEqual(before);
});
