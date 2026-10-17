// The every-20-ticks self-evaluation, now derived by `heartbeat.ts alert-state`
// rather than authored by the eval subagent. What it must get right is the three
// outcomes an operator eventually sees as a proposal: an item that has been quiet
// long enough to retire, an item that keeps firing after its proposal was
// dismissed, and a checklist that has grown past its recommended size.
//
// Usage: bun test tests/heartbeat-self-eval.test.ts   (from the plugin root)

import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runSelfEval, WEIGHT_KEY } from '../scripts/lib/heartbeat/self-eval';
import { normalizeItemKey } from '../scripts/lib/heartbeat-items';
import { runScript, runProposal, PLUGIN_ROOT } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-self-eval-');
afterAll(cleanup);

const NOISY_ITEM = 'Disk usage under 80%';
const QUIET_ITEM = 'Certificates valid for 30 more days';
const NOISY_KEY = normalizeItemKey(NOISY_ITEM)!;
const QUIET_KEY = normalizeItemKey(QUIET_ITEM)!;
const NOISY_ALERT = 'disk is 92% full';

// Eleven items, one over the recommended ceiling, so the weight entry exists too.
const CHECKLIST = ['# Heartbeat', '', `- ${NOISY_ITEM}`, `- ${QUIET_ITEM}`]
  .concat(Array.from({ length: 9 }, (_, i) => `- Filler check number ${i + 1}`))
  .join('\n') + '\n';

function proposal(fm: Record<string, string>): string {
  return '---\n' + Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n---\n# Proposal\n';
}

/** A hermit at a self-eval boundary: 11 items, 20 ticks of noise, one dismissed PROP. */
function fixture(): string {
  const stateDir = path.join(freshDir(), '.hermit');
  fs.mkdirSync(path.join(stateDir, 'proposals'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'HEARTBEAT.md'), CHECKLIST);
  fs.writeFileSync(path.join(stateDir, 'proposals', 'PROP-007-disk-noise-101010.md'), proposal({
    id: 'PROP-007-disk-noise-101010',
    status: 'dismissed',
    source: 'auto-detected',
    self_eval_key: NOISY_KEY,
  }));
  return stateDir;
}

/** Counters one pass short of every threshold, on a date the entries have not seen. */
const PRIMED = () => ({
  [NOISY_KEY]: { clean_ticks: 0, noise_ticks: 19, sessions_seen: 3, last_session_id: '2026-07-09', proposed: true, alert_text: NOISY_ALERT },
  [QUIET_KEY]: { clean_ticks: 19, noise_ticks: 0, sessions_seen: 2, last_session_id: '2026-07-09', proposed: false },
  [WEIGHT_KEY]: { clean_ticks: 19, noise_ticks: 0, sessions_seen: 2, last_session_id: '2026-07-09', proposed: false },
});

const evaluate = (prevSelfEval: object, stateDir = fixture(), today = '2026-07-10') => runSelfEval({
  stateDir,
  prevSelfEval,
  alerts: { [NOISY_KEY]: { text: NOISY_ALERT } },
  today,
});

