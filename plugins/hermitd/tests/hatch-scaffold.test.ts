import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript, PLUGIN_ROOT } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const TEMPLATES = path.join(PLUGIN_ROOT, 'state-templates');
const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/;

const { freshDir, cleanup } = freshDirFactory('hermit-scaffold-');
afterAll(cleanup);

async function scaffold(projectRoot: string, reinit = false) {
  const args = reinit ? [projectRoot, '--reinit=true'] : [projectRoot];
  const r = await runScript('hatch-scaffold.ts', { args });
  expect(r.exitCode).toBe(0);
  return JSON.parse(r.stdout);
}

describe('hatch-scaffold.ts', () => {
  test('fresh project: builds the full tree, stamps a live timestamp', async () => {
    const dir = freshDir();
    const hermit = path.join(dir, '.hermit');
    const out = await scaffold(dir);

    expect(out.operator_existed).toBe(false);

    // dirs
    for (const d of ['tasks', 'proposals', 'templates', 'state', 'raw/.archive', 'compiled', 'bin']) {
      expect(fs.existsSync(path.join(hermit, d))).toBe(true);
    }
    // pristine templates
    for (const f of ['PROPOSAL.md.template']) {
      expect(fs.existsSync(path.join(hermit, 'templates', f))).toBe(true);
    }
    // bin/ enumerated + executable
    const binNames = fs.readdirSync(path.join(TEMPLATES, 'bin'));
    expect(binNames.length).toBeGreaterThan(0);
    for (const name of binNames) {
      const dest = path.join(hermit, 'bin', name);
      expect(fs.existsSync(dest)).toBe(true);
      expect(fs.statSync(dest).mode & 0o111).toBeGreaterThan(0);
    }
    // operator-editable + state files
    for (const f of ['OPERATOR.md', 'HEARTBEAT.md', 'knowledge-schema.md']) {
      expect(fs.existsSync(path.join(hermit, f))).toBe(true);
    }
    expect(fs.existsSync(path.join(hermit, 'sessions'))).toBe(false);
    for (const name of ['SHELL.md.template', 'SESSION-REPORT.md.template']) {
      expect(fs.existsSync(path.join(hermit, 'templates', name))).toBe(false);
    }
    for (const f of [
      'alert-state.json', 'micro-proposals.json', 'reflection-state.json',
      'routine-metrics.jsonl', 'proposal-metrics.jsonl', 'observations.jsonl',
      'update-history.jsonl', 'channel-replies.jsonl',
    ]) {
      expect(fs.existsSync(path.join(hermit, 'state', f))).toBe(true);
    }
    // live timestamp on reflection-state
    const rs = JSON.parse(fs.readFileSync(path.join(hermit, 'state', 'reflection-state.json'), 'utf8'));
    expect(rs.counters.since).toMatch(ISO_OFFSET);

    // never created
    expect(fs.existsSync(path.join(hermit, 'state', 'pending-close.json'))).toBe(false);
  });

  test('--reinit preserves operator/state artifacts, refreshes pristine files', async () => {
    const dir = freshDir();
    const hermit = path.join(dir, '.hermit');
    fs.mkdirSync(path.join(hermit, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(hermit, 'state'), { recursive: true });
    fs.mkdirSync(path.join(hermit, 'sessions'), { recursive: true });

    // operator/state artifacts with custom content
    fs.writeFileSync(path.join(hermit, 'OPERATOR.md'), 'CUSTOM operator profile\n');
    fs.writeFileSync(path.join(hermit, 'state', 'micro-proposals.json'), '{"custom":true}');
    fs.writeFileSync(path.join(hermit, 'state', 'reflection-state.json'), '{"counters":{"since":"CUSTOM"}}');
    fs.writeFileSync(path.join(hermit, 'sessions', 'SHELL.md'), 'live session\n');
    // A retired template must be left untouched.
    fs.writeFileSync(path.join(hermit, 'templates', 'SHELL.md.template'), 'OLD STALE TEMPLATE\n');

    const out = await scaffold(dir, true);
    expect(out.operator_existed).toBe(true);

    // preserved
    expect(fs.readFileSync(path.join(hermit, 'OPERATOR.md'), 'utf8')).toBe('CUSTOM operator profile\n');
    expect(fs.readFileSync(path.join(hermit, 'state', 'micro-proposals.json'), 'utf8')).toBe('{"custom":true}');
    expect(JSON.parse(fs.readFileSync(path.join(hermit, 'state', 'reflection-state.json'), 'utf8')).counters.since).toBe('CUSTOM');
    expect(fs.readFileSync(path.join(hermit, 'sessions', 'SHELL.md'), 'utf8')).toBe('live session\n');

    // Retired operator copies remain frozen.
    const pristine = 'OLD STALE TEMPLATE\n';
    expect(fs.readFileSync(path.join(hermit, 'templates', 'SHELL.md.template'), 'utf8')).toBe(pristine);

    expect(fs.existsSync(path.join(hermit, 'state', 'pending-close.json'))).toBe(false);
  });
});

test('session-id marks hatch session guest on fresh and repeated scaffolds', async () => {
  const { isGuest, clearGuest } = await import('../scripts/lib/guest-marker');
  const dir = freshDir(); const state = path.join(dir, '.hermit/state');
  for (let i = 0; i < 2; i++) {
    const r = await runScript('hatch-scaffold.ts', { args: [dir, '--session-id', 'setup-session'] });
    expect(r.exitCode).toBe(0); expect(isGuest(state, 'setup-session')).toBe(true);
    clearGuest(state, 'setup-session');
  }
});
