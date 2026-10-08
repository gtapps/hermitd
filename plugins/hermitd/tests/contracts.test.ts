// Contract tests for hermitd (bun test port of the non-hermitd-start
// classes in run-contracts.py; the hermitd-start internals live in
// tests/hermitd-start.test.ts).
//
// Only add tests for silent breakage — not for every branch in every helper.
// Tests cover: hook outputs, cache-edit-guard, stderr sanitization, cron corpus,
// validate-config blocks (monitors, push_notifications, routine model, primary),
// the outbound-channel resolver, proposal-id scheme, and skill/agent content
// contracts (analytics skills, kill metrics, procedure capture, bootstrap
// skills, gate-agent memory, external-origin quarantine).
//
// Hooks are exercised as subprocesses (runScript) because that is the boundary
// Claude Code sees. Pure exports (validate, validateCronSchedule, resolve) are
// imported in-process — the Python suite shelled out to `bun -e` only because
// it could not import TypeScript.
//
// Usage: bun test tests/contracts.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript, PLUGIN_ROOT } from './helpers/run';
import { fixturesDir } from './helpers/workdir';
import { triggerPrompt } from './helpers/transcript';
import { frontmatterBlock, isModelInvocationDisabled } from './helpers/skill-frontmatter';
import { validateCronSchedule, validate } from '../scripts/validate-config';
import { resolve, resolveMaintainerTarget } from '../scripts/resolve-outbound-channel';
import { resolvePaths, checkConfig } from '../scripts/doctor-check';
import { PRICING_VERIFIED } from '../scripts/lib/pricing';

const SCRIPTS = path.join(PLUGIN_ROOT, 'scripts');
const SKILLS = path.join(PLUGIN_ROOT, 'skills');
const AGENTS = path.join(PLUGIN_ROOT, 'agents');
const TEMPLATES = path.join(PLUGIN_ROOT, 'state-templates');

const read = (p: string) => fs.readFileSync(p, 'utf-8');
const readJson = (p: string) => JSON.parse(read(p));
// proposal-act's action procedures live in branches.md; assert against the combined surface.
const PROPOSAL_ACT = read(path.join(SKILLS, 'proposal-act', 'SKILL.md')) + '\n' + read(path.join(SKILLS, 'proposal-act', 'branches.md'));

// ---------- tempdir harness (port of _TempDirTest, no chdir needed: cwd is
// passed to spawned processes instead) ----------