describe('heartbeat self-evaluation', () => {
  test('all three outcomes cross their thresholds on the same pass', () => {
    const { self_eval, proposals } = evaluate(PRIMED());
    const byKey = Object.fromEntries(proposals.map(p => [p.key, p]));

    // A dismissed auto-detected proposal re-opens the item, and the item firing
    // anyway is what the noise counter is for.
    // A firing pass advances the session tally too, or a permanently noisy item — one
    // that never has a clean pass — could never reach the three-date threshold.
    expect(byKey[NOISY_KEY]).toEqual({ key: NOISY_KEY, kind: 'noisy', clean_ticks: 0, noise_ticks: 20, sessions_seen: 4 });
    expect(byKey[QUIET_KEY]).toEqual({ key: QUIET_KEY, kind: 'clean', clean_ticks: 20, noise_ticks: 0, sessions_seen: 3 });
    expect(byKey[WEIGHT_KEY]).toMatchObject({ kind: 'weight', clean_ticks: 20, sessions_seen: 3 });
    expect(proposals).toHaveLength(3);

    // Every proposed entry is marked so the next pass does not re-raise it.
    for (const key of [NOISY_KEY, QUIET_KEY, WEIGHT_KEY]) expect(self_eval[key].proposed).toBe(true);
    expect(self_eval[WEIGHT_KEY].text).toBe('Checklist weight: 11 items');
  });

  // A dismissed proposal keeps re-opening its item every pass by design, so the
  // noisy entry re-raises while the item still fires; proposal-create's own
  // duplicate gate is what stops a second file being written. The clean and
  // weight entries stay marked and go quiet.
  test('a second pass re-raises only the item whose proposal was dismissed', () => {
    const first = evaluate(PRIMED());
    expect(evaluate(first.self_eval).proposals.map(p => p.key)).toEqual([NOISY_KEY]);
  });

  test('fewer than three distinct local dates holds a clean item back', () => {
    const primed = PRIMED();
    primed[QUIET_KEY].sessions_seen = 1;
    const { self_eval, proposals } = evaluate(primed);
    expect(proposals.map(p => p.key)).not.toContain(QUIET_KEY);
    expect(self_eval[QUIET_KEY]).toMatchObject({ clean_ticks: 20, sessions_seen: 2, proposed: false });
  });

  test('repeated evaluations on one local date count it only once', () => {
    const first = evaluate({});
    const second = evaluate(first.self_eval);
    expect(second.self_eval[QUIET_KEY].sessions_seen).toBe(1);
    expect(second.self_eval[NOISY_KEY].sessions_seen).toBe(1);
  });

  test('a checklist inside the recommended size carries no weight entry', () => {
    const stateDir = fixture();
    fs.writeFileSync(path.join(stateDir, 'HEARTBEAT.md'), `# Heartbeat\n\n- ${QUIET_ITEM}\n`);
    const { self_eval, proposals } = evaluate(PRIMED(), stateDir);
    expect(self_eval[WEIGHT_KEY]).toBeUndefined();
    expect(proposals.map(p => p.key)).not.toContain(WEIGHT_KEY);
  });

  // The noisy threshold is noise_ticks AND sessions_seen, and the item it targets is one
  // that fires every pass — so it has no clean pass to carry its session tally.
  test('an item that fires every pass still accrues distinct local dates', () => {
    const stateDir = fixture();
    let self_eval: Record<string, unknown> = {};
    for (const date of ['2026-07-10', '2026-07-11', '2026-07-12']) {
      ({ self_eval } = evaluate(self_eval, stateDir, date));
    }
    expect(self_eval[NOISY_KEY]).toMatchObject({ clean_ticks: 0, noise_ticks: 3, sessions_seen: 3 });
  });

  test('a first observation seeds the counters rather than proposing', () => {
    const { self_eval, proposals } = evaluate({});
    expect(proposals).toEqual([]);
    expect(self_eval[QUIET_KEY]).toMatchObject({
      clean_ticks: 1, noise_ticks: 0, sessions_seen: 1, last_session_id: '2026-07-10',
      first_observed: '2026-07-10', proposed: false,
    });
  });
});

describe('heartbeat alert-state — self_eval_proposals on stdout', () => {
  const alertState = async (stateDir: string, total_ticks: number,
    firing = [{ key: NOISY_KEY, text: NOISY_ALERT }]) => {
    const stateFile = path.join(stateDir, 'state', 'alert-state.json');
    const state = fs.existsSync(stateFile)
      ? JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
      : { alerts: {}, last_digest_date: null, self_eval: PRIMED() };
    fs.writeFileSync(stateFile, JSON.stringify({ ...state, total_ticks }));
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ timezone: 'UTC' }));
    const r = await runScript('heartbeat.ts', {
      args: ['alert-state', path.join(stateDir, 'state', 'alert-state.json')],
      stdin: JSON.stringify({ firing }),
      env: { HERMIT_NOW: '2026-07-10T12:00:00Z' },
    });
    expect(r.exitCode).toBe(0);
    return JSON.parse(r.stdout.trim());
  };

  test('an off-boundary tick records firing evidence without advancing counters', async () => {
    const stateDir = fixture();
    expect((await alertState(stateDir, 17)).self_eval_proposals).toEqual([]);
    const written = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'alert-state.json'), 'utf-8'));
    expect(written.self_eval).toEqual({
      ...PRIMED(), [NOISY_KEY]: { ...PRIMED()[NOISY_KEY], fired_since_self_eval: true },
    });
  });

  test('a boundary tick reports the graduated entries and persists their counters', async () => {
    const stateDir = fixture();
    const out = await alertState(stateDir, 20);
    expect(out.self_eval_proposals.map((p: any) => p.kind).sort()).toEqual(['clean', 'noisy', 'weight']);
    const written = JSON.parse(fs.readFileSync(path.join(stateDir, 'state', 'alert-state.json'), 'utf-8'));
    expect(written.self_eval[QUIET_KEY]).toMatchObject({ clean_ticks: 20, proposed: true });
  });

  test('firing at tick 399 then recovering at 400 prevents retirement and the next quiet interval starts fresh', async () => {
    const stateDir = fixture();
    const stateFile = path.join(stateDir, 'state', 'alert-state.json');
    await alertState(stateDir, 399, [{ key: QUIET_KEY, text: 'Certificate expires tomorrow' }]);
    const out = await alertState(stateDir, 400, []);
    const written = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(out.self_eval_proposals.map((p: any) => p.key)).not.toContain(QUIET_KEY);
    expect(written.self_eval[QUIET_KEY]).toMatchObject({ clean_ticks: 0, proposed: false });

    for (let tick = 401; tick <= 420; tick++) await alertState(stateDir, tick, []);
    const quiet = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(quiet.self_eval[QUIET_KEY]).toMatchObject({ clean_ticks: 1, proposed: false });
  });

  test('suppressed firing still counts after the alert is removed before the boundary', async () => {
    const stateDir = fixture();
    const stateFile = path.join(stateDir, 'state', 'alert-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({
      alerts: { [NOISY_KEY]: { count: 6, suppressed: true, consecutive_clean: 0, text: NOISY_ALERT } },
      last_digest_date: '2026-07-10', self_eval: PRIMED(),
    }));
    const silent = await alertState(stateDir, 397);
    expect(silent.notifications).toEqual([]);
    await alertState(stateDir, 398, []);
    await alertState(stateDir, 399, []);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf-8')).alerts[NOISY_KEY]).toBeUndefined();

    const out = await alertState(stateDir, 400, []);
    expect(out.self_eval_proposals).toContainEqual({
      key: NOISY_KEY, kind: 'noisy', clean_ticks: 0, noise_ticks: 20, sessions_seen: 4,
    });
    await alertState(stateDir, 420, []);
    const quiet = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(quiet.self_eval[NOISY_KEY].noise_ticks).toBe(20);
  });
});


