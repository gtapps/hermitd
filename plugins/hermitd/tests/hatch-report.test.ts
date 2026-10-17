// hatch-report.ts — the two operator-facing summaries hatch used to compose by hand.
//
// The load-bearing tests are the "declined step" ones: the old report was written
// by the model from its own memory of the run, so it could claim a file was
// created that the operator had refused. `final` observes the filesystem, so a
// declined .gitignore append reports as absent without anyone having to remember.

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { observe, renderFinal, renderConfirm } from '../scripts/hatch-report';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('hermit-hatchreport-');
afterAll(cleanup);

interface HatchedOpts {
  claudeTarget?: 'CLAUDE.md' | 'CLAUDE.local.md' | null;
  gitignore?: boolean;
  worktreeinclude?: boolean;
  settings?: 'local' | 'committed' | null;
  git?: boolean;
  config?: Record<string, unknown>;
}

/** A project as it looks after a hatch run with the given steps taken or declined. */
function hatched(o: HatchedOpts = {}): string {
  const root = freshDir();
  const hermit = path.join(root, '.hermit');
  fs.mkdirSync(path.join(hermit, 'state'), { recursive: true });
  fs.mkdirSync(path.join(hermit, 'bin'), { recursive: true });
  // The full shipped set: renderFinal warns on any template bin script that is
  // absent, so a fixture with a partial set would read as a broken scaffold.
  for (const b of fs.readdirSync(path.join(import.meta.dir, '..', 'state-templates', 'bin'))) {
    fs.writeFileSync(path.join(hermit, 'bin', b), '#!/bin/sh\n');
  }
  fs.writeFileSync(path.join(hermit, 'config.json'), JSON.stringify({
    agent_name: 'Atlas', language: 'en', timezone: 'UTC', escalation: 'balanced',
    permission_mode: 'auto', push_notifications: true,
    channels: {}, routines: [{ id: 'heartbeat-restart', enabled: true }],
    scheduled_checks: [], heartbeat: { enabled: false },
    _hermit_versions: { 'hermitd': '1.2.34' },
    ...(o.config ?? {}),
  }, null, 2));
  fs.writeFileSync(path.join(hermit, 'state', 'hatch-options.json'),
    JSON.stringify({ target: o.settings === 'committed' ? 'committed' : 'local' }));

  if (o.claudeTarget) {
    fs.writeFileSync(path.join(root, o.claudeTarget),
      '# Project\n\n<!-- hermitd: Session Discipline -->\nrules\n');
  }
  if (o.gitignore) fs.writeFileSync(path.join(root, '.gitignore'), '.hermit/sessions/\n');
  if (o.worktreeinclude) fs.writeFileSync(path.join(root, '.worktreeinclude'), '# >>> hermitd\nOPERATOR.md\n');
  if (o.settings) {
    const f = o.settings === 'local' ? '.claude/settings.local.json' : '.claude/settings.json';
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, f), JSON.stringify({
      permissions: { allow: ['Edit(.hermit/**)'] },
    }));
  }
  if (o.git) fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  return root;
}

describe('final reports disk truth, not a remembered file list', () => {
  test('a fully-completed hatch shows no warnings and names the agent', () => {
    const root = hatched({ claudeTarget: 'CLAUDE.local.md', gitignore: true, worktreeinclude: true, settings: 'local', git: true });
    const out = renderFinal(observe(root), 'docker');
    expect(out).toContain('Atlas is hatched');
    expect(out).not.toContain('Not present');
  });

  test('a workspace-backup .gitignore still reads as configured', () => {
    // Workspace-mode backup rewrites the hermit block into a marker line so state
    // can be committed. The marker keeps the `.hermit` substring on
    // purpose — without it this probe would report the gitignore as missing.
    const root = hatched({ claudeTarget: 'CLAUDE.local.md', worktreeinclude: true, settings: 'local', git: true });
    fs.writeFileSync(path.join(root, '.gitignore'),
      '# .hermit state is tracked here (backup: workspace mode)\n.claude.local/\n.env\n');
    const out = renderFinal(observe(root), 'interactive');
    expect(out).not.toMatch(/Not present:.*\.gitignore/);
  });

  test('a declined .gitignore append surfaces as a warning, never as created', () => {
    const root = hatched({ claudeTarget: 'CLAUDE.local.md', gitignore: false, worktreeinclude: true, settings: 'local' });
    const out = renderFinal(observe(root), 'interactive');
    expect(out).toMatch(/Not present:.*\.gitignore/);
    expect(out).not.toContain('Created');
  });

  test('a declined .worktreeinclude surfaces as a warning', () => {
    const root = hatched({ claudeTarget: 'CLAUDE.md', gitignore: true, worktreeinclude: false, settings: 'local' });
    expect(renderFinal(observe(root), 'tmux')).toMatch(/Not present:.*\.worktreeinclude/);
  });

  test('a declined permissions merge surfaces as a warning', () => {
    const root = hatched({ claudeTarget: 'CLAUDE.md', gitignore: true, worktreeinclude: true, settings: null });
    expect(renderFinal(observe(root), 'tmux')).toMatch(/Not present:.*permissions/);
  });

  test('a partial bin scaffold names the missing scripts', () => {
    const root = hatched({ claudeTarget: 'CLAUDE.md', gitignore: true, worktreeinclude: true, settings: 'local' });
    fs.rmSync(path.join(root, '.hermit', 'bin', 'hermitd-run'));
    expect(renderFinal(observe(root), 'tmux')).toMatch(/Not present:.*bin.*hermitd-run/);
  });

  test('a skipped git init is not warned about', () => {
    const root = hatched({ claudeTarget: 'CLAUDE.md', gitignore: true, worktreeinclude: true, settings: 'local', git: false });
    expect(renderFinal(observe(root), 'interactive')).not.toContain('Not present');
  });

  test('a "keep" on the CLAUDE block still finds the existing marker (no warning)', () => {
    const root = hatched({ claudeTarget: 'CLAUDE.md', gitignore: true, worktreeinclude: true, settings: 'local' });
    expect(renderFinal(observe(root), 'tmux')).not.toMatch(/Not present:.*CLAUDE/);
  });

  test('an aborted hatch (no config.json) reports failure, not success', () => {
    const root = freshDir();
    fs.mkdirSync(path.join(root, '.hermit'), { recursive: true });
    const out = renderFinal(observe(root), 'docker');
    expect(out).toContain('did not complete');
    expect(out).not.toContain('is hatched');
  });
});