function makeTmpdir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-contracts-'));
  fs.mkdirSync(path.join(dir, '.hermit', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

/** Run a test body inside a throwaway tempdir, always cleaning up. */
function withTmpdir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = makeTmpdir();
    try {
      await fn(dir);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  };
}

const writeConfig = (dir: string, config: any) =>
  fs.writeFileSync(path.join(dir, '.hermit', 'config.json'), JSON.stringify(config));

// Stays a subprocess: it asserts the whole-report path (argv → 24 checks → stdout
// JSON → exit 0), which an in-process runAllChecks() would stop covering. Converting
// it was tried and measured slower here (~2.4s → ~4s for this file), so the seam
// buys per-check reach, not spawn count — don't "optimize" this back in-process.
async function runDoctorCheck(dir: string): Promise<any> {
  const r = await runScript('doctor-check.ts', {
    args: ['.hermit'], cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
  });
  return r.exitCode === 0 ? JSON.parse(r.stdout) : {};
}

/** Emulate Python str.split(sep, 2): at most 3 parts, remainder in the last. */
function split3(content: string, sep: string): string[] {
  const parts: string[] = [];
  let rest = content;
  for (let i = 0; i < 2; i++) {
    const idx = rest.indexOf(sep);
    if (idx === -1) break;
    parts.push(rest.slice(0, idx));
    rest = rest.slice(idx + sep.length);
  }
  parts.push(rest);
  return parts;
}

/** Read the YAML frontmatter block (between the two `---` delimiters) of an agent definition. */
function agentFrontmatter(name: string): string {
  const p = path.join(AGENTS, `${name}.md`);
  expect(fs.existsSync(p)).toBe(true);
  const parts = split3(read(p), '---\n');
  expect(parts.length).toBe(3); // agent file missing closing --- of frontmatter
  return parts[1];
}

function extractBlock(text: string, startSentinel: string, endSentinel: string): string {
  const start = text.indexOf(startSentinel);
  const end = text.indexOf(endSentinel, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end + endSentinel.length);
}

// ============================================================
// Hook output tests (TestHookOutputs)
// ============================================================

describe('hook outputs', () => {
  test('cost-log.jsonl entry has required keys with correct types', withTmpdir(async (dir) => {
    const transcript = path.join(dir, '.claude', 'transcript.jsonl');
    fs.copyFileSync(path.join(fixturesDir, 'transcript.jsonl'), transcript);

    const fixture = readJson(path.join(fixturesDir, 'stop-hook-input.json'));
    const hookInput = JSON.stringify({ ...fixture, transcript_path: transcript, cwd: dir });

    const r = await runScript('cost-tracker.ts', {
      stdin: hookInput, cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.exitCode).toBe(0);

    const logPath = path.join(dir, '.claude', 'cost-log.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);

    const entry = JSON.parse(read(logPath).trim().split('\n')[0]);
    expect(entry).not.toHaveProperty('session_id');
    expect(typeof entry.cc_session_id).toBe('string');
    expect(typeof entry.estimated_cost_usd).toBe('number');
    expect(typeof entry.timestamp).toBe('string');
    expect(entry.estimated_cost_usd).toBeGreaterThan(0);
    // schema v2 fields
    expect(typeof entry.api_calls).toBe('number');
    expect(entry.api_calls).toBeGreaterThanOrEqual(1);
    if (entry.context_usage !== null) { expect(typeof entry.context_usage).toBe('number'); }
  }), 15000);


});

// ============================================================
// cache-edit-guard hook (TestCacheEditGuard)
//
// Project-local marketplaces load from `source` at runtime; cache copies are
// stale. Editing a cache file works *until* the bridge restarts and the source
// is read instead. The guard must catch this.
// ============================================================

const runGuard = (dir: string, event: any, env: Record<string, string> = {}) =>
  runScript('cache-edit-guard.ts', {
    stdin: JSON.stringify(event), cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env },
  });

/** Write .claude-plugin/marketplace.json + create the plugin source dir. */
function seedMarketplace(dir: string, pluginSource: any = './services/sample-plugin'): void {
  fs.mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  const manifest = {
    name: 'example-marketplace',
    plugins: [{ name: 'sample-plugin', source: pluginSource }],
  };
  fs.writeFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), JSON.stringify(manifest));
  if (typeof pluginSource === 'string') {
    fs.mkdirSync(path.join(dir, pluginSource.replace(/^\.\//, '')), { recursive: true });
  }
}

const cachePath = (dir: string, ...parts: string[]) =>
  path.join(dir, '.claude/plugins/cache/example-marketplace/sample-plugin/0.1.0', ...parts);

describe('cache-edit-guard', () => {
  test('cache edit warns with source path', withTmpdir(async (dir) => {
    seedMarketplace(dir);
    const r = await runGuard(dir, {
      tool_name: 'Edit',
      tool_input: { file_path: cachePath(dir, 'server.ts') },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('WARNING');
    expect(r.stderr).toContain('marketplace cache copy');
    expect(r.stderr).toContain('services/sample-plugin/server.ts');
  }), 15000);

  test('block mode exits 2', withTmpdir(async (dir) => {
    seedMarketplace(dir);
    const r = await runGuard(
      dir,
      { tool_name: 'Write', tool_input: { file_path: cachePath(dir, 'server.ts') } },
      { HERMIT_CACHE_GUARD: 'block' },
    );
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('BLOCKED');
  }), 15000);

  test('remote git source is skipped silently', withTmpdir(async (dir) => {
    // Remote git refs are objects — guard must skip silently.
    seedMarketplace(dir, { source: 'github', repo: 'someone/sample-plugin' });
    const r = await runGuard(dir, {
      tool_name: 'Edit',
      tool_input: { file_path: cachePath(dir, 'server.ts') },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  }), 15000);

  test('non-cache path passes through', withTmpdir(async (dir) => {
    seedMarketplace(dir);
    const r = await runGuard(dir, {
      tool_name: 'Edit',
      tool_input: { file_path: path.join(dir, 'README.md') },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  }), 15000);

  test('non-edit tool passes through', withTmpdir(async (dir) => {
    seedMarketplace(dir);
    const r = await runGuard(dir, {
      tool_name: 'Read',
      tool_input: { file_path: cachePath(dir, 'server.ts') },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  }), 15000);

  test('no marketplace.json passes through (foreign repo)', withTmpdir(async (dir) => {
    const r = await runGuard(dir, {
      tool_name: 'Edit',
      tool_input: { file_path: cachePath(dir, 'server.ts') },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  }), 15000);

  test('unknown marketplace passes through', withTmpdir(async (dir) => {
    // Cache path names a marketplace not declared in this project's manifest.
    seedMarketplace(dir);
    const unknownCache = path.join(
      dir, '.claude/plugins/cache/some-other-marketplace/foo/0.1.0/index.js',
    );
    const r = await runGuard(dir, {
      tool_name: 'Edit',
      tool_input: { file_path: unknownCache },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  }), 15000);
});

// ============================================================
// Stderr sanitization (TestStderrSanitization)
//
// Adversarial tool_input values must not produce raw control chars in hook stderr.
// ============================================================

describe('stderr sanitization', () => {
  // Inject adversarial chars into the version segment ([^/]+ matches \n
  // and ESC), not the leaf ((.*)$ stops at \n and the regex fails).
  const evilCachePath = (dir: string, version: string, leaf = 'server.ts') =>
    path.join(dir, '.claude/plugins/cache/example-marketplace/sample-plugin', version, leaf);

  test('cache guard strips newline in path', withTmpdir(async (dir) => {
    seedMarketplace(dir);
    const r = await runGuard(dir, {
      tool_name: 'Edit',
      tool_input: { file_path: evilCachePath(dir, '0.1.0\nBAD') },
    });
    expect(r.stderr).toContain('WARNING');
    expect(r.stderr).not.toContain('\nBAD');
    expect(r.stderr).toContain('0.1.0?BAD');
  }), 15000);

  test('cache guard strips ANSI in path', withTmpdir(async (dir) => {
    // ANSI in the leaf exercises BOTH safe(filePath) and safe(canonical):
    // canonical = path.join(sourceRoot, leaf), so a poisoned leaf taints
    // canonical too. The leaf regex `(.*)$` accepts \x1b (not a line
    // terminator), so the warning path still runs.
    seedMarketplace(dir);
    const r = await runGuard(dir, {
      tool_name: 'Edit',
      tool_input: { file_path: evilCachePath(dir, '0.1.0', 'srv\x1b[32mOK\x1b[0m.ts') },
    });
    expect(r.stderr).toContain('WARNING');
    expect(r.stderr).not.toContain('\x1b');
    expect(r.stderr).toContain('OK');
  }), 15000);

  test('cache guard strips C1 CSI', withTmpdir(async (dir) => {
    seedMarketplace(dir);
    const r = await runGuard(dir, {
      tool_name: 'Edit',
      tool_input: { file_path: evilCachePath(dir, '0.1.0\x9b32mFAKE\x9b0m') },
    });
    expect(r.stderr).toContain('WARNING');
    expect(r.stderr).not.toContain('\x9b');
  }), 15000);

  test('channel hook strips chat_id control chars', withTmpdir(async (dir) => {
    writeConfig(dir, { channels: { discord: { enabled: true, dm_channel_id: null } } });
    const chatId = 'abc\n\x1b[31mFAKE\x1b[0m';
    // The save path is only reached when a matching inbound envelope opened the
    // turn, so the hostile id has to arrive on both legs to reach the log line
    // under test.
    const transcript = path.join(dir, 'inbound.jsonl');
    fs.writeFileSync(transcript, triggerPrompt(`<channel source="plugin:discord:discord" chat_id="${chatId}">hi</channel>`) + '\n');
    const r = await runScript('channel-hook.ts', {
      stdin: JSON.stringify({
        tool_name: 'mcp__discord__reply',
        tool_input: { chat_id: chatId },
        transcript_path: transcript,
      }),
      cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });
    expect(r.stderr).toContain('saved discord.dm_channel_id');
    expect(r.stderr).not.toContain('\x1b');
    expect(r.stderr).not.toContain('\nFAKE');
  }), 15000);
});

// ============================================================
// Cron corpus agreement (TestCronCorpus)
//
// validate-config.ts validateCronSchedule() must accept the shared corpus of
// valid expressions and reject the invalid ones. Cron schedules are consumed
// directly by CronCreate (via /hermit-routines) — only config-time validation
// remains.
// ============================================================

describe('cron corpus', () => {
  const corpus = readJson(path.join(import.meta.dir, 'cron-test-corpus.json'));

  test('validateCronSchedule() accepts valid expressions', () => {
    const fails: string[] = [];
    for (const c of corpus.valid_expressions) {
      const err = validateCronSchedule(c.schedule);
      if (err) fails.push(`${c.schedule}: ${err}`);
    }
    expect(fails).toEqual([]);
  });

  test('validateCronSchedule() rejects invalid expressions', () => {
    const fails: string[] = [];
    for (const c of corpus.invalid_expressions) {
      const err = validateCronSchedule(c.schedule);
      if (!err) fails.push(c.schedule);
    }
    expect(fails).toEqual([]);
  });
});

// ============================================================
// validate-config blocks (TestMonitorsValidation, TestPushNotificationsValidation,
// TestRoutineModelValidation)
// ============================================================

// Minimal valid config to merge overrides into
const BASE_CONFIG = {
  agent_name: null, language: null, timezone: null,
  escalation: 'balanced', channels: {}, env: {},
  heartbeat: { enabled: true, active_hours: { start: '08:00', end: '23:00' } },
  routines: [],
  quality_gate: { tier: 'budget' },
};

const runValidate = (overrides: any) => validate({ ...BASE_CONFIG, ...overrides });

describe('channel audience keys validation', () => {
  for (const [key, value] of [['isolate_chats', 'yes'], ['log_chats', 1], ['shared_chats', 'C1'], ['operators', '1'], ['shared_chats', [1]], ['operators', [1]]]) {
    test(`rejects invalid ${key} ${JSON.stringify(value)}`, () => {
      expect(runValidate({ channels: { discord: { [key as string]: value } } }).errors.some(
        (error: string) => error.includes(`channels.discord.${key}:`),
      )).toBe(true);
    });
  }
  test('valid shapes pass', () => {
    expect(runValidate({ channels: { discord: { isolate_chats: false, log_chats: true, shared_chats: ['C1'], operators: ['1'], allowed_users: ['1'] } } }).errors).toEqual([]);
  });
  test('sharing maintainer chat warns without errors', () => {
    const out = runValidate({ channels: { discord: { shared_chats: ['MAINT'], maintainer_channel_id: 'MAINT' } } });
    expect(out.errors).toEqual([]);
    expect(out.warnings.some((warning: string) => warning.includes('shared_chats'))).toBe(true);
  });
  test('operator outside allowed users warns without errors', () => {
    const out = runValidate({ channels: { discord: { operators: ['1'], allowed_users: ['2'] } } });
    expect(out.errors).toEqual([]);
    expect(out.warnings.some((warning: string) => warning.includes('operators'))).toBe(true);
  });
});

describe('passive chats validation', () => {
  test('accepts string chat ids and rejects other shapes', () => {
    expect(runValidate({ channels: { discord: { passive_chats: ['123'] } } }).errors).toEqual([]);
    expect(runValidate({ channels: { discord: {} } }).errors).toEqual([]);
    for (const passive_chats of [[123], '123']) {
      expect(runValidate({ channels: { discord: { passive_chats } } }).errors.some(
        (error: string) => error.includes('channels.discord.passive_chats'),
      )).toBe(true);
    }
  });
});

describe('monitors validation', () => {
  test('a fully valid monitor entry produces no errors or warnings', () => {
    const out = runValidate({ monitors: [
      { id: 'cpu', description: 'CPU watch', command: 'top -bn1',
        class: 'poll', timeout_ms: 5000, persistent: false, enabled: true },
    ] });
    expect(out.errors).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  test('monitors must be an array — non-array value is an error', () => {
    const out = runValidate({ monitors: 'bad' });
    expect(out.errors.some((e: string) => e.includes('monitors: must be an array'))).toBe(true);
  });

  test('monitor without id is an error', () => {
    const out = runValidate({ monitors: [{ description: 'no id here', command: 'true' }] });
    expect(out.errors.some((e: string) => e.includes('missing or invalid id'))).toBe(true);
  });

  test('two monitors sharing the same id produce a warning', () => {
    const out = runValidate({ monitors: [
      { id: 'dup', description: 'first', command: 'true' },
      { id: 'dup', description: 'second', command: 'true' },
    ] });
    expect(out.warnings.some((w: string) => w.includes('duplicate id'))).toBe(true);
  });

  test('class value not in (stream, poll) is an error', () => {
    const out = runValidate({ monitors: [
      { id: 'm1', description: 'desc', command: 'true', class: 'bad' },
    ] });
    expect(out.errors.some((e: string) => e.includes('class must be'))).toBe(true);
  });

  test('timeout_ms below 1000 is an error', () => {
    const out = runValidate({ monitors: [
      { id: 'm1', description: 'desc', command: 'true', timeout_ms: 500 },
    ] });
    expect(out.errors.some((e: string) => e.includes('timeout_ms'))).toBe(true);
  });

  test('monitor missing both description and command produces two errors', () => {
    const out = runValidate({ monitors: [{ id: 'm1' }] });
    expect(out.errors.some((e: string) => e.includes('missing description'))).toBe(true);
    expect(out.errors.some((e: string) => e.includes('missing command'))).toBe(true);
  });
});

describe('remote validation', () => {
  test('remote: true and false are both valid', () => {
    for (const val of [true, false]) {
      const out = runValidate({ remote: val });
      expect(out.errors.some((e: string) => e.includes('remote'))).toBe(false);
    }
  });

  test('remote must be a boolean — strings are rejected', () => {
    const out = runValidate({ remote: 'yes' });
    expect(out.errors.some((e: string) => e.includes('remote'))).toBe(true);
  });

  test('remote absent produces no error (falls through to template default)', () => {
    const out = runValidate({});
    expect(out.errors.some((e: string) => e.includes('remote'))).toBe(false);
  });
});

describe('permission_mode validation (type-only — no enum, Claude Code owns the set)', () => {
  test('any string value produces no error, including values the hermit does not recognize', () => {
    const out = runValidate({ permission_mode: 'bogus' });
    expect(out.errors.some((e: string) => e.includes('permission_mode'))).toBe(false);
  });

  test('non-string permission_mode is an error', () => {
    const out = runValidate({ permission_mode: 5 });
    expect(out.errors.some((e: string) => e.includes('permission_mode'))).toBe(true);
  });

  test('permission_mode absent or null produces no error', () => {
    expect(runValidate({}).errors.some((e: string) => e.includes('permission_mode'))).toBe(false);
    expect(runValidate({ permission_mode: null }).errors.some((e: string) => e.includes('permission_mode'))).toBe(false);
  });
});

describe('push_notifications validation', () => {
  test('push_notifications: true and false are both valid', () => {
    for (const val of [true, false]) {
      const out = runValidate({ push_notifications: val });
      expect(out.errors.some((e: string) => e.includes('push_notifications'))).toBe(false);
    }
  });

  test('push_notifications must be a boolean — strings are rejected', () => {
    const out = runValidate({ push_notifications: 'yes' });
    expect(out.errors.some((e: string) => e.includes('push_notifications'))).toBe(true);
  });
});

describe('retired settings dials', () => {
  const RETIRED = 'is retired and no longer read; run /hermitd:hermit-evolve to remove it';

  test('each leftover key warns once and never errors', () => {
    const fromChat = runValidate({ settings_from_chat: false });
    expect(fromChat.errors.some((e: string) => e.includes('settings_from_chat'))).toBe(false);
    expect(fromChat.warnings.filter((w: string) => w.includes('settings_from_chat') && w.includes(RETIRED))).toHaveLength(1);

    const policy = runValidate({ channels: { discord: { enabled: true, settings_policy: 'allow' } } });
    expect(policy.errors.some((e: string) => e.includes('settings_policy'))).toBe(false);
    expect(policy.warnings.filter((w: string) => w.includes('channels.discord.settings_policy') && w.includes(RETIRED))).toHaveLength(1);

    const perms = runValidate({ settings_permissions: { allow: ['routines'] } });
    expect(perms.errors.some((e: string) => e.includes('settings_permissions'))).toBe(false);
    expect(perms.warnings.filter((w: string) => w.includes('settings_permissions') && w.includes(RETIRED))).toHaveLength(1);
  });

  test('absent keys say nothing', () => {
    const out = runValidate({});
    expect(out.warnings.some((w: string) => w.includes('settings_from_chat'))).toBe(false);
    expect(out.warnings.some((w: string) => w.includes('settings_policy'))).toBe(false);
    expect(out.warnings.some((w: string) => w.includes('settings_permissions'))).toBe(false);
  });
});

// `precheck` is the routine's wake gate: an executable the routine monitor runs
// unattended before deciding whether to wake the session. The validator owns only
// the shape — containment against the project root is re-checked at fire time.
describe('routine precheck validation', () => {
  const ROUTINE = { id: 'mail', schedule: '*/15 * * * *', skill: 'mail-triage', enabled: true };
  const withPrecheck = (extra: Record<string, unknown>) =>
    runValidate({ routines: [{ ...ROUTINE, ...extra }] });

  test('every builtin provider and a project-relative path are accepted', () => {
    expect(withPrecheck({ precheck: 'reflect' }).errors).toEqual([]);
    expect(withPrecheck({ precheck: 'doctor' }).errors).toEqual([]);
    expect(withPrecheck({ precheck: 'later' }).errors).toEqual([]);
    expect(withPrecheck({ precheck: 'tools/mail-gate.sh' }).errors).toEqual([]);
  });

  test('absolute paths and traversal are rejected', () => {
    expect(withPrecheck({ precheck: '/etc/passwd' }).errors.join(' ')).toContain('precheck');
    expect(withPrecheck({ precheck: '../outside.sh' }).errors.join(' ')).toContain('precheck');
  });

  test('a non-string precheck is rejected', () => {
    expect(withPrecheck({ precheck: 42 }).errors.join(' ')).toContain('precheck');
  });

  test('timeout must be an integer within bounds', () => {
    expect(withPrecheck({ precheck: 'reflect', precheck_timeout_s: 60 }).errors).toEqual([]);
    expect(withPrecheck({ precheck: 'reflect', precheck_timeout_s: 301 }).errors.join(' ')).toContain('precheck_timeout_s');
    expect(withPrecheck({ precheck: 'reflect', precheck_timeout_s: 0 }).errors.join(' ')).toContain('precheck_timeout_s');
  });

  test('a timeout without a gate warns rather than errors', () => {
    const out = withPrecheck({ precheck_timeout_s: 60 });
    expect(out.errors).toEqual([]);
    expect(out.warnings.join(' ')).toContain('precheck_timeout_s');
  });

  test('a gate on the re-arm anchor warns — it never runs through the monitor', () => {
    const out = runValidate({
      routines: [{
        id: 'heartbeat-restart', schedule: '0 4 * * *',
        skill: 'hermitd:hermit-routines load', enabled: true, precheck: 'reflect',
      }],
    });
    expect(out.errors).toEqual([]);
    expect(out.warnings.join(' ')).toContain('heartbeat-restart');
  });

  test('the shipped doctor uses its gate and daily-auto-close is retired', () => {
    const template = readJson(path.join(TEMPLATES, 'config.json.template'));
    const byId = (id: string) => template.routines.find((r: any) => r.id === id);
    expect(byId('daily-auto-close')).toBeUndefined();
    expect(byId('doctor').precheck).toBe('doctor');
    expect(runValidate({ routines: template.routines }).errors).toEqual([]);
  });

  test('the shipped template includes the daily later-check routine', () => {
    const template = readJson(path.join(TEMPLATES, 'config.json.template'));
    const entry = template.routines.find((r: any) => r.id === 'later-check');
    expect(entry).toBeTruthy();
    expect(entry.schedule).toBe('5 9 * * *');
    expect(entry.skill).toBe('hermitd:later run');
    expect(entry.precheck).toBe('later');
    expect(entry).not.toHaveProperty('run_during_waiting');
    expect(entry.enabled).toBe(true);
    expect(entry.model).toBeUndefined();
    expect(runValidate({ routines: template.routines }).errors).toEqual([]);
  });

  test('the shipped template includes the monthly capability-brainstorm routine', () => {
    const template = readJson(path.join(TEMPLATES, 'config.json.template'));
    const entry = template.routines.find((r: any) => r.id === 'capability-brainstorm');
    expect(entry).toBeTruthy();
    expect(entry.schedule).toBe('0 10 1 * *');
    expect(entry.skill).toBe('hermitd:capability-brainstorm');
    expect(entry.enabled).toBe(true);
    expect(entry.model).toBeUndefined();
    expect(runValidate({ routines: template.routines }).errors).toEqual([]);
  });
});

// expect_artifact declares the exact file a routine must produce. Globs are
// rejected because they would make both the change check and the duplicate
// check unsound (an unrelated fresh match passes; overlapping patterns are not
// string-equal).
describe('routine expect_artifact validation', () => {
  const ROUTINE = { id: 'cal', schedule: '0 6 * * *', skill: 'calendar-fetch-light', enabled: true };
  const withArtifact = (expect_artifact: unknown, extra: Record<string, unknown> = {}) =>
    runValidate({ routines: [{ ...ROUTINE, expect_artifact, ...extra }] });

  test('an exact raw/ path with a {date} token is accepted', () => {
    const out = withArtifact('raw/snapshot-calendar-{date}.md');
    expect(out.errors).toEqual([]);
  });

  test('an exact compiled/ path with no token is accepted', () => {
    expect(withArtifact('compiled/digest-weekly.md').errors).toEqual([]);
  });

  test('omitting the field entirely is valid', () => {
    expect(runValidate({ routines: [ROUTINE] }).errors).toEqual([]);
  });

  test('an absolute path is rejected', () => {
    expect(withArtifact('/etc/passwd').errors.some((e: string) => e.includes('not absolute'))).toBe(true);
  });

  test('a traversal segment is rejected', () => {
    expect(withArtifact('raw/../../escape.md').errors.some((e: string) => e.includes('".."'))).toBe(true);
  });

  test('a glob is rejected', () => {
    expect(withArtifact('raw/snapshot-*-{date}.md').errors.some((e: string) => e.includes('globs are not supported'))).toBe(true);
  });

  test('a path outside raw/ and compiled/ is rejected', () => {
    expect(withArtifact('state/sneaky.json').errors.some((e: string) => e.includes('raw/'))).toBe(true);
  });

  test('more than one token is rejected', () => {
    expect(withArtifact('raw/s-{date}-{date}.md').errors.some((e: string) => e.includes('at most one'))).toBe(true);
  });

  test('an unknown token is rejected', () => {
    expect(withArtifact('raw/s-{week}.md').errors.some((e: string) => e.includes('{week}'))).toBe(true);
  });

  // A case-wrong token is never substituted by resolveArtifactPath, so accepting
  // it would mean the routine fails artifact-missing on a nonsense path forever.
  test('a case-wrong {DATE} token is rejected, not accepted as a literal', () => {
    expect(withArtifact('raw/s-{DATE}.md').errors.some((e: string) => e.includes('{DATE}'))).toBe(true);
  });

  test('two enabled routines declaring the same artifact is an error', () => {
    const out = runValidate({ routines: [
      { ...ROUTINE, id: 'a', expect_artifact: 'raw/snapshot-{date}.md' },
      { ...ROUTINE, id: 'b', expect_artifact: 'raw/snapshot-{date}.md' },
    ] });
    expect(out.errors.some((e: string) => e.includes('already declared by'))).toBe(true);
  });

  test('a disabled routine may share an artifact with an enabled one', () => {
    const out = runValidate({ routines: [
      { ...ROUTINE, id: 'a', expect_artifact: 'raw/snapshot-{date}.md' },
      { ...ROUTINE, id: 'b', enabled: false, expect_artifact: 'raw/snapshot-{date}.md' },
    ] });
    expect(out.errors).toEqual([]);
  });
});

describe('routine model validation', () => {
  const BASE_ROUTINE = {
    id: 'check', schedule: '0 9 * * *', skill: 'hermitd:recall', enabled: true,
  };
  const HB_ROUTINE = {
    id: 'heartbeat-restart', schedule: '0 4 * * *',
    skill: 'hermitd:heartbeat start', enabled: true,
  };

  test('each valid model value on a routine produces no errors', () => {
    for (const model of ['haiku', 'sonnet', 'opus']) {
      const out = runValidate({ routines: [{ ...BASE_ROUTINE, model }] });
      expect(out.errors).toEqual([]);
    }
  });

  test('routine without model field produces no model-related error', () => {
    const out = runValidate({ routines: [BASE_ROUTINE] });
    expect(out.errors.some((e: string) => e.includes('model'))).toBe(false);
  });

  test('model: null is treated as absent — no error', () => {
    const out = runValidate({ routines: [{ ...BASE_ROUTINE, model: null }] });
    expect(out.errors.some((e: string) => e.includes('model'))).toBe(false);
  });

  test('model: haik (typo) is an error', () => {
    const out = runValidate({ routines: [{ ...BASE_ROUTINE, model: 'haik' }] });
    expect(out.errors.some((e: string) => e.includes('not in'))).toBe(true);
  });

  test('model: 5 (non-string) is an error', () => {
    const out = runValidate({ routines: [{ ...BASE_ROUTINE, model: 5 }] });
    expect(out.errors.some((e: string) => e.includes('not in'))).toBe(true);
  });

  test('model on heartbeat-restart produces a warning (ignored), not an error', () => {
    const out = runValidate({ routines: [{ ...HB_ROUTINE, model: 'haiku' }] });
    expect(out.errors).toEqual([]);
    expect(out.warnings.some((w: string) => w.includes('ignored'))).toBe(true);
  });

  test('effort beside model is accepted; an unknown effort is an error', () => {
    const out = runValidate({ routines: [{ ...BASE_ROUTINE, model: 'haiku', effort: 'high' }] });
    expect(out.errors).toEqual([]);
    expect(out.warnings.some((w: string) => w.includes('effort'))).toBe(false);
    const bad = runValidate({ routines: [{ ...BASE_ROUTINE, model: 'haiku', effort: 'hgh' }] });
    expect(bad.errors.some((e: string) => e.includes('effort'))).toBe(true);
  });

  test('effort without model warns that it has no effect', () => {
    const out = runValidate({ routines: [{ ...BASE_ROUTINE, effort: 'high' }] });
    expect(out.errors).toEqual([]);
    expect(out.warnings.some((w: string) => w.includes('effort has no effect'))).toBe(true);
  });

  test('effort on heartbeat-restart warns that it is ignored, even beside model', () => {
    const out = runValidate({ routines: [{ ...HB_ROUTINE, model: 'haiku', effort: 'high' }] });
    expect(out.warnings.some((w: string) => w.includes('effort on "heartbeat-restart" is ignored'))).toBe(true);
    expect(out.warnings.some((w: string) => w.includes('effort has no effect without'))).toBe(false);
  });

  test('a daily heartbeat-restart schedule produces no warning', () => {
    const out = runValidate({ routines: [HB_ROUTINE] });
    expect(out.errors).toEqual([]);
    expect(out.warnings.some((w: string) => w.includes('not daily'))).toBe(false);
  });

  test('a non-daily heartbeat-restart schedule warns (not an error)', () => {
    const out = runValidate({ routines: [{ ...HB_ROUTINE, schedule: '0 4 */3 * *' }] });
    expect(out.errors).toEqual([]);
    expect(out.warnings.some((w: string) => w.includes('heartbeat-restart') && w.includes('not daily'))).toBe(true);
  });
});

describe('heartbeat.effort validation', () => {
  test('high and null pass', () => {
    for (const effort of ['high', null]) {
      const out = runValidate({ heartbeat: { ...BASE_CONFIG.heartbeat, effort } });
      expect(out.errors.some((e: string) => e.includes('heartbeat.effort'))).toBe(false);
    }
  });

  test('turbo is an error', () => {
    const out = runValidate({ heartbeat: { ...BASE_CONFIG.heartbeat, effort: 'turbo' } });
    expect(out.errors.some((e: string) => e.includes('heartbeat.effort') && e.includes('not in'))).toBe(true);
  });
});

// ============================================================
// context_hygiene.compact validation (PROP-011 commit 3)
// ============================================================

describe('context_hygiene validation', () => {
  test('a fully valid compact block produces no errors or warnings', () => {
    const out = runValidate({ context_hygiene: { compact: {
      enabled: true, min_context_tokens: 150000, min_interval: '4h',
    } } });
    expect(out.errors).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  test('context_hygiene must be an object — non-object value is an error', () => {
    const out = runValidate({ context_hygiene: 'bad' });
    expect(out.errors.some((e: string) => e.includes('context_hygiene: must be an object'))).toBe(true);
  });

  test('context_hygiene.compact must be an object — non-object value is an error', () => {
    const out = runValidate({ context_hygiene: { compact: 'bad' } });
    expect(out.errors.some((e: string) => e.includes('context_hygiene.compact: must be an object'))).toBe(true);
  });

  test('compact.enabled non-boolean is an error', () => {
    const out = runValidate({ context_hygiene: { compact: { enabled: 'yes' } } });
    expect(out.errors.some((e: string) => e.includes('context_hygiene.compact.enabled: must be a boolean'))).toBe(true);
  });

  test('compact.min_context_tokens non-positive is an error', () => {
    const out = runValidate({ context_hygiene: { compact: { min_context_tokens: 0 } } });
    expect(out.errors.some((e: string) => e.includes('min_context_tokens: must be a positive number'))).toBe(true);
  });

  test('compact.min_context_tokens non-number is an error', () => {
    const out = runValidate({ context_hygiene: { compact: { min_context_tokens: '150000' } } });
    expect(out.errors.some((e: string) => e.includes('min_context_tokens: must be a positive number'))).toBe(true);
  });

  test('compact.min_interval non-string is a warning, not an error', () => {
    const out = runValidate({ context_hygiene: { compact: { min_interval: 4 } } });
    expect(out.errors).toEqual([]);
    expect(out.warnings.some((w: string) => w.includes('min_interval: should be a duration string'))).toBe(true);
  });

  test('context_hygiene without compact key produces no errors', () => {
    const out = runValidate({ context_hygiene: {} });
    expect(out.errors).toEqual([]);
  });

  test('absent context_hygiene block produces no errors', () => {
    const out = runValidate({});
    expect(out.errors.filter((e: string) => e.includes('context_hygiene'))).toEqual([]);
  });
});

// ============================================================
// doctor.routine_cost_floor_usd validation
// ============================================================

describe('doctor config validation', () => {
  test('valid routine_cost_floor_usd produces no errors', () => {
    const out = runValidate({ doctor: { routine_cost_floor_usd: 5 } });
    expect(out.errors).toEqual([]);
  });

  test('negative routine_cost_floor_usd is an error', () => {
    const out = runValidate({ doctor: { routine_cost_floor_usd: -1 } });
    expect(out.errors.some((e: string) => e.includes('routine_cost_floor_usd: expected non-negative number'))).toBe(true);
  });

  test('non-number routine_cost_floor_usd is an error', () => {
    const out = runValidate({ doctor: { routine_cost_floor_usd: '5' } });
    expect(out.errors.some((e: string) => e.includes('routine_cost_floor_usd: expected non-negative number'))).toBe(true);
  });

  test('absent doctor block produces no errors', () => {
    const out = runValidate({});
    expect(out.errors.filter((e: string) => e.includes('doctor'))).toEqual([]);
  });
});

// ============================================================
// budget validation (PROP-016)
// ============================================================

describe('budget validation', () => {
  test('a fully valid budget block (all three caps) produces no errors', () => {
    const out = runValidate({ budget: { daily_usd: 5, weekly_usd: 25, monthly_usd: 100, action: 'alert' } });
    expect(out.errors).toEqual([]);
  });

  test('null caps are valid (disables that window)', () => {
    const out = runValidate({ budget: { daily_usd: null, weekly_usd: null, monthly_usd: null, action: 'pause' } });
    expect(out.errors).toEqual([]);
  });

  test('absent budget block produces no errors', () => {
    const out = runValidate({});
    expect(out.errors.filter((e: string) => e.includes('budget'))).toEqual([]);
  });

  test('negative daily_usd is an error', () => {
    const out = runValidate({ budget: { daily_usd: -5 } });
    expect(out.errors.some((e: string) => e.includes('budget.daily_usd: must be a positive number or null'))).toBe(true);
  });

  test('zero weekly_usd is an error', () => {
    const out = runValidate({ budget: { weekly_usd: 0 } });
    expect(out.errors.some((e: string) => e.includes('budget.weekly_usd: must be a positive number or null'))).toBe(true);
  });

  test('non-number monthly_usd is an error', () => {
    const out = runValidate({ budget: { monthly_usd: '100' } });
    expect(out.errors.some((e: string) => e.includes('budget.monthly_usd: must be a positive number or null'))).toBe(true);
  });

  test('invalid action is an error', () => {
    const out = runValidate({ budget: { action: 'notify' } });
    expect(out.errors.some((e: string) => e.includes('budget.action: "notify" not in [alert, pause]'))).toBe(true);
  });

  test('budget block with only one cap set is valid', () => {
    const out = runValidate({ budget: { monthly_usd: 100 } });
    expect(out.errors).toEqual([]);
  });
});

describe('artifacts validation', () => {
  test('a fully valid artifacts block (all three flags) produces no errors', () => {
    const out = runValidate({ artifacts: { dashboard: true, proposals: true, weekly_review: false } });
    expect(out.errors).toEqual([]);
  });

  test('absent artifacts block produces no errors', () => {
    const out = runValidate({});
    expect(out.errors.filter((e: string) => e.includes('artifacts'))).toEqual([]);
  });

  test('non-object artifacts is an error', () => {
    const out = runValidate({ artifacts: 'bad' });
    expect(out.errors.some((e: string) => e.includes('artifacts: must be an object'))).toBe(true);
  });

  test('non-boolean artifacts.dashboard is an error', () => {
    const out = runValidate({ artifacts: { dashboard: 'yes' } });
    expect(out.errors.some((e: string) => e.includes('artifacts.dashboard: must be a boolean'))).toBe(true);
  });

  test('non-boolean artifacts.proposals is an error', () => {
    const out = runValidate({ artifacts: { proposals: 1 } });
    expect(out.errors.some((e: string) => e.includes('artifacts.proposals: must be a boolean'))).toBe(true);
  });

  test('non-boolean artifacts.weekly_review is an error', () => {
    const out = runValidate({ artifacts: { weekly_review: null } });
    expect(out.errors.some((e: string) => e.includes('artifacts.weekly_review: must be a boolean'))).toBe(true);
  });

  test('artifacts.publish_authorized accepts true, false, and null', () => {
    for (const value of [true, false, null]) {
      const out = runValidate({ artifacts: { publish_authorized: value } });
      expect(out.errors.filter((e: string) => e.includes('publish_authorized'))).toEqual([]);
    }
  });

  test('non-boolean, non-null artifacts.publish_authorized is an error', () => {
    const out = runValidate({ artifacts: { publish_authorized: 'yes' } });
    expect(out.errors.some((e: string) => e.includes('artifacts.publish_authorized: must be a boolean or null'))).toBe(true);
  });

  test('artifacts.backend accepts the default and an MCP server name', () => {
    for (const value of ['claude', 'my-artifact-host']) {
      const out = runValidate({ artifacts: { backend: value } });
      expect(out.errors.filter((e: string) => e.includes('backend'))).toEqual([]);
    }
  });

  test('non-string artifacts.backend is an error', () => {
    for (const value of [true, 3, null, ['a']]) {
      const out = runValidate({ artifacts: { backend: value } });
      expect(out.errors.some((e: string) => e.includes('artifacts.backend: must be a string'))).toBe(true);
    }
  });

  test('empty or whitespace-only artifacts.backend is an error', () => {
    for (const value of ['', '   ', '\t\n']) {
      const out = runValidate({ artifacts: { backend: value } });
      expect(
        out.errors.some((e: string) => e.includes('artifacts.backend: must not be empty or whitespace-only')),
      ).toBe(true);
    }
  });
});

// ============================================================
// Outbound channel resolver (TestChannelResolverContract)
//
// Verifies resolution order, primary override, eligibility gates, and the
// validate-config.ts special-case for channels.primary.
// ============================================================

describe('channel resolver contract', () => {
  /** Port of _run_resolver: resolve() in-process; (code, result) tuple shape kept. */
  function runResolver(config: any): { code: number; result: any } {
    const r = resolve(config.channels ?? {});
    return r === null
      ? { code: 1, result: { error: 'no_reachable_channel' } }
      : { code: 0, result: r };
  }

  test('channels.primary picks the named channel when eligible — wins over config order', () => {
    // telegram is listed first; primary points at discord — discord must win.
    const { code, result } = runResolver({ channels: {
      primary: 'discord',
      telegram: { enabled: true, dm_channel_id: 'T1' },
      discord: { enabled: true, dm_channel_id: 'D1' },
    } });
    expect(code).toBe(0);
    expect(result.id).toBe('discord');
    expect(result.chat_id).toBe('D1');
  });

  test('primary channel missing dm_channel_id falls through to first eligible in config order', () => {
    const { code, result } = runResolver({ channels: {
      primary: 'discord',
      discord: { enabled: true, dm_channel_id: null },
      telegram: { enabled: true, dm_channel_id: 'T1' },
    } });
    expect(code).toBe(0);
    expect(result.id).toBe('telegram');
  });

  test('no primary — first eligible entry in config order wins (no hardcoded slug list)', () => {
    // telegram listed first should win — proves there's no built-in preference for discord.
    const { code, result } = runResolver({ channels: {
      telegram: { enabled: true, dm_channel_id: 'T1' },
      discord: { enabled: true, dm_channel_id: 'D1' },
    } });
    expect(code).toBe(0);
    expect(result.id).toBe('telegram');
  });

  test('a future/third-party channel slug is picked up without resolver changes', () => {
    const { code, result } = runResolver({ channels: {
      whatsapp: { enabled: true, dm_channel_id: 'W1' },
    } });
    expect(code).toBe(0);
    expect(result.id).toBe('whatsapp');
  });

  test('primary channel with enabled:false is skipped (policy gate)', () => {
    const { code, result } = runResolver({ channels: {
      primary: 'discord',
      discord: { enabled: false, dm_channel_id: 'D1' },
      telegram: { enabled: true, dm_channel_id: 'T1' },
    } });
    expect(code).toBe(0);
    expect(result.id).toBe('telegram');
  });

  // The pin is the whole point of default_chat_id: dm_channel_id keeps tracking
  // the operator's last inbound chat, but unattended sends must not follow it.
  test('default_chat_id pins the proactive target — a moved dm_channel_id does not', () => {
    const { code, result } = runResolver({ channels: {
      discord: { enabled: true, dm_channel_id: 'MOVED', default_chat_id: 'HOME' },
    } });
    expect(code).toBe(0);
    expect(result.chat_id).toBe('HOME');
  });

  test('no pin — resolution falls back to the learned dm_channel_id (pre-pin installs)', () => {
    const { code, result } = runResolver({ channels: {
      discord: { enabled: true, dm_channel_id: 'D1' },
    } });
    expect(code).toBe(0);
    expect(result.chat_id).toBe('D1');
  });

  test('a pin alone makes a channel eligible — eligibility reads the same fallback chain', () => {
    const { code, result } = runResolver({ channels: {
      discord: { enabled: true, dm_channel_id: null, default_chat_id: 'HOME' },
    } });
    expect(code).toBe(0);
    expect(result.chat_id).toBe('HOME');
  });

  // resolveTarget's third argument became an extractor function so the proactive
  // target could express a fallback chain. Maintainer routing shares that helper
  // and must keep resolving its own single field.
  test('maintainer routing is unaffected by the proactive pin', () => {
    const channels = {
      discord: { enabled: true, dm_channel_id: 'MOVED', default_chat_id: 'HOME', maintainer_channel_id: 'M1' },
    };
    expect(resolveMaintainerTarget(channels)?.chat_id).toBe('M1');
    expect(resolve(channels)?.chat_id).toBe('HOME');
  });

  test('validator rejects channels.primary referencing a missing channel', () => {
    const result = validate({ channels: { primary: 'ghost', discord: { dm_channel_id: 'D1' } } });
    expect(
      (result.errors ?? []).some((e: string) => e.includes('primary') && e.includes('ghost')),
    ).toBe(true);
  });

  test('validator accepts channels.primary pointing to an existing channel', () => {
    const result = validate({ channels: { primary: 'discord', discord: { dm_channel_id: 'D1' } } });
    const primaryErrors = (result.errors ?? []).filter((e: string) => e.includes('primary'));
    expect(primaryErrors).toEqual([]);
  });

  test('allowed_users: [] disables the channel for proactive sends', () => {
    const { code, result } = runResolver({ channels: {
      discord: { enabled: true, dm_channel_id: 'D1', allowed_users: [] },
      telegram: { enabled: true, dm_channel_id: 'T1' },
    } });
    expect(code).toBe(0);
    expect(result.id).toBe('telegram');
  });

  test('missing config.json: exit 1, JSON error on stdout with detail+path', async () => {
    // CLI-path coverage (exit codes) — spawn the resolver directly.
    const r = await runScript('resolve-outbound-channel.ts', { args: ['/nope/missing-dir'] });
    expect(r.exitCode).toBe(1);
    const payload = JSON.parse(r.stdout.trim());
    expect(payload.error).toBe('config_read_failed');
    expect(payload).toContainKey('detail');
    expect(payload.path ?? '').toContain('/nope/missing-dir');
  }, 15000);

  test("channels.primary: 'primary' would point at the string itself — falls through", () => {
    const { code, result } = runResolver({ channels: {
      primary: 'primary',
      discord: { enabled: true, dm_channel_id: 'D1' },
    } });
    expect(code).toBe(0);
    expect(result.id).toBe('discord');
  });

  test("validator rejects channels.primary pointing at the string 'primary' (self)", () => {
    const result = validate({ channels: {
      primary: 'primary',
      discord: { dm_channel_id: 'D1' },
    } });
    expect(
      (result.errors ?? []).some(
        (e: string) => e.includes('primary') && e.includes('channel-config object'),
      ),
    ).toBe(true);
  });

  test('channels.primary must be a string', () => {
    const result = validate({ channels: { primary: 42, discord: { dm_channel_id: 'D1' } } });
    expect(
      (result.errors ?? []).some((e: string) => e.includes('primary') && e.includes('string')),
    ).toBe(true);
  });

  test('validator rejects a numeric allowed_users entry (would break the string sender gate)', () => {
    const result = validate({ channels: { discord: { dm_channel_id: 'D1', allowed_users: [123456789012345678] } } });
    expect(
      (result.errors ?? []).some((e: string) => e.includes('allowed_users') && e.includes('string')),
    ).toBe(true);
  });

  test('validator accepts string allowed_users entries', () => {
    const result = validate({ channels: { discord: { dm_channel_id: 'D1', allowed_users: ['123456789012345678'] } } });
    expect((result.errors ?? []).filter((e: string) => e.includes('allowed_users'))).toEqual([]);
  });
});

// ============================================================
// Proposal ID scheme (TestProposalIdScheme)
//
// Guards against silent regressions: scripts narrowing the filename regex back
// to the legacy-only form.
// ============================================================

describe('proposal-id scheme', () => {
  const WIDENED_REGEX = String.raw`/^PROP-\d+(?:-.+)?\.md$/`;
  const SCRIPTS_WITH_PROPOSAL_GLOB = ['reflect-precheck.ts', 'weekly-review.ts', 'doctor-check.ts'];

  test('all proposal-scanning scripts must contain the widened filename regex', () => {
    for (const script of SCRIPTS_WITH_PROPOSAL_GLOB) {
      const p = path.join(SCRIPTS, script);
      expect(fs.existsSync(p)).toBe(true);
      // missing → new-format PROP-NNN-slug-HHMMSS.md files silently dropped
      expect(read(p)).toContain(WIDENED_REGEX);
    }
  });


});

// ============================================================
// Analytics skills contract (TestAnalyticsSkillsContract, PROP-038)
//
// Guards against copy-paste drift between the directory name and the
// frontmatter `name` field.
// ============================================================

describe('analytics skills contract', () => {
  const ANALYTICS_SKILLS = ['hermit-evolution', 'hermit-health'];

  function readSkill(slug: string): string {
    const p = path.join(SKILLS, slug, 'SKILL.md');
    expect(fs.existsSync(p)).toBe(true);
    return read(p);
  }

  test('frontmatter name matches directory', () => {
    for (const slug of ANALYTICS_SKILLS) {
      const content = readSkill(slug);
      const parts = split3(content, '---\n');
      expect(parts.length).toBe(3); // missing closing --- of frontmatter
      expect(parts[0]).toBe(''); // content before opening --- delimiter
      const head = parts[1];
      expect(head).toContain(`name: ${slug}`);
      expect(head).toContain('description:');
    }
  });
});

// ============================================================
// Plain spend statement contract (cost-reflect --plain routing)
//
// Guards against a future edit silently reverting a channel cost question to
// the jargon-laden raw table: cost-reflect's channel branch must run --plain
// (the actual no-jargon guarantee on --plain's OUTPUT is verified at runtime in
// cost-reflect-plain.test.ts).
// ============================================================

describe('plain spend statement routing contract', () => {
  const costReflect = read(path.join(SKILLS, 'cost-reflect', 'SKILL.md'));

  test('cost-reflect channel branch runs --plain, not the raw breakdown', () => {
    expect(costReflect).toContain('--plain');
  });
});

// ============================================================
// Kill metrics contract (TestKillMetricsContract)
//
// Guards against the silent breakage where capability-brainstorm (or any future
// brainstorm skill) declares kill criteria that grep for an origin token that no
// writer ever emits. The three emitter shapes and the kill-criteria grep targets
// must stay in sync — so each assertion checks both sides of the contract.
// ============================================================

describe('kill metrics contract', () => {
  const proposalTemplate = read(path.join(TEMPLATES, 'PROPOSAL.md.template'));
  const proposalCreate = read(path.join(SKILLS, 'proposal-create', 'SKILL.md'));
  const capabilityBrainstorm = read(path.join(SKILLS, 'capability-brainstorm', 'SKILL.md'));
  const reportScriptPath = path.join(SCRIPTS, 'lib', 'proposals', 'metrics.ts');
  const reportScript = fs.existsSync(reportScriptPath) ? read(reportScriptPath) : '';

  test('PROPOSAL.md.template must declare a tags field so proposal-create can write it', () => {
    // missing → brainstorm origin can never be preserved in proposal frontmatter
    expect(proposalTemplate).toContain('tags:');
  });

  test('PROPOSAL.md.template must carry a Verification section', () => {
    // missing → proposals ship with no defined success check
    expect(proposalTemplate).toContain('## Verification');
  });

  test('proposal-create triage-verdict event must include evidence_source', () => {
    // missing → triage-survival rate cannot be segmented by brainstorm origin.
    // the gate verb (tests/scripts.test.ts describe('proposal gate')) guards that the
    // flag actually lands in the appended event; this guards the call site passes it.
    expect(proposalCreate).toContain('--evidence-source "<evidence source>"');
  });

  test('proposal-create triage-verdict event must include tags', () => {
    // Tagged candidate classes that share an evidence_source (e.g. procedure-capture)
    // can only segment their triage-survival rate by the tags field on this event.
    expect(proposalCreate).toContain("--tags '[<caller-supplied tags>]'");
  });

  test('proposal-create created event must include tags', () => {
    // missing → PROP-acceptance rate cannot be segmented by brainstorm origin.
    // The `created` event is now built by proposal.ts's create verb rather than
    // composed inline in SKILL.md prose — assert against the actual emitter.
    const proposalScript = read(path.join(SCRIPTS, 'proposal.ts'));
    expect(proposalScript).toMatch(/type:\s*'created'[\s\S]{0,80}\btags\b/);
  });

  test('capability-brainstorm kill criteria must invoke the metrics verb', () => {
    const parts = capabilityBrainstorm.split('## Kill criteria');
    expect(parts.length).toBeGreaterThan(1); // Kill criteria section missing
    const killSection = parts[1].split('## ')[0];
    expect(killSection).toContain('proposal.ts metrics');
  });

  test('proposal.ts metrics segment registry must discriminate capability-brainstorm', () => {
    // The contract between the emitter (proposal-create) and the consumer
    // (brainstorm kill criteria) holds via evidence_source (triage) and tags (acceptance).
    expect(fs.existsSync(reportScriptPath)).toBe(true);
    expect(reportScript).toContain('evidence_source');
    expect(reportScript).toContain("'capability-brainstorm'");
    expect(reportScript).toContain("'procedure-capture'");
  });
});

// ============================================================
// Procedure capture contract (TestProcedureCaptureContract)
//
// Guards against the silent breakage where reflect declares kill criteria that
// grep for a tag token that proposal-create never actually emits. Both sides of
// the contract (emit side = proposal-create; measure side = reflect) are asserted
// in parallel so they can't silently drift. Does NOT simulate the kill verdict.
// ============================================================

describe('procedure capture contract', () => {
  // The Procedure capture subsection lives in reflect's branches.md (the
  // main-session rare-branch procedures file; SKILL.md keeps only the stub).
  const reflectBranches = read(path.join(SKILLS, 'reflect', 'branches.md'));
  const proposalCreate = read(path.join(SKILLS, 'proposal-create', 'SKILL.md'));

  /** Extract the kill-criteria block from the Procedure capture subsection. */
  function procedureCaptureKillSection(): string {
    const parts = reflectBranches.split('### Procedure capture (new-skill creation)');
    expect(parts.length).toBeGreaterThan(1); // subsection missing
    const subsection = parts[1].split('\n## ')[0];
    const killParts = subsection.split('Kill criteria');
    expect(killParts.length).toBeGreaterThan(1); // Kill criteria block missing
    return killParts[1].split('**Detection')[0];
  }

  test('reflect procedure-capture kill criteria must invoke the metrics verb', () => {
    expect(procedureCaptureKillSection()).toContain('`proposal-metrics` (Commands)');
  });

  test('proposal-create Skill Draft variant must set the procedure-capture tag', () => {
    const skillDraftParts = proposalCreate.split('## Skill Draft');
    expect(skillDraftParts.length).toBeGreaterThan(1); // ## Skill Draft variant missing
    const skillDraftSection = skillDraftParts[1].split('\n**For ')[0];
    // missing → acceptance-rate grep in reflect kill criteria will find nothing
    expect(skillDraftSection).toContain('procedure-capture');
  });
});

// ============================================================
// Bootstrap skills (TestBootstrapSkills)
//
// Skills reachable from hermitd-start's bootstrap `steps` are invoked via the
// Skill tool when 2+ steps produce the prose path. Any
// `disable-model-invocation: true` among them silently breaks first boot
// (issue #229). Keep them model-invocable.
// ============================================================

describe('bootstrap skills', () => {
  test('bootstrap skills are model-invocable', () => {
    const BOOTSTRAP_SKILLS = ['heartbeat', 'hermit-routines', 'resident-start'];
    const offenders: string[] = [];
    for (const skill of BOOTSTRAP_SKILLS) {
      const text = read(path.join(SKILLS, skill, 'SKILL.md'));
      if (isModelInvocationDisabled(text)) offenders.push(skill);
    }
    expect(offenders).toEqual([]);
  });
});

// ============================================================
// hermit-settings channel reachability
//
// The skill defines channel branches (Step 0, the quality-gate and
// artifact-authorization `--answer` re-entries channel-responder invokes via
// the Skill tool). disable-model-invocation made all of them unreachable.
// Execution-adjacent writes are held by scripts/settings-gate.ts instead, so
// the flag must not come back.
// ============================================================

describe('hermit-settings channel reachability', () => {
  const text = read(path.join(SKILLS, 'hermit-settings', 'SKILL.md'));

  test('is model-invocable, so its channel re-entries can run', () => {
    // Broader than isModelInvocationDisabled on purpose: any value of the key
    // here is a mistake, not just `true`.
    expect(frontmatterBlock(text)).not.toContain('disable-model-invocation');
  });
});

// ============================================================
// Model-invocable inventory
//
// disable-model-invocation is a reachability flag, not a security control — the
// guards above exist because both times it was applied to a machine-invoked
// skill it silently broke a path.
//
// What the flag actually selects is the AUDIENCE, not the authority: a flagged
// skill stays reachable from a terminal and from the Claude app (both parse a
// typed `/name`), and becomes unreachable from Discord/Telegram, where a channel
// message arrives as plain prompt text and the model can only satisfy `/name` by
// calling the Skill tool. It also drops the skill's description from the
// always-loaded context.
//
// So a skill may carry it only when NOTHING but a human invokes it. Watch for the
// non-obvious caller: a skill that ends by printing `/other-skill` as a handoff is
// a Skill-tool caller, because the harness does not parse an emitted slash command
// — the model delegates. hatch used to chain /docker-setup that way; that chain was
// removed, which is what freed docker-setup to carry the flag.
//
// Asserting the whole inventory (rather than the flagged skills alone) is what
// catches the flag spreading to a skill a routine or another skill reaches for.
// ============================================================

describe('model-invocable inventory', () => {
  test('only the operator-invoked wizards have model invocation disabled', () => {
    // Sorted: readdirSync returns directory order, which is arbitrary.
    const flagged = fs.readdirSync(SKILLS).filter((dir) => {
      const skillPath = path.join(SKILLS, dir, 'SKILL.md');
      return fs.existsSync(skillPath)
        && isModelInvocationDisabled(fs.readFileSync(skillPath, 'utf8'));
    }).sort();
    expect(flagged).toEqual(['channel-setup', 'docker-security', 'docker-setup', 'hatch', 'rc-gate']);
  });
});

// ============================================================
// channel-setup empty-channels branch (TestChannelSetupEmptyChannels)
//
// channel-setup used to hard-stop on `channels: {}` and point at
// /hermit-settings, which then carried disable-model-invocation and therefore
// could not be reached from a skill — leaving the operator to type it. The
// skill now creates the entry itself via hatch-config.ts --reinit.
//
// Coverage note: this is a static text scan of SKILL.md. It proves the
// writer is named, not that the model follows the branch; that needs a
// live probe.
// ============================================================

describe('channel-setup empty-channels branch', () => {
  const text = read(path.join(SKILLS, 'channel-setup', 'SKILL.md'));

  test('creates the entry through hatch-config.ts --reinit, discarding stdout', () => {
    expect(text).toContain('hatch-config.ts');
    expect(text).toContain('--reinit');
    // hatch-config prints the whole config on success; skills must not ingest it.
    expect(text).toContain('--reinit >/dev/null');
  });
});

// ============================================================
// channel-setup docker routing (static SKILL.md scan, not a live probe)
// ============================================================

describe('channel setup ownership', () => {
  const channelSetup = read(path.join(SKILLS, 'channel-setup', 'SKILL.md'));
  const dockerSetup = read(path.join(SKILLS, 'docker-setup', 'SKILL.md'));

  const settings = read(path.join(SKILLS, 'hermit-settings', 'SKILL.md'));
  const questionnaire = read(path.join(SKILLS, 'channel-setup', 'references', 'group-enrollment.md'));

  test('one questionnaire owns group enrollment in all three flows', () => {
    expect(questionnaire.match(/Mention required/g)).toHaveLength(1);
    for (const skill of [channelSetup, dockerSetup, settings]) {
      expect(skill).not.toContain('Mention required');
      expect(skill).toContain('group-enrollment.md');
      expect(skill).not.toContain('save access.json to');
      expect(skill).not.toMatch(/echo[^\n]*passive_chats":/);
      const lines = skill.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('access.json')) {
          expect(lines.slice(Math.max(0, i - 5), i + 6).join('\n')).not.toContain('Edit');
        }
      }
    }
    expect(fs.existsSync(path.join(SCRIPTS, ['channel', 'pair.ts'].join('-')))).toBe(false);
    expect(settings).toContain('Never call `AskUserQuestion` on a channel-tagged turn');
  });

  test('keeps a live host tmux hermit on the local flow', () => {
    expect(channelSetup).toContain('liveOwner');
  });

  test('names the hermit command for each Docker host state', () => {
    expect(channelSetup).toContain('hermitd restart');
    expect(channelSetup).toContain('hermitd start');
    expect(channelSetup).toContain('hermitd docker logs');
  });
});

// ============================================================
// Stop payload snapshot (TestStopPayloadSnapshot)
//
// stop-pipeline.ts writes state/cc-stop-snapshot.json from the Stop payload.
// Guards against: snapshot not written, wrong tri-state, absent fields, or
// missing captured_at. Also exercises checkScheduler() via doctor-check.ts.
// ============================================================

describe('stop payload snapshot', () => {
  const runStopPipeline = (dir: string, payload: any) =>
    runScript('stop-pipeline.ts', {
      stdin: JSON.stringify(payload), cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
    });

  /** Seed the minimal state/ layout so stop-pipeline doesn't error on missing files. */
  function seedHermitState(dir: string): void {
    fs.mkdirSync(path.join(dir, '.hermit', 'state'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.hermit', 'sessions'), { recursive: true });
  }

  const snapPath = (dir: string) =>
    path.join(dir, '.hermit', 'state', 'cc-stop-snapshot.json');

  const checkById = (report: any, id: string) =>
    Object.fromEntries((report.checks ?? []).map((c: any) => [c.id, c]))[id];

  test('session_crons present → snapshot written with state=populated', withTmpdir(async (dir) => {
    seedHermitState(dir);
    const fixture = readJson(path.join(fixturesDir, 'stop-hook-input-with-scheduler.json'));
    const r = await runStopPipeline(dir, fixture);
    expect(r.exitCode).toBe(0);

    expect(fs.existsSync(snapPath(dir))).toBe(true);
    const snap = readJson(snapPath(dir));
    expect(snap).toContainKey('captured_at');
    expect(typeof snap.captured_at).toBe('string');
    expect(snap.session_crons.state).toBe('populated');
    expect(snap.session_crons.count).toBe(2);
    expect(snap.background_tasks.state).toBe('empty');
    expect(snap.background_tasks.count).toBe(0);
  }), 20000);

  test('no session_crons/background_tasks in payload → unsupported_or_unreachable', withTmpdir(async (dir) => {
    seedHermitState(dir);
    const fixture = readJson(path.join(fixturesDir, 'stop-hook-input.json'));
    const r = await runStopPipeline(dir, fixture);
    expect(r.exitCode).toBe(0);

    expect(fs.existsSync(snapPath(dir))).toBe(true);
    const snap = readJson(snapPath(dir));
    expect(snap.session_crons.state).toBe('unsupported_or_unreachable');
    expect(snap.background_tasks.state).toBe('unsupported_or_unreachable');
  }), 20000);

  test('unsupported_or_unreachable must NEVER appear as count-based "0" in doctor', withTmpdir(async (dir) => {
    seedHermitState(dir);
    const snap = {
      captured_at: '2026-06-10T09:00:00Z',
      cc_version: null,
      session_crons: { state: 'unsupported_or_unreachable', count: 0 },
      background_tasks: { state: 'empty', count: 0 },
    };
    fs.writeFileSync(snapPath(dir), JSON.stringify(snap));
    writeConfig(dir, {});
    const report = await runDoctorCheck(dir);
    const scheduler = checkById(report, 'scheduler');
    expect(scheduler).toBeDefined();
    // Must say "unsupported or unreachable", not "0 crons" or "0 armed"
    expect(scheduler.detail.toLowerCase()).toContain('unsupported');
  }), 20000);

  test("missing snapshot → ok + 'not yet captured'", withTmpdir(async (dir) => {
    seedHermitState(dir);
    writeConfig(dir, {});
    const report = await runDoctorCheck(dir);
    const scheduler = checkById(report, 'scheduler');
    expect(scheduler).toBeDefined();
    expect(scheduler.status).toBe('ok');
    expect(scheduler.detail).toContain('not yet captured');
  }), 20000);

  test('populated snapshot → ok, detail includes count and captured_at', withTmpdir(async (dir) => {
    seedHermitState(dir);
    const snap = {
      captured_at: '2026-06-10T09:51:00Z',
      cc_version: '2.1.145',
      session_crons: { state: 'populated', count: 3 },
      background_tasks: { state: 'empty', count: 0 },
    };
    fs.writeFileSync(snapPath(dir), JSON.stringify(snap));
    writeConfig(dir, {});
    const report = await runDoctorCheck(dir);
    const scheduler = checkById(report, 'scheduler');
    expect(scheduler).toBeDefined();
    expect(scheduler.status).toBe('ok');
    expect(scheduler.detail).toContain('3');
    expect(scheduler.detail).toContain('2026-06-10');
  }), 20000);
});

// ============================================================
// hermit-routines plugin-root resolution contract (TestHermitRoutinesPluginRootContract)
//
// Guards against the `echo $CLAUDE_PLUGIN_ROOT` pattern being reintroduced.
// That bare env-var form always returns empty at Bash runtime (in all modes),
// causing load to abort and leaving all CronCreates unregistered. The
// fix uses harness-substituted paths and copies them into cron prompts.
// ============================================================

describe('hermit-routines plugin-root resolution contract', () => {
  const skillContent = read(path.join(SKILLS, 'hermit-routines', 'SKILL.md'));

  test('SKILL.md uses braced plugin-root paths, not echo $CLAUDE_PLUGIN_ROOT', () => {
    expect(skillContent).toContain('test -f "${CLAUDE_PLUGIN_ROOT}/scripts/routines.ts"');
    expect(skillContent).not.toContain('echo $CLAUDE_PLUGIN_ROOT');
  });
});

// ============================================================
// hermit-routines diff-registration contract (TestHermitRoutinesCronRegistryContract)
//
// Guards the `load` success path against regressing back to an unconditional
// CronList/CronDelete-all/CronCreate-all sweep on every call. That sweep was
// replaced by cron-registry.ts's plan/commit diff (see scripts/cron-registry.ts
// and its own test file, tests/cron-registry.test.ts, for the planner's pure
// logic); `load --reset` keeps the old unconditional sweep as an explicit,
// operator-invoked escape hatch — only the *default* path must not silently
// regress to it.
// ============================================================

describe('hermit-routines diff-registration contract', () => {
  const skillContent = read(path.join(SKILLS, 'hermit-routines', 'SKILL.md'));

  test('SKILL.md wires the arm verbs into load\'s success path', () => {
    expect(skillContent).toContain('routines.ts arm begin');
    expect(skillContent).toContain('routines.ts arm commit');
  });

  // The saving is entirely in this branch: a healthy monitor must cost one script
  // call and a log line, not a teardown-and-rebuild the operator pays for daily.
  test('SKILL.md documents the HEALTHY fast path as a full stop', () => {
    expect(skillContent).toContain('HEALTHY|routines=');
    expect(skillContent).toContain('**Log that one line and stop.**');
  });

  test('SKILL.md documents the KEEP-only fast path (no CronList/CronCreate/CronDelete)', () => {
    expect(skillContent).toContain('KEEP:<n>');
    expect(skillContent).toContain('No `CronList`, no `CronCreate`, no `CronDelete` this run');
  });

  test('SKILL.md documents load --reset as the unconditional escape hatch', () => {
    expect(skillContent).toContain('load --reset');
    expect(skillContent).toContain('--reset');
  });

  // The anchor's prompt is what makes tomorrow's fire short-circuit, and the
  // planner's promptHash is computed over the rendered text — a model-composed
  // one drifts and re-registers the anchor every day.
  test('SKILL.md uses the script-rendered anchor prompt verbatim', () => {
    expect(skillContent).toContain('ANCHOR_PROMPT_BEGIN');
    expect(skillContent).toContain('ANCHOR_PROMPT_END');
  });

  // Fallback-mode operational detail lives in reference.md, which `load` does not
  // read on the boot path — the contract is that the skill documents it somewhere,
  // not that the boot path carries it.
  test('the skill documents the boot-id mirror-invalidation mechanism', () => {
    const reference = read(path.join(SKILLS, 'hermit-routines', 'reference.md'));
    expect(skillContent + reference).toContain('.boot-id');
  });
});

// ============================================================
// Gate-agent memory contract (TestGateAgentMemoryContract)
//
// Gate agents (proposal-triage, reflection-judge) must declare memory: project.
// Guards against the frontmatter key being accidentally dropped, since it enables
// persistent heuristic accumulation across invocations (17.3 gate-agent memory).
// ============================================================

describe('gate-agent memory contract', () => {
  const GATE_AGENTS = ['proposal-triage', 'reflection-judge'];

  test('gate agents declare memory: project', () => {
    for (const name of GATE_AGENTS) {
      expect(agentFrontmatter(name)).toContain('memory: project');
    }
  });

  test('memory curation needs Write/Edit granted and out of disallowedTools', () => {
    // A silent revert of the tool grant breaks curation just as badly as
    // dropping the memory key, so guard it explicitly.
    for (const name of GATE_AGENTS) {
      const head = agentFrontmatter(name);
      expect(head).toContain('disallowedTools:');
      const idx = head.indexOf('disallowedTools:');
      const tools = head.slice(0, idx);
      const disallowed = head.slice(idx + 'disallowedTools:'.length);
      for (const tool of ['Write', 'Edit']) {
        expect(tools).toContain(`- ${tool}\n`);
        expect(disallowed).not.toContain(`- ${tool}\n`);
      }
    }
  });

  // Consumer half of proposal.ts's `Anchor:` line. A relative `.hermit/` path in
  // a gate resolves to a worktree projection with no state/, so dedup sees nothing.
  test('gate agents read the Anchor: line, fail closed as GATE_BLIND, and never use a relative .hermit/ path', () => {
    for (const name of GATE_AGENTS) {
      const body = read(path.join(AGENTS, `${name}.md`));
      expect(body).toContain('Anchor:');
      expect(body).toContain('GATE_BLIND');
      expect(body).not.toContain('.hermit/');
    }
    for (const caller of [['proposal-create', 'SKILL.md'], ['reflect', 'branches.md'], ['reflect', 'SKILL.md']]) {
      expect(read(path.join(SKILLS, ...caller))).toContain('Anchor:');
    }
  });
});

// ============================================================
// hermit-evolve delegation contract (TestEvolveRunnerRoutingContract)
//
// hermit-evolve delegates steps 0–9 to the evolve-runner subagent. Guards
// against: the agent reference losing its namespace (bare names fail with
// "Agent type not found") and evolve-runner gaining tools it must not have (Agent →
// recursion; web/channel → the subagent must not notify, step 10 owns that).
// ============================================================

describe('hermit-evolve delegation contract', () => {
  const skill = read(path.join(SKILLS, 'hermit-evolve', 'SKILL.md'));

  test('SKILL.md dispatches evolve-runner fully-qualified', () => {
    expect(skill).toContain('hermitd:evolve-runner');
  });

  // Consumer half of `routines.ts arm`'s restart verdict.
  test('SKILL.md branches on the arm restart verdict', () => {
    expect(skill).toContain('RESTART_REQUIRED|command-drift');
  });

  test('evolve-runner omits Agent, web, and channel/MCP tools', () => {
    const head = agentFrontmatter('evolve-runner');
    expect(head).toContain('disallowedTools:');
    const idx = head.indexOf('disallowedTools:');
    const granted = head.slice(0, idx);
    // Agent must not be granted (recursion); web tools must not be granted.
    for (const tool of ['Agent', 'WebSearch', 'WebFetch']) {
      expect(granted).not.toContain(`- ${tool}\n`);
    }
    // No channel/MCP tools — the subagent must not notify.
    expect(granted).not.toContain('mcp__');
  });

  test('evolve-runner declares no memory (non-gate agent)', () => {
    expect(agentFrontmatter('evolve-runner')).not.toContain('memory:');
  });

  test('report contract is identical in evolve-runner.md and SKILL.md', () => {
    // The report format is duplicated: the agent emits it, step 10 parses it.
    // Drift between the two copies would desync producer and consumer.
    const block = (text: string) => extractBlock(text, 'Upgrade: vOLD -> vNEW', '--- end ---');
    const agent = read(path.join(AGENTS, 'evolve-runner.md'));
    expect(block(agent)).toBe(block(skill));
  });

  test('evolve-runner reads reference.md, not SKILL.md, for steps 0-9', () => {
    // Unlike the generic skill-eval-runner dispatchers (reflect/brief/weekly-review),
    // evolve-runner is a dedicated agent that hard-codes the file it reads — so this
    // guards the one place a stale "Read .../SKILL.md" instruction would silently
    // leave the runner executing pre-split steps that no longer live there.
    const agent = read(path.join(AGENTS, 'evolve-runner.md'));
    expect(agent).toContain('hermit-evolve/reference.md');
  });

  test('hermit-evolve/reference.md exists', () => {
    expect(fs.existsSync(path.join(SKILLS, 'hermit-evolve', 'reference.md'))).toBe(true);
  });

  test('SKILL.md guards reference.md before dispatch', () => {
    // reference.md is load-bearing for evolve-runner post-split; a guard that only
    // checks SKILL.md would dispatch into a broken read if reference.md were missing.
    expect(skill).toContain('test -f "${CLAUDE_PLUGIN_ROOT}/skills/hermit-evolve/reference.md"');
    expect(skill).toContain('skills/hermit-evolve/reference.md');
  });
});

// ============================================================
// reflect delegation contract (TestReflectDelegationContract)
//
// reflect dispatches the cross-session file analysis (Resolution Check, routine
// check, procedure detection) to skill-eval-runner, a shared read-only runner.
// Guards against: losing the fully-qualified agent reference, skill-eval-runner
// re-coupling to a single skill or hardcoding a hermit state path, the
// no-memory and no-model-override invariants being dropped (non-gate agent), and
// producer/consumer schema drift between reference.md and SKILL.md.
// ============================================================

describe('reflect delegation contract', () => {
  const skill = read(path.join(SKILLS, 'reflect', 'SKILL.md'));
  const refFile = read(path.join(SKILLS, 'reflect', 'reference.md'));

  test('SKILL.md dispatches skill-eval-runner fully-qualified with reference.md', () => {
    expect(skill).toContain('hermitd:skill-eval-runner');
    expect(skill).toContain('skills/reflect/reference.md');
  });

  test('SKILL.md points at branches.md for rare-branch procedures', () => {
    // branches.md is load-bearing post-split: candidate processing, scheduled
    // checks, and procedure capture live there. A stub that loses the pointer
    // would strand those flows.
    expect(skill).toContain('skills/reflect/branches.md');
  });

  test('skill-eval-runner declares no memory and no model override', () => {
    // Non-gate agent; inherits the session model rather than pinning one.
    const head = agentFrontmatter('skill-eval-runner');
    expect(head).not.toContain('memory:');
    expect(head).not.toContain('model:');
  });

  test('schema block is byte-identical in reference.md and SKILL.md', () => {
    const block = (text: string) => extractBlock(text, '<!-- reflect-eval-schema:start -->', '<!-- reflect-eval-schema:end -->');
    expect(block(refFile)).toBe(block(skill));
  });

  test('nudge write-back uses top-level last_sparse_nudge, not a per-entry field', () => {
    // Producer and consumer must agree on the nudge-debounce write-back field.
    // The runner returns nudge timestamps in the top-level `last_sparse_nudge` map;
    // a stray per-entry `last_sparse_nudge_update` would never reach reflection-state.json.
    expect(refFile).not.toContain('last_sparse_nudge_update');
    expect(refFile).toContain('last_sparse_nudge');
    expect(skill).toContain('last_sparse_nudge');
  });
});

// ============================================================
// weekly-review delegation contract (TestWeeklyReviewDelegationContract)
//
// weekly-review dispatches the topic-page semantic check (Step 3) to
// skill-eval-runner to keep full topic-page bodies off the main session.
// Guards against: losing the fully-qualified agent reference, and
// producer/consumer schema drift between reference.md and SKILL.md.
// Generic skill-eval-runner invariants (stays generic, no memory/model override)
// are already covered by the reflect delegation contract above.
// ============================================================

describe('weekly-review delegation contract', () => {
  const skill = read(path.join(SKILLS, 'weekly-review', 'SKILL.md'));
  const refFile = read(path.join(SKILLS, 'weekly-review', 'reference.md'));

  test('SKILL.md dispatches skill-eval-runner fully-qualified with reference.md', () => {
    expect(skill).toContain('hermitd:skill-eval-runner');
    expect(skill).toContain('skills/weekly-review/reference.md');
  });

  test('schema block is byte-identical in reference.md and SKILL.md', () => {
    const block = (text: string) => extractBlock(text, '<!-- weekly-review-eval-schema:start -->', '<!-- weekly-review-eval-schema:end -->');
    expect(block(refFile)).toBe(block(skill));
  });

  // The renderer's page id is `weekly` (artifact.ts PAGES); `weekly_review` is
  // only the config/state key. A skill that names the gate but not the verb
  // leaves the model to guess, and the guess fails closed with no page published.
  test('SKILL.md names the weekly render verb literally', () => {
    expect(skill).toContain('scripts/artifact.ts render weekly .hermit');
    expect(skill).not.toMatch(/render (weekly_review|weekly-review)/);
  });

  // One dispatch covers both specs: a second one costs another CLAUDE.md
  // re-seed plus two more main turns at full resident context.
  test('SKILL.md dispatches the runner exactly once', () => {
    // Count every phrasing a re-split could use ("Dispatch"/"dispatch"/"invoke"
    // `hermitd:skill-eval-runner`), not just the one written today —
    // sibling skills already use "invoke" (skills/brief/SKILL.md).
    const hits = skill.match(/`hermitd:skill-eval-runner`/g) || [];
    expect(hits.length).toBe(1);
    expect(skill).toContain('skills/weekly-review/consolidation-reference.md');
  });
});

// ============================================================
// weekly-review consolidation delegation contract (PROP-010)
//
// weekly-review folds channel-log consolidation into its single
// skill-eval-runner dispatch, and the runner files its own candidates in that
// isolated context (the main session only marks, prunes, and logs the receipt).
// Guards against: losing the fully-qualified agent reference and
// producer/consumer schema drift between consolidation-reference.md and SKILL.md.
// ============================================================

describe('weekly-review consolidation delegation contract', () => {
  const skill = read(path.join(SKILLS, 'weekly-review', 'SKILL.md'));
  const refFile = read(path.join(SKILLS, 'weekly-review', 'consolidation-reference.md'));

  test('SKILL.md dispatches skill-eval-runner fully-qualified with consolidation-reference.md', () => {
    expect(skill).toContain('hermitd:skill-eval-runner');
    expect(skill).toContain('skills/weekly-review/consolidation-reference.md');
  });

  test('schema block is byte-identical in consolidation-reference.md and SKILL.md', () => {
    const block = (text: string) => extractBlock(text, '<!-- weekly-review-consolidation-schema:start -->', '<!-- weekly-review-consolidation-schema:end -->');
    expect(block(refFile)).toBe(block(skill));
  });
});

// ============================================================
// External-origin quarantine contract (TestExternalOriginQuarantineContract)
//
// Guards against the ROP-001 class of drift where a security rule is added to
// one file but not the others — e.g. reflect sets Evidence Origin but judge
// never reads it.
// ============================================================

describe('external-origin quarantine contract', () => {
  const judge = read(path.join(AGENTS, 'reflection-judge.md'));
  const triage = read(path.join(AGENTS, 'proposal-triage.md'));
  const proposalCreate = read(path.join(SKILLS, 'proposal-create', 'SKILL.md'));

  test('reflection-judge must document the quarantine escalation and reason phrase', () => {
    expect(judge).toContain('external-content');
    expect(judge).toContain('quarantine');
    expect(judge).toContain('Evidence Origin');
  });

  test('proposal-triage must document the Evidence Origin field', () => {
    expect(triage).toContain('external-content');
    expect(triage).toContain('Evidence Origin');
  });

  test('proposal-create must thread Evidence Origin through its Pre-Creation Gate', () => {
    expect(proposalCreate).toContain('external-content');
    expect(proposalCreate).toContain('Evidence Origin');
  });
});

// ============================================================
// template-manifest.json shape contract (TestTemplateManifestContract)
//
// doctor-check.ts must detect missing, malformed, and invalid manifests without
// crashing. Guards against silent regressions in the shape-check added for
// PROP-001 (customization-aware template/bin updates).
// ============================================================

describe('template-manifest doctor contract', () => {
  const EXPECTED_STUB_FILES = [
    'alert-state.json', 'reflection-state.json', 'runtime.json', 'monitors.runtime.json',
  ];

  /** Seed a minimal .hermit/state/ with all expected files. */
  function seedState(dir: string, manifestContent?: string | null): void {
    const stateDir = path.join(dir, '.hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    for (const f of EXPECTED_STUB_FILES) {
      fs.writeFileSync(path.join(stateDir, f), '{}');
    }
    if (manifestContent !== null) {
      const content = manifestContent !== undefined
        ? manifestContent
        : JSON.stringify({ version: 1, files: {
            'templates/HEARTBEAT.md.template': { sha256: 'a'.repeat(64), plugin_version: '1.2.0' },
          }});
      fs.writeFileSync(path.join(stateDir, 'template-manifest.json'), content);
    }
  }

  const stateCheck = (report: any) =>
    (report.checks ?? []).find((c: any) => c.id === 'state');

  test('valid manifest → state check ok', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    seedState(dir);
    const report = await runDoctorCheck(dir);
    const s = stateCheck(report);
    expect(s).toBeDefined();
    expect(s.status).toBe('ok');
  }), 20000);

  test('manifest absent → state check warns, names template-manifest.json', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    seedState(dir, null); // do not write manifest
    const report = await runDoctorCheck(dir);
    const s = stateCheck(report);
    expect(s).toBeDefined();
    expect(s.status).toBe('warn');
    expect(s.detail).toContain('template-manifest.json');
  }), 20000);

  test('manifest without files object → state check fails', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    seedState(dir, JSON.stringify({ version: 1 })); // files key absent
    const report = await runDoctorCheck(dir);
    const s = stateCheck(report);
    expect(s).toBeDefined();
    expect(s.status).toBe('fail');
    expect(s.detail).toContain('template-manifest.json');
  }), 20000);

  test('manifest entry with invalid sha256 → state check fails with key name', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    seedState(dir, JSON.stringify({ version: 1, files: {
      'templates/HEARTBEAT.md.template': { sha256: 'not-a-hash', plugin_version: '1.2.0' },
    }}));
    const report = await runDoctorCheck(dir);
    const s = stateCheck(report);
    expect(s).toBeDefined();
    expect(s.status).toBe('fail');
    expect(s.detail).toContain('templates/HEARTBEAT.md.template');
  }), 20000);

  test('docker deployed but no template baselines → state warns', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    seedState(dir); // default manifest: templates key only, no docker/
    fs.writeFileSync(path.join(dir, 'docker-compose.hermit.yml'), 'services: {}\n');
    const report = await runDoctorCheck(dir);
    const s = stateCheck(report);
    expect(s).toBeDefined();
    expect(s.status).toBe('warn');
    expect(s.detail).toContain('docker');
  }), 20000);

  test('docker deployed + ONLY entrypoint baseline (evolve wrote it, docker-setup did not) → still warns', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    // Step 5c writes the entrypoint key independently of docker-setup; that alone must
    // NOT suppress the warn — the F2 compose/Dockerfile baselines are still missing.
    seedState(dir, JSON.stringify({ version: 1, files: {
      'templates/HEARTBEAT.md.template': { sha256: 'a'.repeat(64), plugin_version: '1.2.0' },
      'docker/docker-entrypoint.hermit.sh': { sha256: 'b'.repeat(64), plugin_version: '1.2.0' },
    }}));
    fs.writeFileSync(path.join(dir, 'docker-compose.hermit.yml'), 'services: {}\n');
    const report = await runDoctorCheck(dir);
    const s = stateCheck(report);
    expect(s).toBeDefined();
    expect(s.status).toBe('warn');
  }), 20000);

  test('docker deployed WITH compose/Dockerfile template baselines → state ok', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    seedState(dir, JSON.stringify({ version: 1, files: {
      'templates/HEARTBEAT.md.template': { sha256: 'a'.repeat(64), plugin_version: '1.2.0' },
      'docker/docker-compose.hermit.yml.template': { sha256: 'b'.repeat(64), plugin_version: '1.2.0' },
      'docker/Dockerfile.hermit.template': { sha256: 'c'.repeat(64), plugin_version: '1.2.0' },
    }}));
    fs.writeFileSync(path.join(dir, 'docker-compose.hermit.yml'), 'services: {}\n');
    const report = await runDoctorCheck(dir);
    const s = stateCheck(report);
    expect(s).toBeDefined();
    expect(s.status).toBe('ok');
  }), 20000);
});

// ============================================================
// brief delegation contract (TestBriefDelegationContract)
//
// brief dispatches archived-report/cost/proposal reads to the shared
// skill-eval-runner. Guards against: losing the fully-qualified agent reference
// and producer/consumer schema drift between reference.md and SKILL.md.
// ============================================================

describe('brief delegation contract', () => {
  const skill = read(path.join(SKILLS, 'brief', 'SKILL.md'));
  const refFile = read(path.join(SKILLS, 'brief', 'reference.md'));

  test('SKILL.md dispatches skill-eval-runner fully-qualified with reference.md', () => {
    expect(skill).toContain('hermitd:skill-eval-runner');
    expect(skill).toContain('skills/brief/reference.md');
  });

  test('schema block is byte-identical in reference.md and SKILL.md', () => {
    const block = (text: string) => extractBlock(text, '<!-- brief-eval-schema:start -->', '<!-- brief-eval-schema:end -->');
    expect(block(refFile)).toBe(block(skill));
  });
});

// ============================================================
// hermit-evolution delegation contract (TestHermitEvolutionDelegationContract)
//
// hermit-evolution dispatches the weekly-review / session-report / proposal-metrics
// reads (and bun script runs) to skill-eval-runner to keep that heavy context
// off the main session.
// Guards against: losing the fully-qualified agent reference and
// producer/consumer schema drift between reference.md and SKILL.md.
// ============================================================

describe('hermit-evolution delegation contract', () => {
  const skill = read(path.join(SKILLS, 'hermit-evolution', 'SKILL.md'));
  const refFile = read(path.join(SKILLS, 'hermit-evolution', 'reference.md'));

  test('SKILL.md dispatches skill-eval-runner fully-qualified with reference.md', () => {
    expect(skill).toContain('hermitd:skill-eval-runner');
    expect(skill).toContain('skills/hermit-evolution/reference.md');
  });

  test('schema block is byte-identical in reference.md and SKILL.md', () => {
    const block = (text: string) => extractBlock(text, '<!-- hermit-evolution-eval-schema:start -->', '<!-- hermit-evolution-eval-schema:end -->');
    expect(block(refFile)).toBe(block(skill));
  });
});

// ============================================================
// capability-brainstorm delegation contract (TestCapabilityBrainstormDelegationContract)
//
// capability-brainstorm dispatches the memory / compiled-artifact / codebase reads
// (and idea generation) to skill-eval-runner. Harness-context signals (skills list,
// MCPs, channels) are gathered in main and passed via the dispatch prompt.
// Guards against: losing the fully-qualified agent reference and
// producer/consumer schema drift between reference.md and SKILL.md.
// ============================================================

describe('capability-brainstorm delegation contract', () => {
  const skill = read(path.join(SKILLS, 'capability-brainstorm', 'SKILL.md'));
  const refFile = read(path.join(SKILLS, 'capability-brainstorm', 'reference.md'));

  test('SKILL.md dispatches skill-eval-runner fully-qualified with reference.md', () => {
    expect(skill).toContain('hermitd:skill-eval-runner');
    expect(skill).toContain('skills/capability-brainstorm/reference.md');
  });

  test('schema block is byte-identical in reference.md and SKILL.md', () => {
    const block = (text: string) => extractBlock(text, '<!-- brainstorm-eval-schema:start -->', '<!-- brainstorm-eval-schema:end -->');
    expect(block(refFile)).toBe(block(skill));
  });
});

// ============================================================
// proposal-act dispatch contract (TestProposalActDispatchContract)
//
// Step (e) dispatches the WHOLE implementation tail (implement → quality gate →
// verification) to general-purpose when the falsification gate returned PROCEED and
// there is no in-main skill handler. Main only resolves + notifies on a verified
// return. The dispatch prompt is the contract — guard its key invariants so they
// can't silently drift.
// ============================================================

describe('proposal-act dispatch contract', () => {
  const skill = PROPOSAL_ACT;

  test('dispatch prompt defines the six-field structured return shape', () => {
    // missing → resolve/notify branch and escalation relay have no defined source fields
    expect(skill).toContain('Status: implemented | escalated | blocked:');
    expect(skill).toContain('Touched files:');
    expect(skill).toContain('Tests run:');
    expect(skill).toContain('Quality gate:');
    expect(skill).toContain('Verification: passed | failed:');
    expect(skill).toContain('Deferred for operator:');
  });
});

describe('reflect routine gating contract (token efficiency)', () => {
  // The reflect routine's CronCreate prompt must run the precheck in bash and
  // hand the verdict to reflect via --precheck-verdict, so EMPTY days never load
  // reflect's body. Both sides of that handoff must stay wired.
  test('hermit-routines documents the reflect precheck-gated prompt', () => {
    const routines = read(path.join(SKILLS, 'hermit-routines', 'SKILL.md'));
    expect(routines).toContain('reflect-precheck.ts');
    expect(routines).toContain('--precheck-verdict');
  });

  test('reflect accepts the --precheck-verdict handoff', () => {
    const reflect = read(path.join(SKILLS, 'reflect', 'SKILL.md'));
    expect(reflect).toContain('--precheck-verdict');
  });
});

// ============================================================
// PROP-018: proactive doctor — report shape, doc-count sync, new checks
// ============================================================

const DOCTOR_CHECK_IDS = [
  'runtime', 'config', 'hooks', 'state', 'cost', 'proposals', 'dependencies', 'version-currency',
  'permissions', 'permission-rules', 'docker-security', 'reflect', 'scheduler', 'watchdog', 'context-age',
  'opus-wake', 'routine-cost', 'heartbeat', 'routine-monitor', 'routine-precheck', 'raw-size', 'credential-expiry', 'model-pricing-known',
  'memory-size', 'passive-chats', 'context-scan', 'voice-carrier', 'overlay-hooks', 'harness-mod', 'classifier-denials', 'channel-liveness', 'peer-inbox',
  'backup',
];

describe('doctor report contract (PROP-018 count pin)', () => {
  test('report emits exactly the pinned check ids, in order', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const report = await runDoctorCheck(dir);
    expect((report.checks ?? []).map((c: any) => c.id)).toEqual(DOCTOR_CHECK_IDS);
  }), 20000);
});

describe('hermit-doctor reference.md doc-sync (no drift between JSON checks and docs)', () => {
  const skill = read(path.join(SKILLS, 'hermit-doctor', 'SKILL.md'));
  const reference = read(path.join(SKILLS, 'hermit-doctor', 'reference.md'));

  test('SKILL.md points at reference.md for per-check semantics', () => {
    expect(skill).toContain('`${CLAUDE_SKILL_DIR}/reference.md`');
  });

  test('every JSON check id appears as a table row in reference.md', () => {
    const missing = DOCTOR_CHECK_IDS.filter(id => !reference.includes(`| \`${id}\` |`));
    expect(missing).toEqual([]);
  });
});

// The seam the rest of this file's doctor cases ride on: a check takes its paths as
// an argument, so one check runs against one scratch dir without a subprocess and
// without the module ever seeing that dir in argv. Without this, nothing fails when
// a check quietly goes back to closing over module-level constants.
describe('doctor per-check seam', () => {
  // Asserts path routing, not config validity — a check reads the dir it was handed,
  // so the schema can gain required keys without this case going red.
  test('one check, two scratch dirs, one process — each reads the dir it was handed',
    withTmpdir(async (seeded) => {
      writeConfig(seeded, {});                              // config.json exists (contents irrelevant here)
      const empty = makeTmpdir();                             // .hermit/ exists, no config.json in it
      try {
        const at = (d: string) => checkConfig(resolvePaths(path.join(d, '.hermit'), PLUGIN_ROOT));

        expect(at(seeded).detail).not.toContain('not found');
        const missing = at(empty);
        expect(missing.id).toBe('config');
        expect(missing.status).toBe('fail');
        expect(missing.detail).toContain('not found');
      } finally {
        try { fs.rmSync(empty, { recursive: true, force: true }); } catch {}
      }
    }));
});

describe('doctor version-currency check', () => {
  const vcCheck = (report: any) => (report.checks ?? []).find((c: any) => c.id === 'version-currency');
  const coreManifest = readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'));
  const installedVersion: string = coreManifest.version;
  const coreName: string = coreManifest.name;

  test('no marketplace cache configured → ok', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const report = await runDoctorCheck(dir);
    const c = vcCheck(report);
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('no marketplace cache');
  }), 20000);

  test('marketplace cache lists no matching plugin entry → ok, no comparable entry', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const mpFile = path.join(dir, 'marketplace.json');
    fs.writeFileSync(mpFile, JSON.stringify({ plugins: [] }));
    const r = await runScript('doctor-check.ts', {
      args: ['.hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, HERMIT_DOCTOR_MARKETPLACE_FILE: mpFile },
    });
    const c = vcCheck(JSON.parse(r.stdout));
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('no comparable version entry');
  }), 20000);

  test('marketplace cache lists the same version → ok, no newer version', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const mpFile = path.join(dir, 'marketplace.json');
    fs.writeFileSync(mpFile, JSON.stringify({ plugins: [{ name: coreName, version: installedVersion }] }));
    const r = await runScript('doctor-check.ts', {
      args: ['.hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, HERMIT_DOCTOR_MARKETPLACE_FILE: mpFile },
    });
    const c = vcCheck(JSON.parse(r.stdout));
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('no newer version');
  }), 20000);

  test('marketplace cache lists a newer version, no Fixed entries in range → warn, not escalated', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const mpFile = path.join(dir, 'marketplace.json');
    fs.writeFileSync(mpFile, JSON.stringify({ plugins: [{ name: coreName, version: '99.0.0' }] }));
    const r = await runScript('doctor-check.ts', {
      args: ['.hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, HERMIT_DOCTOR_MARKETPLACE_FILE: mpFile },
    });
    const c = vcCheck(JSON.parse(r.stdout));
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('99.0.0');
    expect(c.detail).not.toContain('Fixed entries');
  }), 20000);

  test('marketplace cache lists a newer version with a Fixed entry in range → warn, escalated', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const mpFile = path.join(dir, 'marketplace.json');
    fs.writeFileSync(mpFile, JSON.stringify({ plugins: [{ name: coreName, version: '99.0.0' }] }));
    const changelog = path.join(dir, 'CHANGELOG.md');
    fs.writeFileSync(changelog, '## [99.0.0] - 2099-01-01\n\n### Fixed\n- something\n');
    const r = await runScript('doctor-check.ts', {
      args: ['.hermit'], cwd: dir,
      env: {
        CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT,
        HERMIT_DOCTOR_MARKETPLACE_FILE: mpFile,
        HERMIT_DOCTOR_CHANGELOG_PATH: changelog,
      },
    });
    const c = vcCheck(JSON.parse(r.stdout));
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('Fixed entries');
  }), 20000);

  // The escalation must read the newer version's CHANGELOG from the marketplace-cache clone
  // (marketplace.json's dir + the plugin's `source`), which is refreshed with marketplace.json
  // — NOT the installed snapshot, which structurally can't carry the newer version's sections.
  // No HERMIT_DOCTOR_CHANGELOG_PATH override here: resolution must come from `source`.
  test('newer version Fixed entry resolved via marketplace-cache clone `source` → warn, escalated', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const mpRoot = path.join(dir, 'mp');
    const mpFile = path.join(mpRoot, '.claude-plugin', 'marketplace.json');
    fs.mkdirSync(path.dirname(mpFile), { recursive: true });
    fs.writeFileSync(mpFile, JSON.stringify({ plugins: [{ name: coreName, version: '99.0.0', source: './core' }] }));
    fs.mkdirSync(path.join(mpRoot, 'core'), { recursive: true });
    fs.writeFileSync(path.join(mpRoot, 'core', 'CHANGELOG.md'), '## [99.0.0] - 2099-01-01\n\n### Fixed\n- something\n');
    const r = await runScript('doctor-check.ts', {
      args: ['.hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, HERMIT_DOCTOR_MARKETPLACE_FILE: mpFile },
    });
    const c = vcCheck(JSON.parse(r.stdout));
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('Fixed entries');
  }), 20000);
});

