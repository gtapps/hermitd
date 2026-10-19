// Contract tests for apply-settings.ts's permissions-plan / permissions-sync verbs.
//
// These two verbs are the single owner of an operator's hermit permissions: hatch
// and hermit-evolve call them instead of carrying their own copies of the list.
// The property that makes that safe is narrow removal — sync deletes only entries
// named in the sealed HERMIT_OBSOLETE registry, never anything the operator wrote.
// Spawning is intentional (see tests/helpers/run.ts): the process boundary is what
// the skills actually invoke.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript } from './helpers/run';

const SCRIPT_SRC = fs.readFileSync(
  path.join(import.meta.dir, '..', 'scripts', 'apply-settings.ts'),
  'utf-8',
);

function sealedArray(name: string): string[] {
  const m = SCRIPT_SRC.match(new RegExp(`const ${name}\\s*=\\s*(\\[[\\s\\S]*?\\]);`));
  if (!m) throw new Error(`${name} not found in apply-settings.ts`);
  return eval(m[1]) as string[];
}

const HERMIT_ALLOW = sealedArray('HERMIT_ALLOW');
const HERMIT_OBSOLETE = sealedArray('HERMIT_OBSOLETE');
const HERMIT_OBSOLETE_DENY = sealedArray('HERMIT_OBSOLETE_DENY');

const DENY_TEMPLATE = JSON.parse(
  fs.readFileSync(
    path.join(import.meta.dir, '..', 'state-templates', 'deny-patterns.json'),
    'utf-8',
  ),
) as { deny: string[]; ask: string[] };

