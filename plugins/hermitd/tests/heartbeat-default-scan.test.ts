// heartbeat-precheck default proposal-scan resolution (Phase 2 token-efficiency).
//
// The default HEARTBEAT.md item scans `proposals/` for review-worthy proposals.
// Its alerts are keyed `proposal-pending:<PROP-NNN>`, which never matched the
// generic `checklist:<hash>` key the item loop used — so the item always forced
// an LLM EVALUATE and the 6h clean-recheck damper was the only cap on wasted
// dispatches. heartbeat-precheck now resolves that item against real proposal
// frontmatter. These tests pin the resolution matrix AND prove the three
// OK-blocking invariants (self-eval tick, pending micro-proposal, generic items)
// still run before the item loop.
//
// Usage: bun test tests/heartbeat-default-scan.test.ts   (from the plugin root)

import { afterAll, describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript, PLUGIN_ROOT } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';
import { deriveMicroPendingKeys } from '../scripts/lib/alert-state';
import { isProposalScanItem, isCredentialExpiryItem, normalizeItemKey, parseChecklistItems, canonicalChecklistKeys } from '../scripts/lib/heartbeat-items';

const { freshDir, cleanup } = freshDirFactory('hermit-hbscan-');
const { freshDir: freshCredRoot, cleanup: cleanupCredRoot } = freshDirFactory('hermit-credroot-');
afterAll(() => { cleanup(); cleanupCredRoot(); });

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.hermit', ...p);

const NOW = '2026-07-03T12:00:00Z';
// heartbeat-precheck's suppressed-digest gate compares last_digest_date against
// todayYMD('UTC'), which uses real wall-clock (not HERMIT_NOW). Compute "today"
// the same way so the gate is a no-op and these tests exercise the item loop.
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date());

// Default checklist item (verbatim shape from HEARTBEAT.md.template): references
// `proposals/` so the precheck classifies it as the proposal-scan item.
const HEARTBEAT_DEFAULT =
  '# Heartbeat Checklist\n\n## Standing Checks\n' +
  '- Review `proposals/` for any with `status: proposed` needing operator review.\n';

// Template line 6 verbatim. Tests 1–18 reach OK against HEARTBEAT_DEFAULT (proposal
// scan only); adding this bullet would force EVALUATE until every declared credential
// probe is healthy, so the credential matrix uses HEARTBEAT_BOTH instead.
const CREDENTIAL_BULLET =
  '- Read `state/doctor-report.json` → the `credential-expiry` check; if its status is warn or fail, tell the operator which credential needs re-auth and name the plugin\'s reauth skill from the report detail.';
const HEARTBEAT_BOTH = HEARTBEAT_DEFAULT + CREDENTIAL_BULLET + '\n';

// clean_recheck_cooldown: null disables the damper so these tests isolate the
// item-loop resolution (the damper has its own coverage in auto-close.test.ts).
const CONFIG = JSON.stringify({ timezone: 'UTC', heartbeat: { clean_recheck_cooldown: null, active_hours: { start: '00:00', end: '24:00' } } });

interface Fixture {
  heartbeat?: string;
  alertState?: object;
  proposals?: Array<{ id: string; status: string }>;
  unparseableProposal?: string; // filename → written with NO frontmatter block
  microPending?: boolean;
  microPendingIds?: string[]; // ids of the pending tier-1 entries (default ['MP-1'])
  totalTicks?: number;
  noProposalsDir?: boolean;  // don't create proposals/ at all (ENOENT readdir path)
  proposalsAsFile?: boolean; // proposals is a regular file, not a dir (ENOTDIR readdir path)
  microCorrupt?: boolean;    // micro-proposals.json present but unparseable (#764)
  microEntries?: object[];   // raw micro-proposals.json pending entries
  homeChatId?: string;       // discord default_chat_id, making `discord:<id>` the home chat
}

