import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript, PLUGIN_ROOT } from './helpers/run';
import { getPath, setPath, unsetPath, togglePath, showData, applyKnown } from '../scripts/settings-edit';
import { SETTINGS, tableSettings } from '../scripts/lib/settings/registry';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-settings-edit-');
afterAll(cleanup);

function seedConfig(dir: string, config: any): string {
  const hermit = path.join(dir, '.hermit');
  fs.mkdirSync(hermit, { recursive: true });
  const file = path.join(hermit, 'config.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return file;
}

function readConfig(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// --- Pure helper unit tests ---

describe('getPath / setPath / togglePath', () => {
  test('getPath returns whole object when path omitted', () => {
    const obj = { a: 1, b: { c: 2 } };
    expect(getPath(obj)).toEqual(obj);
  });

  test('getPath resolves nested dotted paths', () => {
    const obj = { quality_gate: { tier: 'balanced' }, heartbeat: { stale_threshold: '2h' } };
    expect(getPath(obj, 'quality_gate.tier')).toBe('balanced');
    expect(getPath(obj, 'heartbeat.stale_threshold')).toBe('2h');
  });

  test('getPath returns undefined for missing paths without throwing', () => {
    expect(getPath({ a: 1 }, 'b.c.d')).toBeUndefined();
  });

  test('setPath creates parent objects and preserves siblings', () => {
    const obj: any = { agent_name: 'Atlas', reflection: { other: true } };
    setPath(obj, 'reflection.graduation_min_sessions', 2);
    expect(obj).toEqual({ agent_name: 'Atlas', reflection: { other: true, graduation_min_sessions: 2 } });
    setPath(obj, 'quality_gate.tier', 'quality');
    expect(obj.quality_gate).toEqual({ tier: 'quality' });
    expect(obj.agent_name).toBe('Atlas');
  });

  test('togglePath: absent → true, then flips', () => {
    const obj: any = {};
    togglePath(obj, 'remote');
    expect(obj.remote).toBe(true);
    togglePath(obj, 'remote');
    expect(obj.remote).toBe(false);
  });

  test('togglePath throws on non-boolean current value', () => {
    expect(() => togglePath({ remote: 'yes' }, 'remote')).toThrow();
  });

  // Removing one routine by index is the whole point of `unset routines.<n>`: a
  // `delete` would leave a hole that serializes as `null`, and validation then
  // fails on an entry with no id for every later write.
  test('unsetPath splices an array index, leaving the array dense', () => {
    const obj: any = { routines: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
    expect(unsetPath(obj, 'routines.1')).toBe(true);
    expect(obj.routines).toEqual([{ id: 'a' }, { id: 'c' }]);
  });

  test('unsetPath leaves an out-of-range index alone', () => {
    const obj: any = { routines: [{ id: 'a' }] };
    expect(unsetPath(obj, 'routines.5')).toBe(false);
    expect(unsetPath(obj, 'routines.x')).toBe(false);
    expect(obj.routines).toEqual([{ id: 'a' }]);
  });

  test('unsetPath still deletes an object leaf', () => {
    const obj: any = { channels: { discord: { enabled: true }, telegram: {} } };
    expect(unsetPath(obj, 'channels.discord')).toBe(true);
    expect(obj.channels).toEqual({ telegram: {} });
  });

  test('setPath appends at length but refuses a sparse index', () => {
    const obj: any = { routines: [{ id: 'a' }] };
    setPath(obj, 'routines.1', { id: 'b' });
    expect(obj.routines).toEqual([{ id: 'a' }, { id: 'b' }]);
    setPath(obj, 'routines.0.enabled', false);
    expect(obj.routines[0]).toEqual({ id: 'a', enabled: false });
    expect(() => setPath(obj, 'routines.7', { id: 'gap' })).toThrow(/0\.\.2/);
    expect(obj.routines).toHaveLength(2);
  });

  // An interior index edits an entry that has to already exist, so `length` is out of
  // range there too — otherwise the traversal creates it and the array grows holes.
  test('setPath refuses an out-of-range index in the middle of a path', () => {
    const obj: any = { routines: [{ id: 'a' }, { id: 'b' }] };
    expect(() => setPath(obj, 'routines.2.enabled', false)).toThrow(/0\.\.1/);
    expect(() => setPath(obj, 'routines.9.enabled', false)).toThrow(/0\.\.1/);
    expect(obj.routines).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  test('setPath rejects a non-canonical array index', () => {
    const obj: any = { routines: [{ id: 'a' }, { id: 'b' }] };
    expect(() => setPath(obj, 'routines.01', { id: 'x' })).toThrow();
    expect(unsetPath(obj, 'routines.01')).toBe(false);
    expect(obj.routines).toEqual([{ id: 'a' }, { id: 'b' }]);
  });
});

// --- CLI integration tests (subprocess) ---

describe('settings-edit.ts CLI', () => {
  test('get with no path prints the whole config', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { agent_name: 'Atlas', remote: true });
    const r = await runScript('settings-edit.ts', { args: [file, 'get'] });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ value: { agent_name: 'Atlas', remote: true } });
  });

  test('get with a dotted path prints the leaf value', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { quality_gate: { tier: 'balanced' } });
    const r = await runScript('settings-edit.ts', { args: [file, 'get', 'quality_gate.tier'] });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ value: 'balanced' });
  });

  test('get on an unset path reports not_set', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, {});
    const r = await runScript('settings-edit.ts', { args: [file, 'get', 'quality_gate.tier'] });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ status: 'none', reason: 'not_set' });
  });

  test('set a scalar leaf, preserving siblings', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { agent_name: 'Atlas', language: 'pt', escalation: 'balanced' });
    const r = await runScript('settings-edit.ts', { args: [file, 'set', 'escalation', 'autonomous'] });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('OK');
    expect(readConfig(file)).toEqual({ agent_name: 'Atlas', language: 'pt', escalation: 'autonomous' });
  });

  test('set JSON-parses booleans and numbers', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { remote: false });
    await runScript('settings-edit.ts', { args: [file, 'set', 'remote', 'true'] });
    expect(readConfig(file).remote).toBe(true);
    await runScript('settings-edit.ts', { args: [file, 'set', 'reflection.graduation_min_sessions', '2'] });
    expect(readConfig(file).reflection.graduation_min_sessions).toBe(2);
  });

  test('set treats an unparseable value as a raw string', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, {});
    await runScript('settings-edit.ts', { args: [file, 'set', 'timezone', 'Europe/Lisbon'] });
    expect(readConfig(file).timezone).toBe('Europe/Lisbon');
  });

  test('set with "none" or "clear" writes null', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { agent_name: 'Atlas out.' });
    await runScript('settings-edit.ts', { args: [file, 'set', 'agent_name', 'none'] });
    expect(readConfig(file).agent_name).toBeNull();
    await runScript('settings-edit.ts', { args: [file, 'set', 'agent_name', 'clear'] });
    expect(readConfig(file).agent_name).toBeNull();
  });

  test('set writes the literal string "default" (not null) — for permission_mode', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { permission_mode: 'auto' });
    await runScript('settings-edit.ts', { args: [file, 'set', 'permission_mode', 'default'] });
    // "default" is a real Claude Code permission_mode enum value, distinct from null.
    expect(readConfig(file).permission_mode).toBe('default');
  });

  test('set creates nested parents when absent', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { agent_name: 'Atlas' });
    await runScript('settings-edit.ts', { args: [file, 'set', 'quality_gate.tier', 'quality'] });
    const out = readConfig(file);
    expect(out.quality_gate).toEqual({ tier: 'quality' });
    expect(out.agent_name).toBe('Atlas');
  });

  test('toggle flips a boolean and defaults absent → true', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { remote: true });
    await runScript('settings-edit.ts', { args: [file, 'toggle', 'remote'] });
    expect(readConfig(file).remote).toBe(false);
    await runScript('settings-edit.ts', { args: [file, 'toggle', 'push_notifications'] });
    expect(readConfig(file).push_notifications).toBe(true);
  });

  test('toggle refuses a non-boolean value, leaves file unchanged', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { remote: 'yes' });
    const r = await runScript('settings-edit.ts', { args: [file, 'toggle', 'remote'] });
    expect(r.exitCode).not.toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ error: 'not_boolean:remote' });
    expect(readConfig(file)).toEqual({ remote: 'yes' });
  });

  test('refuses to overwrite a malformed config.json', async () => {
    const dir = freshDir();
    const hermit = path.join(dir, '.hermit');
    fs.mkdirSync(hermit, { recursive: true });
    const file = path.join(hermit, 'config.json');
    const malformed = '{ not valid json !!';
    fs.writeFileSync(file, malformed);
    const r = await runScript('settings-edit.ts', { args: [file, 'set', 'agent_name', 'x'] });
    expect(r.exitCode).not.toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ error: 'invalid_json' });
    expect(fs.readFileSync(file, 'utf8')).toBe(malformed);
  });

  test('unknown op exits non-zero', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, {});
    const r = await runScript('settings-edit.ts', { args: [file, 'frobnicate', 'x'] });
    expect(r.exitCode).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Registry-backed `show` and `apply-known`.