function withTarget(fn: (target: string) => Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-settings-'));
    fs.mkdirSync(path.join(dir, '.claude'));
    try {
      await fn(path.join(dir, '.claude', 'settings.json'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

function seed(target: string, settings: unknown) {
  fs.writeFileSync(target, JSON.stringify(settings, null, 2));
}

function readAllow(target: string): string[] {
  return JSON.parse(fs.readFileSync(target, 'utf-8')).permissions.allow;
}

function readDeny(target: string): string[] {
  return JSON.parse(fs.readFileSync(target, 'utf-8')).permissions.deny;
}

async function run(target: string, op: string) {
  const r = await runScript('apply-settings.ts', { args: [target, op] });
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout.trim());
}

describe('apply-settings permissions-plan', () => {
  test('reports every canonical entry as missing for an absent target', withTarget(async (target) => {
    const plan = await run(target, 'permissions-plan');
    expect(plan.missing).toEqual(HERMIT_ALLOW);
    expect(plan.missing).toContain('Bash(bun */scripts/heartbeat.ts ack-queue*)');
    expect(plan.obsolete).toEqual([]);
    expect(plan.obsolete_deny).toEqual([]);
  }));

  test('writes nothing — the target stays absent', withTarget(async (target) => {
    await run(target, 'permissions-plan');
    expect(fs.existsSync(target)).toBe(false);
  }));

  test('reports an empty plan once the target is in sync', withTarget(async (target) => {
    seed(target, { permissions: { allow: HERMIT_ALLOW } });
    const plan = await run(target, 'permissions-plan');
    expect(plan).toEqual({ missing: [], obsolete: [], obsolete_deny: [] });
  }));

  test('names retired entries the target still carries', withTarget(async (target) => {
    const stale = HERMIT_OBSOLETE[0];
    seed(target, { permissions: { allow: [...HERMIT_ALLOW, stale] } });
    const plan = await run(target, 'permissions-plan');
    expect(plan.obsolete).toEqual([stale]);
    expect(plan.missing).toEqual([]);
  }));

  test('names retired deny entries the target still carries', withTarget(async (target) => {
    seed(target, { permissions: { allow: HERMIT_ALLOW, deny: [...HERMIT_OBSOLETE_DENY, 'Bash(*PASSWORD*)'] } });
    const plan = await run(target, 'permissions-plan');
    expect(plan.obsolete_deny).toEqual(HERMIT_OBSOLETE_DENY);
    expect(plan.obsolete).toEqual([]);
  }));
});

describe('apply-settings permissions-sync', () => {
  test('adds every missing canonical entry', withTarget(async (target) => {
    seed(target, {});
    await run(target, 'permissions-sync');
    expect(readAllow(target)).toEqual(HERMIT_ALLOW);
  }));

  test('removes retired entries and keeps the operator\'s own', withTarget(async (target) => {
    const custom = 'Bash(my-own-tool:*)';
    seed(target, { permissions: { allow: [custom, ...HERMIT_OBSOLETE] } });

    const plan = await run(target, 'permissions-sync');
    const allow = readAllow(target);

    expect(plan.obsolete).toEqual(HERMIT_OBSOLETE);
    expect(allow).toContain(custom);
    for (const stale of HERMIT_OBSOLETE) expect(allow).not.toContain(stale);
    for (const entry of HERMIT_ALLOW) expect(allow).toContain(entry);
  }));

  test('removes the retired credential-word deny globs and keeps the operator\'s own', withTarget(async (target) => {
    // The three word globs were seeded by the `deny` op in an earlier version, so a
    // hand edit is the only other way they leave an unattended hermit's settings —
    // and a strict-profile hermit cannot make one. The operator's own deny rule is
    // structurally safe: removal is filtered by the sealed registry.
    const custom = 'Bash(*PASSWORD*)';
    seed(target, { permissions: { allow: HERMIT_ALLOW, deny: [custom, ...HERMIT_OBSOLETE_DENY] } });

    const plan = await run(target, 'permissions-sync');
    const deny = readDeny(target);

    expect(plan.obsolete_deny).toEqual(HERMIT_OBSOLETE_DENY);
    expect(deny).toEqual([custom]);
  }));

  test('leaves unrelated settings untouched', withTarget(async (target) => {
    seed(target, { env: { FOO: 'bar' }, permissions: { deny: ['Bash(rm:*)'] } });
    await run(target, 'permissions-sync');

    const settings = JSON.parse(fs.readFileSync(target, 'utf-8'));
    expect(settings.env).toEqual({ FOO: 'bar' });
    expect(settings.permissions.deny).toEqual(['Bash(rm:*)']);
  }));

  test('is idempotent — a second run reports nothing to do', withTarget(async (target) => {
    seed(target, {});
    await run(target, 'permissions-sync');
    const second = await run(target, 'permissions-sync');
    expect(second).toEqual({ missing: [], obsolete: [], obsolete_deny: [] });
  }));

  test('a no-op sync does not rewrite the file', withTarget(async (target) => {
    // Deliberately hand-formatted: hermit-evolve runs sync on every upgrade, so a
    // target that is already current must come back untouched, not reformatted.
    const original = JSON.stringify({ permissions: { allow: HERMIT_ALLOW } }, null, 4);
    fs.writeFileSync(target, original);

    const plan = await run(target, 'permissions-sync');

    expect(plan).toEqual({ missing: [], obsolete: [], obsolete_deny: [] });
    expect(fs.readFileSync(target, 'utf-8')).toBe(original);
  }));

  test('refuses to overwrite a malformed target', withTarget(async (target) => {
    fs.writeFileSync(target, '{ not json');
    const r = await runScript('apply-settings.ts', { args: [target, 'permissions-sync'] });
    expect(r.exitCode).toBe(1);
    expect(fs.readFileSync(target, 'utf-8')).toBe('{ not json');
  }));
});

describe('apply-settings deny-add', () => {
  const RULE = 'Bash(*settings-edit* * env*)';

  test('appends a rule to permissions.deny, creating the file if missing', withTarget(async (target) => {
    const r = await runScript('apply-settings.ts', { args: [target, 'deny-add', RULE] });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ added: true });
    expect(readDeny(target)).toEqual([RULE]);
  }));

  test('several rules land in one call, skipping those already present', withTarget(async (target) => {
    seed(target, { permissions: { deny: [RULE] } });
    const more = 'Bash(*settings-edit* * unset env*)';
    const r = await runScript('apply-settings.ts', { args: [target, 'deny-add', RULE, more] });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ added: true });
    expect(readDeny(target)).toEqual([RULE, more]);
  }));

  test('a second call with the same rule is idempotent and does not rewrite', withTarget(async (target) => {
    seed(target, { permissions: { deny: [RULE] } });
    const original = fs.readFileSync(target, 'utf-8');
    const r = await runScript('apply-settings.ts', { args: [target, 'deny-add', RULE] });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ added: false });
    expect(fs.readFileSync(target, 'utf-8')).toBe(original);
  }));

  test('refuses a malformed target and leaves the file untouched', withTarget(async (target) => {
    fs.writeFileSync(target, '{ not json');
    const r = await runScript('apply-settings.ts', { args: [target, 'deny-add', RULE] });
    expect(r.exitCode).toBe(1);
    expect(fs.readFileSync(target, 'utf-8')).toBe('{ not json');
  }));
});

