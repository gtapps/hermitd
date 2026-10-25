import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = path.resolve(import.meta.dir, '../scripts/evolve-plan.ts');
const subjects = { subjects: [
  { id: 'brief', terms: ['morning-brief'], kind: 'routine_id', to: 'hermitd:morning-brief' },
  { id: 'boot', terms: ['ha-boot'], kind: 'name' },
  { id: 'reflect', terms: ['reflect'], kind: 'routine_id', to: 'hermitd:reflect' },
] };
function fixture(git: boolean, body: (root: string, write: (file: string, text: string | Buffer) => void) => void) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'leftover-check-')));
  const write = (file: string, text: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  // The renamed core routines exist, so their renames are live.
  write('.hermit/config.json', JSON.stringify({ routines: [{ id: 'hermitd:morning-brief' }, { id: 'hermitd:reflect' }] }));
  if (git) Bun.spawnSync(['git', 'init', '-q', root]);
  try { body(root, write); } finally { fs.rmSync(root, { recursive: true }); }
}
const planArgs = ['--plugin-list-json=plugins.json'];
// AGENT_DIR is the sanctioned state-dir pin for tests; plan mode gets an empty plugin list unless the test wrote one.
function run(root: string, input = JSON.stringify(subjects), args = ['leftover-check'], agentDir = path.join(root, '.hermit')) {
  if (args === planArgs && !fs.existsSync(path.join(root, 'plugins.json'))) fs.writeFileSync(path.join(root, 'plugins.json'), '[]');
  return Bun.spawnSync(['bun', script, '.hermit', ...args], {
    cwd: root, stdin: Buffer.from(input), env: { ...process.env, CLAUDE_PLUGIN_ROOT: path.resolve(import.meta.dir, '..'), AGENT_DIR: agentDir },
  });
}
const runSaved = (root: string) => run(root, '', ['leftover-check', '--saved']);
const plan = (root: string) => run(root, '', planArgs);
function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else result[path.relative(root, abs)] = entry.isSymbolicLink() ? fs.readlinkSync(abs) : fs.readFileSync(abs).toString('base64');
    }
  }
  walk(root);
  return result;
}
for (const git of [true, false]) test(`discovery and exclusions, git=${git}`, () => fixture(git, (root, write) => {
  write('.claude/skills/house/SKILL.md', 'routine morning-brief\nhermitd:morning-brief\nmorning-briefing\nreflect\nRoutine reflect\nhermitd:reflect');
  write('CLAUDE.md', '/ha-boot');
  write('CLAUDE.local.md', 'ha-boot');
  write('.claude/CLAUDE.md', 'ha-boot');
  write('.claude/rules/house.md', 'ha-boot');
  write('.claude/settings.local.json', '{"hook":"ha-boot"}');
  for (const file of ['OPERATOR.md', 'HEARTBEAT.md', 'knowledge-schema.md', 'dashboard-render.ts']) write('.hermit/' + file, 'ha-boot');
  write('custom/.claude-plugin/plugin.json', '{}');
  for (const folder of ['skills', 'commands', 'agents', 'scripts']) write(`custom/${folder}/x`, 'ha-boot');
  write('checks/gate.sh', 'morning-brief');
  fs.chmodSync(path.join(root, 'checks/gate.sh'), 0o755);
  write('checks/monitor.ts', 'ha-boot');
  write('.hermit/config.json', JSON.stringify({ routines: [{ id: 'hermitd:morning-brief', precheck: 'checks/gate.sh' }, { id: 'hermitd:reflect', precheck: 'always' }], monitors: [{ command: 'bun "checks/monitor.ts"' }] }));
  for (const file of ['.claude/worktrees/copy/CLAUDE.md', '.claude/skills/node_modules/x', '.claude/skills/x.bak', '.claude/skills/x.new', '.claude/skills/x.orig', '.claude/skills/x~', '.claude/skills/x.2026-10-23.md']) write(file, 'ha-boot');
  write('.claude/skills/nested/.git/HEAD', 'ref: refs/heads/main');
  write('.claude/skills/nested/x', 'ha-boot');
  write('.claude/skills/binary', Buffer.from('ha-boot\0'));
  write('.claude/skills/huge', 'ha-boot'.padEnd(1024 * 1024 + 1, 'x'));
  fs.symlinkSync('/etc/hosts', path.join(root, '.claude/skills/escape'));
  const before = snapshot(root);
  const result = run(root);
  expect(result.exitCode).toBe(0);
  const out = JSON.parse(result.stdout.toString());
  expect(out.git).toBe(git);
  expect(out.counts).toEqual({ brief: 2, boot: 10, reflect: 1 });
  expect(out.candidates.some((c: any) => c.file.startsWith('custom/'))).toBe(false);
  expect(out.context_filtered.reflect).toBe(1);
  expect(out.candidates.filter((c: any) => c.subject === 'brief').map((c: any) => c.file).sort()).toEqual(['.claude/skills/house/SKILL.md', 'checks/gate.sh']);
  expect(out.skipped.map((s: any) => s.reason).sort()).toEqual(['binary', 'outside_project', 'oversized']);
  // The only write is the recorded input, which is not an operator file.
  const after = snapshot(root);
  expect(JSON.parse(Buffer.from(after['.hermit/state/leftover-check.json'], 'base64').toString())).toEqual({ ...subjects, declarations: [] });
  delete after['.hermit/state/leftover-check.json'];
  expect(after).toEqual(before);
}));
test('qualified skill calls and routine markers retain old-name hits', () => fixture(false, (root, write) => {
  write('CLAUDE.md', '/hermitd-homeassistant:ha-boot\nroutine:morning-brief\n[hermit-routine:morning-brief]\nroutine:hermitd:morning-brief\nhermitd:reflect');
  const result = run(root);
  expect(result.exitCode).toBe(0);
  const out = JSON.parse(result.stdout.toString());
  expect(out.counts).toEqual({ brief: 2, boot: 1, reflect: 0 });
  expect(out.candidates.map((c: any) => c.line)).toEqual([1, 2, 3]);
}));
// The sibling hatches' reflect wrappers, as the routine-id migration leaves them.
const wrapperRows = [
  { id: 'hermitd-fitness:weekly-coaching-patterns', schedule: '5 9 * * 1', skill: 'hermitd:reflect --check-id weekly-coaching-patterns --check hermitd-fitness:weekly-coaching-patterns', enabled: true, precheck: '.hermit/bin/fitness-weekly-patterns-gate', precheck_timeout_s: 60 },
  { id: 'hermitd-homeassistant:ha-patterns', schedule: '5 9 * * 1', skill: 'hermitd:reflect --check-id ha-patterns --check hermitd-homeassistant:ha-analyze-patterns', enabled: true },
  { id: 'hermitd-homeassistant:ha-safety-audit', schedule: '5 9 * * 1', skill: 'hermitd:reflect --check-id ha-safety-audit --check hermitd-homeassistant:ha-safety-audit', enabled: true },
  { id: 'hermitd-homeassistant:ha-integration-health', schedule: '5 9 * * *', skill: 'hermitd:reflect --check-id ha-integration-health --check hermitd-homeassistant:ha-integration-health', enabled: true },
  { id: 'hermitd-homeassistant:ha-update-check', schedule: '5 9 * * *', skill: 'hermitd:reflect --check-id ha-update-check --check hermitd-homeassistant:ha-update-check', enabled: true },
  { id: 'hermitd-laravel-forge:forge-failed-deploys', schedule: '5 9 * * *', skill: 'hermitd:reflect --check-id forge-failed-deploys --check hermitd-laravel-forge:forge-failed-deploys', enabled: true },
];
const wrapperSubjects = { subjects: wrapperRows.map(row => ({ id: row.id.split(':')[1], terms: [row.id.split(':')[1]], kind: 'routine_id', to: row.id })) };
const perSubject = (n: number) => Object.fromEntries(wrapperSubjects.subjects.map(s => [s.id, n]));
test('reflect wrapper --check-id values in config.json are never counted, filtered or saved', () => fixture(false, (root, write) => {
  write('.hermit/config.json', JSON.stringify({ routines: wrapperRows }, null, 2));
  const out = JSON.parse(run(root, JSON.stringify(wrapperSubjects)).stdout.toString());
  expect(out.counts).toEqual(perSubject(0));
  expect(out.candidates).toEqual([]);
  expect(out.context_filtered).toEqual(perSubject(0));
  expect(out.context_filtered_examples).toEqual(Object.fromEntries(wrapperSubjects.subjects.map(s => [s.id, []])));
  expect(fs.existsSync(path.join(root, '.hermit', 'state', 'leftover-check.json'))).toBe(false);
}));
test('--check-id values outside config.json count', () => fixture(false, (root, write) => {
  write('.hermit/config.json', JSON.stringify({ routines: wrapperRows.map(row => ({ id: row.id })) }));
  write('CLAUDE.md', 'hermitd:reflect --check-id weekly-coaching-patterns\nhermitd:reflect --check-id=ha-patterns');
  write('.claude/settings.json', '{"hooks":"bun audit.ts --check-id ha-safety-audit"}');
  const out = JSON.parse(run(root, JSON.stringify(wrapperSubjects)).stdout.toString());
  expect(out.counts).toEqual({ ...perSubject(0), 'weekly-coaching-patterns': 1, 'ha-patterns': 1, 'ha-safety-audit': 1 });
  expect(out.context_filtered).toEqual(perSubject(0));
}));
test('a pattern rename expands per old id, skips renames with no new routine, and never flags the new form', () => fixture(false, (root, write) => {
  write('.hermit/config.json', JSON.stringify({ routines: [{ id: 'hermitd-fitness:morning-brief' }, { id: 'hermitd-fitness:evening-brief' }] }));
  write('CLAUDE.md', 'Run routine morning-brief daily\nhermitd-fitness:morning-brief is the new id\nroutine evening-brief\n/hermitd-fitness:evening-brief');
  const terms = ['morning-brief', 'evening-brief'];
  const grouped = { subjects: ['hermitd-fitness', 'hermitd-homeassistant'].map(plugin => ({ id: plugin, terms, kind: 'routine_id', to: `${plugin}:<id>` })) };
  const expanded = { subjects: grouped.subjects.flatMap(s => terms.map(term => ({ id: `${s.id}/${term}`, terms: [term], kind: 'routine_id', to: s.to.replace('<id>', term) }))) };
  const [fromGroups, fromExpanded] = [grouped, expanded].map(input => JSON.parse(run(root, JSON.stringify(input)).stdout.toString()));
  expect(fromGroups).toEqual(fromExpanded);
  expect(fromGroups.counts).toEqual({ 'hermitd-fitness/morning-brief': 1, 'hermitd-fitness/evening-brief': 1 });
  expect(fromGroups.candidates.map((c: any) => c.line)).toEqual([1, 3]);
  expect(fromGroups.not_live).toEqual(['hermitd-homeassistant/morning-brief', 'hermitd-homeassistant/evening-brief']);
}));
// Two sibling installs whose changelog gaps declare leftover checks.
const haBootLine = "**Leftover check:** The operator's own files may still invoke the removed skill `ha-boot`. Find those invocations, ask once before changing anything, and replace each with `/hermitd-homeassistant:ha-house-status`.";
const fitnessLine = '**Leftover check:** routine id `morning-brief` renamed to `hermitd-fitness:<id>`.';
function siblingInstalls(root: string, write: (file: string, text: string) => void) {
  const sibling = (name: string, body: string) => {
    write(`installs/${name}/.claude-plugin/plugin.json`, '{"version":"0.2.0"}');
    write(`installs/${name}/CHANGELOG.md`, `# Changelog\n\n## [0.2.0] - 2026-10-24\n\n### Upgrade Instructions\n1. Run the migration.\n\n${body}\n\n## [0.1.0] - 2026-10-01\n- first\n`);
    return { id: `${name}@hermitd`, version: '0.2.0', scope: 'local', enabled: true, installPath: path.join(root, 'installs', name), projectPath: root };
  };
  write('plugins.json', JSON.stringify([sibling('hermitd-homeassistant', haBootLine), sibling('hermitd-fitness', fitnessLine)]));
}
const coreVersion = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, '../.claude-plugin/plugin.json'), 'utf8')).version;
const stamp = (sibling: string) => JSON.stringify({ _hermit_versions: { hermitd: coreVersion, 'hermitd-homeassistant': sibling, 'hermitd-fitness': sibling },
  routines: [{ id: 'hermitd-fitness:morning-brief' }] });