function build(fix: Fixture): string {
  const dir = freshDir();
  fs.mkdirSync(hermit(dir, 'state'), { recursive: true });
  if (fix.proposalsAsFile) {
    fs.writeFileSync(hermit(dir, 'proposals'), 'not a directory\n');
  } else if (!fix.noProposalsDir) {
    fs.mkdirSync(hermit(dir, 'proposals'), { recursive: true });
  }
  fs.writeFileSync(hermit(dir, 'config.json'), fix.homeChatId === undefined ? CONFIG : JSON.stringify({
    ...JSON.parse(CONFIG),
    channels: { discord: { enabled: true, default_chat_id: fix.homeChatId } },
  }));
  fs.writeFileSync(hermit(dir, 'HEARTBEAT.md'), fix.heartbeat ?? HEARTBEAT_DEFAULT);
  const alert = {
    alerts: {},
    last_digest_date: TODAY, // avoid the suppressed-digest gate pre-empting the item loop
    self_eval: {},
    total_ticks: fix.totalTicks ?? 0,
    ...(fix.alertState ?? {}),
  };
  fs.writeFileSync(hermit(dir, 'state', 'alert-state.json'), JSON.stringify(alert));
  for (const p of fix.proposals ?? []) {
    fs.writeFileSync(
      hermit(dir, 'proposals', `${p.id}-test-120000.md`),
      `---\nid: ${p.id}\nstatus: ${p.status}\ntitle: Test ${p.id}\n---\nbody\n`,
    );
  }
  if (fix.unparseableProposal) {
    fs.writeFileSync(hermit(dir, 'proposals', fix.unparseableProposal), 'Just a bullet, no frontmatter.\n');
  }
  if (fix.microCorrupt) {
    fs.writeFileSync(hermit(dir, 'state', 'micro-proposals.json'), '{"pending": [');
  }
  if (fix.microPending || fix.microPendingIds) {
    const ids = fix.microPendingIds ?? ['MP-1'];
    fs.writeFileSync(
      hermit(dir, 'state', 'micro-proposals.json'),
      JSON.stringify({ pending: ids.map(id => ({ id, status: 'pending', tier: 1 })) }),
    );
  }
  if (fix.microEntries) {
    fs.writeFileSync(hermit(dir, 'state', 'micro-proposals.json'), JSON.stringify({ pending: fix.microEntries }));
  }
  return dir;
}

async function verdict(dir: string, peek = false, now = NOW, pluginRoot?: string): Promise<string> {
  const r = await runScript('heartbeat.ts', {
    args: ['precheck', ...(peek ? ['--peek'] : []), '.hermit'],
    cwd: dir,
    env: { HERMIT_NOW: now, ...(pluginRoot ? { CLAUDE_PLUGIN_ROOT: pluginRoot } : {}) },
  });
  return r.stdout.trim();
}

const suppressed = (id: string, consecutive_clean = 0) => ({
  [`proposal-pending:${id}`]: { suppressed: true, consecutive_clean, count: 6 },
});

const microSuppressed = (id: string, consecutive_clean = 0) => ({
  [`micro-proposal-pending:${id}`]: { suppressed: true, consecutive_clean, count: 6 },
});