describe('self-evaluation uses current alert state', () => {
  test('suppression and changed wording cannot make a firing check look clean', () => {
    const stateDir = fixture();
    const { self_eval, proposals } = runSelfEval({
      stateDir,
      prevSelfEval: { [QUIET_KEY]: { clean_ticks: 19, sessions_seen: 3, alert_text: 'old wording' } },
      alerts: { [QUIET_KEY]: { text: 'new wording', suppressed: true, consecutive_clean: 0 } },
      today: '2026-09-05',
    });
    expect(self_eval[QUIET_KEY].clean_ticks).toBe(0);
    expect(self_eval[QUIET_KEY].alert_text).toBeUndefined();
    expect(proposals.map(p => p.key)).not.toContain(QUIET_KEY);
  });

  for (const alerts of [
    { [NOISY_KEY]: { text: NOISY_ALERT, suppressed: true, consecutive_clean: 1 } },
    {},
  ]) {
    test(`a recovered check is clean despite old monitoring text (${Object.keys(alerts).length} retained alerts)`, () => {
      const { self_eval } = runSelfEval({
        stateDir: fixture(), prevSelfEval: { [NOISY_KEY]: { alert_text: NOISY_ALERT } }, alerts,
        today: '2026-09-05',
      });
      expect(self_eval[NOISY_KEY].clean_ticks).toBe(1);
      expect(self_eval[NOISY_KEY].noise_ticks).toBe(0);
    });
  }

  test('a proposal created and dismissed through the CLI reopens its actual checklist item', async () => {
    const stateDir = fixture();
    fs.mkdirSync(path.join(stateDir, 'templates'));
    fs.copyFileSync(path.join(PLUGIN_ROOT, 'state-templates', 'PROPOSAL.md.template'),
      path.join(stateDir, 'templates', 'PROPOSAL.md.template'));
    const created = await runProposal(stateDir, ['create'], { stdin: [
      'Title: Review quiet certificate check', 'Source: auto-detected', 'Category: capability',
      `Self-Eval-Key: ${QUIET_KEY}`, '---', '## Context', 'Review the check.',
    ].join('\n') });
    expect(created.exitCode).toBe(0);
    const { id } = JSON.parse(created.stdout);
    expect(id).toMatch(/^PROP-/);
    const dismissed = await runProposal(stateDir, ['patch', id, '--set', 'status=dismissed']);
    expect(dismissed.exitCode).toBe(0);
    const result = evaluate({ [QUIET_KEY]: { proposed: true, clean_ticks: 20, sessions_seen: 3 } }, stateDir);
    expect(result.self_eval[QUIET_KEY]).toMatchObject({ proposed: false, clean_ticks: 0 });
  });
});
