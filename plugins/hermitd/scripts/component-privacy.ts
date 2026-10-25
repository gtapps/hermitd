import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readHookInput, OVERSIZE } from './lib/hook-input';
import { hermitDir } from './lib/cc-compat';
import { acquireLockWithWait, releaseLock } from './lib/lockfile';
import { readJson } from './lib/cli';

/**
 * PostToolUse hook — keep a hermit-created skill or agent private to this
 * install when the operator chose gitignored hatch outputs.
 *
 * The always-on hermit sometimes writes `.claude/skills/<name>/SKILL.md` or
 * `.claude/agents/<name>.md` directly (routine-bound authoring, or a conversational
 * "make me a skill" request) with no proposal in between. In a `hatch_target:
 * local` project those files are ordinary project files: git would track them,
 * and the next commit ships them to every clone. This hook excludes the path
 * via `$GIT_COMMON_DIR/info/exclude` — never `.gitignore`, which is itself
 * tracked and would leak the private skill's name to every clone.
 *
 * Safety invariant: a component git ALREADY tracks anything under is never
 * touched. This is what protects an operator's own hand-authored skills even if
 * HERMIT_MANAGED leaks into a session by inheritance — only a component with no
 * tracked file in it can ever be privatized.
 *
 * Scoped to the managed always-on session only (HERMIT_MANAGED=1); an
 * operator's own terminal session in the same project never privatizes.
 * `hatch_target: committed` projects, non-git projects, and non-Edit/Write
 * tool calls are all a silent no-op. Fails open on every error.
 */

const COMPONENT_RE = /^\.claude\/(skills\/[^/]+\/.+|agents\/[^/]+\.md)$/;
const LOCK_WAIT_MS = 1000;
const LOCK_STALE_MS = 10_000;

/** Both refs in one spawn: `git rev-parse` prints one line per flag, in argument order. */
function gitRefs(cwd: string): { commonDir: string; topLevel: string } | null {
  try {
    const [commonDir, topLevel] = execFileSync(
      'git', ['rev-parse', '--git-common-dir', '--show-toplevel'], { cwd, encoding: 'utf-8' },
    ).trim().split('\n');
    return commonDir && topLevel ? { commonDir, topLevel } : null;
  } catch {
    return null;
  }
}

/**
 * Does git already track anything under this pathspec?
 *
 * Asked about the path that will be EXCLUDED, not the path that was written: a
 * skill excludes its whole directory, so a hermit adding `reference.md` to the
 * operator's own tracked `.claude/skills/commit/` would otherwise privatize the
 * operator's skill wholesale — and git then refuses their next `git add` inside
 * it. An unreadable index counts as tracked; never privatize on a guess.
 */
function hasTrackedFiles(cwd: string, pathspec: string): boolean {
  try {
    return execFileSync('git', ['ls-files', '-z', '--', pathspec], { cwd, encoding: 'utf-8' }).length > 0;
  } catch {
    return true;
  }
}

/** The path to privatize: the skill's containing dir, or the exact agent file. */
function componentPath(rel: string): string {
  const m = rel.match(COMPONENT_RE);
  if (!m) return rel;
  if (rel.startsWith('.claude/skills/')) {
    const name = rel.split('/')[2];
    return `.claude/skills/${name}/`;
  }
  return rel; // agent file — already the full path
}

function appendExcludeLine(commonDir: string, line: string): void {
  const excludePath = path.join(commonDir, 'info', 'exclude');
  const lockPath = `${excludePath}.lock`;
  // Before acquireLock, which creates its own file inside info/ — a repo built
  // from a stripped init template has no info/ at all, and the lock would then
  // throw ENOENT before any mkdir further down could help.
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  // Hooks run concurrently, and a skill is usually written exactly once, so a
  // contended lock must not drop the only chance to privatize it: wait, then
  // append anyway (an O_APPEND of one line, at worst a duplicate rule).
  const held = acquireLockWithWait(lockPath, LOCK_WAIT_MS, LOCK_STALE_MS);
  try {
    const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf-8') : '';
    const lines = existing.split('\n').map(l => l.trim());
    if (lines.includes(line)) return; // already present — idempotent
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(excludePath, `${sep}${line}\n`);
  } finally {
    if (held) releaseLock(lockPath);
  }
}

async function main() {
  const event = await readHookInput();
  if (!event || event === OVERSIZE) process.exit(0);

  if (event.tool_name !== 'Edit' && event.tool_name !== 'Write') process.exit(0);
  if (process.env.HERMIT_MANAGED !== '1') process.exit(0);

  const filePath: string = event.tool_input?.file_path || event.tool_input?.path || '';
  if (!filePath) process.exit(0);

  // Cheap string filter before any filesystem walk-up: this hook fires on
  // EVERY Edit/Write in the managed session, and the overwhelming majority
  // never touch a skill/agent path. Reject those without calling hermitDir()
  // (fs.existsSync walk, up to 8 levels). Any path COMPONENT_RE can later
  // match must contain one of these substrings, so this can't false-negative.
  if (!/(^|[/\\])\.claude[/\\](skills|agents)[/\\]/.test(filePath)) process.exit(0);

  const hermit = hermitDir();
  const projectRoot = path.dirname(hermit);
  const absPath = path.resolve(projectRoot, filePath);
  const rel = path.relative(projectRoot, absPath).split(path.sep).join('/');
  if (!COMPONENT_RE.test(rel)) process.exit(0);

  const hatchOptions = readJson(path.join(hermit, 'state', 'hatch-options.json'));
  if (hatchOptions?.target !== 'local') process.exit(0);

  const refs = gitRefs(projectRoot);
  if (!refs) process.exit(0);
  const absCommonDir = path.isAbsolute(refs.commonDir) ? refs.commonDir : path.resolve(projectRoot, refs.commonDir);

  const component = componentPath(rel);
  if (hasTrackedFiles(projectRoot, component)) process.exit(0); // safety invariant

  // An info/exclude pattern carrying a slash is anchored at the REPO root, not
  // at the hermit's project root. A hermit hatched into a subdirectory of a
  // larger repo therefore needs the subdirectory prefix, or the rule silently
  // matches nothing and the component is committed anyway.
  const prefix = path.relative(refs.topLevel, projectRoot).split(path.sep).join('/');
  if (prefix.startsWith('..')) process.exit(0); // project root outside the repo — nothing sound to write

  appendExcludeLine(absCommonDir, prefix ? `${prefix}/${component}` : component);
  process.exit(0);
}

main().catch(() => process.exit(0));