describe('default proposal-scan resolution', () => {
  test('1. proposed proposal with no alert → EVALUATE', async () => {
    const dir = build({ proposals: [{ id: 'PROP-001', status: 'proposed' }] });
    expect(await verdict(dir)).toBe('EVALUATE');
  });

  test('2. proposed + suppressed alert (digest sent today) → OK', async () => {
    const dir = build({
      proposals: [{ id: 'PROP-001', status: 'proposed' }],
      alertState: { alerts: suppressed('PROP-001') },
    });
    expect(await verdict(dir)).toBe('OK');
  });

  test('3. suppressed but consecutive_clean > 0 (resolving) → EVALUATE', async () => {
    const dir = build({
      proposals: [{ id: 'PROP-001', status: 'proposed' }],
      alertState: { alerts: suppressed('PROP-001', 1) },
    });
    expect(await verdict(dir)).toBe('EVALUATE');
  });

  test('4. no proposed proposals, no alerts → OK (the headline win)', async () => {
    const dir = build({ proposals: [{ id: 'PROP-001', status: 'accepted' }] });
    expect(await verdict(dir)).toBe('OK');
  });

  test('5. no proposed but stale proposal-pending alert → EVALUATE (resolution cleanup)', async () => {
    const dir = build({
      proposals: [{ id: 'PROP-002', status: 'accepted' }],
      alertState: { alerts: suppressed('PROP-002') },
    });
    expect(await verdict(dir)).toBe('EVALUATE');
  });

  test('6. clean scan but a tier-1 micro-proposal is pending → EVALUATE (gate precedes item loop)', async () => {
    const dir = build({ microPending: true });
    expect(await verdict(dir)).toBe('EVALUATE');
  });

  test('6a. pending micro-proposal + suppressed alert (digest sent today) → OK', async () => {
    // The cost fix: an unanswered operator question stops forcing a paid wake on
    // every poll once its alert has aged into the suppressed state.
    const dir = build({ microPending: true, alertState: { alerts: microSuppressed('MP-1') } });
    expect(await verdict(dir)).toBe('OK');
  });

  test('6b. pending micro-proposal, suppressed but consecutive_clean > 0 (resolving) → EVALUATE', async () => {
    const dir = build({ microPending: true, alertState: { alerts: microSuppressed('MP-1', 1) } });
    expect(await verdict(dir)).toBe('EVALUATE');
  });

  test('6c. two pending micro-proposals, only one suppressed → EVALUATE', async () => {
    const dir = build({
      microPendingIds: ['MP-1', 'MP-2'],
      alertState: { alerts: microSuppressed('MP-1') },
    });
    expect(await verdict(dir)).toBe('EVALUATE');
  });

  // Heartbeat alerts post in the home chat, so a decision asked in another chat
  // never gets an alert key and could never be damped by one.
  test('6d. pending micro-proposal asked outside the home chat → OK on every tick', async () => {
    const dir = build({ homeChatId: '5', microEntries: [{ id: 'MP-group', status: 'pending', tier: 1, chat: 'discord:9' }] });
    expect(await verdict(dir, true)).toBe('OK');
    for (let i = 0; i < 3; i++) expect(await verdict(dir)).toBe('OK');
  });

  test('6e. precheck wakes for exactly the entries the alert deriver keys', async () => {
    const cases: Array<{ chat?: string; home: string; eligible: boolean }> = [
      { chat: 'discord:5', home: '5', eligible: true },
      { chat: 'discord:9', home: '5', eligible: false },
      { home: '5', eligible: true },                      // queued before entries carried a chat
      { chat: 'discord:5', home: '7', eligible: false },  // home chat changed after queueing
    ];
    for (const c of cases) {
      const entry = { id: 'MP-x', status: 'pending', tier: 1, ...(c.chat ? { chat: c.chat } : {}) };
      const dir = build({ homeChatId: c.home, microEntries: [entry] });
      expect(deriveMicroPendingKeys(hermit(dir)).items.length === 1).toBe(c.eligible);
      expect(await verdict(dir)).toBe(c.eligible ? 'EVALUATE' : 'OK');
    }
  });

  test('7. clean scan but 20-tick self-eval is due → EVALUATE (gate precedes item loop)', async () => {
    const dir = build({ totalTicks: 19 }); // non-peek increments to 20 → self-eval
    expect(await verdict(dir)).toBe('EVALUATE');
  });

  // Not about any supported format — the scan must degrade gracefully on a file
  // it cannot parse (truncated write, hand-edited, pre-frontmatter leftover)
  // rather than erroring or silently skipping the tick.
  test('8. proposal file with no parseable frontmatter → EVALUATE (fail-open)', async () => {
    const dir = build({ unparseableProposal: 'PROP-006.md' });
    expect(await verdict(dir)).toBe('EVALUATE');
  });

  test('9. custom non-proposal item without a suppressed entry → EVALUATE (generic rule intact)', async () => {
    const dir = build({ heartbeat: '# Heartbeat\n\n- Check disk usage under 90%\n' });
    expect(await verdict(dir)).toBe('EVALUATE');
  });

  test('10. --peek writes nothing to alert-state.json', async () => {
    const dir = build({ proposals: [{ id: 'PROP-001', status: 'accepted' }] });
    const p = hermit(dir, 'state', 'alert-state.json');
    const before = fs.readFileSync(p, 'utf8');
    await verdict(dir, true);
    expect(fs.readFileSync(p, 'utf8')).toBe(before);
  });

  test('empty proposals dir with no alerts → OK', async () => {
    const dir = build({});
    expect(await verdict(dir)).toBe('OK');
  });

  test('11. missing proposals/ dir, no lingering alert → OK (ENOENT is not ambiguous)', async () => {
    const dir = build({ noProposalsDir: true });
    expect(await verdict(dir)).toBe('OK');
  });

  test('12. proposals/ is a regular file (ENOTDIR readdir error) → EVALUATE (fail-open, never a false OK)', async () => {
    const dir = build({ proposalsAsFile: true });
    expect(await verdict(dir)).toBe('EVALUATE');
  });

  // #764: the micro scan applied the fail-open rule to a malformed *entry* but not
  // to a malformed *file*, so a corrupt queue read as clean and every pending
  // operator question went invisible. Corrupt now wakes — but only once a day,
  // since a human has to fix the file and waking every poll to say so is the
  // unbounded-wake shape the pending-micro damper exists to prevent.
  test('13. corrupt micro-proposals.json → EVALUATE (fail-open, never a false OK)', async () => {
    const dir = build({ microCorrupt: true });
    expect(await verdict(dir)).toBe('EVALUATE');
  });

  test('14. corrupt micro-proposals.json, second tick same day → damped, no repeat wake', async () => {
    const dir = build({ microCorrupt: true });
    expect(await verdict(dir)).toBe('EVALUATE');
    expect(await verdict(dir)).toBe('OK'); // damper stamped by the first tick
  });

  test('15. corrupt micro-proposals.json, 25h later → wakes again', async () => {
    const dir = build({ microCorrupt: true });
    expect(await verdict(dir)).toBe('EVALUATE');
    expect(await verdict(dir, false, '2026-07-04T13:00:00Z')).toBe('EVALUATE');
  });

  test('16. corrupt micro-proposals.json under --peek writes no damper stamp', async () => {
    const dir = build({ microCorrupt: true });
    const p = hermit(dir, 'state', 'alert-state.json');
    const before = fs.readFileSync(p, 'utf8');
    expect(await verdict(dir, true)).toBe('EVALUATE');
    expect(fs.readFileSync(p, 'utf8')).toBe(before);
  });

  test('17. missing micro-proposals.json stays clean (ENOENT is not ambiguous)', async () => {
    const dir = build({});
    expect(await verdict(dir)).toBe('OK');
  });

  test('18. repaired then re-broken inside 24h wakes again (damper cleared on recovery)', async () => {
    const dir = build({ microCorrupt: true });
    const mp = hermit(dir, 'state', 'micro-proposals.json');
    expect(await verdict(dir)).toBe('EVALUATE');
    fs.writeFileSync(mp, JSON.stringify({ pending: [] }));
    expect(await verdict(dir)).toBe('OK');
    fs.writeFileSync(mp, '{"pending": [');
    expect(await verdict(dir)).toBe('EVALUATE'); // new corruption, not the old one's silence
  });
});

