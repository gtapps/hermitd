// bun test for scripts/lib/dashboard.ts — dashboard renderer.
// Usage: bun test tests/dashboard.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadDashboardState, renderDashboard, mdToHtml, escapeHtml } from '../scripts/lib/dashboard';

// ---------- fixture scaffolding ----------

function makeHermitDir(): { hermitDir: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-dashboard-'));
  const hermitDir = path.join(root, '.hermit');
  fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(hermitDir, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(hermitDir, 'proposals'), { recursive: true });
  fs.mkdirSync(path.join(hermitDir, 'compiled'), { recursive: true });
  return { hermitDir, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} } };
}

function withHermitDir(fn: (hermitDir: string) => void) {
  return () => {
    const h = makeHermitDir();
    try { fn(h.hermitDir); } finally { h.cleanup(); }
  };
}

function writeJson(hermitDir: string, rel: string, data: unknown): void {
  fs.writeFileSync(path.join(hermitDir, rel), JSON.stringify(data, null, 2));
}

// "Today" cost is sourced from cost-index.json's timezone-aware daily bucket.
const TODAY_UTC = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date());
function writeTodayCost(hermitDir: string, cost: number, tokens: number): void {
  // version must match cost-log.ts's INDEX_VERSION; readCostIndex null-gates on it.
  writeJson(hermitDir, 'state/cost-index.json', { version: 4, by_date: { [TODAY_UTC]: { cost, tokens, session_ids: [] } } });
}

// A shared-liveness signal is just a fresh mtime on one of liveness.ts's watched
// files; `state/.heartbeat` is the simplest of the set. ageSecs backdates it.
function writeLivenessFile(hermitDir: string, ageSecs: number): void {
  const file = path.join(hermitDir, 'state', '.heartbeat');
  fs.writeFileSync(file, '');
  const stamp = new Date(Date.now() - ageSecs * 1000);
  fs.utimesSync(file, stamp, stamp);
}

function writeProposal(hermitDir: string, file: string, fm: Record<string, string>, body: string): void {
  const yaml = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  fs.writeFileSync(path.join(hermitDir, 'proposals', file), `---\n${yaml}\n---\n${body}\n`);
}

function writeStaleIndex(hermitDir: string, rows: Array<{ id: string; file: string; title: string }>): void {
  writeJson(hermitDir, 'state/proposals-index.json', {
    updated: '2026-07-12T10:00:00Z',
    count: rows.length,
    counts: { proposed: rows.length },
    proposals: rows.map(r => ({
      id: r.id, file: r.file, status: 'proposed', source: 'manual', category: null,
      title: r.title, created: '2026-07-12T10:00:00Z', session: null,
      responded: false, accepted_date: null, resolved_date: null, tags: [],
      self_eval_key: null, unparseable: false,
    })),
  });
}

function writeWeekly(hermitDir: string, week: string, fm: Record<string, string>, body: string): void {
  const yaml = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  fs.writeFileSync(path.join(hermitDir, 'compiled', `review-weekly-${week}.md`), `---\n${yaml}\n---\n${body}\n`);
}

function writeLastBrief(hermitDir: string, kind: string, text: string, generatedAt = '2026-07-05T08:00:00Z'): void {
  writeJson(hermitDir, 'state/last-brief.json', { kind, text, generated_at: generatedAt });
}

function writeCompiledDoc(hermitDir: string, file: string, fm: Record<string, string> | null, body: string): void {
  const content = fm
    ? `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}\n`
    : `${body}\n`;
  fs.writeFileSync(path.join(hermitDir, 'compiled', file), content);
}

// ---------- mdToHtml ----------

