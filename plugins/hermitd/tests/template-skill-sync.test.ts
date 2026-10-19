// Template-skill sync test. (bun test port of test-template-skill-sync.sh)
//
// Asserts every top-level key in state-templates/config.json.template appears
// somewhere in skills/hatch/SKILL.md. Hatch overlays operator choices onto the
// template; if a new field is added to the template but never referenced in
// hatch's text, Quick mode silently drops it from operator configs.
//
// Scope: monorepo-internal only. Verifies that two of OUR shipping files stay
// in sync with each other. Does NOT enforce a schema on operator-owned
// .hermit/config.json — operators can add custom keys, remove
// fields, or hand-edit anytime. The test never reads operator state.
//
// Usage: bun test tests/template-skill-sync.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const TEMPLATE_PATH = path.join(PLUGIN_ROOT, 'state-templates', 'config.json.template');
const SKILL_PATH = path.join(PLUGIN_ROOT, 'skills', 'hatch', 'SKILL.md');
const DENY_PATTERNS_PATH = path.join(PLUGIN_ROOT, 'state-templates', 'deny-patterns.json');
const WORKTREEINCLUDE_PATH = path.join(PLUGIN_ROOT, 'state-templates', 'WORKTREEINCLUDE-APPEND.txt');

test('template file exists', () => {
  expect(fs.existsSync(TEMPLATE_PATH)).toBe(true);
});

test('skill file exists', () => {
  expect(fs.existsSync(SKILL_PATH)).toBe(true);
});

// Extract top-level keys from the template (bash used a python3 JSON walk).
let templateKeys: string[] = [];
try {
  templateKeys = Object.keys(JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf-8')));
} catch {
  // Leave empty — the guard test below fails loud.
}

test('could parse top-level keys from template', () => {
  expect(templateKeys.length).toBeGreaterThan(0);
});

const skillContent = fs.readFileSync(SKILL_PATH, 'utf-8');

// For each top-level key, assert it appears at least once in the skill text.
// We check for the bare key name — if the skill mentions it (in the overlay
// table, in prose, in code blocks), the key is "known" to hatch.
describe('hatch SKILL.md references every template key', () => {
  for (const key of templateKeys) {
    test(`skill references key '${key}' from template`, () => {
      expect(skillContent).toContain(key);
    });
  }
});

// -------------------------------------------------------
// Nested artifacts.* keys — the top-level-key check above only asserts
// `artifacts` itself appears in hatch/SKILL.md (satisfied since it's a
// template-only field), which does NOT catch a nested key like `proposals`
// or `weekly_review` going unreferenced anywhere an operator would find it.
// -------------------------------------------------------
describe('nested artifacts.* keys are referenced in operator-facing docs', () => {
  const HERMIT_SETTINGS_PATH = path.join(PLUGIN_ROOT, 'skills', 'hermit-settings', 'SKILL.md');
  const ARTIFACTS_DOC_PATH = path.join(PLUGIN_ROOT, 'docs', 'artifacts.md');

  let artifactsKeys: string[] = [];
  try {
    const tmpl = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf-8'));
    artifactsKeys = Object.keys(tmpl.artifacts ?? {});
  } catch {
    // Leave empty — the guard test below fails loud.
  }

  test('could parse artifacts keys from template', () => {
    expect(artifactsKeys.length).toBeGreaterThan(0);
  });

  const hermitSettingsContent = fs.readFileSync(HERMIT_SETTINGS_PATH, 'utf-8');
  const artifactsDocContent = fs.readFileSync(ARTIFACTS_DOC_PATH, 'utf-8');

  for (const key of artifactsKeys) {
    test(`config.artifacts.${key} is referenced in hermit-settings/SKILL.md`, () => {
      expect(hermitSettingsContent).toContain(`artifacts.${key}`);
    });

    test(`config.artifacts.${key} is referenced in docs/artifacts.md`, () => {
      expect(artifactsDocContent).toContain(`artifacts.${key}`);
    });
  }
});

describe('channel settings stay referenced in operator skills', () => {
  const VALIDATED_CHANNEL_KEYS = [
    'allowed_users', 'passive_chats', 'isolate_chats', 'log_chats',
    'shared_chats', 'operators', 'maintainer_channel_id', 'default_chat_id', 'dm_channel_id',
  ];
  const WIZARD_CHANNEL_KEYS = [
    'allowed_users', 'isolate_chats', 'log_chats', 'shared_chats',
    'passive_chats', 'operators', 'channels.primary',
  ];
  const validator = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'validate-config.ts'), 'utf8');
  const settings = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'hermit-settings', 'SKILL.md'), 'utf8');
  const wizard = ['SKILL.md', 'references/group-enrollment.md']
    .map((f) => fs.readFileSync(path.join(PLUGIN_ROOT, 'skills', 'channel-setup', f), 'utf8')).join('\n');

  for (const key of VALIDATED_CHANNEL_KEYS) {
    test(`validator references channel key '${key}' as a quoted or dotted literal`, () => {
      expect(validator).toMatch(new RegExp(`['"]${key}['"]|\\.${key}\\b`));
    });
    // passive_chats has no hermit-settings edit path; validator and wizard checks still cover it.
    if (key !== 'passive_chats') {
      test(`hermit-settings references channel key '${key}'`, () => {
        expect(settings).toContain(key);
      });
    }
  }
  for (const key of WIZARD_CHANNEL_KEYS) {
    test(`channel-setup references wizard key '${key}'`, () => {
      expect(wizard).toContain(key);
    });
  }
});