// Scaffolds a fake plugin root whose hermit-meta.json declares one credential with
// the given expiry_probe (omit for "no credential declared"). Nested under plugins/
// so the sibling scan sees only this tree, never another test's tmpdir.
function fakePluginRoot(probe?: string): string {
  const root = path.join(
    freshCredRoot(), 'plugins', 'hermitd',
  );
  const metaDir = path.join(root, '.claude-plugin');
  fs.mkdirSync(metaDir, { recursive: true });
  fs.writeFileSync(path.join(metaDir, 'plugin.json'), '{"name":"hermitd","version":"1.0.0"}');
  fs.writeFileSync(path.join(metaDir, 'hermit-meta.json'), JSON.stringify(
    probe === undefined
      ? {}
      : { credentials: [{ name: 'claude-subscription', expiry_probe: probe, warn_days: 3 }] },
  ));
  return root;
}

const inDays = (n: number) => new Date(Date.now() + n * 24 * 3600000).toISOString();

describe('default credential-expiry resolution', () => {
  const both = { heartbeat: HEARTBEAT_BOTH };
  const credKey = normalizeItemKey(CREDENTIAL_BULLET)!;

  test('1. probe healthy, no alerts → OK', async () => {
    const dir = build(both);
    expect(await verdict(dir, false, NOW, fakePluginRoot('echo OK'))).toBe('OK');
  });

  test('2. probe reports EXPIRED, no alerts → EVALUATE', async () => {
    const dir = build(both);
    expect(await verdict(dir, false, NOW, fakePluginRoot('echo EXPIRED'))).toBe('EVALUATE');
  });

  test('3. probe reports EXPIRED, entry suppressed with consecutive_clean: 0 → OK', async () => {
    const dir = build({
      ...both,
      alertState: { alerts: { [credKey]: { suppressed: true, consecutive_clean: 0, count: 6 } } },
    });
    expect(await verdict(dir, false, NOW, fakePluginRoot('echo EXPIRED'))).toBe('OK');
  });

  test('4. probe healthy, lingering checklist key → EVALUATE', async () => {
    expect(credKey).toMatch(/^checklist:readstate[a-z0-9]*-[0-9a-f]{8}$/);
    const dir = build({
      ...both,
      alertState: { alerts: { [credKey]: { suppressed: true, consecutive_clean: 0, count: 6 } } },
    });
    expect(await verdict(dir, false, NOW, fakePluginRoot('echo OK'))).toBe('EVALUATE');
  });

  test('5. no credential declared → EVALUATE', async () => {
    const dir = build(both);
    expect(await verdict(dir, false, NOW, fakePluginRoot())).toBe('EVALUATE');
  });

  test('6. probe fails (nonzero exit) → EVALUATE', async () => {
    const dir = build(both);
    expect(await verdict(dir, false, NOW, fakePluginRoot('exit 3'))).toBe('EVALUATE');
  });

  test('7. probe reports an expiry inside the warn window → EVALUATE', async () => {
    const dir = build(both);
    expect(await verdict(dir, false, NOW, fakePluginRoot(`echo EXPIRES:${inDays(1)}`))).toBe('EVALUATE');
  });

  test('8. --peek variant of case 1 → OK and alert-state.json unchanged', async () => {
    const dir = build(both);
    const p = hermit(dir, 'state', 'alert-state.json');
    const before = fs.readFileSync(p, 'utf8');
    expect(await verdict(dir, true, NOW, fakePluginRoot('echo OK'))).toBe('OK');
    expect(fs.readFileSync(p, 'utf8')).toBe(before);
  });
});