describe('shared context-signal helper (anti-drift)', () => {
  // The pre-extraction local copies drifted once already: doctor preferred the stale
  // turn-wide max_prompt_tokens while the watchdog had moved to last_call_prompt_tokens.
  // Both consumers must import the shared helper and keep no local selector behind.
  test('watchdog and doctor import lib/context-signal and define no local selector', () => {
    for (const f of ['hermitd-watchdog.ts', 'doctor-check.ts']) {
      const src = fs.readFileSync(path.join(SCRIPTS, f), 'utf-8');
      expect(src).toContain("./lib/context-signal");
      expect(src).not.toMatch(/function promptTokens(Of)?\(/);
      expect(src).not.toMatch(/function isEstimateOnly(Entry)?\(/);
    }
  });
});

describe('doctor context-age check', () => {
  const caCheck = (report: any) => (report.checks ?? []).find((c: any) => c.id === 'context-age');
  const HYGIENE_CONFIG = { context_hygiene: { compact: { enabled: true, min_context_tokens: 1000 } } };

  function writeCostLogEntry(dir: string, sessionId: string, maxPromptTokens: number) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const entry = {
      timestamp: new Date().toISOString(), session_id: 'S-001', cc_session_id: sessionId,
      source: 'interactive', model: 'sonnet',
      input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 0,
      total_tokens: maxPromptTokens, api_calls: 1, max_prompt_tokens: maxPromptTokens,
      estimated_cost_usd: 0,
    };
    fs.writeFileSync(path.join(dir, '.claude', 'cost-log.jsonl'), JSON.stringify(entry) + '\n');
  }

  // cc_session_id is the resident's harness id — what the check resolves on, matching the
  // watchdog's hygiene tiers.
  function writeRuntime(dir: string, sessionId: string) {
    fs.writeFileSync(path.join(dir, '.hermit', 'state', 'runtime.json'), JSON.stringify({
      cc_session_id: sessionId,
      updated_at: new Date().toISOString(),
    }));
  }

  function writeHygieneEvent(dir: string, action: string, ageHours: number) {
    const ts = new Date(Date.now() - ageHours * 3600000).toISOString();
    fs.writeFileSync(path.join(dir, '.hermit', 'state', 'watchdog-events.jsonl'),
      JSON.stringify({ ts, action, reason: 'test' }) + '\n');
  }

  // The check judges compactible conversation (prompt − recorded surface, or − the 50k
  // cold-start assumption). A tiny recorded surface keeps these fixtures' small token
  // values meaningful while also exercising the context-surface.json read path.
  function writeSurface(dir: string, tokens: number) {
    fs.writeFileSync(path.join(dir, '.hermit', 'state', 'context-surface.json'), JSON.stringify({
      surface_upper_bound_tokens: tokens, post_tokens: 100,
      boundary_at: new Date().toISOString(), observed_at: new Date().toISOString(), prev: null,
    }));
  }

  test('compact tier not enabled → ok', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const c = caCheck(await runDoctorCheck(dir));
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('not enabled');
  }), 20000);

  test('no active session → ok', withTmpdir(async (dir) => {
    writeConfig(dir, HYGIENE_CONFIG);
    const c = caCheck(await runDoctorCheck(dir));
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('no active session');
  }), 20000);

  test('active session, context under threshold → ok', withTmpdir(async (dir) => {
    writeConfig(dir, HYGIENE_CONFIG);
    writeRuntime(dir, 'sess-1');
    writeCostLogEntry(dir, 'sess-1', 500);
    const c = caCheck(await runDoctorCheck(dir));
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('under');
  }), 20000);

  test('active session, context over threshold, recent hygiene event → ok', withTmpdir(async (dir) => {
    writeConfig(dir, HYGIENE_CONFIG);
    writeRuntime(dir, 'sess-1');
    writeCostLogEntry(dir, 'sess-1', 2000);
    writeSurface(dir, 500); // compactible 1500 > 1000 threshold
    writeHygieneEvent(dir, 'context-compact', 1);
    const c = caCheck(await runDoctorCheck(dir));
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('hygiene fired');
  }), 20000);

  test('active session, context over threshold, no recent hygiene event → warn', withTmpdir(async (dir) => {
    writeConfig(dir, HYGIENE_CONFIG);
    writeRuntime(dir, 'sess-1');
    writeCostLogEntry(dir, 'sess-1', 2000);
    writeSurface(dir, 500); // compactible 1500 > 1000 threshold
    writeHygieneEvent(dir, 'context-compact', 48);
    const c = caCheck(await runDoctorCheck(dir));
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('context hygiene may be disabled or stuck');
  }), 20000);

  // Estimate-only entry (multi-call, no max_prompt_tokens): the compact tier this check
  // mirrors averages the summed total rather than skipping, so an over-threshold average
  // must still warn — regression guard for the clear-tier skip that used to short-circuit here.
  test('active session, estimate-only entry over threshold → warn (compact-tier parity)', withTmpdir(async (dir) => {
    writeConfig(dir, HYGIENE_CONFIG);
    writeRuntime(dir, 'sess-1');
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const entry = {
      timestamp: new Date().toISOString(), session_id: 'S-001', cc_session_id: 'sess-1',
      source: 'interactive', model: 'sonnet',
      input_tokens: 6000, cache_write_tokens: 0, cache_read_tokens: 0, output_tokens: 0,
      total_tokens: 6000, api_calls: 3, // no max_prompt_tokens → avg 2000 > 1000 threshold
      estimated_cost_usd: 0,
    };
    fs.writeFileSync(path.join(dir, '.claude', 'cost-log.jsonl'), JSON.stringify(entry) + '\n');
    writeSurface(dir, 500); // avg 2000 − 500 = 1500 > 1000 threshold
    writeHygieneEvent(dir, 'context-compact', 48);
    const c = caCheck(await runDoctorCheck(dir));
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('context hygiene may be disabled or stuck');
  }), 20000);

  // Cold start: no context-surface.json → the 50k assumed surface is subtracted, so a
  // prompt must exceed threshold + 50k to read as over-threshold (behavior parity with
  // the pre-gate absolute default).
  test('no surface recorded → 50k assumed surface subtracted', withTmpdir(async (dir) => {
    writeConfig(dir, HYGIENE_CONFIG);
    writeRuntime(dir, 'sess-1');
    writeCostLogEntry(dir, 'sess-1', 45000); // compactible −5000 ≤ 1000 threshold
    const c = caCheck(await runDoctorCheck(dir));
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('under');
  }), 20000);

  // Malformed surface file degrades to the assumed-surface fallback, never throws.
  test('malformed context-surface.json → fallback, no failure', withTmpdir(async (dir) => {
    writeConfig(dir, HYGIENE_CONFIG);
    writeRuntime(dir, 'sess-1');
    writeCostLogEntry(dir, 'sess-1', 52000); // compactible 2000 > 1000 threshold via 50k fallback
    fs.writeFileSync(path.join(dir, '.hermit', 'state', 'context-surface.json'), '{ truncated');
    writeHygieneEvent(dir, 'context-compact', 1);
    const c = caCheck(await runDoctorCheck(dir));
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('hygiene fired');
  }), 20000);
});

