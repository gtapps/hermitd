// Doctor escalation ledger (issue #690).
//
// Before this, hermit-doctor's SKILL.md sent `{new_entries, updated_entries,
// resolved_keys}` to `heartbeat.ts alert-state`, which has read only `firing`
// since #594 — so the payload was silently discarded, no doctor:* key was ever
// persisted, and every run re-notified every standing finding.
//
// The ledger now lives in doctor-alerts.json and is computed by doctor-check.ts.
// These tests drive escalate()/markNotified() directly (the check suite itself is
// covered elsewhere) plus one end-to-end pass through the CLI.

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { mutateTask } from '../scripts/lib/tasks';
import { runScript, PLUGIN_ROOT } from './helpers/run';

// Serial by necessity, not by taste: bunfig.toml's `concurrentTestGlob`
// runs every `beforeEach`, then every body, then every `afterEach`, so
// teardown sees the LAST value of a module/describe-scope fixture and rm's
// a directory another test still needs. `test.serial` restores be/ae
// pairing per test (`describe.serial` is silently ignored, Bun 1.3.14).
// Drop it only after giving each test its own fixture.
let dir: string;
let hermit: string;
let ledger: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-esc-'));
  hermit = path.join(dir, '.hermit');
  fs.mkdirSync(path.join(hermit, 'state'), { recursive: true });
  ledger = path.join(hermit, 'state', 'doctor-alerts.json');
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});

// escalate()/markNotified() take an explicit hermit dir (defaulting to the
// argv-derived one) so each case is isolated in its own tmpdir.
const { escalate: escalateIn, markNotified: markNotifiedIn } =
  await import(`${PLUGIN_ROOT}/scripts/doctor-check.ts`);
const escalate = (checks: any[], nowIso: string) => escalateIn(checks, nowIso, hermit);
const markNotified = (ids: string[]) => markNotifiedIn(ids, hermit);

const check = (id: string, status: string, detail = `${id} detail`, alertDetail?: string, tier?: string) => ({
  id,
  status,
  detail,
  ...(alertDetail ? { alert_detail: alertDetail } : {}),
  ...(tier ? { tier } : {}),
});
const readLedger = () => JSON.parse(fs.readFileSync(ledger, 'utf-8')).alerts;

describe('escalate — audience tier', () => {
  test.serial('a declared tier rides into escalation.new; an undeclared one leaves no key', async () => {

    const checks = [
      check('classifier-denials', 'warn', '3 denials in 7d', undefined, 'maintainer'),
      check('permissions', 'warn'),
    ];

    const out = escalate(checks, '2026-08-01T10:00:00Z');
    const byId = Object.fromEntries(out.new.map((n: any) => [n.id, n]));
    expect(byId['classifier-denials'].tier).toBe('maintainer');
    // Absent, not undefined-valued: the skill tests for the key's presence to decide
    // which leg a row belongs on, so an empty key would put every row on both.
    expect('tier' in byId['permissions']).toBe(false);
  });
});