//
// These replaced a ~45-line *example* settings dump in hermit-settings/SKILL.md
// (invented values, field list drifting every release) and the 14 per-argument
// prose branches that each spelled out their own dotted path.

// The skill's argument table, as markdown built from the registry rows apply-known writes.
function tableMarkdown(): string {
  const cell = (text: string): string => text.replaceAll('|', '\\|').replaceAll('\n', ' ');
  const rows = tableSettings().map(s => {
    const type = (s.kind === 'int' ? 'integer' : s.kind) + (s.nullable ? ', nullable' : '');
    const values = s.values?.join(' / ') ?? (s.kind === 'boolean' ? 'yes / no' : 'any');
    const hint = s.hint ? `${values}; ${s.hint}` : values;
    return `| \`${s.arg}\` | \`${s.path}\` | ${type} | ${cell(hint)} | ${cell(s.applies ?? 'immediately')} |`;
  });
  return ['| Argument | Config path | Type | Values | Applies |', '|---|---|---|---|---|', ...rows].join('\n');
}

describe('settings registry', () => {
  test('every registry path is a real key in the shipped template', () => {
    // A row pointing at a path the template never defines would render "default"
    // forever and write a key nothing reads.
    const template = JSON.parse(
      fs.readFileSync(path.join(PLUGIN_ROOT, 'state-templates', 'config.json.template'), 'utf8'),
    );
    for (const s of SETTINGS) {
      expect(getPath(template, s.path.split('.')[0])).toBeDefined();
    }
  });

  test('the skill table lists exactly the non-exempt registry rows', () => {
    const skill = fs.readFileSync(
      path.join(PLUGIN_ROOT, 'skills', 'hermit-settings', 'SKILL.md'), 'utf8',
    );
    expect(skill.includes(tableMarkdown())).toBe(true);
    // Exempt rows must NOT be in the table — they do more than write one leaf.
    for (const s of SETTINGS.filter(x => x.tableExempt)) {
      expect(skill).not.toContain(`| \`${s.arg}\` | \`${s.path}\``);
    }
  });

  test('every remaining skill branch is one the registry deliberately excludes', () => {
    const skill = fs.readFileSync(
      path.join(PLUGIN_ROOT, 'skills', 'hermit-settings', 'SKILL.md'), 'utf8',
    );
    const branches = [...skill.matchAll(/^\*\*If argument is "([^"]+)":/gm)].map(m => m[1]);
    const tableArgs = new Set(tableSettings().map(s => s.arg));
    // A branch that is also in the table means the prose was left behind.
    for (const b of branches) expect(tableArgs.has(b)).toBe(false);
    expect(branches.length).toBe(14); // 8 stateful + 3 side-effecting + history (read-only) + voice (edits a file, not config) + messages (edits state/messages.json)
  });

  test('enums come from the shared module, not a second copy', () => {
    const validator = fs.readFileSync(path.join(PLUGIN_ROOT, 'scripts', 'validate-config.ts'), 'utf8');
    expect(validator).toContain("from './lib/settings/enums'");
    // The literal arrays must be gone from the validator.
    expect(validator).not.toContain("['conservative', 'balanced', 'autonomous']");
    expect(validator).not.toContain("['budget', 'balanced', 'quality']");
  });
});