// -------------------------------------------------------
// Deny-patterns template file referenced in hatch/SKILL.md
// -------------------------------------------------------
describe('deny-patterns template', () => {
  test('deny-patterns.json exists', () => {
    expect(fs.existsSync(DENY_PATTERNS_PATH)).toBe(true);
  });

  test('hatch/SKILL.md references deny-patterns.json', () => {
    expect(skillContent).toContain('deny-patterns.json');
  });
});

// -------------------------------------------------------
// .worktreeinclude template
// -------------------------------------------------------
describe('.worktreeinclude template', () => {
  test('WORKTREEINCLUDE-APPEND.txt exists', () => {
    expect(fs.existsSync(WORKTREEINCLUDE_PATH)).toBe(true);
  });

  test('hatch/SKILL.md references WORKTREEINCLUDE-APPEND.txt', () => {
    expect(skillContent).toContain('WORKTREEINCLUDE-APPEND.txt');
  });

  // config.json joined the allow-list once the dev hermit began reading
  // commands.* from the worktree copy. It is not an exception to the
  // safety-invariant below: state writes stay pinned to the main checkout by
  // cc-compat's pinnedRoot()/mainCheckoutStateDir(), and config.json carries no
  // credentials (channel tokens live outside it). The invariant that matters —
  // no runtime state, no session history, no ledgers — is asserted directly.
  // Read inside the tests, not at describe-registration time: a missing template
  // must fail the existence test above with its own message, not throw while the
  // file is still being collected and take every test in this file with it.
  const effectivePaths = () => fs.readFileSync(WORKTREEINCLUDE_PATH, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  // The voice file is gitignored, so a worktree gets no copy from git — without
  // this entry a worktree session would silently lose the hermit's voice.
  test('template contains exactly the five allowed paths', () => {
    expect(effectivePaths()).toEqual([
      '.hermit/OPERATOR.md',
      '.hermit/config.json',
      '.hermit/bin/hermitd-run',
      '.hermit/compiled/',
      '.claude/output-styles/hermit-voice.md',
    ]);
  });

  // bin/hermitd-run is the one executable in the block; the resident prompt
  // commands need it at the relative path inside a worktree. The rest of bin/
  // are lifecycle wrappers (start/stop/update/docker) that act on the main
  // hermit; a worktree copy of those is a footgun, so the whole dir must not
  // creep in.
  test('safety-invariant: only hermitd-run from bin/, never the whole dir', () => {
    const binEntries = effectivePaths().filter((e) => e.includes('/bin'));
    expect(binEntries).toEqual(['.hermit/bin/hermitd-run']);
  });

  test('safety-invariant: no runtime state, sessions, ledgers or channel data', () => {
    const forbidden = ['state/', 'sessions/', 'proposals/', 'raw/', 'cost-log', '.jsonl', '.db'];
    for (const entry of effectivePaths()) {
      for (const f of forbidden) expect(entry).not.toContain(f);
    }
  });
});

// -------------------------------------------------------
// hatch no longer restates the allow-list — apply-settings.ts owns it, and hatch
// reaches it through permissions-plan / permissions-sync. There is no second copy
// to keep in sync; tests/apply-settings-permissions.test.ts covers the behavior.
// -------------------------------------------------------
describe('hatch permission delegation', () => {
  test('hatch/SKILL.md carries no copied allow-list JSON block', () => {
    const allowBlocks: unknown[] = [];
    for (const block of skillContent.matchAll(/```json\n([\s\S]*?)```/g)) {
      let parsed: any;
      try {
        parsed = JSON.parse(block[1]);
      } catch {
        continue; // non-JSON or unrelated block — keep scanning
      }
      // Collect, never assert inside the loop: an expect() thrown here would be
      // caught by the parse guard above and silently pass the test.
      if (parsed?.permissions?.allow) allowBlocks.push(parsed.permissions.allow);
    }
    expect(allowBlocks).toEqual([]);
  });

  test('hatch/SKILL.md Step 8 delegates to the permissions verbs', () => {
    expect(skillContent).toContain('permissions-plan');
    expect(skillContent).toContain('permissions-sync');
  });
});

// -------------------------------------------------------
// Routine model defaults
// -------------------------------------------------------
describe('routine model defaults', () => {
  let routines: any[] = [];
  try {
    routines = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf-8')).routines || [];
  } catch {}

  test('doctor has model: haiku', () => {
    const entry = routines.find((r: any) => r.id === 'doctor');
    expect(entry).toBeTruthy();
    expect(entry.model).toBe('haiku');
  });

  test('no other default routine carries a model field', () => {
    const ALLOWED_WITH_MODEL = new Set(['daily-auto-close', 'doctor']);
    const withModel = routines.filter((r: any) => !ALLOWED_WITH_MODEL.has(r.id) && r.model !== undefined);
    expect(withModel).toEqual([]);
  });
});