describe('doctor credential-expiry check', () => {
  const credCheck = (report: any) => (report.checks ?? []).find((c: any) => c.id === 'credential-expiry');
  const VALID_OAT = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789';

  /** Write a setup-token record expiring `days` from now (negative = already lapsed). */
  const writeTokenRecord = (dir: string, days: number) => {
    const stateDir = path.join(dir, '.hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const expires = new Date(Date.now() + days * 24 * 3600000).toISOString();
    fs.writeFileSync(
      path.join(stateDir, 'setup-token.json'),
      JSON.stringify({ minted_at: new Date(Date.now() - 3600000).toISOString(), expires_at: expires })
    );
  };

  /** A signed-in claude.ai credential, optionally dated `days` from now. */
  const writeStoredLogin = (credDir: string, days: number | null) => {
    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(path.join(credDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: {
        accessToken: 'live', refreshToken: 'r', expiresAt: Date.now() - 3600000,
        ...(days === null ? {} : { refreshTokenExpiresAt: Date.now() + days * 24 * 3600000 }),
      },
    }));
  };

  // Core self-declares one dynamic `claude-subscription` credential, so even with
  // no siblings there is exactly one probe. A hermit signed in with a claude.ai
  // login that carries no expiry field has nothing to measure — that reports ok.
  test('no siblings, signed in, nothing to measure → ok', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const credDir = path.join(dir, 'creds');
    writeStoredLogin(credDir, null);
    const r = await runScript('doctor-check.ts', {
      args: ['.hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_CONFIG_DIR: credDir, ANTHROPIC_API_KEY: '' },
    });
    const report = JSON.parse(r.stdout);
    const c = credCheck(report);
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('1 plugin credential(s) ok');
  }), 20000);

  // The point of the whole feature: a credential inside its warn window must warn,
  // and must name the skill that renews it. 3 days for both modes, matching the
  // window Claude Code itself warns on.
  test('setup-token expiring within the 3d window → warn naming the skill', withTmpdir(async (dir) => {
    writeConfig(dir, { auth_mode: 'token' });
    writeTokenRecord(dir, 2);
    const r = await runScript('doctor-check.ts', {
      args: ['.hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_CONFIG_DIR: path.join(dir, 'creds'), ANTHROPIC_API_KEY: '' },
    });
    const c = credCheck(JSON.parse(r.stdout));
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('claude-subscription');
    expect(c.detail).toContain('/hermitd:relogin');
  }), 20000);

  // Just outside the window: silent. Guards against the warn firing all year.
  test('setup-token beyond the 3d window → ok', withTmpdir(async (dir) => {
    writeConfig(dir, { auth_mode: 'token' });
    writeTokenRecord(dir, 30);
    const r = await runScript('doctor-check.ts', {
      args: ['.hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_CONFIG_DIR: path.join(dir, 'creds'), ANTHROPIC_API_KEY: '' },
    });
    const c = credCheck(JSON.parse(r.stdout));
    expect(c.status).toBe('ok');
  }), 20000);

  // A ~30-day login is the short one, so the window is measured against it: at 10
  // days out — a third of that credential's life — the hermit must still stay quiet.
  test('login mode at 10d out → ok (warn_days=3 is honoured, not the 7d default)', withTmpdir(async (dir) => {
    writeConfig(dir, { auth_mode: 'login' });
    const credDir = path.join(dir, 'creds');
    writeStoredLogin(credDir, 10);
    const r = await runScript('doctor-check.ts', {
      args: ['.hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_CONFIG_DIR: credDir, ANTHROPIC_API_KEY: '' },
    });
    expect(credCheck(JSON.parse(r.stdout)).status).toBe('ok');
  }), 20000);

  test('login mode within the 3d window → warn naming the skill', withTmpdir(async (dir) => {
    writeConfig(dir, { auth_mode: 'login' });
    const credDir = path.join(dir, 'creds');
    writeStoredLogin(credDir, 2);
    const r = await runScript('doctor-check.ts', {
      args: ['.hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_CONFIG_DIR: credDir, ANTHROPIC_API_KEY: '' },
    });
    const c = credCheck(JSON.parse(r.stdout));
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('/hermitd:relogin');
  }), 20000);

  // The lapse stub Claude Code writes in place when a refresh fails. The file is
  // still there and still parses, so only the empty token distinguishes it.
  test('login mode with a lapse stub → warn EXPIRED', withTmpdir(async (dir) => {
    writeConfig(dir, { auth_mode: 'login' });
    const credDir = path.join(dir, 'creds');
    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(path.join(credDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 },
    }));
    const r = await runScript('doctor-check.ts', {
      args: ['.hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_CONFIG_DIR: credDir, ANTHROPIC_API_KEY: '' },
    });
    const c = credCheck(JSON.parse(r.stdout));
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('EXPIRED');
  }), 20000);

  // A leftover token file in login mode is confusing, not dangerous: nothing reads
  // it, but its presence is why a renewal looks like it did nothing.
  test('login mode + a stray token file → warn about the stray file, not parking', withTmpdir(async (dir) => {
    writeConfig(dir, { auth_mode: 'login' });
    const credDir = path.join(dir, 'creds');
    writeStoredLogin(credDir, 30);
    fs.writeFileSync(path.join(credDir, '.hermit-setup-token'), `${VALID_OAT}\n`);
    const r = await runScript('doctor-check.ts', {
      args: ['.hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_CONFIG_DIR: credDir, ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' },
    });
    const c = credCheck(JSON.parse(r.stdout));
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('stray');
    expect(c.detail).not.toContain('shadow');
  }), 20000);

  test('already-expired setup-token → warn EXPIRED', withTmpdir(async (dir) => {
    // auth_mode pinned so the EXPIRED verdict provably comes from the token record
    // and not from login mode finding no credential on an empty fixture dir.
    writeConfig(dir, { auth_mode: 'token' });
    writeTokenRecord(dir, -1);
    const r = await runScript('doctor-check.ts', {
      args: ['.hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_CONFIG_DIR: path.join(dir, 'creds'), ANTHROPIC_API_KEY: '' },
    });
    const c = credCheck(JSON.parse(r.stdout));
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('EXPIRED');
  }), 20000);

  // Regression guard: the Claude Code session's own OAuth token auto-refreshes
  // every ~8h with no operator action, so an expired/malformed/near-expiry
  // .credentials.json must never surface as a doctor warning — this check
  // only reports sibling-plugin expiry_probe results.
  test('expired Claude Code session credentials are not flagged → ok', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const credDir = path.join(dir, 'creds');
    // A signed-in credential whose ACCESS token lapsed hours ago. That is the
    // ordinary steady state — Claude Code refreshes it silently — so `expiresAt`
    // being in the past must still read as healthy. Only an empty accessToken (the
    // lapse stub) or a past refreshTokenExpiresAt is a real problem.
    writeStoredLogin(credDir, 90);
    const r = await runScript('doctor-check.ts', {
      args: ['.hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_CONFIG_DIR: credDir, ANTHROPIC_API_KEY: '' },
    });
    const report = JSON.parse(r.stdout);
    expect(credCheck(report).status).toBe('ok');
  }), 20000);

  test('malformed session credentials JSON is not flagged → ok', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    const credDir = path.join(dir, 'creds');
    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(path.join(credDir, '.credentials.json'), '{not json');
    const r = await runScript('doctor-check.ts', {
      args: ['.hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_CONFIG_DIR: credDir, ANTHROPIC_API_KEY: '' },
    });
    const report = JSON.parse(r.stdout);
    expect(credCheck(report).status).toBe('ok');
  }), 20000);

  // In token mode, a stored .credentials.json that still holds a live token is a
  // hazard, not an expiry question: interactive sessions prefer it over the env
  // token, so the hermit 401s ~8h after the stored token lapses. Doctor must warn
  // to park it. A token FILE in the config dir is what makes token mode active.
  const writeSetupTokenFile = (credDir: string) => {
    fs.mkdirSync(credDir, { recursive: true });
    fs.writeFileSync(path.join(credDir, '.hermit-setup-token'), `${VALID_OAT}\n`);
  };

  test('token mode + stored credential with a live token → warn to park it', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    writeTokenRecord(dir, 300); // probe stays ok; the shadow is the only warn source
    const credDir = path.join(dir, 'creds');
    writeSetupTokenFile(credDir);
    fs.writeFileSync(path.join(credDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'live', expiresAt: Date.now() - 3600000 },
    }));
    const r = await runScript('doctor-check.ts', {
      args: ['.hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_CONFIG_DIR: credDir, ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' },
    });
    const c = credCheck(JSON.parse(r.stdout));
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('shadow');
  }), 20000);

  test('token mode + /logout stub (empty accessToken) → ok, no shadow warning', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    writeTokenRecord(dir, 300);
    const credDir = path.join(dir, 'creds');
    writeSetupTokenFile(credDir);
    fs.writeFileSync(path.join(credDir, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: '', expiresAt: 0 },
    }));
    const r = await runScript('doctor-check.ts', {
      args: ['.hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_CONFIG_DIR: credDir, ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' },
    });
    const c = credCheck(JSON.parse(r.stdout));
    expect(c.status).toBe('ok');
    expect(c.detail).not.toContain('shadow');
  }), 20000);

  test('token mode with the credential already parked → ok', withTmpdir(async (dir) => {
    writeConfig(dir, {});
    writeTokenRecord(dir, 300);
    const credDir = path.join(dir, 'creds');
    writeSetupTokenFile(credDir);
    fs.writeFileSync(path.join(credDir, '.credentials.json.pre-token.bak'), JSON.stringify({
      claudeAiOauth: { accessToken: 'live', expiresAt: 1 },
    }));
    const r = await runScript('doctor-check.ts', {
      args: ['.hermit'], cwd: dir,
      env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, CLAUDE_CONFIG_DIR: credDir, ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' },
    });
    const c = credCheck(JSON.parse(r.stdout));
    expect(c.status).toBe('ok');
    expect(c.detail).not.toContain('shadow');
  }), 20000);
});