describe('escalate — episode lifecycle', () => {
  test.serial('first warn is new; unchanged second run is silent and preserves first_seen', async () => {

    const checks = [check('permissions', 'warn'), check('runtime', 'ok')];

    const first = escalate(checks, '2026-08-01T10:00:00Z');
    expect(first.persisted).toBe(true);
    expect(first.prior_state_known).toBe(true);
    expect(first.new.map((n: any) => n.id)).toEqual(['permissions']);
    expect(readLedger()['doctor:permissions'].first_seen).toBe('2026-08-01T10:00:00Z');

    // Announced — confirm delivery, which is what makes the next run silent.
    expect(markNotified(['permissions'])).toBe(true);

    const second = escalate(checks, '2026-08-02T10:00:00Z');
    expect(second.new).toEqual([]);
    const entry = readLedger()['doctor:permissions'];
    expect(entry.first_seen).toBe('2026-08-01T10:00:00Z'); // episode start preserved
    expect(entry.last_seen).toBe('2026-08-02T10:00:00Z');
    expect(entry.count).toBe(2);
  });

  test.serial('an unconfirmed finding is re-offered until delivery is confirmed', async () => {

    const checks = [check('permissions', 'warn')];

    expect(escalate(checks, '2026-08-01T10:00:00Z').new).toHaveLength(1);
    // No markNotified — the send failed or degraded.
    expect(escalate(checks, '2026-08-02T10:00:00Z').new.map((n: any) => n.id)).toEqual(['permissions']);
    expect(escalate(checks, '2026-08-03T10:00:00Z').new).toHaveLength(1);

    markNotified(['permissions']);
    expect(escalate(checks, '2026-08-04T10:00:00Z').new).toEqual([]);
  });

  test.serial('detail change and warn->fail stay one episode, not a re-notification', async () => {

    escalate([check('docker-security', 'warn', 'overlay missing')], '2026-08-01T10:00:00Z');
    markNotified(['docker-security']);

    const escalated = escalate([check('docker-security', 'fail', 'ports published')], '2026-08-02T10:00:00Z');
    expect(escalated.new).toEqual([]); // same unresolved episode

    const entry = readLedger()['doctor:docker-security'];
    expect(entry.status).toBe('fail');          // status refreshed
    expect(entry.message).toBe('ports published'); // detail refreshed
    expect(entry.first_seen).toBe('2026-08-01T10:00:00Z');
  });

  test.serial('alert detail is persisted while the full detail is offered for notification', async () => {
    const fullDetail = 'today $12.3400; 2 corrupt cost-log lines skipped; recorded spend may be understated';
    const alertDetail = '2 corrupt cost-log lines skipped; recorded spend may be understated';
    const first = escalate([check('cost', 'warn', fullDetail, alertDetail)], '2026-08-01T10:00:00Z');

    expect(readLedger()['doctor:cost'].message).toBe(alertDetail);
    expect(first.new).toEqual([{ id: 'cost', status: 'warn', detail: fullDetail }]);

    markNotified(['cost']);
    const second = escalate([
      check('cost', 'warn', 'today $20.0000; 3 corrupt cost-log lines skipped; recorded spend may be understated',
        '3 corrupt cost-log lines skipped; recorded spend may be understated'),
    ], '2026-08-02T10:00:00Z');

    expect(second.new).toEqual([]);
    expect(readLedger()['doctor:cost'].message)
      .toBe('3 corrupt cost-log lines skipped; recorded spend may be understated');
  });

  test.serial('resolution deletes the key and reports it; recurrence is new again', async () => {

    escalate([check('permissions', 'warn')], '2026-08-01T10:00:00Z');
    markNotified(['permissions']);

    const cleared = escalate([check('permissions', 'ok')], '2026-08-02T10:00:00Z');
    expect(cleared.resolved).toEqual(['permissions']);
    expect(readLedger()['doctor:permissions']).toBeUndefined();

    const again = escalate([check('permissions', 'warn')], '2026-08-03T10:00:00Z');
    expect(again.new.map((n: any) => n.id)).toEqual(['permissions']);
    expect(readLedger()['doctor:permissions'].first_seen).toBe('2026-08-03T10:00:00Z');
  });

  test.serial('a check absent from the report entirely resolves its episode', async () => {

    escalate([check('reflect', 'warn')], '2026-08-01T10:00:00Z');
    markNotified(['reflect']);

    // `reflect` became informational upstream and no longer reports warn.
    const out = escalate([check('runtime', 'ok')], '2026-08-02T10:00:00Z');
    expect(out.resolved).toEqual(['reflect']);
    expect(readLedger()['doctor:reflect']).toBeUndefined();
  });

  test.serial('markNotified ignores unknown ids without corrupting the ledger', async () => {

    escalate([check('permissions', 'warn')], '2026-08-01T10:00:00Z');
    expect(markNotified(['nonexistent-check'])).toBe(true);
    expect(readLedger()['doctor:permissions'].notified).toBe(false);
  });
});

describe('escalate — degraded prior state', () => {
  test.serial('missing ledger is a trustworthy prior: first run notifies', async () => {

    expect(fs.existsSync(ledger)).toBe(false);
    const out = escalate([check('permissions', 'warn')], '2026-08-01T10:00:00Z');
    expect(out.prior_state_known).toBe(true);
    expect(out.new).toHaveLength(1);
  });

  test.serial('corrupt ledger re-seeds but emits nothing — it cannot know what was already sent', async () => {
    fs.writeFileSync(ledger, '{ this is not json', 'utf-8');


    const out = escalate([check('permissions', 'warn')], '2026-08-01T10:00:00Z');
    expect(out.persisted).toBe(true);
    expect(out.prior_state_known).toBe(false);
    expect(out.new).toEqual([]); // silent this run
    expect(out.resolved).toEqual([]);

    // But the entry was re-seeded, so the NEXT run dedups normally rather than
    // re-notifying forever.
    expect(readLedger()['doctor:permissions']).toBeDefined();
    const next = escalate([check('permissions', 'warn')], '2026-08-02T10:00:00Z');
    expect(next.prior_state_known).toBe(true);
    expect(next.new).toHaveLength(1); // owed: never confirmed delivered
  });

  test.serial('unreadable ledger touches nothing and reports persisted:false', async () => {
    fs.writeFileSync(ledger, JSON.stringify({ alerts: {} }), 'utf-8');
    fs.chmodSync(ledger, 0o000);


    try {
      const out = escalate([check('permissions', 'warn')], '2026-08-01T10:00:00Z');
      // Root ignores the mode bit; only assert when the read genuinely failed.
      if (out.persisted === false) {
        expect(out.new).toEqual([]);
        expect(out.resolved).toEqual([]);
      }
    } finally {
      fs.chmodSync(ledger, 0o600);
    }
  });
});

