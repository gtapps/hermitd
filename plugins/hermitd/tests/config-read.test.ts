// Contract tests for the settled config read path (scripts/lib/config-read.ts):
// degenerate-input settling, the customizability invariants (pass-through at
// every nesting level, shape-not-vocabulary settling, containers settle to
// empty), and template parity so a new template key can't ship without a
// defaults-table row.

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { settleConfig, readSettledConfig, configExists, SETTLED_KEYS, TABLE, type Spec } from '../scripts/lib/config-read';
import { validate } from '../scripts/validate-config';
import { freshDirFactory } from './helpers/workdir';

const templatePath = path.resolve(import.meta.dir, '../state-templates/config.json.template');
const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));

function getPath(obj: any, dotted: string): any {
  return dotted.split('.').reduce((o, k) => o?.[k], obj);
}

describe('settleConfig degenerate inputs', () => {
  // [case, raw input, dotted path, settled value]
  const CASES: Array<[string, unknown, string, unknown]> = [
    ['missing config -> nullable scalar null', undefined, 'timezone', null],
    ['missing config -> scalar default', undefined, 'escalation', 'balanced'],
    ['missing lateness limit -> default', {}, 'routine_max_lateness_minutes', 60],
    ['custom lateness limit survives', { routine_max_lateness_minutes: 15 }, 'routine_max_lateness_minutes', 15],
    ['malformed lateness limit -> default', { routine_max_lateness_minutes: '15' }, 'routine_max_lateness_minutes', 60],
    ['missing config -> container empty', undefined, 'routines', []],
    ['missing config -> nested default', undefined, 'heartbeat.every', '30m'],
    ['non-object (null)', null, 'escalation', 'balanced'],
    ['non-object (number)', 42, 'push_notifications', true],
    ['non-object (string)', 'x', 'model', 'sonnet'],
    ['non-object (array)', [], 'permission_mode', 'auto'],
    ['empty-string nullable scalar -> null', { timezone: '' }, 'timezone', null],
    ['wrong-typed nullable scalar -> null', { timezone: 42 }, 'timezone', null],
    ['valid custom string kept', { timezone: 'Europe/Lisbon' }, 'timezone', 'Europe/Lisbon'],
    ['empty-string non-nullable scalar -> default', { escalation: '' }, 'escalation', 'balanced'],
    ['wrong-typed boolean -> default', { remote: 'yes' }, 'remote', true],
    ['NaN number -> default', { knowledge: { raw_retention_days: NaN } }, 'knowledge.raw_retention_days', 14],
    ['string where number expected -> default', { context_hygiene: { compact: { min_context_tokens: '100' } } }, 'context_hygiene.compact.min_context_tokens', 100000],
    ['nullable number malformed -> null', { budget: { daily_usd: '5' } }, 'budget.daily_usd', null],
    ['wrong-typed nested block -> default block', { heartbeat: 'yes' }, 'heartbeat.every', '30m'],
    ['wrong-typed nested block -> nested shape default', { heartbeat: 'yes' }, 'heartbeat.active_hours.start', '08:00'],
    ['nested wrong-typed sub-key settles', { heartbeat: { every: 5 } }, 'heartbeat.every', '30m'],
    ['nested sibling default fills in', { heartbeat: { every: '4h' } }, 'heartbeat.enabled', true],
    ['nested wrong-typed boolean settles', { watchdog: { enabled: 1 } }, 'watchdog.enabled', false],
    ['watchdog.scheduler_enabled absent → true', { watchdog: { enabled: false } }, 'watchdog.scheduler_enabled', true],
    ['watchdog.scheduler_enabled explicit false survives', { watchdog: { scheduler_enabled: false } }, 'watchdog.scheduler_enabled', false],
    ['watchdog.scheduler_enabled malformed → true', { watchdog: { scheduler_enabled: 1 } }, 'watchdog.scheduler_enabled', true],
    ['explicit null on a scalar is preserved (disable semantics)', { heartbeat: { clean_recheck_cooldown: null } }, 'heartbeat.clean_recheck_cooldown', null],
    ['explicit null on a non-nullable scalar is preserved', { escalation: null }, 'escalation', null],
    ['malformed routines -> empty, never template seeds', { routines: 'x' }, 'routines', []],
    ['malformed channels -> empty object', { channels: 7 }, 'channels', {}],
    ['malformed env -> empty object', { env: 'PATH' }, 'env', {}],
  ];

  test.each(CASES)('%s', (_name, raw, dotted, want) => {
    expect(getPath(settleConfig(raw), dotted)).toEqual(want);
  });

  test('every template key is present after settling anything', () => {
    const settled = settleConfig(undefined);
    for (const key of SETTLED_KEYS) expect(settled).toContainKey(key);
  });
});