const state = (root: string, file: string) => JSON.parse(fs.readFileSync(path.join(root, '.hermit/state', file), 'utf8'));
const fitnessSubjects = JSON.stringify({ subjects: [{ id: 'hermitd-fitness', terms: ['morning-brief'], kind: 'routine_id', to: 'hermitd-fitness:<id>' }] });
const fitnessConcrete = [{ id: 'hermitd-fitness/morning-brief', terms: ['morning-brief'], kind: 'routine_id', to: 'hermitd-fitness:morning-brief' }];
test('plan mode records each gap declaration verbatim, and a check pairs them with its concrete subjects for --saved', () => fixture(false, (root, write) => {
  siblingInstalls(root, write);
  write('.hermit/config.json', stamp('0.1.0'));
  write('CLAUDE.md', 'Run routine morning-brief daily');
  const planned = plan(root);
  expect(planned.exitCode).toBe(0);
  expect(JSON.parse(planned.stdout.toString()).errors).toEqual([]);
  const declarations = [
    { plugin: 'hermitd-homeassistant', version: '0.2.0', text: haBootLine },
    { plugin: 'hermitd-fitness', version: '0.2.0', text: fitnessLine },
  ];
  expect(state(root, 'leftover-declarations.json')).toEqual({ declarations });
  const fresh = JSON.parse(run(root, fitnessSubjects).stdout.toString());
  expect(fresh.counts).toEqual({ 'hermitd-fitness/morning-brief': 1 });
  expect(state(root, 'leftover-check.json')).toEqual({ subjects: fitnessConcrete, declarations });
  const saved = runSaved(root);
  expect(saved.exitCode).toBe(0);
  const out = JSON.parse(saved.stdout.toString());
  expect(out).toEqual({ ...fresh, declarations });
  expect(out.declarations[0].text).toBe(haBootLine);
}));
test('a plan with no declarations removes the record, leaving none for the next check', () => fixture(false, (root, write) => {
  siblingInstalls(root, write);
  write('.hermit/config.json', stamp('0.1.0'));
  plan(root);
  write('.hermit/config.json', stamp('0.2.0'));
  plan(root);
  expect(fs.existsSync(path.join(root, '.hermit/state/leftover-declarations.json'))).toBe(false);
  write('CLAUDE.md', 'Run routine morning-brief daily');
  run(root, fitnessSubjects);
  expect(state(root, 'leftover-check.json').declarations).toEqual([]);
}));
test('a failed declarations record does not fail the plan', () => fixture(false, (root, write) => {
  write('.hermit/config.json', JSON.stringify({ _hermit_versions: { hermitd: coreVersion } }));
  fs.mkdirSync(path.join(root, '.hermit/state/leftover-declarations.json'), { recursive: true });
  const planned = plan(root);
  expect(planned.exitCode).toBe(0);
  expect(JSON.parse(planned.stdout.toString()).errors).toEqual([]);
}));
test('a check with nothing found records nothing, so --saved reports none', () => fixture(false, root => {
  run(root);
  expect(fs.existsSync(path.join(root, '.hermit/state/leftover-check.json'))).toBe(false);
  const r = runSaved(root);
  expect(r.exitCode).toBe(0);
  expect(JSON.parse(r.stdout.toString())).toEqual({ status: 'none', reason: 'no_saved_subjects' });
}));
test('bounds and context examples', () => fixture(false, (root, write) => {
  write('CLAUDE.md', Array(220).fill('ha-boot ' + 'x'.repeat(250)).join('\n') + '\n' + Array(12).fill('reflect').join('\n'));
  const out = JSON.parse(run(root).stdout.toString());
  expect(out.counts.boot).toBe(220);
  expect(out.candidates).toHaveLength(200);
  expect(out.candidates.every((c: any) => c.text.length <= 200)).toBe(true);
  expect(out.truncated).toBe(true);
  expect(out.context_filtered.reflect).toBe(12);
  expect(out.context_filtered_examples.reflect).toHaveLength(5);
}));
for (const git of [true, false]) test(`symlinked skill directories inside the project are scanned, git=${git}`, () => fixture(git, (root, write) => {
  write('shared/house/SKILL.md', 'ha-boot');
  fs.mkdirSync(path.join(root, '.claude/skills'), { recursive: true });
  fs.symlinkSync('../../shared/house', path.join(root, '.claude/skills/house'));
  fs.symlinkSync('..', path.join(root, '.claude/skills/loop'));
  const out = JSON.parse(run(root).stdout.toString());
  expect(out.candidates.filter((c: any) => c.subject === 'boot').map((c: any) => c.file)).toEqual(['.claude/skills/house/SKILL.md']);
}));
test('gitignored files under the walked folders are skipped, ignored fixed files are not', () => fixture(true, (root, write) => {
  write('.gitignore', '.venv/\nCLAUDE.local.md\n.hermit/\n');
  write('.claude/skills/tool/.venv/lib.py', 'ha-boot');
  write('.claude/skills/tool/[x].md', 'ha-boot');
  write('CLAUDE.local.md', 'ha-boot');
  write('.hermit/OPERATOR.md', '/ha-boot');
  Bun.spawnSync(['git', '-C', root, 'add', '.claude/skills/tool/[x].md']);
  const out = JSON.parse(run(root).stdout.toString());
  const boot = out.candidates.filter((c: any) => c.subject === 'boot');
  expect(boot.map((c: any) => c.file).sort()).toEqual(['.claude/skills/tool/[x].md', '.hermit/OPERATOR.md', 'CLAUDE.local.md']);
  expect(boot.find((c: any) => c.file === '.claude/skills/tool/[x].md').tracked).toBe(true);
}));
test('a project inside a larger repository marks its tracked files as shared', () => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'leftover-check-parent-')));
  try {
    Bun.spawnSync(['git', 'init', '-q', parent]);
    fs.writeFileSync(path.join(parent, '.gitignore'), 'ignored/\n.hermit/\n');
    for (const dir of ['proj', 'ignored']) {
      fs.mkdirSync(path.join(parent, dir, '.hermit'), { recursive: true });
      fs.writeFileSync(path.join(parent, dir, '.hermit/config.json'), '{}');
      fs.writeFileSync(path.join(parent, dir, 'CLAUDE.md'), '/ha-boot');
    }
    Bun.spawnSync(['git', '-C', parent, 'add', 'proj/CLAUDE.md']);
    const tracked = JSON.parse(run(path.join(parent, 'proj')).stdout.toString());
    expect(tracked.git).toBe(true);
    expect(tracked.candidates.filter((c: any) => c.subject === 'boot')).toEqual([expect.objectContaining({ file: 'CLAUDE.md', tracked: true })]);
    const ignored = JSON.parse(run(path.join(parent, 'ignored')).stdout.toString());
    expect(ignored.git).toBe(true);
    expect(ignored.candidates.filter((c: any) => c.subject === 'boot')).toEqual([expect.objectContaining({ file: 'CLAUDE.md', tracked: false })]);
  } finally { fs.rmSync(parent, { recursive: true }); }
});
test('missing project directory fails as JSON', () => fixture(false, root => {
  const missing = path.join(root, 'nope/.hermit');
  const result = Bun.spawnSync(['bun', script, missing, 'leftover-check'], { stdin: Buffer.from(JSON.stringify(subjects)), env: { ...process.env, AGENT_DIR: missing } });
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout.toString())).toEqual({ error: 'check_failed' });
}));
test('unreadable config is reported', () => fixture(false, (root, write) => {
  write('.hermit/config.json', 'invalid');
  expect(JSON.parse(run(root).stdout.toString()).skipped).toContainEqual({ file: '.hermit/config.json', reason: 'unreadable_config' });
}));
test('invalid subjects fail', () => fixture(false, root => {
  for (const input of ['bad', '{}', '{"subjects":[{}]}']) {
    const result = run(root, input);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout.toString())).toEqual({ error: 'bad_subjects' });
  }
}));
test('--saved refuses a record without valid declarations', () => fixture(false, (root, write) => {
  const subjects = [{ id: 'reflect', terms: ['reflect'], kind: 'routine_id', to: 'hermitd:reflect' }];
  for (const record of [{ subjects }, { subjects, declarations: [{ plugin: 'hermitd' }] }]) {
    write('.hermit/state/leftover-check.json', JSON.stringify(record));
    const result = runSaved(root);
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout.toString())).toEqual({ error: 'bad_subjects' });
  }
}));
test('no-mode output is unchanged by scanner calls', () => fixture(false, (root, write) => {
  const version = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, '../.claude-plugin/plugin.json'), 'utf8')).version;
  write('.hermit/config.json', JSON.stringify({ _hermit_versions: { hermitd: version } }));
  const before = plan(root);
  run(root);
  const after = plan(root);
  expect(after.exitCode).toBe(before.exitCode);
  expect(after.stdout.toString()).toBe(before.stdout.toString());
}));
test('a foreign state dir is refused in every mode and nothing is written', () => fixture(false, (root, write) => {
  write('CLAUDE.md', '/ha-boot');
  write('plugins.json', '[]');
  const foreign = path.join(root, 'other/.hermit');
  const before = snapshot(root);
  for (const args of [['leftover-check'], ['leftover-check', '--saved']]) {
    const r = run(root, JSON.stringify(subjects), args, foreign);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout.toString())).toEqual({ error: `foreign_state_dir:${foreign}` });
  }
  const planned = run(root, '', planArgs, foreign);
  expect(planned.exitCode).toBe(0);
  expect(JSON.parse(planned.stdout.toString()).errors).toEqual([expect.objectContaining({ code: 'foreign_state_dir' })]);
  expect(snapshot(root)).toEqual(before);
}));