describe('doctor model-pricing-known check', () => {
  const priceCheck = (report: any) => (report.checks ?? []).find((c: any) => c.id === 'model-pricing-known');

  test('default template models → ok', withTmpdir(async (dir) => {
    const template = readJson(path.join(TEMPLATES, 'config.json.template'));
    writeConfig(dir, template);
    const report = await runDoctorCheck(dir);
    expect(priceCheck(report).status).toBe('ok');
  }), 20000);

  test('unknown config.model → warn naming config.model', withTmpdir(async (dir) => {
    writeConfig(dir, { ...BASE_CONFIG, model: 'gpt-mini' });
    const report = await runDoctorCheck(dir);
    const c = priceCheck(report);
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('config.model');
  }), 20000);

  test('full Claude model id (detectModel-priced) → ok, not a false warn', withTmpdir(async (dir) => {
    // "claude-opus-4-8" is an exact rate-table key, so it must not be flagged.
    writeConfig(dir, { ...BASE_CONFIG, model: 'claude-opus-4-8' });
    const report = await runDoctorCheck(dir);
    expect(priceCheck(report).status).toBe('ok');
    expect(priceCheck(report).detail).toContain(`pricing verified ${PRICING_VERIFIED}`);
  }), 20000);

  test('dated haiku snapshot is priced; unknown id is named', withTmpdir(async (dir) => {
    writeConfig(dir, { ...BASE_CONFIG, model: 'claude-haiku-4-5-20251001' });
    const okReport = await runDoctorCheck(dir);
    expect(priceCheck(okReport).status).toBe('ok');
    expect(priceCheck(okReport).detail).toContain(`pricing verified ${PRICING_VERIFIED}`);

    writeConfig(dir, { ...BASE_CONFIG, model: 'claude-nova-9' });
    const warnReport = await runDoctorCheck(dir);
    const c = priceCheck(warnReport);
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('claude-nova-9');
    expect(c.detail).toContain(`pricing verified ${PRICING_VERIFIED}`);
  }), 20000);

  test('unknown routine model → warn naming the routine', withTmpdir(async (dir) => {
    writeConfig(dir, {
      ...BASE_CONFIG,
      routines: [{ id: 'my-routine', schedule: '0 9 * * *', skill: 'x:y', model: 'gpt-mini', enabled: true }],
    });
    const report = await runDoctorCheck(dir);
    const c = priceCheck(report);
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('routines[my-routine].model');
  }), 20000);

  test('unknown heartbeat.model → warn naming heartbeat.model', withTmpdir(async (dir) => {
    writeConfig(dir, { ...BASE_CONFIG, heartbeat: { ...BASE_CONFIG.heartbeat, model: 'gpt-mini' } });
    const report = await runDoctorCheck(dir);
    const c = priceCheck(report);
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('heartbeat.model');
  }), 20000);

  test('unknown model in cost-log within last 7d → warn naming cost-log', withTmpdir(async (dir) => {
    writeConfig(dir, BASE_CONFIG);
    const costLog = path.join(dir, '.claude', 'cost-log.jsonl');
    fs.writeFileSync(costLog, JSON.stringify({
      timestamp: new Date().toISOString(), model: 'mystery-model', estimated_cost_usd: 0.01, total_tokens: 100,
    }) + '\n');
    const report = await runDoctorCheck(dir);
    const c = priceCheck(report);
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('cost-log');
  }), 20000);
});