describe('customizability invariants', () => {
  test('unknown top-level keys pass through verbatim', () => {
    const settled = settleConfig({ my_custom_block: { a: 1 }, my_flag: false });
    expect(settled.my_custom_block).toEqual({ a: 1 });
    expect(settled.my_flag).toBe(false);
  });

  test('unknown keys inside a known nested block pass through', () => {
    const settled = settleConfig({ heartbeat: { every: '4h', my_extra: 'x' } });
    expect(settled.heartbeat.my_extra).toBe('x');
    expect(settled.heartbeat.every).toBe('4h');
  });

  test('custom enum-ish strings are never settled by vocabulary', () => {
    const settled = settleConfig({ escalation: 'my-custom-mode' });
    expect(settled.escalation).toBe('my-custom-mode');
  });

  test('routine/channel item contents are not normalized', () => {
    const routines = [{ id: 'r1', custom_field: true, schedule: 42 }];
    const channels = { discord: { bot_token_env: 'X', my_key: 1 } };
    const settled = settleConfig({ routines, channels });
    expect(settled.routines).toEqual(routines);
    expect(settled.channels).toEqual(channels);
  });

  test('template _note keys survive via spread', () => {
    const settled = settleConfig({ telemetry_export: { _note: 'doc', enabled: true } });
    expect(settled.telemetry_export._note).toBe('doc');
    expect(settled.telemetry_export.enabled).toBe(true);
  });
});

describe('readSettledConfig fs behavior', () => {
  const { freshDir, cleanup } = freshDirFactory('hermit-config-read-');
  afterAll(cleanup);

  test('missing file -> full defaults, configExists false', () => {
    const dir = freshDir();
    expect(configExists(dir)).toBe(false);
    const settled = readSettledConfig(dir);
    expect(settled.escalation).toBe('balanced');
    expect(settled.routines).toEqual([]);
  });

  test('malformed JSON -> full defaults, configExists true', () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, 'config.json'), '{nope');
    expect(configExists(dir)).toBe(true);
    const settled = readSettledConfig(dir);
    expect(settled.model).toBe('sonnet');
  });

  test('well-formed file passes through with settling', () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ timezone: '', agent_name: 'Hermie', custom: 1 }));
    const settled = readSettledConfig(dir);
    expect(settled.timezone).toBe(null);
    expect(settled.agent_name).toBe('Hermie');
    expect(settled.custom).toBe(1);
  });
});

describe('read-path gate', () => {
  // Migration completeness: any script touching config.json must go through
  // lib/config-read (settled or raw) or sit on the explicit allowlist below.
  const ALLOW = new Set([
    'lib/config-read.ts', // the reader itself
    'validate-config.ts', // advisory schema validator — raw by design
    'hatch-config.ts', // writer: strict read before write
    'lib/config-write.ts', // shared config.json persister for settings-edit, hatch-config and channel-access
    'evolve-finalize.ts', // writer: upgrade path
    'evolve-plan.ts', // upgrade tooling: differentiated error taxonomy (no_config vs invalid vs unreadable)
    'channel-hook.ts', // writer: default_chat_id persist path keeps its strict read
    'resolve-outbound-channel.ts', // CLI: config_read_failed error output carries the parse message
    'lib/cc-compat.ts', // hermitDir(): existence walk, never parses
    'docker-preflight.ts', // existence check, never parses
    'lib/config-audit.ts', // audit ledger: the literal is a row's target label, never a path it reads
    'settings-gate.ts', // PreToolUse gate: the literal is a path suffix it matches tool calls against, never a file it reads
  ]);

  test('no config.json literal outside config-read importers and the allowlist', () => {
    const scriptsDir = path.resolve(import.meta.dir, '../scripts');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith('.ts')) continue;
        const rel = path.relative(scriptsDir, full);
        if (ALLOW.has(rel)) continue;
        const content = fs.readFileSync(full, 'utf8');
        if (content.includes("'config.json'") && !content.includes("/config-read'")) {
          offenders.push(rel);
        }
      }
    };
    walk(scriptsDir);
    expect(offenders).toEqual([]);
  });
});

describe('template parity', () => {
  test('defaults table keys === template top-level keys', () => {
    expect([...SETTLED_KEYS].sort()).toEqual(Object.keys(template).sort());
  });

  // Containers settle to empty (template values are hatch-time seeds, not
  // defaults); everything else's settled default must track the template.
  const CONTAINERS = new Set(['_hermit_versions', 'channels', 'routines', 'monitors', 'env', 'scheduled_checks']);

  test('scalar defaults track template values', () => {
    const defaults = settleConfig(undefined);
    const compare = (tmpl: any, settled: any, at: string) => {
      for (const [k, v] of Object.entries(tmpl)) {
        if (k === '_note') continue;
        if (at === '' && CONTAINERS.has(k)) {
          expect(settled[k]).toEqual(Array.isArray(v) ? [] : {});
        } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          compare(v, settled[k], `${at}${k}.`);
        } else {
          expect(settled[k]).toEqual(v);
        }
      }
    };
    compare(template, defaults, '');
  });
});

describe('config reference coverage', () => {
  test('every table leaf is documented backticked in docs/config-reference.md', () => {
    const doc = fs.readFileSync(path.join(import.meta.dir, '..', 'docs', 'config-reference.md'), 'utf8');
    const spans = doc.match(/`[^`\n]+`/g) ?? [];
    const missing: string[] = [];
    const walk = (rows: Record<string, Spec>, prefix = ''): void => {
      for (const [key, spec] of Object.entries(rows)) {
        if (key === '_hermit_versions') continue;
        const dotted = prefix ? `${prefix}.${key}` : key;
        const leaf = new RegExp(`(^|[^A-Za-z0-9_])${key}($|[^A-Za-z0-9_])`);
        if (!spans.some(span => leaf.test(span))) missing.push(dotted);
        if (spec.kind === 'shape') walk(spec.sub, dotted);
      }
    };
    walk(TABLE);
    expect(missing).toEqual([]);
  });
});