describe('settings-edit show', () => {
  const row = (out: any, group: string, arg: string) => out[group].find((r: any) => r.arg === arg);

  test('carries live values, not an invented example', () => {
    const dir = freshDir();
    const file = seedConfig(dir, { agent_name: 'Atlas', escalation: 'autonomous', remote: false });
    const out = showData(JSON.parse(fs.readFileSync(file, 'utf8')), file);
    expect(row(out, 'identity', 'name').value).toBe('Atlas');
    expect(row(out, 'identity', 'escalation').value).toBe('autonomous');
    expect(row(out, 'operational', 'remote')).toEqual({ arg: 'remote', label: 'Remote control', value: false, applies: 'next hermitd-start' });
  });

  test('absent optional keys carry no value, and every section is present', () => {
    const out = JSON.parse(JSON.stringify(showData({}, 'cfg.json')));
    expect(out.config_path).toBe('cfg.json');
    expect(row(out, 'identity', 'name')).not.toHaveProperty('value');
    expect(out.operational.some((r: any) => r.arg === null)).toBe(true);
    expect(out.stateful.map((r: any) => r.arg)).toEqual(
      ['channels', 'brief', 'heartbeat', 'watchdog', 'routines', 'scheduled-checks', 'env', 'docker']);
  });

  test('stateful sections summarize counts and names', () => {
    const out = showData({
      channels: { primary: 'discord', discord: { enabled: true, morning_brief: { enabled: true, time: '08:00' } }, telegram: {} },
      routines: [{ id: 'a', enabled: true }, { id: 'b', enabled: false }],
      env: { FOO: '1' },
    }, 'cfg.json');
    const s = (arg: string) => out.stateful.find((r: any) => r.arg === arg);
    expect(s('channels')).toMatchObject({ configured: ['discord', 'telegram'], enabled: ['discord'] });
    expect(s('brief').enabled).toEqual([{ channel: 'discord', time: '08:00' }]);
    expect(s('routines')).toMatchObject({ enabled: 1, total: 2 });
    expect(s('env').keys).toEqual(['FOO']);
  });

  test('CLI show exits 0 and prints one JSON object', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { agent_name: 'Scout' });
    const r = await runScript('settings-edit.ts', { args: [file, 'show'] });
    expect(r.exitCode).toBe(0);
    expect(row(JSON.parse(r.stdout), 'identity', 'name').value).toBe('Scout');
  });
});

describe('settings-edit apply-known', () => {
  test('writes the registry path and preserves siblings', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { agent_name: 'Atlas', escalation: 'balanced', custom_key: 'kept' });
    const r = await runScript('settings-edit.ts', { args: [file, 'apply-known', 'escalation', 'autonomous'] });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ path: 'escalation', value: 'autonomous', applies: 'immediately' });
    const cfg = readConfig(file);
    expect(cfg.escalation).toBe('autonomous');
    expect(cfg.custom_key).toBe('kept');
    expect(cfg.agent_name).toBe('Atlas');
  });

  test('refuses a value outside the enum', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { escalation: 'balanced' });
    const r = await runScript('settings-edit.ts', { args: [file, 'apply-known', 'escalation', 'aggressive'] });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ status: 'refused', reason: 'invalid_value' });
    expect(out.detail).toContain('conservative');
    expect(readConfig(file).escalation).toBe('balanced'); // unchanged
  });

  test('retired setting arguments do not modify config', () => {
    const cfg = { agent_name: 'Atlas', escalation: 'balanced' };
    expect(applyKnown(cfg, 'sign-off', 'Atlas out.').ok).toBe(false);
    expect(applyKnown(cfg, 'idle', 'wait').ok).toBe(false);
    expect(cfg).toEqual({ agent_name: 'Atlas', escalation: 'balanced' });
  });

  test('refuses an unknown argument rather than inventing a path', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, {});
    const r = await runScript('settings-edit.ts', { args: [file, 'apply-known', 'nonesuch', 'x'] });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'refused', reason: 'unknown_setting' });
  });

  test('coerces booleans from operator vocabulary', () => {
    for (const yes of ['on', 'yes', 'true', 'enabled']) {
      const cfg: any = {};
      expect(applyKnown(cfg, 'remote', yes).ok).toBe(true);
      expect(cfg.remote).toBe(true);
    }
    for (const no of ['off', 'no', 'false', 'disabled']) {
      const cfg: any = {};
      applyKnown(cfg, 'remote', no);
      expect(cfg.remote).toBe(false);
    }
  });

  test('nullable settings accept none/clear; non-nullable refuse it', () => {
    const cfg: any = {};
    expect(applyKnown(cfg, 'name', 'none').ok).toBe(true);
    expect(cfg.agent_name).toBeNull();
    expect(applyKnown(cfg, 'escalation', 'none').ok).toBe(false);
  });

  test('string settings refuse an empty or whitespace-only value', () => {
    for (const blank of ['', '   ', '\t']) {
      const cfg: any = {};
      const r = applyKnown(cfg, 'artifact-backend', blank);
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('non-empty');
      expect(cfg.artifacts).toBeUndefined();
    }
    const cfg: any = {};
    expect(applyKnown(cfg, 'artifact-backend', 'my-artifact-host').ok).toBe(true);
    expect(cfg.artifacts.backend).toBe('my-artifact-host');
  });

  test('int settings reject non-positive and non-numeric input', () => {
    const cfg: any = {};
    expect(applyKnown(cfg, 'reflection', '2').ok).toBe(true);
    expect(cfg.reflection.graduation_min_sessions).toBe(2);
    expect(applyKnown(cfg, 'reflection', '0').ok).toBe(false);
    expect(applyKnown(cfg, 'reflection', 'two').ok).toBe(false);
  });

  test('creates the parent object for a nested path', () => {
    const cfg: any = {};
    applyKnown(cfg, 'artifact-dashboard', 'off');
    expect(cfg.artifacts.dashboard).toBe(false);
  });
});