describe('sealed registries', () => {
  test('no entry is both canonical and retired', () => {
    const canonical = new Set(HERMIT_ALLOW);
    for (const stale of HERMIT_OBSOLETE) expect(canonical.has(stale)).toBe(false);
  });

  test('no deny entry is both canonical and retired', () => {
    const canonical = new Set([...DENY_TEMPLATE.deny, ...DENY_TEMPLATE.ask]);
    for (const stale of HERMIT_OBSOLETE_DENY) expect(canonical.has(stale)).toBe(false);
  });

  // The bug class this guards: a path rule that reads as "anywhere on the filesystem"
  // but isn't. Claude Code anchors an unanchored pattern at the settings source, so
  // both a bare-`*`/`**` first segment and a single leading `/` (which looks absolute
  // and is not, as the docs call out explicitly) match almost nothing and the rule
  // ships silently dead. `Edit(*/.claude/plugins/marketplaces/*)` shipped that way.
  // Reaching outside the project needs `//` (filesystem root) or `~/` (home); a rule
  // meant to stay inside the project names its first segment (`.claude/...`,
  // `*.hermit/...`) and is fine unanchored.
  const pathRuleOffenders = (rules: string[]) =>
    rules.filter((rule) => {
      const m = rule.match(/^(?:Read|Edit|Write)\((.*)\)$/);
      if (!m) return false;
      const pattern = m[1];
      if (pattern.startsWith('//') || pattern.startsWith('~/')) return false;
      if (pattern.startsWith('/')) return true;
      const firstSegment = pattern.split('/')[0];
      return firstSegment === '*' || firstSegment === '**';
    });

  test('every sealed path rule is anchored or project-scoped', () => {
    expect(pathRuleOffenders(HERMIT_ALLOW)).toEqual([]);
    expect(pathRuleOffenders(DENY_TEMPLATE.deny)).toEqual([]);
    expect(pathRuleOffenders(DENY_TEMPLATE.ask)).toEqual([]);
  });

  test('the anchoring check flags the spelling that shipped dead', () => {
    expect(pathRuleOffenders(['Edit(*/.claude/plugins/marketplaces/*)'])).toEqual([
      'Edit(*/.claude/plugins/marketplaces/*)',
    ]);
    // The other half of the same footgun: a single leading slash is settings-relative,
    // not absolute, so this spelling is just as dead.
    expect(pathRuleOffenders(['Read(/home/hermit/.claude/plugins/cache/**)'])).toEqual([
      'Read(/home/hermit/.claude/plugins/cache/**)',
    ]);
    // …and the shapes that replaced them are clean.
    expect(
      pathRuleOffenders([
        'Edit(//**/.claude/plugins/**)',
        'Read(//**/.claude/plugins/**/hermitd/**)',
      ]),
    ).toEqual([]);
  });

  // The hermit reads its own installed plugin tree on unattended paths (hermit-evolve
  // reaching skills/hermit-evolve/reference.md); without the grant that read prompts.
  // The plugin runs from either install tree, and `hermitd` names the plugin
  // slot rather than the marketplace slot so a fork's marketplace name cannot orphan it.
  test('the plugin read grant covers both install trees from the plugin slot', () => {
    expect(HERMIT_ALLOW).toContain('Read(//**/.claude/plugins/**/hermitd/**)');
    // The marketplace-slot spelling grants every sibling in the marketplace and matches
    // nothing at all once the marketplace is named something else.
    expect(HERMIT_ALLOW).not.toContain('Read(//**/plugins/cache/hermitd/**)');
  });

  // Nothing hatched by this plugin edits plugin source: not our own marketplace clone,
  // not any third-party plugin's cache. One `.claude`-scoped rule covers both trees;
  // scoping to `.claude` is what keeps an unrelated project's `plugins/cache/` out of a
  // deny an operator can only lift from a terminal. The retired single-slash spellings
  // have to leave already-hatched hermits, so they are retired, not merely respelled.
  test('plugin source is deny-listed for Edit on both trees, old spellings retired', () => {
    expect(DENY_TEMPLATE.deny).toContain('Edit(//**/.claude/plugins/**)');
    expect(DENY_TEMPLATE.deny).not.toContain('Edit(*/.claude/plugins/marketplaces/*)');
    // Unscoped: would have matched any project directory containing plugins/cache/.
    expect(DENY_TEMPLATE.deny).not.toContain('Edit(//**/plugins/cache/**)');
    expect(HERMIT_OBSOLETE_DENY).toContain('Edit(*/.claude/plugins/marketplaces/*)');
    expect(HERMIT_OBSOLETE_DENY).toContain('Write(*/.claude/plugins/marketplaces/*)');
  });

  // The narrowed metrics-writer grant. The old entry allowed writing arbitrary
  // JSON to an arbitrary path, so it has to be actively retired from existing
  // installs, not merely dropped from the canonical list.
  test('the observations writer is granted and its arbitrary-path predecessor retired', () => {
    expect(HERMIT_ALLOW).toContain('Bash(bun */scripts/observations.ts observe*)');
    expect(HERMIT_OBSOLETE).toContain('Bash(bun */scripts/append-metrics.ts*)');
  });

  // CC 2.1.246 warns at startup on a fully-literal argument following a
  // wildcard-containing one (e.g. `Bash(bun */scripts/x.ts observe *)`). The
  // space-before-verb form was retired in favor of the no-space form above.
  test('the observations writer\'s space-before-verb predecessor is retired', () => {
    expect(HERMIT_OBSOLETE).toContain('Bash(bun */scripts/observations.ts observe *)');
  });

  // Regression guard for the lint shape itself: no HERMIT_ALLOW entry should have a
  // fully-literal argument following a wildcard-containing argument, else Claude Code
  // warns at every hermit session start. Option-shaped arguments are exempt — Claude
  // Code's own check skips them, so flagging one here would fail CI on a rule it
  // accepts. Otherwise deliberately stricter than the real check (which also spares a
  // rule whose first token is wildcarded, or that ends in `:*`): a narrower shape rule
  // is cheaper to keep than a faithful port of someone else's linter.
  test('no allow rule has a literal argument trailing a wildcard-containing argument', () => {
    const offenders = HERMIT_ALLOW.filter((rule) => {
      const inner = rule.match(/^[A-Za-z]+\((.*)\)$/)?.[1];
      if (!inner) return false;
      const args = inner.split(' ');
      const firstWildcardIdx = args.findIndex((a) => a.includes('*'));
      if (firstWildcardIdx === -1) return false;
      return args
        .slice(firstWildcardIdx + 1)
        .some((a) => a.length > 0 && !a.includes('*') && !a.startsWith('-'));
    });
    expect(offenders).toEqual([]);
  });

  test('the routine Monitor subprocess is granted without widening to arbitrary shell scripts', () => {
    expect(HERMIT_ALLOW).toContain('Bash(bash */scripts/routine-monitor.sh *)');
    expect(HERMIT_ALLOW).not.toContain('Bash(bash */scripts/*.sh *)');
  });

  // The renderer must reproduce the host-substituted native monitor command
  // exactly (drift detection compares against it), so it uses absolute paths
  // and never `$PWD`.
  test('the routine monitor command uses an absolute state path without shell expansion', () => {
    const arm = fs.readFileSync(path.join(import.meta.dir, '..', 'scripts', 'lib', 'routines', 'arm.ts'), 'utf8');
    expect(arm).toContain("path.resolve(hermitDirArg)");
    expect(arm).toContain('bash "${PLUGIN_ROOT}"/scripts/monitor-supervisor.sh routines "${hermitDir}"');
    expect(arm).not.toContain('$PWD');
  });

  // finish resolves the hermit dir itself. A state-dir argument under a wildcard
  // grant would be a caller-selected root — the cross-project boundary
  // lib/cc-compat.ts exists to close.
  test('the routine finalizer is granted verb-pinned and takes no state-dir argument', () => {
    expect(HERMIT_ALLOW).toContain('Bash(bun */scripts/routines.ts finish*)');
    expect(HERMIT_ALLOW).not.toContain('Bash(bun */scripts/routines.ts*)');
    const skill = fs.readFileSync(path.join(import.meta.dir, '..', 'skills', 'hermit-routines', 'SKILL.md'), 'utf8');
    expect(skill).toContain('routines.ts finish <id> <delivery>');
    expect(skill).not.toContain('routines.ts finish <id> .hermit');
  });

  // The whole point of #689: the fire path must not log success on its own say-so.
  test('the shared execution semantics call finish, never a bare fired stamp', () => {
    const skill = fs.readFileSync(path.join(import.meta.dir, '..', 'skills', 'hermit-routines', 'SKILL.md'), 'utf8');
    expect(skill).not.toContain('log-event <id> fired');
  });
});

