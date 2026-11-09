// bun test for scripts/lib/artifact-strings.ts + the renderers' use of it.
// Usage: bun test tests/artifact-strings.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_STRINGS, loadStrings, fmt } from '../scripts/lib/artifact-strings';
import { loadDashboardState, renderDashboard } from '../scripts/lib/dashboard';

// ---------- fixture scaffolding ----------

function makeHermitDir(): { hermitDir: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-strings-'));
  const hermitDir = path.join(root, '.hermit');
  fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
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

function writeStrings(hermitDir: string, strings: Record<string, unknown>, language = 'pt'): void {
  fs.writeFileSync(
    path.join(hermitDir, 'state', 'artifact-strings.json'),
    JSON.stringify({ language, generated: '2026-07-10T00:00:00Z', strings }),
  );
}

// A complete overlay that x's out every alphabetic word while preserving {tokens},
// punctuation and digits. Proves chrome is table-sourced (no hardcoded English leaks)
// and that placeholder fills still work after an overlay.
function fullMaskedOverlay(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(DEFAULT_STRINGS)) {
    // Mask alphabetic words but leave {tokens} untouched so fmt() still fills them.
    out[k] = v.replace(/\{[^}]+\}|[A-Za-z][A-Za-z']*/g, m => (m.startsWith('{') ? m : 'x'.repeat(m.length)));
  }
  return out;
}

// ---------- fmt ----------

describe('fmt', () => {
  test('fills {placeholder} tokens from params', () => {
    expect(fmt('+{n} more not shown', { n: 5 })).toBe('+5 more not shown');
    expect(fmt('{a} and {b}', { a: 'x', b: 'y' })).toBe('x and y');
  });

  test('leaves unmatched tokens intact rather than blanking them', () => {
    expect(fmt('{known} {missing}', { known: 'ok' })).toBe('ok {missing}');
  });
});

// ---------- loadStrings ----------

describe('loadStrings', () => {
  test('returns the English defaults when no overlay file exists', withHermitDir((hermitDir) => {
    expect(loadStrings(hermitDir)).toEqual(DEFAULT_STRINGS);
  }));

  test('overlays per key — provided keys win, missing keys fall back to English', withHermitDir((hermitDir) => {
    writeStrings(hermitDir, { status_heading: 'Estado' });
    const s = loadStrings(hermitDir);
    expect(s.status_heading).toBe('Estado');           // overlaid
    expect(s.status_no_alerts).toBe(DEFAULT_STRINGS.status_no_alerts); // untouched key stays English
  }));

  test('ignores unknown overlay keys and non-string values', withHermitDir((hermitDir) => {
    writeStrings(hermitDir, { not_a_real_key: 'x', status_today: 42, status_session: 'Sessão' });
    const s = loadStrings(hermitDir);
    expect((s as Record<string, unknown>).not_a_real_key).toBeUndefined();
    expect(s.status_today).toBe(DEFAULT_STRINGS.status_today); // non-string ignored -> default
    expect(s.status_session).toBe('Sessão');
  }));

  test('falls back to defaults on malformed JSON', withHermitDir((hermitDir) => {
    fs.writeFileSync(path.join(hermitDir, 'state', 'artifact-strings.json'), '{ not json');
    expect(loadStrings(hermitDir)).toEqual(DEFAULT_STRINGS);
  }));

  test('escapes HTML in overlay values — a corrupt translation file cannot inject markup', withHermitDir((hermitDir) => {
    writeStrings(hermitDir, { status_heading: '<script>alert(1)</script>', waiting_heading: 'Tom & "Jerry"' });
    const s = loadStrings(hermitDir);
    expect(s.status_heading).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(s.waiting_heading).toBe('Tom &amp; &quot;Jerry&quot;');
  }));

  test('{placeholder} tokens in an overlay value survive escaping and still fill via fmt()', withHermitDir((hermitDir) => {
    writeStrings(hermitDir, { dashboard_title: '{name} — O Painel' });
    const s = loadStrings(hermitDir);
    expect(fmt(s.dashboard_title, { name: 'Atlas' })).toBe('Atlas — O Painel');
  }));

  test('every DEFAULT_STRINGS value is a non-empty string', () => {
    for (const [k, v] of Object.entries(DEFAULT_STRINGS)) {
      expect(typeof v, k).toBe('string');
      expect(v.length, k).toBeGreaterThan(0);
    }
  });
});

// ---------- renderer integration ----------

describe('renderers honor the overlay', () => {
  test('dashboard chrome is fully table-sourced — a full overlay leaks no English defaults', withHermitDir((hermitDir) => {
    fs.writeFileSync(path.join(hermitDir, 'config.json'), JSON.stringify({ agent_name: 'Atlas' }));
    writeStrings(hermitDir, fullMaskedOverlay());
    const { html } = renderDashboard(loadDashboardState(hermitDir), { now: '2026-07-05T09:00:00Z' });

    // English chrome must be gone (all masked to x-runs)...
    for (const phrase of ['Status', 'No active alerts.', 'Nothing waiting on you.', 'Latest brief',
                          'No brief yet.', 'Compiled docs', 'Dashboard', 'Execution', 'Open tasks']) {
      expect(html, phrase).not.toContain(phrase);
    }
    // ...replaced by the masked chrome, with the {name} placeholder still filled from config.
    expect(html).toContain('Atlas');
    expect(html).toContain('xxxxxx'); // masked words present
  }));

  test('a partial overlay translates only its keys, leaving the rest English', withHermitDir((hermitDir) => {
    writeStrings(hermitDir, { waiting_none: 'Nenhuma proposta aberta.' });
    const { html } = renderDashboard(loadDashboardState(hermitDir), { now: '2026-07-05T09:00:00Z' });
    expect(html).toContain('Nenhuma proposta aberta.');   // overlaid key
    expect(html).toContain('No active alerts.');          // untouched key still English
  }));

  test('an empty overlay renders byte-identically to no overlay at all', withHermitDir((hermitDir) => {
    const bare = renderDashboard(loadDashboardState(hermitDir), { now: '2026-07-05T09:00:00Z' });
    writeStrings(hermitDir, {});
    const empty = renderDashboard(loadDashboardState(hermitDir), { now: '2026-07-05T09:00:00Z' });
    expect(empty.html).toBe(bare.html);
    expect(empty.hash).toBe(bare.hash);
  }));

  test('translating a chrome string changes the hash exactly once (stable thereafter)', withHermitDir((hermitDir) => {
    const before = renderDashboard(loadDashboardState(hermitDir));
    writeStrings(hermitDir, { status_heading: 'Estado' });
    const after1 = renderDashboard(loadDashboardState(hermitDir));
    const after2 = renderDashboard(loadDashboardState(hermitDir));
    expect(after1.hash).not.toBe(before.hash);
    expect(after2.hash).toBe(after1.hash);
  }));

  // Overlay values with HTML-special chars (apostrophes are common in fr/it/…, plus `&`)
  // must be escaped exactly once. Two renderer spots compose chrome + data into one line;
  // a stray re-escape there turns a translated string into literal `&#39;`/`&amp;` mojibake.
  test('overlay values with special chars render escaped exactly once (no double-escape)', withHermitDir((hermitDir) => {
    // Weekly card summary line (renderWeekly) + budget-alert line (renderStatus).
    fs.writeFileSync(
      path.join(hermitDir, 'compiled', 'review-weekly-2026-W27.md'),
      '---\nweek: 2026-W27\ntotal_cost_usd: 12.34\nproposals_created: 1\nproposals_resolved: 2\n---\nbody',
    );
    fs.writeFileSync(
      path.join(hermitDir, 'state', 'budget-alerts.json'),
      JSON.stringify({ alerts: { 'budget:daily': { kind: 'budget', period: 'daily', level: 'breach', spend: 5, cap: 4, timestamp: '2026-07-05T00:00:00Z' } } }),
    );
    writeStrings(hermitDir, {
      weekly_cost: "Coût : {amount} d'auto-dirige & co{delta}",
      budget_state_breached: "d'epasse",
    });
    const { html } = renderDashboard(loadDashboardState(hermitDir), { now: '2026-07-05T09:00:00Z' });

    // Singly-escaped forms present...
    expect(html).toContain("d&#39;auto-dirige &amp; co"); // weekly line
    expect(html).toContain('d&#39;epasse');               // budget alert line
    // ...and no double-escaped mojibake anywhere.
    expect(html).not.toContain('&amp;#39;');
    expect(html).not.toContain('&amp;amp;');
  }));
});
