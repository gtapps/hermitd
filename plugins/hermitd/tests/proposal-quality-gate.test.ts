// proposal.ts quality-gate — the single decider for the post-implementation
// cleanup pass.
//
// The regression this file exists for is the first test below: before the verb,
// the rubric lived as prose in two places and the dispatched-subagent copy had
// no bookkeeping-path filter, so an implementation whose only diff was
// `state/runtime.json` ran /simplify on one path and skipped on the other.

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { decide } from '../scripts/lib/proposals/quality-gate';
import { runScript, runProposal } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-qgate-');
afterAll(cleanup);

/** A project dir with `.hermit/config.json` at the given tier. */
function projectAt(tier: string | null): { root: string; stateDir: string } {
  const root = freshDir();
  const stateDir = path.join(root, '.hermit');
  fs.mkdirSync(stateDir, { recursive: true });
  const cfg: Record<string, unknown> = { agent_name: 'Test' };
  if (tier !== null) cfg.quality_gate = { tier };
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(cfg, null, 2));
  return { root, stateDir };
}

function proposalAt(root: string, category: string): string {
  const dir = path.join(root, '.hermit', 'proposals');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'PROP-001-test-000000.md');
  fs.writeFileSync(file, `---\nid: PROP-001-test-000000\ntitle: "test"\nstatus: accepted\ncategory: ${category}\n---\n# Body\n`);
  return file;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, stdio: 'ignore' });
}

// ---------------------------------------------------------------- the bug

test('balanced: a diff of only state bookkeeping does NOT run cleanup', () => {
  const { root, stateDir } = projectAt('balanced');
  const v = decide(stateDir, undefined, ['.hermit/state/runtime.json'], root);
  expect(v.status).toBe('skip');
  expect(v.reason).toBe('bookkeeping_only');
  expect(v.detail).toContain('session bookkeeping');
  expect(v.focus_files).toEqual([]);
});

// ------------------------------------------------------- tier resolution

