// bun test for scripts/lib/proposals-page.ts — proposals-page renderer.
// Usage: bun test tests/proposals-page.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadProposalsPageState, renderProposalsPage, proposalAnchorId } from '../scripts/lib/proposals-page';

// ---------- fixture scaffolding ----------

function makeHermitDir(): { hermitDir: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-proposals-page-'));
  const hermitDir = path.join(root, '.hermit');
  fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(hermitDir, 'proposals'), { recursive: true });
  return { hermitDir, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} } };
}

function withHermitDir(fn: (hermitDir: string) => void) {
  return () => {
    const h = makeHermitDir();
    try { fn(h.hermitDir); } finally { h.cleanup(); }
  };
}

function writeProposal(hermitDir: string, file: string, fm: Record<string, string>, body: string): void {
  const yaml = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n');
  fs.writeFileSync(path.join(hermitDir, 'proposals', file), `---\n${yaml}\n---\n${body}\n`);
}

// ---------- proposalAnchorId ----------

describe('proposalAnchorId', () => {
  test('lowercases the PROP-NNN prefix from a full frontmatter id', () => {
    expect(proposalAnchorId('PROP-025-architecture-hub-spoke-artifact-delivery-123243')).toBe('prop-025');
  });

  test('falls back to a slugified full id when no PROP-NNN prefix is present', () => {
    expect(proposalAnchorId('legacy-id-with-no-prefix')).toBe('legacy-id-with-no-prefix');
  });
});

// ---------- loadProposalsPageState ----------

describe('loadProposalsPageState', () => {
  test('open (proposed/accepted) proposals carry full body; others are one-liners', withHermitDir((hermitDir) => {
    writeProposal(hermitDir, 'PROP-001-open-100000.md',
      { id: 'PROP-001-open-100000', title: '"Open one"', status: 'proposed', created: '2026-07-01T10:00:00Z' },
      'Full body text for the open proposal.');
    writeProposal(hermitDir, 'PROP-002-deferred-100000.md',
      { id: 'PROP-002-deferred-100000', title: '"Deferred one"', status: 'deferred', created: '2026-06-20T10:00:00Z' },
      'Deferred body should not appear.');
    writeProposal(hermitDir, 'PROP-003-resolved-100000.md',
      { id: 'PROP-003-resolved-100000', title: '"Resolved one"', status: 'resolved', created: '2026-06-01T10:00:00Z' },
      'Resolved body should not appear.');

    const state = loadProposalsPageState(hermitDir);
    expect(state.open.map(p => p.id)).toEqual(['PROP-001-open-100000']);
    expect(state.open[0].body).toContain('Full body text for the open proposal.');
    expect(state.other.map(p => p.id).sort()).toEqual(['PROP-002-deferred-100000', 'PROP-003-resolved-100000']);
  }));

  test('caps the "other" history list and reports the omitted count', withHermitDir((hermitDir) => {
    for (let i = 0; i < 25; i++) {
      writeProposal(hermitDir, `PROP-${String(i).padStart(3, '0')}-old-100000.md`,
        { id: `PROP-${String(i).padStart(3, '0')}-old-100000`, title: '"Old"', status: 'resolved', created: '2026-01-01T10:00:00Z' },
        'body');
    }
    const state = loadProposalsPageState(hermitDir);
    expect(state.other.length).toBe(20);
    expect(state.other_omitted).toBe(5);
  }));
});

// ---------- renderProposalsPage ----------