describe('doctor routine-cost check', () => {
  const routineCostCheck = (report: any) => (report.checks ?? []).find((c: any) => c.id === 'routine-cost');
  const routine = (id: string) => ({ id, schedule: '0 9 * * *', skill: 'x:y', enabled: true });

  // Both $/run inputs now come from one population: cost rows stamped
  // source_attribution_version 2. One main row per model wake = one run; subagent rows add
  // cost to the same source without adding a run.
  type Row = { source: string; cost: number; subagent?: boolean; inherited?: boolean; version?: number };
  const wakes = (id: string, n: number, cost: number): Row[] =>
    Array.from({ length: n }, () => ({ source: `routine:${id}`, cost }));

  function writeCostLog(dir: string, rows: Row[]) {
    const lines = rows.map((r, i) => JSON.stringify({
      timestamp: new Date(Date.UTC(2026, 6, 1, 0, i)).toISOString(),
      session_id: 'S-001', source: r.source, model: 'sonnet',
      total_tokens: 1000, estimated_cost_usd: r.cost,
      ...(r.subagent ? { subagent: true } : {}),
      ...(r.inherited ? { source_inherited: true } : {}),
      ...(r.version === undefined ? { source_attribution_version: 2 } : r.version === 0 ? {} : { source_attribution_version: r.version }),
    })).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, '.claude', 'cost-log.jsonl'), lines);
  }

  test('no enabled routines → ok', withTmpdir(async (dir) => {
    writeConfig(dir, BASE_CONFIG);
    const report = await runDoctorCheck(dir);
    expect(routineCostCheck(report).status).toBe('ok');
  }), 20000);

  test('cost log absent → ok', withTmpdir(async (dir) => {
    writeConfig(dir, { ...BASE_CONFIG, routines: [routine('a')] });
    const report = await runDoctorCheck(dir);
    expect(routineCostCheck(report).status).toBe('ok');
  }), 20000);

  test('fewer than 3 runs → ok (no divide-by-small-N false positive)', withTmpdir(async (dir) => {
    writeConfig(dir, { ...BASE_CONFIG, routines: [routine('a')] });
    writeCostLog(dir, wakes('a', 2, 50));
    const report = await runDoctorCheck(dir);
    expect(routineCostCheck(report).status).toBe('ok');
  }), 20000);

  test('outlier routine exceeding 3x peer median and floor → warn naming it', withTmpdir(async (dir) => {
    writeConfig(dir, { ...BASE_CONFIG, routines: [routine('cheap'), routine('cheap2'), routine('expensive')] });
    writeCostLog(dir, [
      ...wakes('cheap', 3, 0.40),
      ...wakes('cheap2', 3, 0.45),
      ...wakes('expensive', 3, 15),   // peer median ≈$0.42, threshold $2
    ]);
    const report = await runDoctorCheck(dir);
    const c = routineCostCheck(report);
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('expensive');
    expect(c.detail).toContain('peer median $');  // the comparison basis is rendered, not just the verdict
  }), 20000);

  test('all routines under the floor → ok', withTmpdir(async (dir) => {
    writeConfig(dir, { ...BASE_CONFIG, routines: [routine('a'), routine('b')] });
    writeCostLog(dir, [...wakes('a', 3, 1.00), ...wakes('b', 3, 1.10)]);
    const report = await runDoctorCheck(dir);
    expect(routineCostCheck(report).status).toBe('ok');
  }), 20000);

  test('polluted routine:<artifact> source with no matching routine id is ignored', withTmpdir(async (dir) => {
    // Rows carrying a `routine:<word>` source that matches no configured id — minted by
    // classifySource's retired log-routine-event.sh prose fallback, and still on disk in
    // already-written v2 rows — must not be treated as a real routine.
    writeConfig(dir, { ...BASE_CONFIG, routines: [routine('a')] });
    writeCostLog(dir, [
      ...wakes('a', 3, 1.00),
      ...wakes('fired', 3, 333),  // classifier artifact
    ]);
    const report = await runDoctorCheck(dir);
    const c = routineCostCheck(report);
    expect(c.status).toBe('ok');
    expect(c.detail).not.toContain('333');
  }), 20000);

  test('legacy pre-attribution-fix rows cannot produce a warn (the incident shape)', withTmpdir(async (dir) => {
    // jpereira's monthly-revenue read $37.96/run off a $121 lifetime bucket built from daily
    // turns misattributed by tool-output marker capture. Those rows carry no v2 stamp, so they
    // are not a measurement — the check reports insufficient history instead of warning.
    writeConfig(dir, { ...BASE_CONFIG, routines: [routine('monthly-revenue'), routine('peer')] });
    writeCostLog(dir, [
      ...Array.from({ length: 9 }, () => ({ source: 'routine:monthly-revenue', cost: 12.6, version: 0 })),
      ...wakes('monthly-revenue', 3, 1.11),  // the real, post-fix cost
      ...wakes('peer', 3, 0.90),
    ]);
    const c = routineCostCheck(await runDoctorCheck(dir));
    expect(c.status).toBe('ok');
    expect(c.detail).not.toContain('monthly-revenue');
  }), 20000);

  test('subagent rows add cost to their source without adding a run', withTmpdir(async (dir) => {
    // A routine that delegates: 3 wakes, each dispatching a subagent. $/run must fold the
    // subagent cost into the dispatching source (3 runs at $4, not 6 runs at $2).
    writeConfig(dir, { ...BASE_CONFIG, routines: [routine('delegator'), routine('peer')] });
    writeCostLog(dir, [
      ...wakes('delegator', 3, 1),
      ...Array.from({ length: 3 }, () => ({ source: 'routine:delegator', cost: 3, subagent: true })),
      ...wakes('peer', 3, 0.50),
    ]);
    const c = routineCostCheck(await runDoctorCheck(dir));
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('delegator');
    expect(c.detail).toContain('4.00'); // ($1+$3)×3 / 3 runs
  }), 20000);

  test('an async-dispatching routine is judged per fire, not per billed turn', withTmpdir(async (dir) => {
    // Each fire of 'delegator' bills two main turns: the wake ($1) and the turn that ingests
    // the subagent-completion notification ($3), which the dispatch hop attributes back to the
    // routine. Counting that second turn as a run reports $2/run (under the $2 floor → silent);
    // counting one run per fire reports $4/run and warns, which is the truth.
    writeConfig(dir, { ...BASE_CONFIG, routines: [routine('delegator'), routine('peer')] });
    writeCostLog(dir, [
      ...wakes('delegator', 3, 1),
      ...Array.from({ length: 3 }, () => ({ source: 'routine:delegator', cost: 3, inherited: true })),
      ...wakes('peer', 3, 0.50),
    ]);
    const c = routineCostCheck(await runDoctorCheck(dir));
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('delegator');
    expect(c.detail).toContain('4.00');
  }), 20000);

  test('co-fire cost bucketed to routine:multi is excluded from the per-routine comparison', withTmpdir(async (dir) => {
    // 'a' and 'b' only ever co-fire; classifySource attributes their shared wake turn to the
    // synthetic routine:multi source (not the first id). Since the check iterates only
    // configured ids, routine:multi is ignored — neither routine shows an inflated $/run, and
    // neither appears as a zero-cost peer dragging the median down.
    writeConfig(dir, { ...BASE_CONFIG, routines: [routine('a'), routine('b'), routine('x'), routine('y')] });
    writeCostLog(dir, [
      ...wakes('multi', 3, 300),   // co-fire cost — not a configured id, excluded
      ...wakes('x', 3, 1.00),
      ...wakes('y', 3, 1.10),
    ]);
    const c = routineCostCheck(await runDoctorCheck(dir));
    expect(c.status).toBe('ok');
    expect(c.detail).not.toContain('multi');
    expect(c.detail).toContain('2 routine(s)'); // a and b contribute no zero-cost peers
  }), 20000);

  test('expensive routine in a two-routine fleet is flagged (peer median, not self-inclusive)', withTmpdir(async (dir) => {
    // With a self-inclusive median, 3×median is unreachable at n=2 and the outlier escapes;
    // comparing against the peer median (self excluded) catches it.
    writeConfig(dir, { ...BASE_CONFIG, routines: [routine('cheap'), routine('pricey')] });
    writeCostLog(dir, [...wakes('cheap', 3, 1.00), ...wakes('pricey', 3, 10.00)]);
    const c = routineCostCheck(await runDoctorCheck(dir));
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('pricey');
  }), 20000);

  test('default floor absorbs a low-absolute-cost outlier that is many times the median', withTmpdir(async (dir) => {
    writeConfig(dir, { ...BASE_CONFIG, routines: [routine('a'), routine('b'), routine('lonewolf')] });
    writeCostLog(dir, [
      ...wakes('a', 3, 0.01), ...wakes('b', 3, 0.012),
      ...wakes('lonewolf', 3, 0.05),  // >3x median, under the $2 floor
    ]);
    const report = await runDoctorCheck(dir);
    expect(routineCostCheck(report).status).toBe('ok');
  }), 20000);

  test('config.doctor.routine_cost_floor_usd override flags the same outlier', withTmpdir(async (dir) => {
    writeConfig(dir, {
      ...BASE_CONFIG, routines: [routine('a'), routine('b'), routine('lonewolf')],
      doctor: { routine_cost_floor_usd: 0.02 },
    });
    writeCostLog(dir, [
      ...wakes('a', 3, 0.01), ...wakes('b', 3, 0.012), ...wakes('lonewolf', 3, 0.05),
    ]);
    const report = await runDoctorCheck(dir);
    const c = routineCostCheck(report);
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('lonewolf');
  }), 20000);

  test('#573 successor: a routine still compared on its clean rows despite huge legacy cost', withTmpdir(async (dir) => {
    // #573 windowed the numerator to each routine's earliest tracked fire so pre-tracking
    // lifetime cost wasn't divided across only the tracked runs. The v2 epoch subsumes that
    // window: legacy rows are dropped by stamp, not by timestamp. `weekly` carries $97 of
    // pre-fix cost plus 3 clean $1 wakes — it must be judged at $1/run (and still take part
    // in the comparison, not be dropped from it).
    writeConfig(dir, { ...BASE_CONFIG, routines: [routine('weekly'), routine('other')] });
    writeCostLog(dir, [
      { source: 'routine:weekly', cost: 97, version: 0 },  // pre-fix, unstamped
      ...wakes('weekly', 3, 1.00),
      ...wakes('other', 3, 1.00),
    ]);
    const c = routineCostCheck(await runDoctorCheck(dir));
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('2 routine(s)');  // both compared — legacy cost dropped, not the routine
  }), 20000);
});