describe('tier resolution', () => {
  test('budget never runs cleanup, even with code changed', () => {
    const { root, stateDir } = projectAt('budget');
    const v = decide(stateDir, undefined, ['scripts/thing.ts'], root);
    expect(v).toMatchObject({ tier: 'budget', status: 'skip' });
  });

  test('quality always runs cleanup and passes focus files through', () => {
    const { root, stateDir } = projectAt('quality');
    const v = decide(stateDir, undefined, ['README.md'], root);
    expect(v).toMatchObject({ tier: 'quality', status: 'run' });
    expect(v.focus_files).toEqual(['README.md']);
  });

  test('a missing quality_gate object resolves to budget', () => {
    const { root, stateDir } = projectAt(null);
    expect(decide(stateDir, undefined, ['scripts/a.ts'], root).tier).toBe('budget');
  });

  test('a tier outside the enum resolves to budget', () => {
    const { root, stateDir } = projectAt('agressive');
    expect(decide(stateDir, undefined, ['scripts/a.ts'], root).tier).toBe('budget');
  });

  test('an unreadable config resolves to budget rather than throwing', () => {
    const root = freshDir();
    const stateDir = path.join(root, '.hermit');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{ not json');
    expect(decide(stateDir, undefined, ['scripts/a.ts'], root).tier).toBe('budget');
  });
});

// ------------------------------------------------- bookkeeping exclusions

describe('bookkeeping exclusions (each dropped individually)', () => {
  const EXCLUDED = [
    '.hermit/state/runtime.json',
    '.hermit/state/runtime.json',
    '.hermit/state/monitors.runtime.json',
    '.hermit/state/state-summary.md',
    '.hermit/state/proposal-metrics.jsonl',
    '.hermit/HEARTBEAT.md',
    '.hermit/proposals/PROP-042-thing-101112.md',
  ];

  for (const p of EXCLUDED) {
    test(`drops ${p}`, () => {
      const { root, stateDir } = projectAt('balanced');
      expect(decide(stateDir, undefined, [p], root).status).toBe('skip');
    });
  }

  test('an excluded path alongside a code change still runs cleanup', () => {
    const { root, stateDir } = projectAt('balanced');
    const v = decide(stateDir, undefined, ['.hermit/state/runtime.json', 'scripts/x.ts'], root);
    expect(v.status).toBe('run');
    expect(v.focus_files).toEqual(['scripts/x.ts']);
  });

  test('a state .jsonl outside the hermit dir is NOT treated as bookkeeping', () => {
    const { root, stateDir } = projectAt('balanced');
    // The pattern is anchored on `state/<name>.jsonl` — a bare data file elsewhere
    // is a real change, and silently dropping it would be a false SKIP.
    expect(decide(stateDir, undefined, ['fixtures/sample.jsonl'], root).status).toBe('skip');
    expect(decide(stateDir, undefined, ['fixtures/state/sample.jsonl'], root).status).toBe('skip');
  });
});

// ------------------------------------------------------ balanced rubric

describe('balanced classification', () => {
  const cases: Array<[string, string, 'run' | 'skip']> = [
    ['code — ts', 'scripts/a.ts', 'run'],
    ['code — sh', 'bin/a.sh', 'run'],
    ['code — py', 'tools/a.py', 'run'],
    ['code — go', 'cmd/a.go', 'run'],
    ['code — rs', 'src/a.rs', 'run'],
    ['code — js', 'web/a.js', 'run'],
    ['instruction — SKILL.md', 'skills/foo/SKILL.md', 'run'],
    ['instruction — agents', 'agents/reviewer.md', 'run'],
    ['docs — README', 'README.md', 'skip'],
    ['docs — CHANGELOG', 'CHANGELOG.md', 'skip'],
    ['docs — docs tree', 'docs/security.md', 'skip'],
    ['docs — plain md', 'notes/thinking.md', 'skip'],
    ['other — gitignore', '.gitignore', 'skip'],
    ['other — txt', 'fixture.txt', 'skip'],
  ];

  for (const [label, file, expected] of cases) {
    test(`${label} → ${expected}`, () => {
      const { root, stateDir } = projectAt('balanced');
      expect(decide(stateDir, undefined, [file], root).status).toBe(expected);
    });
  }

  test('an empty candidate set skips', () => {
    const { root, stateDir } = projectAt('balanced');
    const v = decide(stateDir, undefined, [], root);
    expect(v.status).toBe('skip');
    expect(v.reason).toBe('no_files_changed');
  });

  test('a path containing spaces is classified by extension, not mangled', () => {
    const { root, stateDir } = projectAt('balanced');
    expect(decide(stateDir, undefined, ['my scripts/some file.ts'], root).status).toBe('run');
  });

  test('category is recorded in the detail but does not decide', () => {
    const { root, stateDir } = projectAt('balanced');
    const prop = proposalAt(root, 'constraint');
    // `constraint` used to "lean SKIP" as a category prior; observed change wins.
    const v = decide(stateDir, prop, ['scripts/a.ts'], root);
    expect(v.status).toBe('run');
    expect(v.detail).toContain('constraint');
  });

  test('a missing proposal file does not break the verdict', () => {
    const { root, stateDir } = projectAt('balanced');
    const v = decide(stateDir, path.join(root, 'nope.md'), ['scripts/a.ts'], root);
    expect(v.status).toBe('run');
  });
});

// ------------------------------------------- structured config, via git

describe('structured config changes (needs a real diff)', () => {
  function gitProjectAt(tier: string): { root: string; stateDir: string } {
    const { root, stateDir } = projectAt(tier);
    git(root, 'init', '-q');
    fs.writeFileSync(path.join(root, 'conf.json'), JSON.stringify({ version: '1.0.0', retries: 3 }, null, 2) + '\n');
    fs.writeFileSync(path.join(root, 'doc.md'), 'hello\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
    return { root, stateDir };
  }

  test('a value-only JSON change skips', () => {
    const { root, stateDir } = gitProjectAt('balanced');
    fs.writeFileSync(path.join(root, 'conf.json'), JSON.stringify({ version: '1.0.1', retries: 3 }, null, 2) + '\n');
    const v = decide(stateDir, undefined, ['conf.json'], root);
    expect(v.status).toBe('skip');
  });

  test('a new key in JSON is structural and runs', () => {
    const { root, stateDir } = gitProjectAt('balanced');
    fs.writeFileSync(path.join(root, 'conf.json'), JSON.stringify({ version: '1.0.0', retries: 3, timeout: 9 }, null, 2) + '\n');
    const v = decide(stateDir, undefined, ['conf.json'], root);
    expect(v.status).toBe('run');
    expect(v.reason).toBe('structural_change');
  });

  test('outside git a structured file cannot be proven value-only, so it runs', () => {
    const { root, stateDir } = projectAt('balanced');
    expect(decide(stateDir, undefined, ['conf.json'], root).status).toBe('run');
  });

  test('a project below the git root still resolves the repo-root-relative pathspec', () => {
    const repo = freshDir();
    git(repo, 'init', '-q');
    const project = path.join(repo, 'sub');
    const stateDir = path.join(project, '.hermit');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ quality_gate: { tier: 'balanced' } }));
    fs.writeFileSync(path.join(project, 'conf.json'), JSON.stringify({ version: '1.0.0' }, null, 2) + '\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');

    fs.writeFileSync(path.join(project, 'conf.json'), JSON.stringify({ version: '1.0.1' }, null, 2) + '\n');
    // `sub/conf.json` is the frame git emits. Read as a pathspec relative to
    // `project` it would match nothing, the diff would come back empty, and a
    // plain version bump would be misclassified as structural.
    expect(decide(stateDir, undefined, ['sub/conf.json'], project).status).toBe('skip');
  });

  test('the working-tree diff is used when no files are supplied', () => {
    const { root, stateDir } = gitProjectAt('balanced');
    fs.writeFileSync(path.join(root, 'app.ts'), 'export const x = 1;\n');
    const v = decide(stateDir, undefined, null, root);
    expect(v.status).toBe('run');
    expect(v.focus_files).toContain('app.ts');
  });

  test('supplied files win over an unrelated dirty worktree', () => {
    const { root, stateDir } = gitProjectAt('balanced');
    fs.writeFileSync(path.join(root, 'unrelated.ts'), 'export const y = 2;\n');
    const v = decide(stateDir, undefined, ['doc.md'], root);
    expect(v.status).toBe('skip');
    expect(v.focus_files).toEqual([]);
  });

  test('an untracked new file counts as a change', () => {
    const { root, stateDir } = gitProjectAt('balanced');
    fs.writeFileSync(path.join(root, 'brand-new.ts'), 'export const z = 3;\n');
    const v = decide(stateDir, undefined, null, root);
    expect(v.focus_files).toContain('brand-new.ts');
  });

  test('a clean git worktree skips', () => {
    const { root, stateDir } = gitProjectAt('balanced');
    const v = decide(stateDir, undefined, null, root);
    expect(v.status).toBe('skip');
  });

  test('outside git with no supplied files reports missing evidence, never a crash', () => {
    const { root, stateDir } = projectAt('balanced');
    const v = decide(stateDir, undefined, null, root);
    expect(v.status).toBe('skip');
    expect(v.reason).toBe('no_file_evidence');
  });
});

