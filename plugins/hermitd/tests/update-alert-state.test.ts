import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory, withDir, hermit, write, readJson } from './helpers/workdir';
import { normalizeItemKey } from '../scripts/lib/heartbeat-items';

const { freshDir: freshCredRoot, cleanup: cleanupCredRoots } = freshDirFactory('hermit-credroot-');
afterAll(cleanupCredRoots);

describe('update-alert-state', () => {
  const NOW = '2026-07-10T12:00:00.000Z';

  async function updateAlertState(dir: string, payload: string, env: Record<string, string> = { HERMIT_NOW: NOW }) {
    const stateFile = hermit(dir, 'state', 'alert-state.json');
    const shellPath = hermit(dir, 'sessions', 'SHELL.md');
    const before = monitoringLines(shellPath);
    const r = await runScript('heartbeat.ts', { args: ['alert-state', stateFile], stdin: payload, env });
    expect(r.exitCode).toBe(0);
    return {
      state: fs.existsSync(stateFile) ? readJson(stateFile) : null,
      stdout: r.stdout.trim() ? JSON.parse(r.stdout.trim()) : null,
      // Retired journal writes remain absent.
      monitoring: monitoringLines(shellPath).slice(before.length),
    };
  }

  // `## Monitoring` body lines, minus the `<!-- none -->` placeholder the template ships.
  function monitoringLines(shellPath: string): string[] {
    if (!fs.existsSync(shellPath)) return [];
    const body = fs.readFileSync(shellPath, 'utf-8').split(/^## Monitoring$/m)[1] ?? '';
    return body.split(/^## /m)[0].split('\n').map(l => l.trim())
      .filter(l => l && l !== '<!-- none -->');
  }

  const firingPayload = (firing: Array<{ key?: string; item?: string; text: string }>, self_eval_updates: object = {}) =>
    JSON.stringify({ firing, self_eval_updates });

  const CREDENTIAL_ITEM =
    '- Read `state/doctor-report.json` → the `credential-expiry` check; if its status is warn or fail, tell the operator which credential needs re-auth and name the plugin\'s reauth skill from the report detail.';
  const writeHeartbeat = (dir: string, body = `# Heartbeat Checklist\n${CREDENTIAL_ITEM}\n`) =>
    write(hermit(dir, 'HEARTBEAT.md'), body);

  test('update-alert-state (new firing item creates entry, notifies once, preserves total_ticks)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'alert-state.json'), '{"alerts":{},"self_eval":{},"total_ticks":5}');
    const { state, stdout, monitoring } = await updateAlertState(dir, firingPayload([{ key: 'checklist:idle0001', text: 'Session idle 3h' }]));
    expect(state.alerts['checklist:idle0001']).toEqual({
      count: 1, consecutive_clean: 0, suppressed: false, first_seen: '2026-07-10', last_seen: '2026-07-10', text: 'Session idle 3h',
    });
    expect(state.total_ticks).toBe(5); // precheck-owned — must survive untouched
    expect(stdout.heartbeat_result).toBe('alert');
    expect(monitoring).toEqual([]);
    expect(stdout.notifications).toEqual(['Session idle 3h']); // first observation notifies
  }));

  // Issue #690: v1.2.17–v1.2.24 persisted doctor:* keys here, when this writer
  // still honoured doctor's new_entries payload. Those entries carry `detail`
  // but neither `text` nor `suppressed`, so aging them through classifyTick
  // emitted a literal "resolved — undefined" line. doctor-check.ts owns the
  // prefix now (state/doctor-alerts.json); heartbeat just retires the residue.
  test('update-alert-state (legacy doctor:* residue is dropped silently in one tick)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'alert-state.json'), JSON.stringify({
      alerts: {
        'doctor:permissions': { first_seen: '2026-08-04', status: 'warn', detail: 'world-readable' },
        'checklist:keepme': { count: 1, consecutive_clean: 0, suppressed: false, first_seen: '2026-07-10', last_seen: '2026-07-10', text: 'keep me' },
      },
      self_eval: {}, total_ticks: 2,
    }));
    const { state, stdout, monitoring } = await updateAlertState(dir, firingPayload([{ key: 'checklist:keepme', text: 'keep me' }]));

    expect(state.alerts['doctor:permissions']).toBeUndefined();       // gone in ONE tick, not aged over two
    expect(state.alerts['checklist:keepme']).toBeDefined();           // unrelated keys untouched
    expect(monitoring.join('\n')).not.toContain('undefined');
    expect(monitoring.join('\n')).not.toContain('doctor:');
    expect(stdout.notifications.join('\n')).not.toContain('doctor:'); // silent — no resolution ping
  }));

  test('update-alert-state (a model-authored doctor:* firing key is ignored)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'alert-state.json'), '{"alerts":{},"self_eval":{},"total_ticks":0}');
    const { state } = await updateAlertState(dir, firingPayload([
      { key: 'doctor:permissions', text: 'model tried to author a doctor finding' },
    ]));
    expect(state.alerts['doctor:permissions']).toBeUndefined();
  }));

  test('update-alert-state (repeat fire increments count, no notification on ticks 2-4)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'alert-state.json'),
      '{"alerts":{"checklist:idle0001":{"count":1,"consecutive_clean":0,"suppressed":false,"first_seen":"2026-07-08","last_seen":"2026-07-08","text":"old text"}},"self_eval":{},"total_ticks":10}');
    const { state, stdout, monitoring } = await updateAlertState(dir, firingPayload([{ key: 'checklist:idle0001', text: 'Session idle 5h' }]));
    expect(state.alerts['checklist:idle0001'].count).toBe(2);
    expect(state.alerts['checklist:idle0001'].suppressed).toBe(false);
    expect(state.alerts['checklist:idle0001'].text).toBe('Session idle 5h'); // label refreshed
    expect(monitoring).toEqual([]);
    expect(stdout.notifications).toEqual([]); // repeat fire — no re-notification
  }));

  test('update-alert-state (sixth fire suppresses — count:6, monitoring + notification once)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'alert-state.json'),
      '{"alerts":{"checklist:abc12345":{"count":5,"consecutive_clean":0,"suppressed":false,"first_seen":"2026-07-01","last_seen":"2026-07-09","text":"disk 90% full"}},"self_eval":{},"total_ticks":20,"last_digest_date":"2026-07-10"}'); // digest already sent today — isolates this assertion to the suppression transition alone
    const { state, stdout, monitoring } = await updateAlertState(dir, firingPayload([{ key: 'checklist:abc12345', text: 'disk 90% full' }]));
    expect(state.alerts['checklist:abc12345']).toMatchObject({ count: 6, suppressed: true, consecutive_clean: 0 });
    // Suppression still notifies the channel without writing to frozen session files.
    expect(monitoring).toEqual([]);
    expect(stdout.notifications).toEqual(['Heartbeat: "disk 90% full" suppressed after 5 fires — daily digest only.']);
  }));

  test('update-alert-state (seventh fire — silent, stays suppressed, no notification)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'alert-state.json'),
      '{"alerts":{"checklist:abc12345":{"count":6,"consecutive_clean":0,"suppressed":true,"first_seen":"2026-07-01","last_seen":"2026-07-09","text":"disk 90% full"}},"self_eval":{},"total_ticks":21,"last_digest_date":"2026-07-10"}');
    const { state, stdout, monitoring } = await updateAlertState(dir, firingPayload([{ key: 'checklist:abc12345', text: 'disk 90% full' }]));
    expect(state.alerts['checklist:abc12345'].count).toBe(7);
    expect(state.alerts['checklist:abc12345'].suppressed).toBe(true);
    expect(monitoring).toEqual([]);
    expect(stdout.notifications).toEqual([]); // last_digest_date already today — no repeat digest
  }));

  test('update-alert-state (not firing for 2 ticks resolves — unsuppressed announces, suppressed silent)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'alert-state.json'), JSON.stringify({
      alerts: {
        'checklist:aaa11111': { count: 2, consecutive_clean: 1, suppressed: false, first_seen: '2026-07-08', last_seen: '2026-07-09', text: 'flaky check' },
        'checklist:bbb22222': { count: 8, consecutive_clean: 1, suppressed: true, first_seen: '2026-07-01', last_seen: '2026-07-09', text: 'noisy suppressed check' },
      },
      self_eval: {}, total_ticks: 15,
    }));
    const { state, stdout, monitoring } = await updateAlertState(dir, firingPayload([]));
    expect(state.alerts).not.toHaveProperty('checklist:aaa11111');
    expect(state.alerts).not.toHaveProperty('checklist:bbb22222');
    expect(monitoring).toEqual([]); // suppressed one resolves silently
  }));

  // self_eval is derived from files this script reads, so nothing the subagent
  // returns may reach it — a payload that still carries the old key, in any shape,
  // leaves the counters exactly as they were.
  test('update-alert-state (a subagent self_eval_updates payload never reaches self_eval)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'alert-state.json'),
      '{"alerts":{},"self_eval":{"existing-key":"old-value"},"total_ticks":1}');
    const { state } = await updateAlertState(dir, firingPayload([], { 'new-key': 'new-value' }));
    expect(state.self_eval).toEqual({ 'existing-key': 'old-value' });

    const { state: state2 } = await updateAlertState(dir, JSON.stringify({ firing: [], self_eval_updates: ['not', 'an', 'object'] }));
    expect(state2.self_eval).toEqual({ 'existing-key': 'old-value' });
  }));

  test('update-alert-state (empty firing sets last_clean_eval_at to now; firing clears it)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'alert-state.json'), '{"alerts":{},"self_eval":{},"last_clean_eval_at":null,"total_ticks":2}');
    const { state: clean } = await updateAlertState(dir, firingPayload([]));
    expect(clean.last_clean_eval_at).toBe(NOW);

    write(hermit(dir, 'state', 'alert-state.json'), '{"alerts":{},"self_eval":{},"last_clean_eval_at":"2026-06-20T10:00:00.000Z","total_ticks":1}');
    const { state: alerting } = await updateAlertState(dir, firingPayload([{ key: 'checklist:idle0001', text: 'x' }]));
    expect(alerting.last_clean_eval_at).toBeNull();
  }));

  // Issue #783: a proposal awaiting review re-derives its `decision-pending:*` key
  // on every tick, so `firing` was never empty and last_clean_eval_at was never
  // stamped — precheck's clean-recheck damper could never arm and every poll
  // promoted to a full paid EVALUATE for as long as the proposal sat unreviewed
  // (observed live: one key at 227 ticks since July). An already-suppressed key is
  // bookkeeping, not news: it must not disarm the damper.
  test('update-alert-state (#783: a tick firing only already-suppressed keys is clean — stamps last_clean_eval_at, reports OK)', withDir(async (dir) => {
    fs.mkdirSync(hermit(dir, 'proposals'), { recursive: true });
    const pending: Array<[string, string, number]> = [['025', 'Retry queue', 227], ['030', 'Cost index', 82], ['032', 'Digest gate', 35]];
    const alerts: Record<string, unknown> = {};
    for (const [n, title, count] of pending) {
      write(hermit(dir, 'proposals', `PROP-${n}-slug-120000.md`), `---\nid: PROP-${n}\nstatus: proposed\ntitle: ${title}\n---\nbody\n`);
      alerts[`custom:PROP-${n}`] = { count, consecutive_clean: 0, suppressed: true, first_seen: '2026-07-01', last_seen: '2026-07-09', text: `PROP-${n} "${title}"` };
    }
    write(hermit(dir, 'state', 'alert-state.json'), JSON.stringify({
      alerts, self_eval: {}, total_ticks: 345, last_clean_eval_at: null, last_digest_date: '2026-07-10', // digest already sent today
    }));
    const { state, stdout } = await updateAlertState(dir, firingPayload(pending.map(([n, title]) => ({ key: `custom:PROP-${n}`, text: `PROP-${n} "${title}"` })))); // model reports nothing new
    expect(stdout.heartbeat_result).toBe('ok');
    expect(state.last_clean_eval_at).toBe(NOW);
    expect(stdout.notifications).toEqual([]);
    // Still tracked, still suppressed, still counting — only the damper verdict changed.
    expect(state.alerts['custom:PROP-025']).toMatchObject({ count: 228, suppressed: true, consecutive_clean: 0 });
  }));

  // The ladder notifies on the first observation and again at count===6; ticks 2-5 push a
  // Monitoring line and nothing else, whatever the text says (it is model-composed per tick
  // and carries no stability contract). So an already-recorded key is news already delivered:
  // treating it as un-clean cost five full EVALUATE wakes per alert before the damper armed.
  test('update-alert-state (already-recorded key repeating with new text is clean — stamps last_clean_eval_at, reports OK)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'alert-state.json'), JSON.stringify({
      alerts: {
        'checklist:invoice1': {
          count: 2, consecutive_clean: 0, suppressed: false,
          first_seen: '2026-07-09', last_seen: '2026-07-09', text: 'An invoice is overdue',
        },
      },
      self_eval: {}, total_ticks: 12, last_clean_eval_at: null,
    }));
    const { state, stdout } = await updateAlertState(dir,
      firingPayload([{ key: 'checklist:invoice1', text: 'An invoice has been overdue since Monday' }]));
    expect(stdout.heartbeat_result).toBe('ok');
    expect(state.last_clean_eval_at).toBe(NOW);
    expect(stdout.notifications).toEqual([]);
    expect(state.alerts['checklist:invoice1']).toMatchObject({ count: 3, suppressed: false, consecutive_clean: 0 });
  }));

  test('update-alert-state (a key with no prior entry is not already-recorded — clears last_clean_eval_at, reports ALERT)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'alert-state.json'),
      '{"alerts":{},"self_eval":{},"total_ticks":12,"last_clean_eval_at":"2026-07-10T06:00:00.000Z"}');
    const { state, stdout } = await updateAlertState(dir,
      firingPayload([{ key: 'checklist:invoice1', text: 'An invoice is overdue' }]));
    expect(stdout.heartbeat_result).toBe('alert');
    expect(state.last_clean_eval_at).toBeNull();
    expect(stdout.notifications).toEqual(['An invoice is overdue']);
  }));

  test('update-alert-state (total_ticks, last_digest_date preserved absent a digest event)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'alert-state.json'),
      '{"alerts":{},"self_eval":{},"total_ticks":42,"last_digest_date":"2026-06-21","last_clean_eval_at":null}');
    const { state } = await updateAlertState(dir, firingPayload([]));
    expect(state.total_ticks).toBe(42);
    expect(state.last_digest_date).toBe('2026-06-21');
  }));

  test('update-alert-state (missing state file — fail-open, seeds default, exits 0)', withDir(async (dir) => {
    const stateFile = hermit(dir, 'state', 'alert-state.json');
    const r = await runScript('heartbeat.ts', {
      args: ['alert-state', stateFile], stdin: firingPayload([{ key: 'custom:x', text: 'k fired' }]), env: { HERMIT_NOW: NOW },
    });
    expect(r.exitCode).toBe(0);
    const d = readJson(stateFile);
    expect(d.alerts['custom:x']).toBeDefined();
  }));

  test('update-alert-state (bad JSON payload — exits 1, no write)', withDir(async (dir) => {
    const stateFile = hermit(dir, 'state', 'alert-state.json');
    const r = await runScript('heartbeat.ts', { args: ['alert-state', stateFile], stdin: 'not-json' });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: 'invalid_json' });
    expect(fs.existsSync(stateFile)).toBe(false);
  }));

  test('update-alert-state (malformed firing shapes reject the whole tick — no write, no aging)', withDir(async (dir) => {
    const before = '{"alerts":{"custom:x":{"count":1,"consecutive_clean":0,"suppressed":false,"first_seen":"2026-07-01","last_seen":"2026-07-01","text":"t"}},"self_eval":{},"total_ticks":9}';
    const stateFile = hermit(dir, 'state', 'alert-state.json');

    write(stateFile, before);
    let r = await runScript('heartbeat.ts', { args: ['alert-state', stateFile], stdin: JSON.stringify({ firing: 'not-an-array', self_eval_updates: {} }), env: { HERMIT_NOW: NOW } });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ heartbeat_result: 'indeterminate', reason: 'missing_or_malformed_firing' });
    expect(readJson(stateFile)).toEqual(JSON.parse(before)); // untouched — never coerced to empty and aged

    write(stateFile, before);
    r = await runScript('heartbeat.ts', { args: ['alert-state', stateFile], stdin: JSON.stringify({ firing: [{ key: 'checklist:x' }], self_eval_updates: {} }), env: { HERMIT_NOW: NOW } }); // missing text
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ heartbeat_result: 'indeterminate', reason: 'missing_or_malformed_firing' });
    expect(readJson(stateFile)).toEqual(JSON.parse(before));

    write(stateFile, before);
    r = await runScript('heartbeat.ts', { args: ['alert-state', stateFile], stdin: JSON.stringify({ firing: [{ text: 'x' }], self_eval_updates: {} }), env: { HERMIT_NOW: NOW } }); // neither item nor key
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ heartbeat_result: 'indeterminate', reason: 'missing_or_malformed_firing' });
    expect(readJson(stateFile)).toEqual(JSON.parse(before));
  }));

  test('update-alert-state (rejected tick leaves state untouched and leaves the frozen Monitoring section untouched)', withDir(async (dir) => {
    const before = '{"alerts":{"custom:x":{"count":1,"consecutive_clean":0,"suppressed":false,"first_seen":"2026-07-01","last_seen":"2026-07-01","text":"t"}},"self_eval":{},"total_ticks":9,"last_clean_eval_at":"2026-07-09T12:00:00.000Z"}';
    write(hermit(dir, 'state', 'alert-state.json'), before);
    const { state, stdout, monitoring } = await updateAlertState(dir, '{"firing":null}');
    expect(state).toEqual(JSON.parse(before)); // untouched — last_clean_eval_at and the live alert both survive
    expect(stdout).toMatchObject({ heartbeat_result: 'indeterminate', reason: 'missing_or_malformed_firing' });
    expect(monitoring).toHaveLength(0);
  }));

  // A bare `null` return parses but has no properties — the reject path must
  // still produce the contract, not a TypeError with empty stdout.
  test('update-alert-state (payload that parses to a non-object still reports INDETERMINATE)', withDir(async (dir) => {
    const before = '{"alerts":{},"self_eval":{},"total_ticks":1}';
    write(hermit(dir, 'state', 'alert-state.json'), before);
    const { state, stdout } = await updateAlertState(dir, 'null');
    expect(state).toEqual(JSON.parse(before));
    expect(stdout).toMatchObject({ heartbeat_result: 'indeterminate', reason: 'missing_or_malformed_firing' });
  }));

  test('update-alert-state (duplicate firing keys deduped — first occurrence wins)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'alert-state.json'), '{"alerts":{},"self_eval":{},"total_ticks":1}');
    const { state } = await updateAlertState(dir, firingPayload([
      { key: 'checklist:dup00000', text: 'first text' },
      { key: 'checklist:dup00000', text: 'second text' },
    ]));
    expect(Object.keys(state.alerts)).toEqual(['checklist:dup00000']);
    expect(state.alerts['checklist:dup00000'].text).toBe('first text');
  }));

  test('update-alert-state (item matching HEARTBEAT.md is stored under the derived checklist key)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'alert-state.json'), '{"alerts":{},"self_eval":{},"total_ticks":1}');
    writeHeartbeat(dir);
    const { state } = await updateAlertState(dir, firingPayload([
      { item: CREDENTIAL_ITEM, text: 'claude-subscription needs re-auth' },
    ]));
    expect(state.alerts[normalizeItemKey(CREDENTIAL_ITEM)!]).toMatchObject({ text: 'claude-subscription needs re-auth', count: 1 });
    expect(Object.keys(state.alerts).some(k => k.startsWith('custom:'))).toBe(false);
  }));

  test('update-alert-state (indented or backtick-less item echo snaps to the checklist key)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'alert-state.json'), '{"alerts":{},"self_eval":{},"total_ticks":1}');
    writeHeartbeat(dir);
    const { state } = await updateAlertState(dir, firingPayload([
      { item: `  ${CREDENTIAL_ITEM.replace(/`/g, '')}`, text: 'claude-subscription needs re-auth' },
    ]));
    expect(Object.keys(state.alerts)).toEqual([normalizeItemKey(CREDENTIAL_ITEM)!]);
  }));

  test('update-alert-state (custom:* and waiting-timeout keep their key)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'alert-state.json'), '{"alerts":{},"self_eval":{},"total_ticks":1}');
    writeHeartbeat(dir);
    const { state } = await updateAlertState(dir, firingPayload([
      { key: 'custom:diskfull', text: 'disk 90% full' },
      { key: 'waiting-timeout', text: 'waiting timed out' },
    ]));
    expect(state.alerts['custom:diskfull']).toBeDefined();
    expect(state.alerts['waiting-timeout']).toBeDefined();
    expect(state.alerts[normalizeItemKey(CREDENTIAL_ITEM)!]).toBeUndefined();
  }));

  test('update-alert-state (a model-authored doctor key is dropped, never remapped to custom:)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'alert-state.json'), '{"alerts":{},"self_eval":{},"total_ticks":1}');
    writeHeartbeat(dir);
    const { state, stdout } = await updateAlertState(dir, firingPayload([
      { key: 'doctor:credential-expiry', text: 'doctor finding' },
    ]));
    expect(state.alerts).toEqual({});
    expect(stdout.notifications).toEqual([]);
    expect(stdout.heartbeat_result).toBe('ok');
  }));

  test('update-alert-state (unresolvable key dedups on the key, not the reworded text)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'alert-state.json'), '{"alerts":{},"self_eval":{},"total_ticks":1}');
    writeHeartbeat(dir);
    await updateAlertState(dir, firingPayload([{ key: 'checklist:gonemiss', text: 'disk is filling up' }]));
    const { state } = await updateAlertState(dir, firingPayload([{ key: 'checklist:gonemiss', text: 'disk almost full' }]));
    const customKeys = Object.keys(state.alerts).filter(k => k.startsWith('custom:'));
    expect(customKeys).toHaveLength(1);
    expect(state.alerts[customKeys[0]].count).toBe(2);
  }));

  test('update-alert-state (unresolvable item mints no phantom checklist key)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'alert-state.json'), '{"alerts":{},"self_eval":{},"total_ticks":1}');
    writeHeartbeat(dir);
    const { state } = await updateAlertState(dir, firingPayload([
      { item: 'Totally paraphrased credential check', key: 'checklist:totallyp', text: 'needs re-auth' },
    ]));
    expect(state.alerts['checklist:totallyp']).toBeUndefined();
    expect(state.alerts[normalizeItemKey(CREDENTIAL_ITEM)!]).toBeUndefined();
    const customKeys = Object.keys(state.alerts).filter(k => k.startsWith('custom:'));
    expect(customKeys).toHaveLength(1);
  }));

  test('update-alert-state (credential item six ticks suppress, then precheck is OK)', withDir(async (dir) => {
    // last_digest_date must be wall-clock today: precheck's digest gate uses
    // todayYMD, which does not honour HERMIT_NOW.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date());
    writeHeartbeat(dir);
    write(hermit(dir, 'config.json'), JSON.stringify({
      timezone: 'UTC',
      heartbeat: { clean_recheck_cooldown: null, active_hours: { start: '00:00', end: '24:00' } },
    }));
    write(hermit(dir, 'state', 'alert-state.json'), JSON.stringify({
      alerts: {}, self_eval: {}, total_ticks: 3, last_digest_date: today,
    }));
    write(hermit(dir, 'state', 'runtime.json'), '{}');
    write(hermit(dir, 'state', 'micro-proposals.json'), '{"pending":[]}');
    fs.mkdirSync(hermit(dir, 'proposals'), { recursive: true });

    const pluginRoot = path.join(freshCredRoot(), 'plugins', 'hermitd');
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), '{"name":"hermitd","version":"1.0.0"}');
    fs.writeFileSync(path.join(pluginRoot, '.claude-plugin', 'hermit-meta.json'), JSON.stringify({
      credentials: [{ name: 'claude-subscription', expiry_probe: 'echo EXPIRED', warn_days: 3 }],
    }));

    for (let i = 0; i < 6; i++) {
      await updateAlertState(dir, firingPayload([
        { item: CREDENTIAL_ITEM, text: 'claude-subscription needs re-auth' },
      ]), {});
    }
    const after = readJson(hermit(dir, 'state', 'alert-state.json'));
    expect(after.alerts[normalizeItemKey(CREDENTIAL_ITEM)!].count).toBe(6);
    expect(after.alerts[normalizeItemKey(CREDENTIAL_ITEM)!].suppressed).toBe(true);

    const r = await runScript('heartbeat.ts', {
      args: ['precheck', hermit(dir)],
      env: { CLAUDE_PLUGIN_ROOT: pluginRoot },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('OK');
  }));

  test('update-alert-state (write failure — no side effects)', withDir(async (dir) => {
    const stateFile = hermit(dir, 'state', 'alert-state.json');
    const before = '{"alerts":{},"self_eval":{},"total_ticks":1}';
    write(stateFile, before);
    const stateSubdir = path.dirname(stateFile);
    fs.chmodSync(stateSubdir, 0o555); // read-only dir — the tmp-file write inside writeAlertState fails
    try {
      const r = await runScript('heartbeat.ts', { args: ['alert-state', stateFile], stdin: firingPayload([{ key: 'custom:x', text: 'x' }]), env: { HERMIT_NOW: NOW } });
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout.trim())).toMatchObject({ heartbeat_result: 'indeterminate', reason: 'write_failed' });
      expect(fs.readFileSync(stateFile, 'utf-8')).toBe(before); // untouched
    } finally {
      fs.chmodSync(stateSubdir, 0o755);
    }
  }));

  test('update-alert-state (apostrophe in free-text value round-trips intact)', withDir(async (dir) => {
    // Regression: apostrophes broke single-quoted argv passing.
    write(hermit(dir, 'state', 'alert-state.json'), '{"alerts":{},"self_eval":{},"total_ticks":7}');
    const { state } = await updateAlertState(dir, firingPayload(
      [{ key: 'checklist:idle0001', text: "the session's been idle" }],
    ));
    expect(state.alerts['checklist:idle0001'].text).toBe("the session's been idle");
    expect(state.total_ticks).toBe(7);
  }));

  test('update-alert-state (embedded double-quote and newline round-trip intact)', withDir(async (dir) => {
    write(hermit(dir, 'state', 'alert-state.json'), '{"alerts":{},"self_eval":{},"total_ticks":1}');
    const text = 'said "hi"\nthen left';
    const { state } = await updateAlertState(dir, firingPayload([{ key: 'custom:k', text }]));
    expect(state.alerts['custom:k'].text).toBe(text);
  }));

  // -----------------------------------------------------------------------
  // Structured-key derivation (issue #594 scope A′) — micro-proposal-pending
  // and proposal-pending are script-derived from source-of-truth, never
  // model-authored. These pin the regression the refactor exists to close.
  // -----------------------------------------------------------------------

});
