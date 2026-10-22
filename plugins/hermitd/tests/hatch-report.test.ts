// hatch-report.ts: the data behind hatch's two operator-facing summaries.
//
// The load-bearing tests are the "declined step" ones: a report written by the
// model from its own memory of the run could claim a file was created that the
// operator had refused. `final` observes the filesystem, so a declined .gitignore
// append reports as absent without anyone having to remember.

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { observe, finalData, confirmData } from '../scripts/hatch-report';
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
  // The full shipped set: finalData reports any template bin script that is
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
  const clean = (out: any) => {
    const o = out.observed;
    return o.gitignore && o.worktreeinclude && !!o.permissions_file && o.missing_bin_scripts.length === 0;
  };

  test('a fully-completed hatch observes everything present and names the agent', () => {
    const root = hatched({ claudeTarget: 'CLAUDE.local.md', gitignore: true, worktreeinclude: true, settings: 'local', git: true });
    const out = finalData(observe(root), 'docker');
    expect(out.agent_name).toBe('Atlas');
    expect(out.observed).not.toHaveProperty('claude_block');
    expect(out.observed.permissions_file).toBe('.claude/settings.local.json');
    expect(clean(out)).toBe(true);
  });

  test('a workspace-backup .gitignore still reads as configured', () => {
    // Workspace-mode backup rewrites the hermit block into a marker line so state
    // can be committed. The marker keeps the `.hermit` substring on
    // purpose — without it this probe would report the gitignore as missing.
    const root = hatched({ claudeTarget: 'CLAUDE.local.md', worktreeinclude: true, settings: 'local', git: true });
    fs.writeFileSync(path.join(root, '.gitignore'),
      '# .hermit state is tracked here (backup: workspace mode)\n.claude.local/\n.env\n');
    expect(finalData(observe(root), 'interactive').observed.gitignore).toBe(true);
  });

  test('a declined .gitignore append reports as absent, never as created', () => {
    const root = hatched({ claudeTarget: 'CLAUDE.local.md', gitignore: false, worktreeinclude: true, settings: 'local' });
    expect(finalData(observe(root), 'interactive').observed.gitignore).toBe(false);
  });

  test('a declined .worktreeinclude reports as absent', () => {
    const root = hatched({ claudeTarget: 'CLAUDE.md', gitignore: true, worktreeinclude: false, settings: 'local' });
    expect(finalData(observe(root), 'tmux').observed.worktreeinclude).toBe(false);
  });

  test('a declined permissions merge reports no permissions file', () => {
    const root = hatched({ claudeTarget: 'CLAUDE.md', gitignore: true, worktreeinclude: true, settings: null });
    expect(finalData(observe(root), 'tmux').observed.permissions_file).toBeNull();
  });

  test('a partial bin scaffold names the missing scripts', () => {
    const root = hatched({ claudeTarget: 'CLAUDE.md', gitignore: true, worktreeinclude: true, settings: 'local' });
    fs.rmSync(path.join(root, '.hermit', 'bin', 'hermitd-run'));
    expect(finalData(observe(root), 'tmux').observed.missing_bin_scripts).toEqual(['hermitd-run']);
  });

  test('a skipped git init is not reported', () => {
    const root = hatched({ claudeTarget: 'CLAUDE.md', gitignore: true, worktreeinclude: true, settings: 'local', git: false });
    const out = finalData(observe(root), 'interactive');
    expect(clean(out)).toBe(true);
    expect(Object.keys(out.observed)).not.toContain('git_repo');
  });

  test('legacy CLAUDE blocks are not part of hatch completion', () => {
    const root = hatched({ claudeTarget: 'CLAUDE.md', gitignore: true, worktreeinclude: true, settings: 'local' });
    expect(finalData(observe(root), 'tmux').observed).not.toHaveProperty('claude_block');
  });

  test('an aborted hatch (no config.json) reports incomplete, not success', () => {
    const root = freshDir();
    fs.mkdirSync(path.join(root, '.hermit'), { recursive: true });
    expect(finalData(observe(root), 'docker')).toEqual({ status: 'incomplete', reason: 'config_missing' });
  });
});