// Coherence guard: the whole optimization hinges on isProposalScanItem matching
// the item shipped in HEARTBEAT.md.template. If a future template reword drops the
// `proposed` keyword (or the `proposals/` reference), the classifier stops matching
// the default, the item silently falls back to the generic alert path, and the
// wasted-dispatch bug returns with only the 6h damper capping it. Pin them together
// so a template edit that breaks the match fails here instead of shipping silently.
describe('shipped HEARTBEAT.md.template ↔ classifier coherence', () => {
  test('the shipped default proposal-scan item matches isProposalScanItem', () => {
    const tpl = fs.readFileSync(
      path.join(PLUGIN_ROOT, 'state-templates', 'HEARTBEAT.md.template'), 'utf8',
    );
    const bullets = parseChecklistItems(tpl);
    const proposalItem = bullets.find(l => /proposals/i.test(l));
    expect(proposalItem).toBeDefined();
    expect(isProposalScanItem(proposalItem!)).toBe(true);
  });

  test('the shipped default credential-expiry item matches isCredentialExpiryItem', () => {
    const tpl = fs.readFileSync(
      path.join(PLUGIN_ROOT, 'state-templates', 'HEARTBEAT.md.template'), 'utf8',
    );
    const bullets = parseChecklistItems(tpl);
    const credentialItem = bullets.find(l => /doctor-report/i.test(l));
    expect(credentialItem).toBeDefined();
    expect(isCredentialExpiryItem(credentialItem!)).toBe(true);
  });

  test('every shipped item derives the same key from both call sites', () => {
    const tpl = fs.readFileSync(
      path.join(PLUGIN_ROOT, 'state-templates', 'HEARTBEAT.md.template'), 'utf8',
    );
    const items = parseChecklistItems(tpl);
    expect(items.length).toBeGreaterThan(0);
    const fromItems = items.map(i => normalizeItemKey(i));
    expect(fromItems.every(k => k !== null)).toBe(true);

    const fromCanonical = canonicalChecklistKeys(hermit(build({ heartbeat: tpl })));
    expect(fromCanonical).not.toBeNull();
    expect([...fromCanonical!].sort()).toEqual((fromItems as string[]).sort());
  });
});