describe('mdToHtml', () => {
  test('renders headings, bold, italic, inline code, and links', () => {
    const html = mdToHtml('# Title\n\nSome **bold** and *italic* and `code` and a [link](https://example.com).');
    expect(html).toContain('<h1>Title</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a>');
  });

  test('handles multiple inline code spans in one paragraph', () => {
    const html = mdToHtml('Compare `alpha` against `beta` and `gamma`.');
    expect(html).toContain('<code>alpha</code>');
    expect(html).toContain('<code>beta</code>');
    expect(html).toContain('<code>gamma</code>');
  });

  test('renders unordered lists', () => {
    const html = mdToHtml('- one\n- two\n- three');
    expect(html).toBe('<ul><li>one</li><li>two</li><li>three</li></ul>');
  });

  test('renders fenced code blocks with escaped content', () => {
    const html = mdToHtml('```\nconst x = 1 < 2;\n```');
    expect(html).toContain('<pre><code>const x = 1 &lt; 2;</code></pre>');
  });

  test('drops javascript: scheme links but keeps the label', () => {
    const html = mdToHtml('[click me](javascript:alert(1))');
    expect(html).not.toContain('<a ');
    expect(html).toContain('click me');
  });

  test('escapes raw HTML in proposal text', () => {
    const html = mdToHtml('<script>alert(1)</script> and & ampersand');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp; ampersand');
  });
});

