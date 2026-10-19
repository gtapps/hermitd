// One-time, pre-start migration of an already moved 1.4.8 project.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readTargetState } from './lib/domain-hatch/target';
import { writeFileAtomic } from './lib/md-write';
import { sha256 } from './lib/hash';

const root = path.resolve(import.meta.dir, '..');
const verbs = ['attach', 'docker', 'pause', 'run', 'start', 'status', 'stop', 'update', 'watchdog'];
function read(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function writeChanged(file: string, content: string): void {
  if (read(file) === content) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, content);
}
function command(project: string, script: string, args: string[], input?: string): void {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
    cwd: project, input, encoding: 'utf8', env: process.env,
  });
  if (result.error || result.status !== 0) throw new Error(`${script} failed: ${result.error?.message ?? (result.stdout.trim() || result.stderr)}`);
}
export function migrateProject(project: string): string[] {
  project = fs.realpathSync(project);
  const state = path.join(project, '.hermit');
  if (!fs.existsSync(path.join(state, 'config.json'))) throw new Error('Expected .hermit/config.json after the state-directory move');
  const report: string[] = [];
  command(project, 'settings-edit.ts', [path.join(state, 'config.json'), 'migrate', 'hermitd']);

  // Old markers supply the fallback when no hatch choice was recorded.
  const local = read(path.join(project, 'CLAUDE.local.md')) ?? '';
  const fallback = local.includes('<!-- claude-code-hermit:') ? 'local' : 'committed';
  const targetState = readTargetState(state, { core_scope: null, target: fallback });
  const target = targetState.target ?? targetState.target_default;
  // Rewriting existing lines preserves both normal and workspace-backup policy.
  // No ignore block is inserted, even when a file or managed marker is absent.
  for (const name of ['.gitignore', '.worktreeinclude']) {
    const file = path.join(project, name);
    const text = read(file);
    if (text !== null) writeChanged(file, text.replaceAll('.claude-code-hermit', '.hermit')
      .replaceAll('claude-code-hermit', 'hermitd').replaceAll('bin/hermit-run', 'bin/hermitd-run'));
  }
  const memory = path.join(project, '.claude/agent-memory');
  if (fs.existsSync(memory)) {
    for (const name of fs.readdirSync(memory).filter(name => name.startsWith('claude-code-hermit-'))) {
      const dest = path.join(memory, name.replace('claude-code-hermit-', 'hermitd-'));
      if (fs.existsSync(dest)) throw new Error(`Agent memory destination already exists: ${dest}`);
      fs.renameSync(path.join(memory, name), dest);
    }
  }
  const ledger = read(path.join(state, 'state/hypotheses.jsonl'));
  for (const line of ledger?.split('\n').filter(Boolean) ?? []) {
    const row = JSON.parse(line);
    if (row.state === 'pending' && typeof row.cmd === 'string' && /\.claude-code-hermit|hermit-run/.test(row.cmd)) {
      // Report identifiers only: commands can contain private argument values.
      report.push(`Pending later ${row.id ?? '(no id)'}: re-arm these commands with the new paths.`);
    }
  }

  const manifestFile = path.join(state, 'state/template-manifest.json');
  const rawManifest = read(manifestFile);
  const manifest = rawManifest === null ? { version: 1, files: {} } : JSON.parse(rawManifest);
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw new Error('Invalid template manifest');
  const managed = verbs.map(verb => ({
    key: `bin/hermitd-${verb}`, oldKey: `bin/hermit-${verb}`,
    source: path.join(root, 'state-templates/bin', `hermitd-${verb}`),
    dest: path.join(state, 'bin', `hermitd-${verb}`), old: path.join(state, 'bin', `hermit-${verb}`),
  }));
  if (fs.existsSync(path.join(project, 'docker-compose.hermit.yml'))) {
    managed.push({ key: 'docker/docker-entrypoint.hermit.sh', oldKey: 'docker/docker-entrypoint.hermit.sh',
      source: path.join(root, 'state-templates/docker/docker-entrypoint.hermit.sh.template'),
      dest: path.join(project, 'docker-entrypoint.hermit.sh'), old: path.join(project, 'docker-entrypoint.hermit.sh') });
    const config = JSON.parse(fs.readFileSync(path.join(state, 'config.json'), 'utf8'));
    if (config.tmux_session_name && config.tmux_session_name !== `hermit-${path.basename(project)}`) {
      report.push('Custom tmux_session_name: the container will show unhealthy until hermit-evolve runs.');
    }
  }
  const entries: { key: string; file: string }[] = [];
  const version = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin/plugin.json'), 'utf8')).version;
  for (const file of managed) {
    const content = fs.readFileSync(file.source, 'utf8');
    const previous = read(file.old);
    if (previous !== null && previous !== content && sha256(previous) !== manifest.files[file.oldKey]?.sha256) {
      const backup = file.old + '.bak';
      const existing = read(backup);
      if (existing !== null && existing !== previous) throw new Error(`Refusing to replace existing backup: ${backup}`);
      writeChanged(backup, previous);
      report.push(`Customized file saved: ${backup}`);
    }
    writeChanged(file.dest, content);
    if ((fs.statSync(file.dest).mode & 0o777) !== 0o755) fs.chmodSync(file.dest, 0o755);
    if (file.old !== file.dest && previous !== null) fs.unlinkSync(file.old);
    const pristine = path.join(state, 'state/pristine', file.key);
    if (manifest.files[file.key]?.sha256 !== sha256(content) || manifest.files[file.key]?.plugin_version !== version || read(pristine) !== content) {
      entries.push({ key: file.key, file: file.source });
    }
  }
  // The existing seeder owns hashes and pristine writes; do not invoke it when
  // already seeded because it deliberately rewrites its manifest every time.
  if (entries.length) command(project, 'manifest-seed.ts', [state], JSON.stringify({ plugin_version: version, entries }));
  const seeded = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  for (const file of managed) {
    if (file.oldKey === file.key) continue;
    delete seeded.files[file.oldKey];
    const oldPristine = path.join(state, 'state/pristine', file.oldKey);
    if (fs.existsSync(oldPristine)) fs.unlinkSync(oldPristine);
  }
  writeChanged(manifestFile, JSON.stringify(seeded, null, 2) + '\n');
  // Seeded deny/ask rules are operator-owned and never re-applied by sync, so
  // follow the state-directory move here or they stop protecting anything.
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = path.join(project, '.claude', name);
    const text = read(file);
    if (text === null) continue;
    const settings = JSON.parse(text);
    let changed = false;
    for (const key of ['deny', 'ask']) {
      const rules = settings.permissions?.[key];
      if (!Array.isArray(rules)) continue;
      settings.permissions[key] = rules.map((rule: unknown) => {
        if (typeof rule !== 'string' || !rule.includes('.claude-code-hermit/')) return rule;
        changed = true;
        return rule.replaceAll('.claude-code-hermit/', '.hermit/');
      });
    }
    if (changed) writeChanged(file, JSON.stringify(settings, null, 2) + '\n');
  }
  const settingsFile = target === 'local' ? '.claude/settings.local.json' : '.claude/settings.json';
  command(project, 'apply-settings.ts', [path.join(project, settingsFile), 'permissions-sync']);
  return report;
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: migrate-from-claude-code-hermit.ts <project-root>');
    for (const line of migrateProject(process.argv[2])) console.log(line);
    console.log('Project migration complete.');
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