describe('doctor channel-liveness check', () => {
  const liveCheck = (report: any) => (report.checks ?? []).find((c: any) => c.id === 'channel-liveness');

  function seedChannel(dir: string, port: number | undefined, tokenLine = 'TELEGRAM_BOT_TOKEN=dummy') {
    writeConfig(dir, {
      ...BASE_CONFIG,
      channels: { telegram: { enabled: true, dm_channel_id: '1', state_dir: 'chan' } },
    });
    const chanDir = path.join(dir, 'chan');
    fs.mkdirSync(chanDir, { recursive: true });
    if (tokenLine) fs.writeFileSync(path.join(chanDir, '.env'), tokenLine + '\n');
    return { HERMIT_DOCTOR_TELEGRAM_API: `http://127.0.0.1:${port}` };
  }

  test('no channels configured → ok, skipped', withTmpdir(async (dir) => {
    writeConfig(dir, BASE_CONFIG);
    const report = await runDoctorCheck(dir);
    const c = liveCheck(report);
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('skipped');
  }), 20000);

  test('missing .env → warn, no token configured', withTmpdir(async (dir) => {
    const env = seedChannel(dir, 0, '');
    const r = await runScript('doctor-check.ts', {
      args: ['.hermit'], cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env },
    });
    const report = JSON.parse(r.stdout);
    const c = liveCheck(report);
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('no token configured');
  }), 20000);

  test('200 response → ok, reachable', withTmpdir(async (dir) => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('{"ok":true}', { status: 200 }) });
    try {
      const env = seedChannel(dir, server.port);
      const r = await runScript('doctor-check.ts', {
        args: ['.hermit'], cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env },
      });
      const report = JSON.parse(r.stdout);
      const c = liveCheck(report);
      expect(c.status).toBe('ok');
      expect(c.detail).toContain('reachable');
    } finally {
      server.stop(true);
    }
  }), 20000);

  test('401 response → fail, auth rejected, token never echoed', withTmpdir(async (dir) => {
    const server = Bun.serve({ port: 0, fetch: () => new Response('unauthorized', { status: 401 }) });
    try {
      const env = seedChannel(dir, server.port);
      const r = await runScript('doctor-check.ts', {
        args: ['.hermit'], cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env },
      });
      const report = JSON.parse(r.stdout);
      const c = liveCheck(report);
      expect(c.status).toBe('fail');
      expect(c.detail).toContain('auth rejected');
      expect(c.detail).not.toContain('dummy');
    } finally {
      server.stop(true);
    }
  }), 20000);

  // Self-mention identity drift (scripts/channel-bot-id.ts writes bot_user_id).
  // The liveness probe response already carries the bot's own account, so the
  // stored id is validated here without a second request.
  function seedWithBotId(dir: string, port: number | undefined, botId: string, botUsername?: string) {
    writeConfig(dir, {
      ...BASE_CONFIG,
      channels: {
        telegram: {
          enabled: true, dm_channel_id: '1', state_dir: 'chan', bot_user_id: botId,
          ...(botUsername === undefined ? {} : { bot_username: botUsername }),
        },
      },
    });
    const chanDir = path.join(dir, 'chan');
    fs.mkdirSync(chanDir, { recursive: true });
    fs.writeFileSync(path.join(chanDir, '.env'), 'TELEGRAM_BOT_TOKEN=dummy\n');
    return { HERMIT_DOCTOR_TELEGRAM_API: `http://127.0.0.1:${port}` };
  }

  const getMeServer = () => Bun.serve({
    port: 0,
    fetch: () => Response.json({ ok: true, result: { id: 111222333, username: 'hermitbot' } }),
  });

  test('stored bot id matches the live bot → ok, reachable', withTmpdir(async (dir) => {
    const server = getMeServer();
    try {
      const env = seedWithBotId(dir, server.port, '111222333');
      const r = await runScript('doctor-check.ts', {
        args: ['.hermit'], cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env },
      });
      const c = liveCheck(JSON.parse(r.stdout));
      expect(c.status).toBe('ok');
      expect(c.detail).toContain('reachable');
      expect(c.detail).not.toContain('stale');
    } finally {
      server.stop(true);
    }
  }), 20000);

  test('stored bot id from a different bot → warn, stale identity', withTmpdir(async (dir) => {
    const server = getMeServer();
    try {
      const env = seedWithBotId(dir, server.port, '999999999');
      const r = await runScript('doctor-check.ts', {
        args: ['.hermit'], cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env },
      });
      const c = liveCheck(JSON.parse(r.stdout));
      expect(c.status).toBe('warn');
      expect(c.detail).toContain('stale');
      expect(c.detail).toContain('/channel-setup');
      expect(c.detail).not.toContain('dummy');
    } finally {
      server.stop(true);
    }
  }), 20000);

  test('stored bot_username no longer matches the live handle → warn, renamed', withTmpdir(async (dir) => {
    const server = getMeServer();
    try {
      const env = seedWithBotId(dir, server.port, '111222333', 'oldhandle');
      const r = await runScript('doctor-check.ts', {
        args: ['.hermit'], cwd: dir, env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env },
      });
      const c = liveCheck(JSON.parse(r.stdout));
      expect(c.status).toBe('warn');
      expect(c.detail).toContain('renamed');
    } finally {
      server.stop(true);
    }
  }), 20000);

  test('timeout → warn, unreachable', withTmpdir(async (dir) => {
    const server = Bun.serve({ port: 0, fetch: () => new Promise(() => {}) });
    try {
      const env = seedChannel(dir, server.port);
      const r = await runScript('doctor-check.ts', {
        args: ['.hermit'], cwd: dir,
        env: { CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env, HERMIT_DOCTOR_LIVENESS_TIMEOUT_MS: '250' },
      });
      const report = JSON.parse(r.stdout);
      const c = liveCheck(report);
      expect(c.status).toBe('warn');
      expect(c.detail).toContain('unreachable');
    } finally {
      server.stop(true);
    }
  }), 20000);
});

