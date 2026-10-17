// proposal.ts index / lib/proposals/index-rebuild.ts — derived-cache correctness + hook-dispatch wiring.
// The index replaces reading every PROP-*.md body (~22K tokens) with a single
// frontmatter mirror, and becomes the single source of proposal counts.
//
// Usage: bun test tests/proposals-index.test.ts   (from the plugin root)

import { afterAll, describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { rebuildIndex } from '../scripts/lib/proposals/index-rebuild';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-propidx-');
const { freshDir: freshNoProp, cleanup: cleanupNoProp } = freshDirFactory('hermit-noprop-');
afterAll(() => { cleanup(); cleanupNoProp(); });

const hermit = (dir: string, ...p: string[]) => path.join(dir, '.hermit', ...p);

function makeDir(): string {
  const dir = freshDir();
  fs.mkdirSync(hermit(dir, 'state'), { recursive: true });
  fs.mkdirSync(hermit(dir, 'proposals'), { recursive: true });
  return dir;
}

function writeProposal(dir: string, name: string, body: string): void {
  fs.writeFileSync(hermit(dir, 'proposals', name), body);
}

const fm = (o: Record<string, string>) =>
  '---\n' + Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n---\n';

describe('rebuildIndex', () => {
  test('parses frontmatter proposals into rows with counts', () => {
    const dir = makeDir();
    writeProposal(dir, 'PROP-001-foo-120000.md',
      fm({ id: 'PROP-001-foo-120000', status: 'proposed', source: 'auto-detected', category: 'improvement', created: '2026-07-01T10:00:00Z', session: 'S-005' }) +
      '# Proposal: PROP-001 — Foo\n');
    writeProposal(dir, 'PROP-002-bar-130000.md',
      fm({ id: 'PROP-002-bar-130000', status: 'accepted', title: '"Bar direct"' }) +
      '# Proposal: PROP-002 — Bar heading\n');

    const idx = rebuildIndex(hermit(dir))!;
    expect(idx.count).toBe(2);
    expect(idx.counts).toEqual({ proposed: 1, accepted: 1 });

    const p1 = idx.proposals.find(p => p.id === 'PROP-001-foo-120000')!;
    expect(p1.status).toBe('proposed');
    expect(p1.source).toBe('auto-detected');
    expect(p1.title).toBe('Foo'); // from heading (no frontmatter title)
    expect(p1.unparseable).toBe(false);

    const p2 = idx.proposals.find(p => p.id === 'PROP-002-bar-130000')!;
    expect(p2.title).toBe('Bar direct'); // frontmatter title wins over heading
  });

  test('a no-frontmatter proposal still gets a placeholder row, not a parsed one', () => {
    const dir = makeDir();
    // Bullet metadata is no longer parsed — but the file must not vanish from the
    // index, or proposal-list and heartbeat (which reads disk directly) would
    // disagree about whether it exists. It surfaces as status-unknown, which is
    // honest: proposal.ts only writes frontmatter, so nothing can act on it.
    writeProposal(dir, 'PROP-006.md',
      '# Proposal: PROP-006 — Legacy one\n\n**Status:** accepted\n**Created:** 2026-01-01\n');
    const idx = rebuildIndex(hermit(dir))!;
    const p = idx.proposals[0];
    expect(p.unparseable).toBe(true);
    expect(p.id).toBe('PROP-006');
    expect(p.file).toBe('PROP-006.md');
    expect(p.status).toBeNull();
    expect(p.source).toBeNull();
    expect(p.title).toBeNull();
    expect(idx.counts.unknown).toBe(1);
  });

  test('writes proposals-index.json and is idempotent on content', () => {
    const dir = makeDir();
    writeProposal(dir, 'PROP-001-a-120000.md', fm({ status: 'proposed' }) + '# Proposal: PROP-001 — A\n');
    rebuildIndex(hermit(dir));
    const p = hermit(dir, 'state', 'proposals-index.json');
    expect(fs.existsSync(p)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    expect(parsed.count).toBe(1);
    expect(parsed.proposals[0].status).toBe('proposed');
  });

  test('returns null when there is no proposals dir', () => {
    const dir = freshNoProp();
    fs.mkdirSync(hermit(dir, 'state'), { recursive: true });
    expect(rebuildIndex(hermit(dir))).toBe(null);
  });
});

describe('CLI verdict', () => {
  test('count with a proposals dir', async () => {
    const dir = makeDir();
    writeProposal(dir, 'PROP-001-a-120000.md', fm({ status: 'proposed' }) + '# Proposal: PROP-001 — A\n');
    const r = await runScript('proposal.ts', { args: ['index', '.hermit'], cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ count: 1 });
  });

  test('skip when the proposals dir is absent', async () => {
    const dir = freshNoProp();
    fs.mkdirSync(hermit(dir, 'state'), { recursive: true });
    const r = await runScript('proposal.ts', { args: ['index', '.hermit'], cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ status: 'skip', reason: 'no_proposals_dir' });
  });
});

describe('generate-summary hook regenerates the index on a proposal write', () => {
  test('proposal-path payload builds the index', async () => {
    const dir = makeDir();
    writeProposal(dir, 'PROP-001-a-120000.md', fm({ status: 'proposed' }) + '# Proposal: PROP-001 — A\n');
    const payload = JSON.stringify({
      tool_name: 'Write',
      tool_input: { file_path: hermit(dir, 'proposals', 'PROP-001-a-120000.md') },
    });
    await runScript('generate-summary.ts', { stdin: payload });
    expect(fs.existsSync(hermit(dir, 'state', 'proposals-index.json'))).toBe(true);
  });

  test('non-proposal, non-state payload writes nothing', async () => {
    const dir = makeDir();
    const payload = JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(dir, 'src', 'x.ts') } });
    await runScript('generate-summary.ts', { stdin: payload });
    expect(fs.existsSync(hermit(dir, 'state', 'proposals-index.json'))).toBe(false);
  });
});

// CLI mode only — hook mode above derives its path from a PostToolUse payload
// for a write that already happened and is not reachable through the
// pre-approved `Bash(bun */scripts/generate-summary.ts*)` grant. CLI mode is,
// so an unvalidated `<hermit>/state` argv let one such call regenerate
// (and read alert/proposal state into) another project's state-summary.md.
describe('generate-summary CLI mode: state-dir pin', () => {
  test('refuses a state dir belonging to another project', async () => {
    const mine = makeDir();
    const victim = makeDir();
    fs.writeFileSync(hermit(victim, 'state', 'alert-state.json'), '{}');
    const summaryPath = hermit(victim, 'state', 'state-summary.md');
    fs.writeFileSync(summaryPath, 'victim content\n');
    const before = fs.readFileSync(summaryPath, 'utf-8');

    // AGENT_DIR pins hermitDir() to `mine`; argv still names the victim's state dir.
    const r = await runScript('generate-summary.ts', {
      args: [hermit(victim, 'state')],
      env: { AGENT_DIR: hermit(mine) },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toStartWith('{"error":"foreign_state_dir:');
    expect(fs.readFileSync(summaryPath, 'utf-8')).toBe(before);
  });
});