describe('escapeHtml', () => {
  test('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });
});

// ---------- loadDashboardState ----------

describe('loadDashboardState', () => {
  test('degrades to placeholders when all state files are missing', withHermitDir((hermitDir) => {
    const state = loadDashboardState(hermitDir);
    expect(state.agent_name).toBe('Hermit');
    expect(state.execution_state).toBe('unknown');
    expect(state.alive_now).toBe(false); // no liveness files -> unknown, never "alive"
    expect(state.today_cost_usd).toBe(0);
    expect(state.today_tokens).toBe(0);
    expect(state.alerts).toEqual([]);
    expect(state.proposals.open).toEqual([]);
    expect(state.proposals.other).toEqual([]);
    expect(state.weekly).toBeNull();
  }));

  test('reads agent name, session state, cost, and alerts', withHermitDir((hermitDir) => {
    writeJson(hermitDir, 'config.json', { agent_name: 'shelly' });
    writeJson(hermitDir, 'state/execution.json', { state: 'in_flight', at: new Date().toISOString() });
    writeTodayCost(hermitDir, 0.42, 125000);
    writeJson(hermitDir, 'state/alert-state.json', {
      alerts: { 'budget-daily': { message: 'Daily budget at 92%', timestamp: '2026-07-05T08:00:00Z' } },
      self_eval: {}, total_ticks: 1, last_digest_date: null,
    });

    const state = loadDashboardState(hermitDir);
    expect(state.agent_name).toBe('shelly');
    expect(state.execution_state).toBe('in_flight');
    expect(state.today_cost_usd).toBe(0.42);
    expect(state.today_tokens).toBe(125000);
    expect(state.alerts).toHaveLength(1);
    expect(state.alerts[0].message).toBe('Daily budget at 92%');
  }));

  test('alive_now is true when a shared liveness file is fresh', withHermitDir((hermitDir) => {
    writeLivenessFile(hermitDir, 30); // 30s old, well under the 600s threshold
    const state = loadDashboardState(hermitDir);
    expect(state.alive_now).toBe(true);
  }));

  test('alive_now is false when the shared liveness file is stale', withHermitDir((hermitDir) => {
    writeJson(hermitDir, 'state/execution.json', { state: 'idle', at: new Date().toISOString() });
    writeLivenessFile(hermitDir, 900); // past the 600s freshness threshold
    const state = loadDashboardState(hermitDir);
    expect(state.alive_now).toBe(false); // stale proves nothing, never "alive"
  }));

  test('skips suppressed alerts and reads a readable message for message-less budget alerts', withHermitDir((hermitDir) => {
    writeJson(hermitDir, 'state/alert-state.json', {
      alerts: {
        'budget-breach:daily:2026-07-05': { kind: 'budget', level: 'breach', period: 'daily', spend: 5.2, cap: 5, notified: true, ts: '2026-07-05T08:00:00Z' },
        'telemetry-export-failed': { message: 'telemetry export failing', count: 9, suppressed: true },
      },
      self_eval: {}, total_ticks: 1, last_digest_date: null,
    });
    const state = loadDashboardState(hermitDir);
    expect(state.alerts).toHaveLength(1); // suppressed telemetry alert excluded
    expect(state.alerts[0].message).toBe('daily budget breached ($5.20 of $5.00)');
    expect(state.alerts[0].message).not.toContain('budget-breach:daily'); // not the raw dedup key
  }));

  test('oldest open accepted age is measured from accepted_date, not creation', withHermitDir((hermitDir) => {
    const nowMs = Date.now();
    const created = new Date(nowMs - 40 * 86400000).toISOString();  // created 40d ago
    const accepted = new Date(nowMs - 3 * 86400000).toISOString();  // accepted 3d ago
    writeProposal(hermitDir, 'PROP-010-accepted-100000.md',
      { id: 'PROP-010-accepted-100000', title: '"Long-open accept"', status: 'accepted', created, accepted_date: accepted },
      'body');
    const state = loadDashboardState(hermitDir);
    expect(state.proposals.oldest_open_accepted?.id).toBe('PROP-010-accepted-100000');
    expect(state.proposals.oldest_open_accepted?.age_days).toBe(3); // since accepted, not 40 since created
  }));

  test('splits proposed/accepted (open, with body) from resolved/dismissed (one-liners)', withHermitDir((hermitDir) => {
    writeProposal(hermitDir, 'PROP-001-open-100000.md',
      { id: 'PROP-001-open-100000', title: '"Open one"', status: 'proposed', created: '2026-07-01T10:00:00Z' },
      '## Context\nSome details here.');
    writeProposal(hermitDir, 'PROP-002-accepted-100000.md',
      { id: 'PROP-002-accepted-100000', title: '"Accepted one"', status: 'accepted', created: '2026-06-20T10:00:00Z', accepted_date: '2026-06-21T10:00:00Z' },
      'Accepted body.');
    writeProposal(hermitDir, 'PROP-003-resolved-100000.md',
      { id: 'PROP-003-resolved-100000', title: '"Resolved one"', status: 'resolved', created: '2026-06-01T10:00:00Z' },
      'Resolved body should not appear.');

    const state = loadDashboardState(hermitDir);
    expect(state.proposals.open.map(p => p.id).sort()).toEqual(['PROP-001-open-100000', 'PROP-002-accepted-100000']);
    expect(state.proposals.other.map(p => p.id)).toEqual(['PROP-003-resolved-100000']);

    const open = state.proposals.open.find(p => p.id === 'PROP-001-open-100000')!;
    expect(open.body).toContain('Some details here.');
    // Resolved rows are one-liners: no body field on the ProposalRow shape.
    expect((state.proposals.other[0] as any).body).toBeUndefined();

    expect(state.proposals.oldest_open_accepted?.id).toBe('PROP-002-accepted-100000');
  }));

  // Regression for the 2026-07-12 incident: a bulk Bash `mv` rename left
  // proposals-index.json stale (old ids/filenames), and both artifact pages
  // rendered the open proposal with an empty body until the index was rebuilt
  // by hand. loadProposals() must now self-heal on every read instead of
  // trusting a parseable-but-stale cache.
  test('self-heals a stale index against a renamed proposal file (incident regression)', withHermitDir((hermitDir) => {
    // Current state on disk: the proposal under its NEW (post-rename) name.
    writeProposal(hermitDir, 'PROP-004-renamed-140000.md',
      { id: 'PROP-004-renamed-140000', title: '"Renamed proposal"', status: 'proposed', created: '2026-07-12T10:00:00Z' },
      'Full body text that must survive the rename.');
    // Stale cache left over from before the rename: old id/filename that no
    // longer exists on disk.
    writeStaleIndex(hermitDir, [
      { id: 'PROP-004-old-name-100000', file: 'PROP-004-old-name-100000.md', title: 'Renamed proposal' },
    ]);

    const state = loadDashboardState(hermitDir);
    expect(state.proposals.open.map(p => p.id)).toEqual(['PROP-004-renamed-140000']);
    expect(state.proposals.open[0].body).toContain('Full body text that must survive the rename.');
    // Stale entry from before the rebuild must not linger.
    expect(state.proposals.open.some(p => p.id === 'PROP-004-old-name-100000')).toBe(false);
  }));

  test('a stale index entry for a since-deleted proposal file does not appear', withHermitDir((hermitDir) => {
    // No proposal file on disk — only a stale index claiming one exists.
    writeStaleIndex(hermitDir, [
      { id: 'PROP-005-deleted-100000', file: 'PROP-005-deleted-100000.md', title: 'Deleted proposal' },
    ]);

    const state = loadDashboardState(hermitDir);
    expect(state.proposals.open).toEqual([]);
  }));

  test('a proposal file added out-of-band appears even though the index predates it', withHermitDir((hermitDir) => {
    // Stale index reflects zero proposals.
    writeJson(hermitDir, 'state/proposals-index.json', {
      updated: '2026-07-12T09:00:00Z', count: 0, counts: {}, proposals: [],
    });
    // A proposal written to disk after that snapshot (e.g. by a script that
    // bypassed the Write/Edit-gated generate-summary hook).
    writeProposal(hermitDir, 'PROP-006-new-150000.md',
      { id: 'PROP-006-new-150000', title: '"New proposal"', status: 'proposed', created: '2026-07-12T15:00:00Z' },
      'Body of the new proposal.');

    const state = loadDashboardState(hermitDir);
    expect(state.proposals.open.map(p => p.id)).toEqual(['PROP-006-new-150000']);
  }));

  test('caps the "other" (resolved/dismissed) list and reports the omitted count', withHermitDir((hermitDir) => {
    for (let i = 0; i < 25; i++) {
      writeProposal(hermitDir, `PROP-${String(i).padStart(3, '0')}-old-100000.md`,
        { id: `PROP-${String(i).padStart(3, '0')}-old-100000`, title: '"Old"', status: 'resolved', created: '2026-01-01T10:00:00Z' },
        'body');
    }
    const state = loadDashboardState(hermitDir);
    expect(state.proposals.other.length).toBe(20);
    expect(state.proposals.other_omitted).toBe(5);
  }));

  test('reads latest weekly review and computes deltas against the prior week', withHermitDir((hermitDir) => {
    writeWeekly(hermitDir, '2026-W26', { week: '2026-W26', total_cost_usd: '3.65' }, 'Prior body.');
    writeWeekly(hermitDir, '2026-W27', {
      week: '2026-W27', total_cost_usd: '3.20',
      proposals_created: '3', proposals_resolved: '2',
    }, '## Summary\nThis week had **14 sessions**.');

    const state = loadDashboardState(hermitDir);
    expect(state.weekly).not.toBeNull();
    expect(state.weekly!.week).toBe('2026-W27');
    expect(state.weekly!.cost_usd).toBeCloseTo(3.20, 5);
    expect(state.weekly!.prior_cost_usd).toBeCloseTo(3.65, 5);
    expect(state.weekly!.has_prior).toBe(true);
    expect(state.weekly!.body_html).toContain('<strong>14 sessions</strong>');
  }));

  test('weekly review with no prior week omits comparison fields', withHermitDir((hermitDir) => {
    writeWeekly(hermitDir, '2026-W27', { week: '2026-W27', total_cost_usd: '3.20' }, 'Body.');
    const state = loadDashboardState(hermitDir);
    expect(state.weekly!.has_prior).toBe(false);
    expect(state.weekly!.prior_cost_usd).toBeNull();
  }));

  test('last_brief is null when state/last-brief.json is absent', withHermitDir((hermitDir) => {
    const state = loadDashboardState(hermitDir);
    expect(state.last_brief).toBeNull();
  }));

  test('last_brief is null when text is blank', withHermitDir((hermitDir) => {
    writeLastBrief(hermitDir, 'morning', '   ');
    const state = loadDashboardState(hermitDir);
    expect(state.last_brief).toBeNull();
  }));

  test('reads lastBrief kind, text, and generated_at', withHermitDir((hermitDir) => {
    writeLastBrief(hermitDir, 'evening', 'Working on the artifact hub. 3 proposals resolved.', '2026-07-05T22:00:00Z');
    const state = loadDashboardState(hermitDir);
    expect(state.last_brief?.kind).toBe('evening');
    expect(state.last_brief?.text).toBe('Working on the artifact hub. 3 proposals resolved.');
    expect(state.last_brief?.generated_at).toBe('2026-07-05T22:00:00Z');
  }));

  test('compiled_index is empty when compiled/ has no docs', withHermitDir((hermitDir) => {
    const state = loadDashboardState(hermitDir);
    expect(state.compiled_index.docs).toEqual([]);
    expect(state.compiled_index.omitted).toBe(0);
  }));

  test('compiled_index excludes review-weekly files and uses frontmatter title when present', withHermitDir((hermitDir) => {
    writeWeekly(hermitDir, '2026-W27', { week: '2026-W27' }, 'body');
    writeCompiledDoc(hermitDir, 'architecture-decisions.md', { title: '"Architecture Decisions"' }, 'body');
    writeCompiledDoc(hermitDir, 'no-frontmatter-doc.md', null, 'plain body, no frontmatter');
    const state = loadDashboardState(hermitDir);
    const names = state.compiled_index.docs.map(d => d.name).sort();
    expect(names).toEqual(['architecture-decisions.md', 'no-frontmatter-doc.md']);
    expect(state.compiled_index.docs.find(d => d.name === 'architecture-decisions.md')?.title).toBe('Architecture Decisions');
    expect(state.compiled_index.docs.find(d => d.name === 'no-frontmatter-doc.md')?.title).toBe('no-frontmatter-doc.md');
  }));

  test('compiled_index caps at 20 and reports the omitted count', withHermitDir((hermitDir) => {
    for (let i = 0; i < 25; i++) {
      writeCompiledDoc(hermitDir, `doc-${String(i).padStart(2, '0')}.md`, null, 'body');
    }
    const state = loadDashboardState(hermitDir);
    expect(state.compiled_index.docs.length).toBe(20);
    expect(state.compiled_index.omitted).toBe(5);
  }));

  test('compiled_index is newest-first by mtime, so a recent doc is not hidden by an alphabetically-late name', withHermitDir((hermitDir) => {
    // 20 older docs whose names sort BEFORE the newest, plus one recent doc whose
    // name sorts LAST — under an alphabetical cap it would fall into the omitted bucket.
    for (let i = 0; i < 20; i++) {
      const f = path.join(hermitDir, 'compiled', `aaa-old-${String(i).padStart(2, '0')}.md`);
      fs.writeFileSync(f, 'body\n');
      fs.utimesSync(f, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    }
    const recent = path.join(hermitDir, 'compiled', 'zzz-newest.md');
    fs.writeFileSync(recent, 'body\n');
    fs.utimesSync(recent, new Date('2026-07-05T00:00:00Z'), new Date('2026-07-05T00:00:00Z'));

    const state = loadDashboardState(hermitDir);
    expect(state.compiled_index.docs[0].name).toBe('zzz-newest.md');
    expect(state.compiled_index.omitted).toBe(1);
  }));
});

// ---------- renderDashboard ----------

describe('renderDashboard', () => {
  test('idle + fresh liveness renders "On watch", not "Idle"', withHermitDir((hermitDir) => {
    writeJson(hermitDir, 'state/execution.json', { state: 'idle', at: new Date().toISOString() });
    writeLivenessFile(hermitDir, 30);
    const { html } = renderDashboard(loadDashboardState(hermitDir));
    expect(html).toContain('On watch');
    expect(html).not.toContain('>Idle<');
  }));

  test('idle + stale liveness still renders "Idle" (stale proves nothing)', withHermitDir((hermitDir) => {
    writeJson(hermitDir, 'state/execution.json', { state: 'idle', at: new Date().toISOString() });
    writeLivenessFile(hermitDir, 900);
    const { html } = renderDashboard(loadDashboardState(hermitDir));
    expect(html).toContain('>Idle<');
    expect(html).not.toContain('On watch');
  }));

  test('in_progress + fresh liveness still renders "Working", not "On watch"', withHermitDir((hermitDir) => {
    writeJson(hermitDir, 'state/execution.json', { state: 'in_flight', at: new Date().toISOString() });
    writeLivenessFile(hermitDir, 30);
    const { html } = renderDashboard(loadDashboardState(hermitDir));
    expect(html).toContain('Working');
    expect(html).not.toContain('On watch');
  }));

  test('is a self-contained fragment with no doctype/html/head/body wrapper', withHermitDir((hermitDir) => {
    const state = loadDashboardState(hermitDir);
    const { html } = renderDashboard(state, { now: '2026-07-05T09:00:00Z' });
    expect(html).not.toMatch(/<!DOCTYPE/i);
    expect(html).not.toMatch(/<html/i);
    expect(html).not.toMatch(/<head>/i);
    expect(html).not.toMatch(/<body>/i);
    expect(html).toContain('<title>Hermit — Dashboard</title>');
  }));

  test('both page titles lead with the hermit name, never doubling it', withHermitDir((hermitDir) => {
    writeJson(hermitDir, 'config.json', { agent_name: 'Atlas' });
    const { html } = renderDashboard(loadDashboardState(hermitDir), { now: '2026-07-05T09:00:00Z' });
    expect(html).toContain('<title>Atlas — Dashboard</title>');
    expect(html).toContain('<h1>Atlas — Dashboard</h1>');
    expect(html).not.toContain('Hermit Dashboard');
  }));

  test('hash is stable across identical state regardless of the "now" timestamp', withHermitDir((hermitDir) => {
    writeJson(hermitDir, 'config.json', { agent_name: 'shelly' });
    const state = loadDashboardState(hermitDir);
    const a = renderDashboard(state, { now: '2026-07-05T09:00:00Z' });
    const b = renderDashboard(state, { now: '2026-07-05T10:30:00Z' });
    expect(a.hash).toBe(b.hash);
    expect(a.html).not.toBe(b.html); // displayed timestamp still differs
    expect(a.html).toContain('2026-07-05T09:00:00Z');
    expect(b.html).toContain('2026-07-05T10:30:00Z');
  }));

  test('hash changes when the underlying state changes', withHermitDir((hermitDir) => {
    const before = renderDashboard(loadDashboardState(hermitDir), { now: '2026-07-05T09:00:00Z' });
    writeTodayCost(hermitDir, 1.23, 5000);
    const after = renderDashboard(loadDashboardState(hermitDir), { now: '2026-07-05T09:00:00Z' });
    expect(before.hash).not.toBe(after.hash);
  }));

  test('never embeds config env values', withHermitDir((hermitDir) => {
    writeJson(hermitDir, 'config.json', {
      agent_name: 'shelly',
      env: { HERMIT_SECRET_TOKEN: 'super-secret-value-should-not-leak' },
    });
    const { html } = renderDashboard(loadDashboardState(hermitDir));
    expect(html).not.toContain('super-secret-value-should-not-leak');
    expect(html).not.toContain('HERMIT_SECRET_TOKEN');
  }));

  test('still never embeds config env values when a brief is present', withHermitDir((hermitDir) => {
    writeJson(hermitDir, 'config.json', {
      agent_name: 'shelly',
      env: { HERMIT_SECRET_TOKEN: 'super-secret-value-should-not-leak' },
    });
    writeLastBrief(hermitDir, 'morning', 'Brief text mentioning nothing sensitive.');
    const { html } = renderDashboard(loadDashboardState(hermitDir));
    expect(html).not.toContain('super-secret-value-should-not-leak');
    expect(html).not.toContain('HERMIT_SECRET_TOKEN');
  }));

  test('renders the latest brief section, safely escaping markdown', withHermitDir((hermitDir) => {
    writeLastBrief(hermitDir, 'morning', 'Working on **the hub**. <script>alert(1)</script>');
    const { html } = renderDashboard(loadDashboardState(hermitDir));
    expect(html).toContain('Latest brief');
    expect(html).toContain('(morning)');
    expect(html).toContain('<strong>the hub</strong>');
    expect(html).not.toContain('<script>alert(1)</script>');
  }));

  test('brief section shows when it was generated, so a stale brief is not undated', withHermitDir((hermitDir) => {
    writeLastBrief(hermitDir, 'morning', 'Brief body.', '2026-07-05T08:00:00Z');
    const { html } = renderDashboard(loadDashboardState(hermitDir));
    expect(html).toContain('2026-07-05T08:00:00Z');
  }));

  test('renders the compiled-docs index, capped, excluding weekly-review files', withHermitDir((hermitDir) => {
    writeWeekly(hermitDir, '2026-W27', { week: '2026-W27' }, 'body');
    writeCompiledDoc(hermitDir, 'architecture-decisions.md', { title: '"Architecture Decisions"' }, 'body');
    const { html } = renderDashboard(loadDashboardState(hermitDir));
    expect(html).toContain('Architecture Decisions');
    expect(html).toContain('architecture-decisions.md');
    expect(html).not.toContain('review-weekly-2026-W27.md');
  }));

  test('renders open proposals as expandable details and history as one-liners', withHermitDir((hermitDir) => {
    writeProposal(hermitDir, 'PROP-001-open-100000.md',
      { id: 'PROP-001-open-100000', title: '"Open one"', status: 'proposed', created: '2026-07-01T10:00:00Z' },
      'Full body text for the open proposal.');
    writeProposal(hermitDir, 'PROP-002-resolved-100000.md',
      { id: 'PROP-002-resolved-100000', title: '"Resolved one"', status: 'resolved', created: '2026-06-01T10:00:00Z' },
      'Body that must not appear on the page.');

    const { html } = renderDashboard(loadDashboardState(hermitDir));
    expect(html).toContain('<details class="proposal">');
    expect(html).toContain('Full body text for the open proposal.');
    expect(html).not.toContain('Body that must not appear on the page.');
    expect(html).toContain('PROP-002-resolved-100000');
  }));

  test('shows placeholder copy for empty proposals and alerts', withHermitDir((hermitDir) => {
    const { html } = renderDashboard(loadDashboardState(hermitDir));
    expect(html).toContain('No open proposals.');
    expect(html).toContain('No active alerts.');
  }));

  test('proposal-pending alerts stay out of the alert list but keep counting in the tile', withHermitDir((hermitDir) => {
    writeJson(hermitDir, 'state/alert-state.json', {
      alerts: {
        'proposal-pending:PROP-001': { message: 'PROP-001 awaiting decision' },
        'proposal-pending:PROP-002': { message: 'PROP-002 awaiting decision' },
        'budget-daily': { message: 'Daily budget at 92%' },
      },
      self_eval: {}, total_ticks: 1, last_digest_date: null,
    });
    const { html } = renderDashboard(loadDashboardState(hermitDir));
    expect(html).not.toContain('PROP-001 awaiting decision');
    expect(html).toContain('Daily budget at 92%');          // other kinds still render
    expect(html).toContain('>3<');                          // tile still counts all three
  }));

  test('renders no alert list rather than "No active alerts." when every alert is card-owned', withHermitDir((hermitDir) => {
    writeJson(hermitDir, 'state/alert-state.json', {
      alerts: { 'proposal-pending:PROP-001': { message: 'PROP-001 awaiting decision' } },
      self_eval: {}, total_ticks: 1, last_digest_date: null,
    });
    const { html } = renderDashboard(loadDashboardState(hermitDir));
    expect(html).not.toContain('No active alerts.');        // would contradict the tile
    expect(html).not.toContain('PROP-001 awaiting decision');
  }));

  test('omits the weekly card entirely when there is no review yet', withHermitDir((hermitDir) => {
    const { html } = renderDashboard(loadDashboardState(hermitDir));
    expect(html).not.toContain('<h2>Week ');
    expect(html).not.toContain('<details class="weekly-body">');
  }));
});