// --- voice: the one enum whose `custom` value depends on a sibling key ---

describe('settings-edit voice', () => {
  test('writes a built-in style through the registry row', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { agent_name: 'Atlas', voice: { style: null, prose: null } });
    const r = await runScript('settings-edit.ts', { args: [file, 'apply-known', 'voice', 'Concise'] });
    expect(r.exitCode).toBe(0);
    const cfg = readConfig(file);
    expect(cfg.voice.style).toBe('Concise');
    expect(cfg.voice.prose).toBeNull();
    expect(cfg.agent_name).toBe('Atlas');
  });

  test('refuses a Claude Code built-in this hermit does not render', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { voice: { style: 'Concise', prose: null } });
    const r = await runScript('settings-edit.ts', { args: [file, 'apply-known', 'voice', 'Explanatory'] });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ status: 'refused', reason: 'invalid_value' });
    expect(out.detail).toContain('custom');
    expect(readConfig(file).voice.style).toBe('Concise');
  });

  // `default` is a real value here, not the "inherit Claude Code's default"
  // shorthand every other nullable row gives it: Claude Code's picker persists
  // the lowercase literal. Swallowing it to null would leave the style unset and
  // the previously rendered outputStyle in place forever.
  test('"default" persists as the literal, not as a cleared value', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { voice: { style: 'Concise', prose: null } });
    const r = await runScript('settings-edit.ts', { args: [file, 'apply-known', 'voice', 'default'] });
    expect(r.exitCode).toBe(0);
    expect(readConfig(file).voice.style).toBe('default');
  });

  test('style is nullable — clearing it stops the hermit managing the key', () => {
    // Clearing means "stop rendering", not "revert": the last rendered outputStyle
    // stays in settings until the operator changes it themselves. Nothing records
    // which scope's key the hermit wrote, so deleting it could clobber their own pick.
    const cfg: any = { voice: { style: 'Concise', prose: null } };
    expect(applyKnown(cfg, 'voice', 'none').ok).toBe(true);
    expect(cfg.voice.style).toBeNull();
  });

  test('custom without prose is refused, so the boot render can never fail on it', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { voice: { style: null, prose: null } });
    const r = await runScript('settings-edit.ts', { args: [file, 'apply-known', 'voice', 'custom'] });
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.error).toBe('invalid_config');
    expect(out.errors.join('\n')).toContain('voice.prose');
    expect(readConfig(file).voice.style).toBeNull();
  });

  test('prose first, then custom — the order the skill writes them in', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { voice: { style: null, prose: null } });
    const p = await runScript('settings-edit.ts', {
      args: [file, 'set', 'voice.prose', '"Lead with the answer. No preamble."'],
    });
    expect(p.exitCode).toBe(0);
    const s = await runScript('settings-edit.ts', { args: [file, 'apply-known', 'voice', 'custom'] });
    expect(s.exitCode).toBe(0);
    const cfg = readConfig(file);
    expect(cfg.voice.style).toBe('custom');
    expect(cfg.voice.prose).toBe('Lead with the answer. No preamble.');
  });

  test('prose must be a string — a bare number is refused', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, { voice: { style: null, prose: null } });
    const r = await runScript('settings-edit.ts', { args: [file, 'set', 'voice.prose', '42'] });
    expect(r.exitCode).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.error).toBe('invalid_config');
    expect(out.errors.join('\n')).toContain('voice.prose');
  });
});

// --- Audit ledger, unset, history ---

function auditRows(dir: string): any[] {
  const file = path.join(dir, '.hermit', 'state', 'settings-audit.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Satisfies validate()'s required keys, so a mutation's own validity is the only
// thing under test.
function validConfig(extra: any = {}): any {
  return {
    agent_name: 'Atlas', language: 'en', timezone: 'UTC', escalation: 'balanced',
    channels: {}, env: {}, heartbeat: { enabled: false }, routines: [], quality_gate: { tier: 'budget' },
    ...extra,
  };
}

describe('settings-edit audit ledger', () => {
  test('set records an attributed row with old → new', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, validConfig({ heartbeat: { enabled: true, every: '2h' } }));
    await runScript('settings-edit.ts', { args: [file, 'set', 'heartbeat.every', '30m'] });
    const rows = auditRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: 'settings-edit', target: 'config.json',
      path: 'heartbeat.every', old: '2h', new: '30m',
    });
  });

  test('apply-known and toggle are audited too', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, validConfig());
    await runScript('settings-edit.ts', { args: [file, 'apply-known', 'escalation', 'autonomous'] });
    await runScript('settings-edit.ts', { args: [file, 'toggle', 'remote'] });
    expect(auditRows(dir).map((r) => r.path)).toEqual(['escalation', 'remote']);
  });

  test('a refused write leaves neither config nor ledger changed', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, validConfig());
    const before = readConfig(file);
    const r = await runScript('settings-edit.ts', {
      args: [file, 'set', 'routines', '[{"id":"x","skill":"s","schedule":"not a cron","enabled":true}]'],
    });
    expect(r.exitCode).toBe(1);
    expect(readConfig(file)).toEqual(before);
    expect(auditRows(dir)).toHaveLength(0);
  });

  test('a dangling channels.primary is refused', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, validConfig({
      channels: { discord: { enabled: true }, primary: 'discord' },
    }));
    const r = await runScript('settings-edit.ts', { args: [file, 'unset', 'channels.discord'] });
    expect(r.exitCode).toBe(1);
    expect(readConfig(file).channels.discord).toBeDefined();
    expect(auditRows(dir)).toHaveLength(0);
  });

  test('pre-existing invalidity does not block an unrelated edit', async () => {
    const dir = freshDir();
    // Missing required keys — the operator's config is already invalid.
    const file = seedConfig(dir, { agent_name: 'Atlas' });
    const r = await runScript('settings-edit.ts', { args: [file, 'set', 'timezone', 'Europe/Lisbon'] });
    expect(r.exitCode).toBe(0);
    expect(readConfig(file).timezone).toBe('Europe/Lisbon');
  });
});