describe('escalate — file boundaries', () => {
  test.serial('doctor findings never touch alert-state.json', async () => {
    const alertState = path.join(hermit, 'state', 'alert-state.json');
    const seeded = JSON.stringify({ alerts: {}, last_digest_date: null, self_eval: {}, total_ticks: 3 }, null, 2) + '\n';
    fs.writeFileSync(alertState, seeded, 'utf-8');


    escalate([check('permissions', 'warn')], '2026-08-01T10:00:00Z');

    expect(fs.readFileSync(alertState, 'utf-8')).toBe(seeded); // byte-identical
    expect(readLedger()['doctor:permissions']).toBeDefined();
  });

  test.serial('readMergedAlerts unions doctor entries with the other alert files', async () => {
    const { readMergedAlerts } = await import(`${PLUGIN_ROOT}/scripts/lib/alert-state.ts`);
    fs.writeFileSync(
      path.join(hermit, 'state', 'alert-state.json'),
      JSON.stringify({ alerts: { 'checklist-thing': { text: 'x' } } }),
      'utf-8',
    );
    fs.writeFileSync(ledger, JSON.stringify({ alerts: { 'doctor:permissions': { message: 'world-readable' } } }), 'utf-8');

    const merged = readMergedAlerts(hermit);
    expect(Object.keys(merged).sort()).toEqual(['checklist-thing', 'doctor:permissions']);
    expect(merged['doctor:permissions'].message).toBe('world-readable');
  });
});

describe('doctor-check CLI', () => {
  test.serial('emits escalation in the report and --mark-notified silences the next run', async () => {
    fs.writeFileSync(path.join(hermit, 'config.json'), JSON.stringify({ timezone: 'UTC' }), 'utf-8');
    const run = async (...args: string[]) =>
      await runScript('doctor-check.ts', { args: [hermit, ...args], cwd: dir });

    const first = JSON.parse((await run()).stdout);
    expect(Array.isArray(first.checks)).toBe(true);
    expect(first.escalation).toBeDefined();
    expect(first.escalation.persisted).toBe(true);

    const firstIds = first.escalation.new.map((n: any) => n.id);
    if (firstIds.length === 0) return; // a fully-green scratch install has nothing to assert

    await run('--mark-notified', ...firstIds);
    const second = JSON.parse((await run()).stdout);
    // Everything announced and confirmed above must now be silent.
    for (const id of firstIds) {
      expect(second.escalation.new.map((n: any) => n.id)).not.toContain(id);
    }
  }, 60_000);

  test.serial('decision check counts task waits instead of legacy proposal files', async () => {
    fs.writeFileSync(path.join(hermit, 'config.json'), JSON.stringify({ timezone: 'UTC' }), 'utf-8');
    const proposals = path.join(hermit, 'proposals');
    fs.mkdirSync(proposals, { recursive: true });
    fs.writeFileSync(path.join(proposals, 'PROP-001.md'), '---\nstatus: proposed\ncreated: 2020-01-01\n---\nLegacy history\n');
    mutateTask(hermit, 'open', undefined, { title: 'Review the backup policy', done: 'Policy applied', requester: 'agent', kind: 'proposal' }, '');
    mutateTask(hermit, 'open', undefined, { title: 'Ordinary work', done: 'Work done', requester: 'agent' }, '');
    const report = JSON.parse((await runScript('doctor-check.ts', { args: [hermit], cwd: dir })).stdout);
    const check = report.checks.find((c: any) => c.id === 'proposals');
    expect(check.status).toBe('ok');
    expect(check.detail).toBe('1 pending decision(s)');
  }, 60_000);
});