describe('watchdog validation', () => {
  test('template ships scheduler_enabled true and validates cleanly', () => {
    const template = readJson(path.join(TEMPLATES, 'config.json.template'));
    expect(template.watchdog.scheduler_enabled).toBe(true);
    const { errors, warnings } = validate(template);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test('non-boolean scheduler_enabled warns', () => {
    const out = runValidate({ watchdog: { enabled: false, scheduler_enabled: 1 } });
    expect(out.warnings.join(' ')).toContain('scheduler_enabled');
  });

  test('explicit false scheduler_enabled is accepted', () => {
    const out = runValidate({ watchdog: { enabled: false, scheduler_enabled: false } });
    expect(out.warnings.some((w: string) => w.includes('scheduler_enabled'))).toBe(false);
    expect(out.errors.some((e: string) => e.includes('scheduler_enabled'))).toBe(false);
  });
});

describe('doctor routine template contract', () => {
  test('template config validates cleanly with the doctor routine present', () => {
    const template = readJson(path.join(TEMPLATES, 'config.json.template'));
    const routine = template.routines.find((r: any) => r.id === 'doctor');
    expect(routine).toBeDefined();
    expect(routine.schedule).toBe('10 9 * * 1');
    expect(routine.skill).toBe('hermitd:hermit-doctor --maintainer');
    expect(routine.enabled).toBe(true);

    const { errors, warnings } = validate(template);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

// ============================================================
// proposal-triage batch contract (PR-1: batch proposal-triage in reflect)
//
// proposal-triage used to be invoked strictly per-candidate ("never as a
// batch"); it now accepts N candidates in one call and returns N title-tagged
// verdict blocks, mirroring reflection-judge's existing batch grammar. Guards
// against: the agent definition regressing to the old bare CREATE/SUPPRESS —
// <code>/DUPLICATE:<PROP-ID> grammar, and any caller (reflect, proposal-create,
// capability-brainstorm) still parsing the old bare grammar.
// ============================================================

describe('proposal-triage batch contract', () => {
  const triage = read(path.join(AGENTS, 'proposal-triage.md'));
  const branches = read(path.join(SKILLS, 'reflect', 'branches.md'));
  const proposalCreate = read(path.join(SKILLS, 'proposal-create', 'SKILL.md'));
  const brainstorm = read(path.join(SKILLS, 'capability-brainstorm', 'SKILL.md'));

  test('agents/proposal-triage.md documents the title-tagged verdict grammar', () => {
    expect(triage).toContain('CREATE: <title>');
    expect(triage).toContain('SUPPRESS: <title>');
    expect(triage).toContain('DUPLICATE: <title>');
  });

  test('reflect/branches.md parses the title-tagged triage verdict grammar', () => {
    // Routed via the gate verb's PROCEED/DROP tokens rather than the raw agent
    // grammar directly — the raw `CREATE: <title>` line still flows into the
    // script's stdin (see the gate-verb invocation just above these lines).
    expect(branches).toContain('PROCEED|CREATE');
    expect(branches).toContain('DROP|DUPLICATE:<PROP-ID>');
    expect(branches).toContain('DROP|SUPPRESS:<code>');
  });

  test('proposal-create/SKILL.md documents its call as a batch of one and parses the new grammar', () => {
    expect(proposalCreate).toContain('batch of one');
    expect(proposalCreate).toContain('PROCEED|CREATE');
    expect(proposalCreate).toContain('DROP|DUPLICATE:<PROP-ID>');
    expect(proposalCreate).toContain('DROP|SUPPRESS:<code>');
  });

  test('capability-brainstorm/SKILL.md parses proposal-create outcome with the title-tagged grammar', () => {
    expect(brainstorm).toContain('CREATE: <title>');
    expect(brainstorm).toContain('DUPLICATE: <title> — <PROP-ID>');
  });
});

// ============================================================
// Voice-carrier contract
//
// The hermit's tone rides in the SYSTEM PROMPT via a native Claude Code output
// style, not in resident-start context. That only works if the file Claude Code
// loads carries exact frontmatter — a wrong `name` or a missing
// keep-coding-instructions silently changes what the operator gets (no style, or
// a hermit stripped of its engineering instructions). Hence verbatim assertions.
// ============================================================

describe('voice carrier contract', () => {
  const voice = () => read(path.join(TEMPLATES, 'hermit-voice.md.template'));

  test('template frontmatter names the style and keeps coding instructions', () => {
    const text = voice();
    expect(text.startsWith('---\n')).toBe(true);
    const frontmatter = text.slice(4, text.indexOf('\n---', 4));
    expect(frontmatter).toContain('name: hermit-voice');
    expect(frontmatter).toContain('keep-coding-instructions: true');
    expect(frontmatter).toContain('description:');
  });

  test('template carries the prose placeholder and the precedence rule', () => {
    const text = voice();
    expect(text).toContain('{{VOICE_PROSE}}');
    expect(text).toContain(
      'Project security, routing, approval, and audience rules take precedence',
    );
  });

  // One renderer owns config.voice -> outputStyle + the style file. hatch and
  // hermit-settings both write the config through settings-edit and then call it;
  // boot calls the same op. A second writer is how the key and the file drifted.
  test('hatch and hermit-settings both render through the one voice-render op', () => {
    const hatch = read(path.join(SKILLS, 'hatch', 'SKILL.md'));
    const settings = read(path.join(SKILLS, 'hermit-settings', 'SKILL.md'));
    for (const text of [hatch, settings]) {
      expect(text).toContain('apply-settings.ts .claude/settings.local.json voice-render');
    }
    // Local scope is not incidental: it is where /config writes, and a custom
    // voice file is gitignored, so a committed pointer would name a missing file.
    expect(hatch).not.toContain('<resolved-settings-file> voice-render');
  });

  // The voice file is operator-curated and gitignored — which is exactly the
  // combination that falls through every lifecycle pass unless each one names
  // it: git won't carry it, so the worktree path and the moving-hosts docs must.
  test('the voice file is gitignored, worktree-included and its migration handling documented', () => {
    expect(read(path.join(TEMPLATES, 'GITIGNORE-APPEND.txt')))
      .toContain('.claude/output-styles/hermit-voice.md');
    expect(read(path.join(TEMPLATES, 'WORKTREEINCLUDE-APPEND.txt')))
      .toContain('.claude/output-styles/hermit-voice.md');

    // The moving-hosts answer is the one place that has to say what happens to
    // the file on a new machine. Assert on that line rather than on the path
    // appearing anywhere in the docs — config-reference.md also names the path
    // in its unrelated voice-style table, so a bare toContain() would stay
    // green even if the migration guidance were deleted outright.
    const faq = read(path.join(PLUGIN_ROOT, 'docs', 'faq.md'));
    const line = faq
      .split('\n')
      .find((l) => l.includes('.claude/output-styles/hermit-voice.md'));
    expect(line).toBeDefined();
    expect(line).toContain('config.json');
  });
});

// ============================================================
// Proactive-notify unification contract
//
// Model-composed proactive (unsolicited-push) notifications must route through
// the unified channel-send.ts --notice mechanism, not a hand-rolled resolve +
// reply-tool call — that split is what let maintainer-tier content hit the
// access.json-gated reply tool and get blocked. Inbound replies (a response to
// a message that arrived on a channel) are a different path and must keep
// using the reply tool; these assertions are scoped to the proactive step only.
// ============================================================

describe('proactive-notify unification contract', () => {
  test('cost-reflect Step 3 (proactive) routes through --notice', () => {
    const costReflect = read(path.join(SKILLS, 'cost-reflect', 'SKILL.md'));
    const step3 = costReflect.slice(costReflect.indexOf('## Step 3'));
    expect(costReflect).toContain('Automated (`--maintainer`');
    expect(costReflect).toContain('hermitd:cost-reflect --maintainer');
    expect(step3).toContain('channel-send.ts');
    expect(step3).toContain('--notice');
    expect(step3).toContain('`maintainer` leg only (no `client` leg)');
  });

  test('weekly-review proactive delivery routes through --notice', () => {
    const weeklyReview = read(path.join(SKILLS, 'weekly-review', 'SKILL.md'));
    expect(weeklyReview).toContain('channel-send.ts');
    expect(weeklyReview).toContain('--notice');
  });

  test('channel-responder outbound.md and CLAUDE-APPEND both point to the same --notice mechanism', () => {
    const responder = read(path.join(SKILLS, 'channel-responder', 'outbound.md'));
    const append = read(path.join(TEMPLATES, 'CLAUDE-APPEND.md'));
    // Both name the script through bin/hermitd-run: outbound.md is also read
    // from the operator's CLAUDE.md, where `<plugin_root>` has no definition.
    expect(responder).toContain('hermitd-run channel-send');
    expect(responder).toContain('--notice');
    expect(append).toContain('hermitd-run channel-send');
    expect(append).toContain('--notice');
  });
});

// ============================================================
// Heartbeat eval-runner return contract (issue #594)
//
// The subagent (reference.md) and the calling skill (SKILL.md) must agree on
// the return shape, and neither may reintroduce the model-authored bookkeeping
// fields that update-alert-state.ts now owns exclusively. A drift here (e.g.
// SKILL.md pre-validating the return itself, or reference.md instructing the
// model to emit `suppressed`/`resolved_keys` again) would silently reopen #594.
// ============================================================

describe('heartbeat eval-runner return contract', () => {
  const reference = read(path.join(SKILLS, 'heartbeat', 'reference.md'));
  const skill = read(path.join(SKILLS, 'heartbeat', 'SKILL.md'));

  const REMOVED_MODEL_FIELDS = [
    'resolved_keys', 'new_entries', 'updated_entries', 'shell_monitoring_lines',
    'operator_message', 'suppressed', 'consecutive_clean',
  ];

  test('reference.md Return Schema is exactly {firing}', () => {
    expect(reference).toContain('{"firing": [{"item": "<HEARTBEAT.md line, verbatim>", "text": "<channel-voice one-liner>"} or {"key": "custom:<…>"|"waiting-timeout", "text": "<channel-voice one-liner>"}, ...]}');
    expect(reference).not.toContain('self_eval_updates');
  });

  test('reference.md never instructs the model to author removed bookkeeping fields', () => {
    // Backtick-wrapped, matching how a field name is referenced in these docs —
    // 'suppressed'/'consecutive_clean' still appear as plain prose describing
    // the historical bug, which is fine; as a schema field, they must not.
    for (const field of REMOVED_MODEL_FIELDS) {
      expect(reference).not.toContain(`\`${field}\``);
    }
  });

  test('SKILL.md step 5 leaves validation to the script', () => {
    // Pre-validating here is what made a rejected evaluation report
    // HEARTBEAT_OK: the skill swallowed the reject and the script never saw it.
    expect(skill).not.toContain('skip all writes and emit `HEARTBEAT_OK`');
    // Positive half: a pure absence assertion also passes on a step 5 that lost
    // the script call or the reject branch outright.
    expect(skill).toContain('heartbeat.ts alert-state');
    expect(skill).toContain('respond `HEARTBEAT_INDETERMINATE (<reason>)`');
    for (const field of REMOVED_MODEL_FIELDS) {
      expect(skill).not.toContain(`\`${field}\``);
    }
  });

  // The counters are derived from files the script already reads, so a subagent
  // that still returns self_eval_updates must not be able to write through.
  test('SKILL.md takes the self-evaluation from the script, not the subagent', () => {
    expect(skill).toContain('`self_eval_proposals`');
    expect(skill).not.toContain('self_eval_updates');
  });

  test('SKILL.md reads notifications/heartbeat_result from the script, not the subagent', () => {
    expect(skill).toContain('{"notifications": [...], "self_eval_proposals"');
    expect(skill).toContain("per the **script's** `heartbeat_result`");
  });

  // The script appends the monitoring lines itself now. If SKILL.md were to hand
  // them back to the model again, every tick would re-pay an Edit per line — the
  // exact per-call cost this verb exists to remove.
  test('SKILL.md no longer receives monitoring lines to append', () => {
    expect(skill).not.toContain('monitoring_lines');
  });

  // `run` and `start` are the two paths the monitor and the daily anchor take on
  // every wake, so each needs its deterministic half behind one script call.
  test('SKILL.md run drives the tick verb and marks budget alerts by mark_key', () => {
    expect(skill).toContain('scripts/heartbeat.ts tick');
    expect(skill).toContain('scripts/heartbeat.ts ack-queue');
    expect(skill).toContain('`delivered: true`');
    expect(skill).toContain('--mark-budget-notified <mark_key>');
  });

  test('SKILL.md start short-circuits on FRESH and commits the task id', () => {
    expect(skill).toContain('scripts/heartbeat.ts start-check');
    expect(skill).toContain('scripts/heartbeat.ts start-commit');
    expect(skill).toContain('FRESH|interval=');
  });

  // Issue #690: this guard used to read only heartbeat's two files, so when
  // #594 stopped the writer accepting `new_entries`/`resolved_keys`,
  // hermit-doctor kept sending exactly that payload — accepted, discarded,
  // exit 0 — and doctor's dedup was dead for eleven releases. The invariant is
  // ownership: alert-state.json has exactly one writer skill.
  test('only skills/heartbeat/SKILL.md invokes heartbeat.ts alert-state', () => {
    // Match the invocation form, not the bare phrase — heartbeat/reference.md
    // mentions the verb in prose three times and must not trip this.
    const INVOCATION = 'scripts/heartbeat.ts alert-state';
    const offenders = fs.readdirSync(SKILLS)
      .flatMap((d) => {
        const skillDir = path.join(SKILLS, d);
        if (!fs.statSync(skillDir).isDirectory()) return [];
        return fs.readdirSync(skillDir)
          .filter((f) => f.endsWith('.md'))
          .filter((f) => read(path.join(skillDir, f)).includes(INVOCATION))
          .map((f) => `${d}/${f}`);
      });
    expect(offenders).toEqual(['heartbeat/SKILL.md']);
  });

  test('hermit-doctor authors no alert-state bookkeeping fields', () => {
    const doctor = read(path.join(SKILLS, 'hermit-doctor', 'SKILL.md'));
    for (const field of ['new_entries', 'updated_entries', 'resolved_keys']) {
      expect(doctor).not.toContain(field);
    }
    // …and consumes the script-derived verdict instead.
    expect(doctor).toContain('escalation.new');
    expect(doctor).toContain('--mark-notified');
  });
});

// ============================================================
// Determinized lifecycle wiring contract
//
// Guards the skill→script cutover for the Phase A determinization: each skill
// must keep invoking its deterministic replacement. A silent edit dropping the
// reference would revert the branch back to prose-driven (model-judged) writes.
// ============================================================

describe('determinized lifecycle wiring contract', () => {
  test('reflect SKILL.md applies resolution actions via apply-reflection-actions.ts', () => {
    const skill = read(path.join(SKILLS, 'reflect', 'SKILL.md'));
    expect(skill).toContain('apply-reflection-actions.ts');
  });


});

// ============================================================
// Proposal-lifecycle state writes are fully script-mediated — the harness
// background-isolation guard blocks the Write/Edit tools on the main-rooted
// `.hermit/` state dir, so proposal-create and proposal-act must
// never fall back to those tools for a proposal-file or task-record mutation.
// ============================================================

describe('proposal lifecycle: no tool-mediated state writes', () => {
  const proposalCreate = read(path.join(SKILLS, 'proposal-create', 'SKILL.md'));
  const proposalAct = PROPOSAL_ACT;

  test('proposal-create/SKILL.md invokes proposal.ts create instead of the Write tool', () => {
    expect(proposalCreate).toContain('proposal.ts create');
    expect(proposalCreate).not.toMatch(/Write tool|Edit the/);
  });

  test('proposal-act/SKILL.md invokes proposal.ts patch/routine and task.ts open/note instead of Edit/Write', () => {
    expect(proposalAct).toContain('proposal.ts patch');
    expect(proposalAct).toContain('task.ts open');
    expect(proposalAct).toContain('task.ts note');
    expect(proposalAct).not.toContain('proposal.ts next-task');
    expect(proposalAct).toContain('proposal.ts routine');
    expect(proposalAct).not.toMatch(/Write tool|Edit the/);
  });
});

// hermit-evolve Step 8 must delegate the whole permission reconciliation to
// apply-settings.ts rather than restate it in prose. The additive list had
// already drifted (15 of the canonical entries) and instructed a Write rule the
// writer strips; removals live in the script's sealed HERMIT_OBSOLETE registry.
describe('hermit-evolve permission delegation contract', () => {
  const evolveRef = fs.readFileSync(path.join(SKILLS, 'hermit-evolve', 'reference.md'), 'utf-8');
  const step8 = evolveRef.slice(
    evolveRef.indexOf('### 8. Ensure plugin permissions'),
    evolveRef.indexOf('### 9. Write updated config'),
  );

  test('Step 8 delegates to apply-settings.ts permissions-sync', () => {
    expect(step8).toContain('`apply-settings` (Commands)');
    expect(fs.readFileSync(path.join(PLUGIN_ROOT, 'agents/evolve-runner.md'), 'utf8')).toContain('apply-settings.ts <resolved-settings-file> permissions-sync');
  });

  test('Step 8 no longer hand-enumerates the per-script allow-list', () => {
    // The removed prose opened with this phrase before listing scripts by name.
    expect(evolveRef).not.toContain('The required entries are:');
    // Structural, not name-based: an enumeration is *many* `Bash(bun */scripts/…)`
    // patterns written out in Step 8. Exactly one is expected and allowed — the
    // bootstrap caveat naming apply-settings.ts's own grant, for a hermit whose
    // allow-list predates the script that would add it. Naming two example scripts
    // here (the previous form) went stale the moment those scripts were absorbed
    // into proposal.ts verbs: the assertion still passed, but against nothing.
    const inlineGrants = step8.match(/Bash\(bun \*\/scripts\//g) ?? [];
    expect(inlineGrants.length).toBe(1);
    expect(step8).toContain('Bash(bun */scripts/apply-settings.ts*)');
  });
});

// ---------- stale-plugin-runtime header (config ahead of loaded plugin) ----------
//
// check-upgrade.sh emits two different headers, and which one appears decides whether a
// hermit runs hermit-evolve. Config-ahead means a stale install copy got loaded: evolve
// reads that as up-to-date, and finalizing would downgrade the applied stamp. So the
// header has to stay distinct and its consumers must not treat it as an upgrade —
// without this pin a later prose edit can quietly collapse both headers back into one
// "any banner -> run evolve" rule, which is the loop this contract exists to prevent.
describe('stale plugin runtime header', () => {
  const HEADER = '---Stale Plugin Runtime---';
  const emitter = read(path.join(SCRIPTS, 'check-upgrade.sh'));
  const sessionStart = read(path.join(SKILLS, 'resident-start', 'SKILL.md'));
  const brief = read(path.join(SKILLS, 'brief', 'SKILL.md'));

  test('check-upgrade.sh emits the header without an evolve directive', () => {
    expect(emitter).toContain(HEADER);
    // The branch may NAME hermit-evolve (to say it cannot help) but must never carry
    // the slash-command directive form that resident-start acts on, nor REQUIRED.
    const staleBranch = emitter.slice(emitter.indexOf(`echo "${HEADER}"`), emitter.indexOf('echo "---Upgrade Available---"'));
    expect(staleBranch.length).toBeGreaterThan(0);
    expect(staleBranch).not.toContain('/hermitd:hermit-evolve');
    expect(staleBranch).not.toContain('REQUIRED');
  });

  test('both banner consumers recognize the header', () => {
    expect(sessionStart).toContain(HEADER);
    expect(brief).toContain(HEADER);
  });
});

describe('worktree state-dir template contract', () => {
  // config.json must ride into a `claude --worktree` copy: skills read config
  // keys (commands.*, and anything else operator-set) at the relative path, and
  // those reads hard-fail inside a worktree without it. The resolver comments in
  // routines/event.ts and cc-compat.ts also assert this block carries it, so a
  // regression here silently makes those comments false.
  const block = read(path.join(TEMPLATES, 'WORKTREEINCLUDE-APPEND.txt'));
  const CONFIG_LINE = '.hermit/config.json';

  test('managed block carries OPERATOR.md, config.json and compiled/, in that order', () => {
    const operator = block.indexOf('.hermit/OPERATOR.md');
    const config = block.indexOf(CONFIG_LINE);
    const compiled = block.indexOf('.hermit/compiled/');
    expect(operator).toBeGreaterThan(-1);
    expect(config).toBeGreaterThan(operator);
    expect(compiled).toBeGreaterThan(config);
  });

  test('config.json sits inside the managed markers', () => {
    const open = block.indexOf('# >>> hermitd');
    const close = block.indexOf('# <<< hermitd');
    expect(open).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(open);
    expect(block.indexOf(CONFIG_LINE)).toBeGreaterThan(open);
    expect(block.indexOf(CONFIG_LINE)).toBeLessThan(close);
  });
});

// The task worker's dispatch/return contract is what channel-responder parses.
describe('task-worker agent contract', () => {
  const agent = read(path.join(AGENTS, 'task-worker.md'));

  test('frontmatter names the agent and fences off dispatch and questions', () => {
    const head = agentFrontmatter('task-worker');
    expect(head).toContain('name: task-worker');
    expect(head).toContain('- Agent');
    expect(head).toContain('- AskUserQuestion');
    expect(head).not.toContain('model:');
    expect(head).not.toContain('tools:');
  });

  test('returns exactly one of the two WORKER lines', () => {
    expect(agent).toContain('WORKER <task-id> done <id>');
    expect(agent).toContain('WORKER <task-id> needs-input <id>');
  });

  test('writes its report where the relay hook reads it', () => {
    expect(agent).toContain('.hermit/helper-reports/<id>.md');
    expect(agent).toContain('edit_message');
  });

  // Consumer half of the WORKER lines and of conversation.ts's task-thread annotation.
  test('the task skill parses both WORKER lines and the task-thread annotation', () => {
    const task = read(path.join(SKILLS, 'task', 'SKILL.md'));
    expect(task).toContain('WORKER <task-id> done <id>');
    expect(task).toContain('WORKER <task-id> needs-input <id>');
    expect(task).toContain('[task thread <key>: ');
  });
});

// Skill text spells script invocations out for the model; a renamed verb or flag
// whose own subprocess tests were updated leaves these callers failing at runtime.
test('skill command strings match the script verbs and flags they call', () => {
  const pins: [string, string[]][] = [
    [path.join(TEMPLATES, 'CLAUDE-APPEND.md'), ['hermitd-run observations observe .hermit skill-preference-applied']],
    [path.join(SKILLS, 'reflect', 'SKILL.md'), ['observations.ts graduate .hermit', '--graduation-cursor']],
    [path.join(SKILLS, 'task', 'SKILL.md'), [
      "chat-lookup --chat-id '<chat_id>'",
      "thread-create --chat-id '<chat_id>' --message-id '<message_id>' --name '<title>'",
      "conversation.ts .hermit history --source '<source>' --chat-id '<chat_id>' --limit 100",
    ]],
  ];
  const missing = pins.flatMap(([file, commands]) => {
    const text = read(file);
    return commands.filter((c) => !text.includes(c)).map((c) => `${path.relative(PLUGIN_ROOT, file)}: ${c}`);
  });
  expect(missing).toEqual([]);
});


test('responder invocation evidence has one resident Skill hook writer', () => {
  const hooks = JSON.parse(read(path.join(PLUGIN_ROOT, 'hooks/hooks.json')));
  const entries = hooks.hooks.PostToolUse.filter((entry: any) => entry.matcher === 'Skill');
  expect(entries).toHaveLength(1);
  expect(entries[0].hooks).toEqual([{
    type: 'command', command: 'bun',
    args: ['${CLAUDE_PLUGIN_ROOT}/scripts/channel-responder-invoked.ts'], timeout: 3,
  }]);
  const architecture = read(path.join(PLUGIN_ROOT, 'docs/architecture.md'));
  expect(architecture).toContain('state/channel-responder-invoked.json');
  expect(architecture).toContain('channel-responder-invoked.ts only');
});

describe('shared resident liveness (anti-drift)', () => {
  test('lifecycle deciders use the shared verdict', () => {
    for (const file of ['hermitd-stop.ts', 'hermitd-start.ts', 'docker-preflight.ts', 'startup-context.ts', 'hermitd-watchdog.ts']) {
      const source = fs.readFileSync(path.join(SCRIPTS, file), 'utf-8');
      expect(source).not.toContain('sharedLivenessAgeSecs(');
      expect(source).toContain('./lib/resident-liveness');
    }
  });
});