describe('settings-edit unset', () => {
  test('removes a nested leaf, leaving parents and siblings', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, validConfig({ channels: { discord: { enabled: true }, telegram: { enabled: true } } }));
    await runScript('settings-edit.ts', { args: [file, 'unset', 'channels.discord'] });
    const cfg = readConfig(file);
    expect(cfg.channels.discord).toBeUndefined();
    expect(cfg.channels.telegram).toBeDefined();
    expect(auditRows(dir)[0]).toMatchObject({ path: 'channels.discord' });
  });

  test('set on a config.json that does not exist yet creates it', async () => {
    const dir = freshDir();
    const file = path.join(dir, 'config.json');
    const r = await runScript('settings-edit.ts', { args: [file, 'set', 'model', '"sonnet"'] });
    expect(r.exitCode).toBe(0);
    expect(readConfig(file).model).toBe('sonnet');
  });

  test('a missing path is a no-op, not an error', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, validConfig());
    const r = await runScript('settings-edit.ts', { args: [file, 'unset', 'nope.not.here'] });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ status: 'none', reason: 'not_set' });
    expect(auditRows(dir)).toHaveLength(0);
  });
});

// The add/remove path hermit-settings uses from a channel: one entry at a time,
// so the gate sees a legible value and no confirmation code is asked for.
describe('settings-edit routines by index', () => {
  const routine = (id: string, extra: any = {}) => ({
    id, schedule: '0 9 * * *', skill: 'hermitd:brief', enabled: true, ...extra,
  });

  test('unset removes one routine and leaves the rest writable', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, validConfig({
      routines: [routine('morning'), routine('gated', { precheck: 'reflect' }), routine('evening')],
    }));
    const r = await runScript('settings-edit.ts', { args: [file, 'unset', 'routines.1'] });
    expect(r.exitCode).toBe(0);
    expect(readConfig(file).routines.map((x: any) => x.id)).toEqual(['morning', 'evening']);

    // The hole a `delete` used to leave made this next write fail validation.
    const after = await runScript('settings-edit.ts', { args: [file, 'set', 'routines.1.enabled', 'false'] });
    expect(after.exitCode).toBe(0);
    expect(readConfig(file).routines[1]).toMatchObject({ id: 'evening', enabled: false });
  });

  test('set at the array length appends one routine', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, validConfig({ routines: [routine('morning')] }));
    const r = await runScript('settings-edit.ts', {
      args: [file, 'set', 'routines.1', JSON.stringify(routine('evening'))],
    });
    expect(r.exitCode).toBe(0);
    expect(readConfig(file).routines.map((x: any) => x.id)).toEqual(['morning', 'evening']);
  });

  test('set past the end is refused, naming the valid range', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, validConfig({ routines: [routine('morning')] }));
    const r = await runScript('settings-edit.ts', {
      args: [file, 'set', 'routines.7', JSON.stringify(routine('gap'))],
    });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).error).toStartWith('index_out_of_range:routines.7: ');
    expect(JSON.parse(r.stdout).error).toContain('0..1');
    expect(readConfig(file).routines).toHaveLength(1);
  });
});

describe('settings-edit history', () => {
  test('prints recorded changes, filters by path, and honors --limit', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, validConfig({ heartbeat: { enabled: true, every: '2h' } }));
    await runScript('settings-edit.ts', { args: [file, 'set', 'heartbeat.every', '30m'] });
    await runScript('settings-edit.ts', { args: [file, 'set', 'model', 'opus'] });

    const all = JSON.parse((await runScript('settings-edit.ts', { args: [file, 'history'] })).stdout).rows;
    expect(all).toEqual([
      { ts: expect.any(String), path: 'heartbeat.every', actor: 'settings-edit', old: '2h', new: '30m' },
      { ts: expect.any(String), path: 'model', actor: 'settings-edit', new: 'opus' },
    ]);

    const filtered = JSON.parse((await runScript('settings-edit.ts', { args: [file, 'history', 'heartbeat'] })).stdout).rows;
    expect(filtered.map((r: any) => r.path)).toEqual(['heartbeat.every']);

    const limited = JSON.parse((await runScript('settings-edit.ts', { args: [file, 'history', '--limit', '1'] })).stdout).rows;
    expect(limited).toHaveLength(1);
  });

  test('an empty ledger reports plainly', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, validConfig());
    const r = await runScript('settings-edit.ts', { args: [file, 'history'] });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ rows: [] });
  });

  test('history names the routine id and field that changed', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, validConfig({
      routines: [{ id: 'hermitd:heartbeat-restart', schedule: '0 9 * * *', skill: 'hermitd:brief', enabled: true }],
    }));
    await runScript('settings-edit.ts', { args: [file, 'set', 'routines.0.schedule', '"0 8 * * *"'] });
    const r = await runScript('settings-edit.ts', { args: [file, 'history', 'routines'] });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).rows[0].diff).toEqual({ added: [], removed: [], changed: { 'hermitd:heartbeat-restart': ['schedule'] } });
  });
});