describe('renderProposalsPage', () => {
  test('is a self-contained fragment with no doctype/html/head/body wrapper', withHermitDir((hermitDir) => {
    const state = loadProposalsPageState(hermitDir);
    const { html } = renderProposalsPage(state, { now: '2026-07-05T09:00:00Z' });
    expect(html).not.toMatch(/<!DOCTYPE/i);
    expect(html).not.toMatch(/<html/i);
    expect(html).not.toMatch(/<head>/i);
    expect(html).not.toMatch(/<body>/i);
    expect(html).toContain('<title>Hermit — Proposals</title>');
  }));

  test('renders each open proposal as a collapsed <details> carrying a prop-nnn id', withHermitDir((hermitDir) => {
    writeProposal(hermitDir, 'PROP-025-hub-spoke-100000.md',
      { id: 'PROP-025-hub-spoke-100000', title: '"Hub and spoke"', status: 'proposed', created: '2026-07-01T10:00:00Z' },
      'Full text of the proposal.');
    const { html } = renderProposalsPage(loadProposalsPageState(hermitDir));
    expect(html).toContain('<details class="proposal" id="prop-025">');
    expect(html).not.toMatch(/<details class="proposal" id="prop-025"[^>]*\sopen/);
    expect(html).toContain('Full text of the proposal.'); // present in markup even though collapsed by default
  }));

  test('shows an open-proposal count heading, absent when there are none open', withHermitDir((hermitDir) => {
    writeProposal(hermitDir, 'PROP-001-open-a-100000.md',
      { id: 'PROP-001-open-a-100000', title: '"Open A"', status: 'proposed', created: '2026-07-01T10:00:00Z' },
      'body a');
    writeProposal(hermitDir, 'PROP-002-open-b-100000.md',
      { id: 'PROP-002-open-b-100000', title: '"Open B"', status: 'accepted', created: '2026-07-02T10:00:00Z' },
      'body b');
    const { html } = renderProposalsPage(loadProposalsPageState(hermitDir));
    expect(html).toContain('2 Open');
  }));

  test('omits the open count heading when there are no open proposals', withHermitDir((hermitDir) => {
    const { html } = renderProposalsPage(loadProposalsPageState(hermitDir));
    expect(html).not.toContain('Open</h2>');
    expect(html).toContain('No open proposals.');
  }));

  test('omits age-in-days so the hash stays activity-driven, not date-driven', withHermitDir((hermitDir) => {
    // created far enough in the past that an age label would definitely appear
    // in the dashboard's rendering, if this renderer reused that logic.
    writeProposal(hermitDir, 'PROP-001-open-100000.md',
      { id: 'PROP-001-open-100000', title: '"Open one"', status: 'proposed', created: '2020-01-01T10:00:00Z' },
      'body');
    const { html } = renderProposalsPage(loadProposalsPageState(hermitDir));
    expect(html).not.toMatch(/\d+d\)/); // dashboard's "(NNNNd)" age suffix
    expect(html).toContain('2020-01-01T10:00:00Z'); // created date shown instead
  }));

  test('hash is stable across identical state regardless of the "now" timestamp', withHermitDir((hermitDir) => {
    writeProposal(hermitDir, 'PROP-001-open-100000.md',
      { id: 'PROP-001-open-100000', title: '"Open one"', status: 'proposed', created: '2026-07-01T10:00:00Z' },
      'body');
    const state = loadProposalsPageState(hermitDir);
    const a = renderProposalsPage(state, { now: '2026-07-05T09:00:00Z' });
    const b = renderProposalsPage(state, { now: '2026-07-05T10:30:00Z' });
    expect(a.hash).toBe(b.hash);
    expect(a.html).not.toBe(b.html);
  }));

  test('hash changes when the underlying state changes', () => {
    // Two independent fixtures rather than mutating one in place — loadProposalsPageState
    // caches proposals-index.json on first read (the self-heal rebuild writes it back to
    // disk), so a second read against the same hermitDir would see the stale cache instead
    // of the newly-written proposal (in production a PostToolUse hook keeps the cache fresh
    // on every proposal write; this unit test has no such hook).
    const empty = makeHermitDir();
    const withProposal = makeHermitDir();
    try {
      writeProposal(withProposal.hermitDir, 'PROP-001-open-100000.md',
        { id: 'PROP-001-open-100000', title: '"Open one"', status: 'proposed', created: '2026-07-01T10:00:00Z' },
        'body');
      const before = renderProposalsPage(loadProposalsPageState(empty.hermitDir), { now: '2026-07-05T09:00:00Z' });
      const after = renderProposalsPage(loadProposalsPageState(withProposal.hermitDir), { now: '2026-07-05T09:00:00Z' });
      expect(before.hash).not.toBe(after.hash);
    } finally {
      empty.cleanup();
      withProposal.cleanup();
    }
  });

  test('escapes markdown/HTML safely in proposal bodies', withHermitDir((hermitDir) => {
    writeProposal(hermitDir, 'PROP-001-open-100000.md',
      { id: 'PROP-001-open-100000', title: '"Open one"', status: 'proposed', created: '2026-07-01T10:00:00Z' },
      '**bold** text and <script>alert(1)</script>');
    const { html } = renderProposalsPage(loadProposalsPageState(hermitDir));
    expect(html).toContain('<strong>bold</strong>');
    expect(html).not.toContain('<script>alert(1)</script>');
  }));

  test('shows placeholder copy when there are no open proposals', withHermitDir((hermitDir) => {
    const { html } = renderProposalsPage(loadProposalsPageState(hermitDir));
    expect(html).toContain('No open proposals.');
  }));

  test('never embeds config env values (renderer never reads config.json)', withHermitDir((hermitDir) => {
    fs.writeFileSync(path.join(hermitDir, 'config.json'), JSON.stringify({
      env: { HERMIT_SECRET_TOKEN: 'super-secret-value-should-not-leak' },
    }));
    const { html } = renderProposalsPage(loadProposalsPageState(hermitDir));
    expect(html).not.toContain('super-secret-value-should-not-leak');
  }));
});