// Literal-path resolver grants. Their `bun */scripts/<name>.ts` twins are
// wildcarded-interpreter rules, which auto mode suspends — so on the fleet's
// default permission mode these entries are the only pre-resolved path to the
// scripts behind them. The first three are reached ad hoc mid-session; the
// `rc-server` four are reached through the rc-gate skill, which the operator
// invokes (it carries `disable-model-invocation`) — the grant is still needed,
// because the classifier judges the Bash call regardless of what reached it.
describe('literal-path hermitd-run grants', () => {
  const LITERAL_PATH = [
    'Bash(.hermit/bin/hermitd-run channel-send *)',
    'Bash(.hermit/bin/hermitd-run observations observe *)',
    'Bash(.hermit/bin/hermitd-run task note *)',
    'Bash(.hermit/bin/hermitd-run task list *)',
    'Bash(.hermit/bin/hermitd-run task block *)',
    'Bash(.hermit/bin/hermitd-run task close *)',
    'Bash(.hermit/bin/hermitd-run rc-server start)',
    'Bash(.hermit/bin/hermitd-run rc-server stop)',
    'Bash(.hermit/bin/hermitd-run rc-server status)',
    'Bash(.hermit/bin/hermitd-run rc-server gc)',
    'Bash(.hermit/bin/hermitd-run later list *)',
    'Bash(.hermit/bin/hermitd-run later cancel *)',
    'Bash(.hermit/bin/hermitd-run later verdict *)',
    'Bash(.hermit/bin/hermitd-run later deliver *)',
    'Bash(.hermit/bin/hermitd-run later due *)',
  ];

  for (const verb of ['add', 'check']) {
    test(`not sealed: later ${verb} stays with the prompt or classifier`, () => {
      expect(HERMIT_ALLOW.some((e: string) => e.includes(`hermitd-run later ${verb}`))).toBe(false);
    });
  }

  test('task resolver grants expose only the verbs the annotation offers', () => {
    expect(HERMIT_ALLOW.filter((entry: string) => entry.includes('hermitd-run task '))).toEqual([
      'Bash(.hermit/bin/hermitd-run task note *)',
      'Bash(.hermit/bin/hermitd-run task list *)',
      'Bash(.hermit/bin/hermitd-run task block *)',
      'Bash(.hermit/bin/hermitd-run task close *)',
    ]);
    expect(HERMIT_ALLOW.some((entry: string) => entry.includes('task-check.ts'))).toBe(false);
  });

  for (const entry of LITERAL_PATH) {
    test(`sealed: ${entry}`, () => {
      expect(HERMIT_ALLOW).toContain(entry);
    });
  }

  test('permissions-sync lands them in an operator target', withTarget(async (target) => {
    const r = await runScript('apply-settings.ts', { args: [target, 'permissions-sync'] });
    expect(r.exitCode).toBe(0);
    for (const entry of LITERAL_PATH) expect(readAllow(target)).toContain(entry);
  }));

  // Narrowness is why these are enumerated rather than blanket: `proposal *` would
  // also hand out create/patch/next-task/routine. `observations *` is moot today
  // (one verb) but pinning keeps the grant from widening if it ever grows one.
  test('neither proposal nor observations is granted blanket', () => {
    expect(HERMIT_ALLOW).not.toContain('Bash(.hermit/bin/hermitd-run proposal *)');
    expect(HERMIT_ALLOW).not.toContain('Bash(.hermit/bin/hermitd-run observations *)');
  });

  // rc-server's four verbs are argless, so each grant ends at the verb. A
  // blanket `rc-server *` would confer nothing extra today, but it would stop
  // being exact the moment a verb grows an argument.
  test('rc-server is granted per verb, never blanket', () => {
    expect(HERMIT_ALLOW).not.toContain('Bash(.hermit/bin/hermitd-run rc-server *)');
  });

  // channel-send is the one mode-less grant, which is safe only because
  // channel-send.ts pins its own state dir. Without that pin this entry would be a
  // second unvalidated route into an egress script — fail loudly if the pin goes
  // while the grant stays.
  test('the mode-less channel-send grant is backed by an in-script state-dir pin', () => {
    const src = fs.readFileSync(path.join(import.meta.dir, '..', 'scripts', 'channel-send.ts'), 'utf8');
    expect(src).toContain('pinStateDirOrExit');
  });
});