describe('settings-edit record-file', () => {
  test('records a baseline, skips an unchanged rewrite, then records a change', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, validConfig());
    const heartbeat = path.join(dir, '.hermit', 'HEARTBEAT.md');
    fs.writeFileSync(heartbeat, '# Heartbeat\n- item one\n');

    const first = await runScript('settings-edit.ts', { args: [file, 'record-file', 'HEARTBEAT.md'] });
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout).status).toBe('recorded');
    const rows = auditRows(dir);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: 'heartbeat-edit',
      target: 'HEARTBEAT.md',
      path: 'HEARTBEAT.md',
    });
    expect(rows[0].old).toBeUndefined();
    const firstNew = rows[0].new;
    expect(firstNew).toMatch(/^[0-9a-f]{12} \(\d+ lines\)$/);

    const second = await runScript('settings-edit.ts', { args: [file, 'record-file', 'HEARTBEAT.md'] });
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout).status).toBe('unchanged');
    expect(auditRows(dir)).toHaveLength(1);

    fs.writeFileSync(heartbeat, '# Heartbeat\n- item one\n- item two\n');
    const third = await runScript('settings-edit.ts', { args: [file, 'record-file', 'HEARTBEAT.md'] });
    expect(third.exitCode).toBe(0);
    expect(JSON.parse(third.stdout).status).toBe('recorded');
    const after = auditRows(dir);
    expect(after).toHaveLength(2);
    expect(after[1].old).toBe(firstNew);
    expect(after[1].new).not.toBe(firstNew);

    const history = await runScript('settings-edit.ts', { args: [file, 'history', 'HEARTBEAT.md'] });
    expect(history.exitCode).toBe(0);
    const historyRows = JSON.parse(history.stdout).rows;
    expect(historyRows).toHaveLength(2);
    expect(historyRows.every((r: any) => r.path === 'HEARTBEAT.md' && r.actor === 'heartbeat-edit')).toBe(true);
  });

  test('an unsupported file name exits 1', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, validConfig());
    const r = await runScript('settings-edit.ts', { args: [file, 'record-file', 'OPERATOR.md'] });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: 'unsupported_file' });
    expect(auditRows(dir)).toHaveLength(0);
  });
});

