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
import { pendingDecisions } from '../scripts/lib/decisions';
import { mutateTask } from '../scripts/lib/tasks';
import { taskFixture } from './helpers/tasks';
import { startHttpStub } from './helpers/http-stub';
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

describe('pending decision delivery budget', () => {
  function decisionFixture(authority = 'admin', extra: object = {}) {
    const f = taskFixture();
    const tokenDir = path.join(f.dir, '..', '.claude.local', 'channels', 'telegram');
    fs.mkdirSync(tokenDir, { recursive: true });
    fs.writeFileSync(path.join(tokenDir, '.env'), 'TELEGRAM_BOT_TOKEN=test-token\n');
    f.put('config.json', { operator_profile: 'non-technical', timezone: 'UTC', heartbeat: { active_hours: { start: '00:00', end: '24:00' } }, channels: { telegram: { enabled: true, default_chat_id: 'home', state_dir: tokenDir, ...extra } } });
    fs.writeFileSync(path.join(f.dir, 'HEARTBEAT.md'), '# Checks\n- Review proposals/ for attention\n');
    const receipt = mutateTask(f.dir, 'open', undefined, { requester: 'agent', title: 'Question', done: 'Answered',
      ...(authority === 'admin' ? { kind: 'proposal' } : { conversation: 'telegram:team' }),
      'waiting-on': authority, decision: JSON.stringify({ purpose: authority === 'admin' ? 'consent' : 'input', authority, generation: 1 }),
    }, '') as { id: string };
    const send = async (url: string, generation = 1) => runScript('channel-send.ts', { cwd: f.dir + '/..', args: [f.dir, '--notice'], env: { AGENT_DIR: f.dir, HERMIT_TELEGRAM_API_URL: url },
      stdin: JSON.stringify({ client: 'From the agent: Question. Waiting on you.', decision: { task: receipt.id, generation } }),
    });
    // A proposal-scan item resolves without an alert, so only the decision gates decide the wake.
    const precheck = async (now: number) => (fs.writeFileSync(path.join(f.dir, 'HEARTBEAT.md'), '# Checks\n- Scan proposals/ for status proposed\n'), await runScript('heartbeat.ts', { args: ['precheck', f.dir], env: { AGENT_DIR: f.dir, HERMIT_NOW: new Date(now).toISOString() } })).stdout.trim();
    return { ...f, id: receipt.id, send, precheck };
  }
  test('a decision wakes once per attempt window, and a failed attempt still waits a day', async () => {
    const f = decisionFixture('admin', { maintainer_channel_id: 'maintainer' });
    const stub = startHttpStub(); stub.setStatus(403);
    try {
      const now = Date.now();
      expect(await f.precheck(now)).toBe('EVALUATE');
      await f.send(stub.url);
      expect(pendingDecisions(f.dir)).toMatchObject({ ok: true, records: [{ delivered: 0, attempted_at: expect.any(String) }] });
      expect(await f.precheck(now + 3600000)).toBe('OK');
      expect(await f.precheck(now + 25 * 3600000)).toBe('EVALUATE');
    } finally { stub.stop(); f.cleanup(); }
  });
  test('an unreadable inventory wakes at most once a day', async () => {
    const f = decisionFixture();
    try {
      fs.writeFileSync(path.join(f.dir, 'tasks', 'corrupt.md'), 'not a record');
      expect(pendingDecisions(f.dir)).toEqual({ ok: false });
      const now = Date.now();
      expect(await f.precheck(now)).toBe('EVALUATE');
      expect(await f.precheck(now + 3600000)).toBe('OK');
      expect(await f.precheck(now + 25 * 3600000)).toBe('EVALUATE');
    } finally { f.cleanup(); }
  });
  test('two confirmed deliveries then silence, including a non-technical home fallback', async () => {
    const f = decisionFixture(); const stub = startHttpStub();
    try {
      for (let count = 1; count <= 2; count++) {
        const result = await f.send(stub.url);
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(result.stdout).status).toBe('delivered');
        expect(pendingDecisions(f.dir)).toMatchObject({ ok: true, records: [{ delivered: count }] });
      }
      await f.send(stub.url);
      expect(stub.requests).toHaveLength(2);
      expect(stub.requests[0].body.chat_id).toBe('home');
    } finally { stub.stop(); f.cleanup(); }
  });
  test('failed and unreachable maintainer sends consume none', async () => {
    const f = decisionFixture('admin', { maintainer_channel_id: 'maintainer' });
    const stub = startHttpStub(); stub.setStatus(403);
    try {
      await f.send(stub.url);
      expect(pendingDecisions(f.dir)).toMatchObject({ ok: true, records: [{ delivered: 0 }] });
      expect(stub.requests.every(request => request.body.chat_id === 'maintainer')).toBe(true);
    } finally { stub.stop(); f.cleanup(); }
  });
  test('an input decision goes to its own chat', async () => {
    const f = decisionFixture('chat'); const stub = startHttpStub();
    try {
      await f.send(stub.url);
      expect(stub.requests[0].body.chat_id).toBe('team');
      expect(pendingDecisions(f.dir)).toMatchObject({ ok: true, records: [{ delivered: 1 }] });
    } finally { stub.stop(); f.cleanup(); }
  });
  test('a new generation gets a fresh budget and stale sends are refused', async () => {
    const f = decisionFixture(); const stub = startHttpStub();
    try {
      await f.send(stub.url); await f.send(stub.url);
      f.put('config.json', { channels: { telegram: { operators: ['admin'], enabled: true, default_chat_id: 'home', state_dir: path.join(f.dir, '..', '.claude.local', 'channels', 'telegram') } } });
      mutateTask(f.dir, 'answer', f.id, { chat: 'telegram:home', user: 'admin', reply: 'yes' }, '');
      mutateTask(f.dir, 'note', f.id, { done: 'Changed', actor: 'admin' }, '');
      expect(pendingDecisions(f.dir)).toMatchObject({ ok: true, records: [{ delivered: 0, decision: { generation: 2 } }] });
      await f.send(stub.url, 1); expect(stub.requests).toHaveLength(2);
      await f.send(stub.url, 2); expect(stub.requests).toHaveLength(3);
    } finally { stub.stop(); f.cleanup(); }
  });
  test('unreadable inventory prevents digest and clean evaluation', async () => {
    const f = decisionFixture();
    try {
      fs.mkdirSync(path.join(f.dir, 'tasks', 'broken.md'));
      // ENOTDIR makes the inventory ambiguous without relying on uid/chmod behavior.
      const file = path.join(f.dir, 'tasks', 'corrupt.md');
      fs.writeFileSync(file, 'not a record');
      expect(pendingDecisions(f.dir)).toEqual({ ok: false });
      f.put('state/alert-state.json', { alerts: { 'custom:disk': { count: 6, suppressed: true, consecutive_clean: 0, text: 'disk' } }, last_digest_date: null, last_clean_eval_at: null, total_ticks: 3 });
      const result = await runScript('heartbeat.ts', { args: ['alert-state', path.join(f.dir, 'state', 'alert-state.json')], env: { AGENT_DIR: f.dir }, stdin: '{"firing":[]}' });
      expect(result.exitCode).toBe(0);
      const state = JSON.parse(fs.readFileSync(path.join(f.dir, 'state', 'alert-state.json'), 'utf8'));
      expect(state.last_digest_date).toBeNull(); expect(state.last_clean_eval_at).toBeNull();
    } finally { f.cleanup(); }
  });
});

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
  test('the shipped default has no proposal scan; scripts own decision deliveries', () => {
    const tpl = fs.readFileSync(
      path.join(PLUGIN_ROOT, 'state-templates', 'HEARTBEAT.md.template'), 'utf8',
    );
    const bullets = parseChecklistItems(tpl);
    const proposalItem = bullets.find(l => /proposals/i.test(l));
    expect(proposalItem).toBeUndefined();
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