describe('final next-steps keys off deployment', () => {
  test('docker points at docker-setup', () => {
    expect(renderFinal(observe(hatched()), 'docker')).toContain('docker-setup');
  });

  test('tmux points at the boot script', () => {
    expect(renderFinal(observe(hatched()), 'tmux')).toContain('hermitd start');
  });

  test('interactive points at resident-start', () => {
    const out = renderFinal(observe(hatched()), 'interactive');
    expect(out).toContain('resident-start` — start the agent');
    expect(out).toContain('The agent is not running until step');
    expect(out).not.toContain(':session');
  });

  test('channel-setup appears only when a channel is configured', () => {
    const without = renderFinal(observe(hatched()), 'interactive');
    expect(without).not.toContain('channel-setup');
    const withChan = renderFinal(observe(hatched({ config: { channels: { discord: { enabled: true } } } })), 'interactive');
    expect(withChan).toContain('channel-setup');
  });

  test('CLI rejects a deployment outside the enum', async () => {
    const r = await runScript('hatch-report.ts', { args: ['final', hatched(), '--deployment', 'kubernetes'] });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: 'invalid_deployment' });
  });

  test('CLI final exits 0 and prints the report', async () => {
    const r = await runScript('hatch-report.ts', { args: ['final', hatched(), '--deployment', 'tmux'] });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('is hatched');
  });
});

describe('confirm previews intent, before anything is written', () => {
  test('renders the operator choices verbatim and says nothing is written yet', () => {
    const out = renderConfirm({
      agent_name: 'Atlas', language: 'pt', timezone: 'Europe/Lisbon',
      deployment: 'docker', channel: 'discord', hatch_target: 'local',
    });
    expect(out).toContain('Atlas');
    expect(out).toContain('Docker always-on');
    expect(out).toContain('Discord — pairing comes after setup');
    expect(out).toContain('Nothing has been written yet');
  });

  test('consequential defaults come from the shipped template, tagged as defaults', () => {
    const out = renderConfirm({ deployment: 'tmux' });
    // "auto" is the template's permission_mode; a template change should change
    // this test's fixture expectation only via the template itself.
    expect(out).toMatch(/Permission mode.*auto.*\(default\)/);
    expect(out).toMatch(/Autonomy.*\(default\)/);
    expect(out).toMatch(/Budget caps.*\(default\)/);
  });

  test('heartbeat is folded into the untagged Routines row', () => {
    const out = renderConfirm({ deployment: 'tmux' });
    expect(out).toMatch(/Routines.*heartbeat every 30m, 08:00–23:00/);
  });

  test('cosmetic defaults are trimmed from the preview', () => {
    const out = renderConfirm({ deployment: 'tmux' });
    expect(out).not.toContain('Model / Effort');
    expect(out).not.toContain('Notifications');
    expect(out).not.toContain('Artifact pages');
  });

  test('a skipped agent name renders no Name row and never "undefined"', () => {
    const out = renderConfirm({ language: 'en', deployment: 'tmux' });
    expect(out).not.toContain('undefined');
    expect(out).not.toContain('Name');
  });

  test('CLI confirm reads the payload from stdin', async () => {
    const r = await runScript('hatch-report.ts', {
      args: ['confirm', '/tmp'],
      stdin: JSON.stringify({ agent_name: 'Scout', deployment: 'interactive' }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Scout');
  });

  test('CLI confirm rejects a non-JSON payload rather than rendering nonsense', async () => {
    const r = await runScript('hatch-report.ts', { args: ['confirm', '/tmp'], stdin: 'not json' });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: 'invalid_answers' });
  });
});