// spawn-session's launcher is deliberately absent. Every grant here is verb-pinned
// because a prefix over `claude --bg` would also cover the flags that come after it
// — `--dangerously-skip-permissions`, `--permission-mode bypassPermissions`,
// `--settings`, `--append-system-prompt` — and no prefix can exclude them. Leaving it
// out is what makes the prompting modes ask before any of those run. It is not a
// complete fence: on `auto` the classifier was measured permitting the
// `--dangerously-skip-permissions` form, so the sealed list is the wrong place to
// look for that guarantee, and a narrower launcher is what would provide it.
describe('the spawn-session launcher is not pre-approved', () => {
  test('no claude CLI grant is sealed', () => {
    expect(HERMIT_ALLOW.filter((e) => e.startsWith('Bash(claude'))).toEqual([]);
  });
});

// hermitd-exec.sh resolves a bare name to $PLUGIN_ROOT/scripts/<name>.ts and
// nothing else. A grant naming a script that isn't there is a dead entry that
// only shows up as a permission prompt on the call it was meant to pre-approve.
test('every hermitd-run grant names a script that exists', () => {
  const names = HERMIT_ALLOW
    .map((e) => e.match(/^Bash\(\.hermit\/bin\/hermitd-run ([a-z0-9-]+) /)?.[1])
    .filter((n): n is string => !!n);
  expect(names.length).toBeGreaterThan(0);
  for (const name of [...new Set(names)]) {
    const target = path.join(import.meta.dir, '..', 'scripts', `${name}.ts`);
    expect(fs.existsSync(target)).toBe(true);
  }
});

describe('apply-settings artifact-revoke', () => {
  test('removes Artifact and keeps operator entries and other keys', withTarget(async (target) => {
    seed(target, { permissions: { allow: ['Artifact', 'Bash(git status:*)'], deny: ['Read(secret)'] }, language: 'English' });
    expect(await run(target, 'artifact-revoke')).toEqual({ removed: true });
    expect(JSON.parse(fs.readFileSync(target, 'utf-8'))).toEqual({
      permissions: { allow: ['Bash(git status:*)'], deny: ['Read(secret)'] }, language: 'English',
    });
  }));

  test('no-op leaves file bytes unchanged', withTarget(async (target) => {
    const bytes = '{ "permissions": { "allow": ["Bash(git status:*)"] } }\n';
    fs.writeFileSync(target, bytes);
    expect(await run(target, 'artifact-revoke')).toEqual({ removed: false });
    expect(fs.readFileSync(target, 'utf-8')).toBe(bytes);
  }));

  test('missing target creates no file', withTarget(async (target) => {
    expect(await run(target, 'artifact-revoke')).toEqual({ removed: false });
    expect(fs.existsSync(target)).toBe(false);
  }));
});


describe('hermitd permission migration', () => {
  test('replaces old grants and preserves operator rules', withTarget(async (target) => {
    const custom = 'Bash(my-operator-command *)';
    const old = [
      'Bash(.claude-code-hermit/bin/hermit-run task note *)',
      'Edit(.claude-code-hermit/**)',
      'Read(//**/.claude/plugins/**/claude-code-hermit/**)',
    ];
    seed(target, { permissions: { allow: [...old, custom] } });
    await run(target, 'permissions-sync');
    expect(readAllow(target)).toEqual([custom, ...HERMIT_ALLOW]);
    expect(readAllow(target)).toContain('Bash(.hermit/bin/hermitd-run task note *)');
  }));
});


describe('apply-settings hatch target guard', () => {
  for (const [op, ...args] of [
    ['permissions-sync'], ['permissions-plan'], ['deny', 'standard'], ['deny-add', 'Bash(operator-own*)'],
  ]) {
    test(`committed stamp refuses local ${op} without writes or audit`, withTarget(async (fixture) => {
      const root = path.dirname(path.dirname(fixture));
      const state = path.join(root, '.hermit', 'state');
      fs.mkdirSync(state, { recursive: true });
      fs.writeFileSync(path.join(state, 'hatch-options.json'), JSON.stringify({ target: 'committed' }));
            const target = path.join(root, '.claude', 'settings.local.json');
      seed(target, { permissions: { allow: ['operator-owned'] } });
      const before = fs.readFileSync(target, 'utf8');
      const audit = path.join(state, 'settings-audit.jsonl');
      fs.writeFileSync(audit, 'existing audit row\n');
      const result = await runScript('apply-settings.ts', { args: [target, op!, ...args] });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        status: 'refused', reason: 'not_hatch_target', settings_file: '.claude/settings.json',
      });
      expect(fs.readFileSync(target, 'utf8')).toBe(before);
      expect(fs.readFileSync(audit, 'utf8')).toBe('existing audit row\n');
    }));
  }

  for (const stamp of ['committed', 'local', null, 'invalid'] as const) {
    for (const name of ['settings.json', 'settings.local.json']) {
      test(`${stamp ?? 'absent'} stamp with ${name}`, withTarget(async (fixture) => {
        const root = path.dirname(path.dirname(fixture));
        if (stamp !== null) {
          const state = path.join(root, '.hermit', 'state');
          fs.mkdirSync(state, { recursive: true });
          fs.writeFileSync(path.join(state, 'hatch-options.json'), JSON.stringify({ target: stamp }));
        }
                const target = path.join(root, '.claude', name);
        const result = await run(target, 'permissions-sync');
        if (stamp === 'local' && name === 'settings.json' || stamp === 'committed' && name === 'settings.local.json') {
          expect(result).toEqual({ status: 'refused', reason: 'not_hatch_target', settings_file: `.claude/${stamp === 'local' ? 'settings.local.json' : 'settings.json'}` });
          expect(fs.existsSync(target)).toBe(false);
        } else {
          expect(result.missing).toEqual(HERMIT_ALLOW);
          expect(readAllow(target)).toEqual(HERMIT_ALLOW);
        }
      }));
    }
  }
});