describe('migrate 1.4.0', () => {
  test('migrates legacy settings once and preserves operator choices', async () => {
    const dir = freshDir();
    const file = seedConfig(dir, {
      post_close_clear: false,
      boot_skill: '/hermitd:session-start',
      context_hygiene: { compact: { enabled: false } },
      routines: [
        { id: 'daily-auto-close', schedule: '0 0 * * *', skill: 'hermitd:session-close', enabled: true },
        { id: 'custom', schedule: '0 9 * * *', skill: 'custom:run', enabled: false, run_during_waiting: true },
      ],
      agent_name: 'Preserved',
    });
    const args = [file, 'migrate', '1.4.0'];
    const first = await runScript('settings-edit.ts', { args });
    expect(first.exitCode).toBe(0);
    const config = readConfig(file);
    expect(config.post_close_clear).toBeUndefined();
    expect(config.boot_skill).toBe('/hermitd:resident-start');
    expect(config.context_hygiene).toEqual({
      compact: { enabled: false },
      clear: { enabled: true, quiet: '1h', max_age: '24h', min_tokens: 20000 },
    });
    expect(config.routines).toEqual([
      { id: 'custom', schedule: '0 9 * * *', skill: 'custom:run', enabled: false },
    ]);
    expect(config.agent_name).toBe('Preserved');
    const ledger = path.join(path.dirname(file), 'state/settings-audit.jsonl');
    const recorded = fs.readFileSync(ledger, 'utf8');
    const rows = recorded.trim().split('\n').map(line => JSON.parse(line));
    expect(rows.map(row => row.path).sort()).toEqual([
      'boot_skill', 'context_hygiene.clear', 'post_close_clear', 'routines',
    ]);
    const bytes = fs.readFileSync(file, 'utf8');
    const mtime = fs.statSync(file).mtimeMs;
    expect((await runScript('settings-edit.ts', { args })).exitCode).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
    expect(fs.readFileSync(ledger, 'utf8')).toBe(recorded);
  });

  test('preserves domain boot skills and existing clear policy', async () => {
    const file = seedConfig(freshDir(), {
      boot_skill: '/domain:boot',
      context_hygiene: { clear: { enabled: false, quiet: '2h', max_age: '48h', min_tokens: 30000 } },
    });
    const before = fs.readFileSync(file, 'utf8');
    expect((await runScript('settings-edit.ts', { args: [file, 'migrate', '1.4.0'] })).exitCode).toBe(0);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('migrate channel-home', () => {
  test('seeds empty homes, excludes maintainers, preserves pins, and runs once', async () => {
    const file = seedConfig(freshDir(), {
      channels: {
        primary: 'discord',
        discord: { default_chat_id: '', dm_channel_id: 'HOME', custom: 'preserved' },
        telegram: { default_chat_id: null, dm_channel_id: 'T1' },
        custom: { dm_channel_id: 'M1', maintainer_channel_id: 'M1', send_script: 'send' },
        pinned: { default_chat_id: 'PIN', dm_channel_id: 'OTHER' },
        empty: { dm_channel_id: '' },
      },
    });
    const args = [file, 'migrate', 'channel-home'];
    const result = await runScript('settings-edit.ts', { args });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('OK');
    expect(readConfig(file).channels).toEqual({
      primary: 'discord', discord: { default_chat_id: 'HOME', custom: 'preserved' },
      telegram: { default_chat_id: 'T1' },
      custom: { maintainer_channel_id: 'M1', send_script: 'send' },
      pinned: { default_chat_id: 'PIN' }, empty: {},
    });
    const ledger = path.join(path.dirname(file), 'state/settings-audit.jsonl');
    const audit = fs.readFileSync(ledger, 'utf8');
    const bytes = fs.readFileSync(file, 'utf8');
    const mtime = fs.statSync(file).mtimeMs;
    const again = await runScript('settings-edit.ts', { args });
    expect(again.exitCode).toBe(0);
    expect(again.stdout.trim()).toBe('OK');
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
    expect(fs.readFileSync(ledger, 'utf8')).toBe(audit);
  });

  test('retired home does not grant runtime routing, trust, or unscoped recall', async () => {
    const { resolve } = await import('../scripts/resolve-outbound-channel');
    const { isTrustedController, recallScope } = await import('../scripts/lib/channel-auth');
    const { contextPolicyHash } = await import('../scripts/lib/context-policy');
    const { validate } = await import('../scripts/validate-config');
    const dir = freshDir();
    const config = { channels: { discord: { dm_channel_id: 'LEGACY' } } };
    const file = seedConfig(dir, config);
    const hermit = path.dirname(file);
    expect(resolve(config.channels)).toBeNull();
    expect(isTrustedController(config, 'discord', 'U1', 'LEGACY')).toBe(false);
    expect(recallScope(config, 'discord', 'LEGACY', hermit)).not.toBeNull();
    const before = contextPolicyHash(hermit);
    config.channels.discord.dm_channel_id = 'OTHER';
    fs.writeFileSync(file, JSON.stringify(config));
    expect(contextPolicyHash(hermit)).not.toBe(before);
    const result = validate({ channels: { discord: { dm_channel_id: 123, maintainer_channel_id: '123' } } });
    expect([...result.errors, ...result.warnings].some(line => line.includes('dm_channel_id'))).toBe(false);
  });
});

test('chat instructions append, replace and remove preserve siblings and reject invalid writes', async () => {
  const dir = freshDir();
  const original = { chat_id: 'C1', text: 'Review' };
  const sibling = { chat_id: 'C2', text: 'Check' };
  const file = seedConfig(dir, validConfig({ channels: { discord: { instructions: [original], allowed_users: ['U1'] }, telegram: { enabled: true } } }));
  const edit = (verb: string, key: string, value?: unknown) => runScript('settings-edit.ts', {
    args: [file, verb, `channels.discord.instructions.${key}`, ...(value === undefined ? [] : [JSON.stringify(value)])],
  });
  expect((await edit('set', '1', sibling)).exitCode).toBe(0);
  expect((await edit('set', '0', { ...original, text: 'Changed' })).exitCode).toBe(0);
  for (const value of [sibling, { ...original, text: 'x'.repeat(2001) }]) {
    const before = readConfig(file);
    const r = await edit('set', '0', value);
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).error).toBe('invalid_config');
    expect(readConfig(file)).toEqual(before);
  }
  expect((await edit('unset', '0')).exitCode).toBe(0);
  expect(readConfig(file).channels).toEqual({ discord: { instructions: [sibling], allowed_users: ['U1'] }, telegram: { enabled: true } });
});

describe('plugin routine migrations', () => {
  const row = (id: string, skill: string) => ({ id, skill, schedule: '0 9 * * *', enabled: true });
  const migrate = (file: string, plugin = 'hermitd-example', ids = 'morning-brief,patterns') =>
    runScript('settings-edit.ts', { args: [file, 'migrate', 'plugin-routine-ids', '--plugin', plugin, '--ids', ids] });

  test('renames only owned seeded routines, including reflect wrappers, and reruns as OK', async () => {
    const file = seedConfig(freshDir(), { routines: [
      { ...row('morning-brief', 'hermitd-example:brief --morning'), model: 'haiku', custom: true },
      row('operator-check', 'hermitd-example:brief'),
      row('patterns', 'hermitd:reflect --check-id patterns --check hermitd-example:patterns --quick'),
      row('foreign', 'other:brief'),
    ] });
    const r = await migrate(file);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ renamed: [
      { from: 'morning-brief', to: 'hermitd-example:morning-brief' },
      { from: 'patterns', to: 'hermitd-example:patterns' },
    ] });
    expect(readConfig(file).routines).toEqual([
      { ...row('hermitd-example:morning-brief', 'hermitd-example:brief --morning'), model: 'haiku', custom: true },
      row('operator-check', 'hermitd-example:brief'),
      row('hermitd-example:patterns', 'hermitd:reflect --check-id patterns --check hermitd-example:patterns --quick'),
      row('foreign', 'other:brief'),
    ]);
    const before = fs.readFileSync(file, 'utf8');
    expect((await migrate(file)).stdout.trim()).toBe('OK');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  test('same seeded id belongs only to the invoking plugin, including wrapped checks', async () => {
    for (const skill of ['hermitd-fitness:fitness-brief --morning',
      'hermitd:reflect --check-id morning-brief --check hermitd-fitness:fitness-brief --morning']) {
      const file = seedConfig(freshDir(), { routines: [row('morning-brief', skill)] });
      expect((await migrate(file, 'hermitd-homeassistant')).stdout.trim()).toBe('OK');
      expect(readConfig(file).routines[0].id).toBe('morning-brief');
      expect((await migrate(file, 'hermitd-fitness')).exitCode).toBe(0);
      expect(readConfig(file).routines[0].id).toBe('hermitd-fitness:morning-brief');
    }
  });

  test('carries renamed routines\' schedule cursors and leaves other cursors alone', async () => {
    const root = freshDir();
    const file = seedConfig(root, { routines: [
      row('morning-brief', 'hermitd-example:brief --morning'),
      row('patterns', 'hermitd:reflect --check-id patterns --check hermitd-example:patterns'),
      row('foreign', 'other:brief'),
    ] });
    const schedulePath = path.join(root, '.hermit', 'state', 'routine-schedule.json');
    fs.mkdirSync(path.dirname(schedulePath), { recursive: true });
    const mark = (m: string) => ({ last_consumed_mark: `2026-10-24T0${m}:00:00.000Z` });
    fs.writeFileSync(schedulePath, JSON.stringify({
      'morning-brief': mark('1'),
      patterns: mark('2'),
      'hermitd-example:patterns': mark('3'),
      foreign: mark('4'),
    }));
    expect((await migrate(file)).exitCode).toBe(0);
    expect(JSON.parse(fs.readFileSync(schedulePath, 'utf8'))).toEqual({
      'hermitd-example:morning-brief': mark('1'),
      patterns: mark('2'),
      'hermitd-example:patterns': mark('3'),
      foreign: mark('4'),
    });
  });

  test('notes script-gated renames only, and a replay prints OK', async () => {
    const root = freshDir();
    const gate = path.join(root, 'gates', 'brief.sh');
    fs.mkdirSync(path.dirname(gate), { recursive: true });
    fs.writeFileSync(gate, '#!/bin/sh\necho WAKE\n', { mode: 0o755 });
    const file = seedConfig(root, { routines: [
      { ...row('morning-brief', 'hermitd-example:brief'), precheck: 'gates/brief.sh' },
      { ...row('patterns', 'hermitd-example:patterns'), precheck: 'reflect' },
    ] });
    const r = await migrate(file);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.renamed).toHaveLength(2);
    expect(out.note).toContain('hermitd-example:morning-brief');
    expect(out.note).not.toContain('patterns');
    expect((await migrate(file)).stdout.trim()).toBe('OK');
  });

  test('builtin-gated and ungated renames carry no note', async () => {
    const file = seedConfig(freshDir(), { routines: [
      row('morning-brief', 'hermitd-example:brief'),
      { ...row('patterns', 'hermitd-example:patterns'), precheck: 'doctor' },
    ] });
    const out = JSON.parse((await migrate(file)).stdout);
    expect(out.renamed).toHaveLength(2);
    expect(out).not.toHaveProperty('note');
  });

  test('renames even when a project skill shares the plugin skill name', async () => {
    const root = freshDir();
    fs.mkdirSync(path.join(root, '.claude/skills/brief'), { recursive: true });
    const file = seedConfig(root, { routines: [row('morning-brief', 'hermitd-example:brief')] });
    expect((await migrate(file)).exitCode).toBe(0);
    expect(readConfig(file).routines[0].id).toBe('hermitd-example:morning-brief');
  });

  test('empty input prints OK for both migrations', async () => {
    const file = seedConfig(freshDir(), {});
    expect((await migrate(file)).stdout.trim()).toBe('OK');
    expect((await runScript('settings-edit.ts', { args: [file, 'migrate', 'clear-sibling-boot-skill', '--skill', '/hermitd-example:start'] })).stdout.trim()).toBe('OK');
  });

  test('clears only the exact named startup skill', async () => {
    for (const boot_skill of ['/hermitd-example:start', '/hermitd-example:other', '/hermitd-other:start', '/acme-hermit:boot', '/hermitd:resident-start', '/operator:start', 'local-start', null]) {
      const file = seedConfig(freshDir(), { boot_skill, custom: true });
      const args = [file, 'migrate', 'clear-sibling-boot-skill', '--skill', '/hermitd-example:start'];
      const r = await runScript('settings-edit.ts', { args });
      expect(r.exitCode).toBe(0);
      if (boot_skill === '/hermitd-example:start') {
        expect(JSON.parse(r.stdout)).toEqual({ cleared: boot_skill });
        expect(readConfig(file)).toEqual({ boot_skill: null, custom: true });
      } else {
        expect(r.stdout.trim()).toBe('OK');
        expect(readConfig(file)).toEqual({ boot_skill, custom: true });
      }
      expect((await runScript('settings-edit.ts', { args })).stdout.trim()).toBe('OK');
    }
  });

  test('argument-free migrations still reject extra arguments', async () => {
    const file = seedConfig(freshDir(), {});
    const r = await runScript('settings-edit.ts', { args: [file, 'migrate', 'channel-home', 'extra'] });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: 'unsupported_migration' });
  });

  test('clear-sibling-boot-skill rejects malformed arguments', async () => {
    const config = { boot_skill: '/hermitd-example:start' };
    const bad = [
      [],
      ['--skill'],
      ['--plugin', 'hermitd-example', '--skill', '/hermitd-example:start'],
      ['--skill', '/hermitd-example:start', 'extra'],
      ['--skill', 'start'],
      ['--skill', '/hermitd-example'],
      ['--skill', '/hermitd-example:'],
      ['--skill', '/Bad_Id:start'],
      ['--skill', '/hermitd-example:start --flag'],
    ];
    for (const extra of bad) {
      const file = seedConfig(freshDir(), config);
      const r = await runScript('settings-edit.ts', { args: [file, 'migrate', 'clear-sibling-boot-skill', ...extra] });
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.stdout).error).toContain('expected --skill /<plugin>:<name>');
      expect(readConfig(file)).toEqual(config);
    }
  });
});

test('chrome warns only when enabling it from off', async () => {
  for (const [before, raw, warned] of [[false, 'yes', true], [true, 'yes', false], [true, 'no', false], [false, 'no', false]] as const) {
    const file = seedConfig(freshDir(), { chrome: before });
    const result = await runScript('settings-edit.ts', { args: [file, 'apply-known', 'chrome', raw] });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).applies.includes('Warning: Claude in Chrome uses')).toBe(warned);
    expect(readConfig(file).chrome).toBe(raw === 'yes');
  }
});