// -------------------------------------------------------- CLI contract

describe('CLI contract', () => {
  test('emits one JSON line and exits 0', async () => {
    const { root, stateDir } = projectAt('balanced');
    const r = await runProposal(stateDir, ['quality-gate', '--files-json', JSON.stringify(['scripts/a.ts'])], { cwd: root });
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ tier: 'balanced', status: 'run' });
  });

  test('a missing state dir is a usage error, matching every other verb', async () => {
    const r = await runScript('proposal.ts', { args: ['quality-gate'] });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe('{"error":"usage"}\n');
  });

  test('malformed --files-json falls back rather than failing the call', async () => {
    const { root, stateDir } = projectAt('balanced');
    const r = await runProposal(stateDir, ['quality-gate', '--files-json', '{not json'], { cwd: root });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.trim()).status).toBe('skip');
  });
});

// ------------------------------------------------------ single ownership

describe('proposal-act delegates the decision (no second copy of the rubric)', () => {
  const skill = ['SKILL.md', 'branches.md']
    .map((f) => fs.readFileSync(path.join(import.meta.dir, '..', 'skills', 'proposal-act', f), 'utf8'))
    .join('\n');

  test('all three implementation paths route through the verb', () => {
    // dispatched subagent, in-main e.5, and the queued queued record note.
    expect(skill).toContain('- `proposal-quality-gate`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts quality-gate .hermit`');
    const dispatch = skill.slice(skill.indexOf('**Dispatch (falsification gate'), skill.indexOf('**After the subagent returns**'));
    const inline = skill.slice(skill.indexOf('e.5. **Quality gate.**'), skill.indexOf('e.6. **Verification gate**'));
    const queued = skill.slice(skill.indexOf('## Queue a task'));
    for (const branch of [dispatch, inline, queued]) expect(branch).toContain('`proposal-quality-gate` (Commands)');
    expect(dispatch).toContain('Copy the absolute command');
    expect(queued).toContain('into the note as an absolute command');
  });

  test('the rubric is not restated in prose anywhere in the skill', () => {
    // These phrases each belonged to one of the two prose copies. Their return
    // would mean a path started deciding for itself again.
    for (const phrase of ['lean SKIP', 'lean RUN', 'Category prior', 'bias toward RUN', 'Resolved tier']) {
      expect(skill).not.toContain(phrase);
    }
  });

  test('the bookkeeping exclusion list is not duplicated into the skill', () => {
    // The script owns it; a second list in prose is exactly the drift this removes.
    expect(skill).not.toContain('monitors.runtime.json');
    expect(skill).not.toContain('tasks-snapshot.md');
  });
});