describe('final next-steps keys off deployment', () => {
  const runs = (out: any) => out.next_steps.map((s: any) => s.run);
  const discord = { config: { channels: { discord: { enabled: true } } } };

  test('docker points at docker-setup, after the plugin reload', () => {
    const out = finalData(observe(hatched()), 'docker');
    expect(runs(out)).toEqual(['/reload-plugins', '/hermitd:docker-setup']);
    expect(out.running_after_step).toBe(2);
  });

  test('docker already set up (a re-init) restarts the container instead', () => {
    const root = hatched();
    fs.writeFileSync(path.join(root, 'docker-compose.hermit.yml'), 'services: {}\n');
    const out = finalData(observe(root), 'docker');
    expect(runs(out)).toEqual(['/reload-plugins', '!hermitd restart']);
    expect(out.running_after_step).toBe(2);
  });

  test('a docker re-init with a channel pairs it after the restart', () => {
    const root = hatched(discord);
    fs.writeFileSync(path.join(root, 'docker-compose.hermit.yml'), 'services: {}\n');
    const out = finalData(observe(root), 'docker');
    expect(runs(out)).toEqual(['/reload-plugins', '!hermitd restart', '/hermitd:channel-setup']);
    expect(out.running_after_step).toBe(2);
  });

  test('tmux points at the boot script, and is running before pairing', () => {
    const out = finalData(observe(hatched(discord)), 'tmux');
    expect(runs(out)).toEqual(['/reload-plugins', '!hermitd start', '/hermitd:channel-setup']);
    expect(out.running_after_step).toBe(2);
  });

  test('interactive points at resident-start', () => {
    const out = finalData(observe(hatched()), 'interactive');
    expect(runs(out)).toEqual(['/reload-plugins', '/hermitd:resident-start']);
    expect(out.running_after_step).toBe(2);
  });

  test('channel-setup appears only when a channel is configured', () => {
    expect(runs(finalData(observe(hatched()), 'interactive'))).not.toContain('/hermitd:channel-setup');
    const withChan = finalData(observe(hatched(discord)), 'interactive');
    expect(runs(withChan)).toEqual(['/reload-plugins', '/hermitd:channel-setup', '/hermitd:resident-start']);
    expect(withChan.running_after_step).toBe(3);
  });

  test('CLI rejects a deployment outside the enum', async () => {
    const r = await runScript('hatch-report.ts', { args: ['final', hatched(), '--deployment', 'kubernetes'] });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: 'invalid_deployment' });
  });

  test('CLI final exits 0 and prints one JSON object', async () => {
    const r = await runScript('hatch-report.ts', { args: ['final', hatched(), '--deployment', 'tmux'] });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.agent_name).toBe('Atlas');
    expect(out.next_steps.map((s: any) => s.run)).toContain('!hermitd start');
  });
});

describe('confirm previews intent, before anything is written', () => {
  test('carries the operator choices verbatim', () => {
    const { will_apply } = confirmData({
      agent_name: 'Atlas', language: 'pt', timezone: 'Europe/Lisbon',
      deployment: 'docker', channel: 'discord', hatch_target: 'local',
    });
    expect(will_apply).toMatchObject({
      agent_name: 'Atlas', language: 'pt', timezone: 'Europe/Lisbon',
      deployment: 'docker', channel: 'discord', hatch_target: 'local', safety_rules: 'standard',
    });
  });

  test('consequential defaults come from the shipped template, tagged as defaults', () => {
    const out = confirmData({ deployment: 'tmux' });
    // "auto" is the template's permission_mode; a template change should change
    // this test's fixture expectation only via the template itself.
    expect(out.will_apply.permission_mode).toBe('auto');
    expect(out.defaults).toEqual(expect.arrayContaining(['permission_mode', 'escalation', 'remote', 'budget']));
    // Every will_apply key not taken from the answers is a default, and only those.
    expect(out.defaults).not.toContain('deployment');
    expect(out.defaults.every((k: string) => k in out.will_apply)).toBe(true);
    expect(out.will_apply.budget.action).toBeDefined();
  });

  test('a non-default permission mode is not tagged as a default', () => {
    const out = confirmData({ deployment: 'tmux', permission_mode: 'acceptEdits' });
    expect(out.will_apply.permission_mode).toBe('acceptEdits');
    expect(out.defaults).not.toContain('permission_mode');
  });

  test('heartbeat folds into routines, and heartbeat-restart stays out', () => {
    const { routines } = confirmData({ deployment: 'tmux' }).will_apply;
    expect(routines.heartbeat).toEqual({ enabled: true, every: '30m', active_hours: { start: '08:00', end: '23:00' } });
    expect(routines.briefs).toEqual({ morning: '08:30', evening: '22:30' });
    expect(routines.others).not.toContain('heartbeat-restart');
  });

  test('cosmetic defaults are left out of the preview', () => {
    const { will_apply } = confirmData({ deployment: 'tmux' });
    for (const k of ['model', 'effort', 'push_notifications', 'artifacts']) expect(will_apply).not.toHaveProperty(k);
  });

  test('a skipped agent name carries no agent_name and never "undefined"', () => {
    const out = confirmData({ language: 'en', deployment: 'tmux' });
    expect(out.will_apply).not.toHaveProperty('agent_name');
    expect(JSON.stringify(out)).not.toContain('undefined');
  });

  test('CLI confirm reads the payload from stdin', async () => {
    const r = await runScript('hatch-report.ts', {
      args: ['confirm', '/tmp'],
      stdin: JSON.stringify({ agent_name: 'Scout', deployment: 'interactive' }),
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).will_apply.agent_name).toBe('Scout');
  });

  test('CLI confirm rejects a non-JSON payload rather than rendering nonsense', async () => {
    const r = await runScript('hatch-report.ts', { args: ['confirm', '/tmp'], stdin: 'not json' });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: 'invalid_answers' });
  });
});
