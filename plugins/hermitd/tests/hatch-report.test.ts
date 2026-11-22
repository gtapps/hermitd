// hatch-report.ts: the data behind hatch's final report.
//
// The load-bearing tests are the "declined step" ones: a report written by the
// model from its own memory of the run could claim a file was created that the
// operator had refused. `final` observes the filesystem, so a declined .gitignore
// append reports as absent without anyone having to remember.

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { observe as observeDisk, finalData } from '../scripts/hatch-report';
import { runScript as runScriptDisk } from './helpers/run';
import { readSeedPatterns } from '../scripts/lib/settings/seed-patterns';
import { freshDirFactory } from './helpers/workdir';

const observe = (root: string) => observeDisk(root, () => false);
const runScript: typeof runScriptDisk = (name, options = {}) => runScriptDisk(name, { ...options, env: { ...options.env, CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(freshDir(), 'cache') } });

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
    channels: {}, routines: [{ id: 'weekly-review', enabled: true }],
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
    expect(runs(out)).toEqual(['/reload-plugins', '!hermitd restart --fresh']);
    expect(out.running_after_step).toBe(2);
  });

  test('a docker re-init with a channel pairs it after the restart', () => {
    const root = hatched(discord);
    fs.writeFileSync(path.join(root, 'docker-compose.hermit.yml'), 'services: {}\n');
    const out = finalData(observe(root), 'docker');
    expect(runs(out)).toEqual(['/reload-plugins', '!hermitd restart --fresh', '/hermitd:channel-setup']);
    expect(out.running_after_step).toBe(2);
  });

  test('tmux with a channel starts and admits through channel-setup', () => {
    const out = finalData(observe(hatched(discord)), 'tmux');
    expect(runs(out)).toEqual(['/reload-plugins', '/hermitd:channel-setup start', 'hermitd run browser-host']);
    expect(out.next_steps[1].purpose).toBe('set_credential_start_and_admit');
    expect(out.running_after_step).toBe(2);
  });

  test('tmux without a channel points straight at the boot script', () => {
    const out = finalData(observe(hatched()), 'tmux');
    expect(runs(out)).toEqual(['/reload-plugins', '!hermitd start', 'hermitd run browser-host']);
    expect(out.running_after_step).toBe(2);
  });

  test('interactive points at resident-start', () => {
    const out = finalData(observe(hatched()), 'interactive');
    expect(runs(out)).toEqual(['/reload-plugins', '/hermitd:resident-start', 'hermitd run browser-host']);
    expect(out.running_after_step).toBe(2);
  });

  test('channel-setup appears only when a channel is configured', () => {
    expect(runs(finalData(observe(hatched()), 'interactive'))).not.toContain('/hermitd:channel-setup');
    const withChan = finalData(observe(hatched(discord)), 'interactive');
    expect(runs(withChan)).toEqual(['/reload-plugins', '/hermitd:channel-setup', '/hermitd:resident-start', 'hermitd run browser-host']);
    expect(withChan.running_after_step).toBe(3);
  });

  test('host browser setup is optional, and omitted when ready or using Docker', () => {
    const root = hatched();
    expect(finalData(observe(root), 'tmux').next_steps.at(-1)).toEqual({
      run: 'hermitd run browser-host', purpose: 'install_browser_prerequisites', optional: true, from: 'terminal',
    });
    expect(runs(finalData(observeDisk(root, () => true), 'tmux'))).not.toContain('hermitd run browser-host');
    expect(runs(finalData(observe(root), 'docker'))).not.toContain('hermitd run browser-host');
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

test('final reports transcription defaults and explicit opt-out', () => {
  expect(finalData(observe(hatched()), 'tmux').transcription).toEqual({ enabled: true, echo: true });
  expect(finalData(observe(hatched({ config: { transcription: { enabled: false } } })), 'docker').transcription.enabled).toBe(false);
});

test('CLI final --quick reports settings observed in the written files', async () => {
  const root = hatched({
    settings: 'committed',
    config: {
      permission_mode: 'acceptEdits',
      routines: [{ id: 'active', enabled: true }, { id: 'off', enabled: false }, { id: 'weekly-review', enabled: true }],
      heartbeat: { enabled: true, every: '45m' },
    },
  });
  const args = ['final', root, '--deployment', 'tmux'];
  const quick = await runScript('hatch-report.ts', { args: [...args, '--quick'] });
  expect(quick.exitCode).toBe(0);
  expect(JSON.parse(quick.stdout).defaults_applied).toEqual({
    permission_mode: 'acceptEdits', enabled_routines: ['active', 'weekly-review'],
    heartbeat_every: '45m', standard_deny_rules: false,
  });

  const { deny } = readSeedPatterns(path.resolve(import.meta.dir, '..'));
  fs.writeFileSync(path.join(root, '.claude/settings.json'), JSON.stringify({ permissions: { deny } }));
  const withDeny = await runScript('hatch-report.ts', { args: [...args, '--quick'] });
  expect(withDeny.exitCode).toBe(0);
  expect(JSON.parse(withDeny.stdout).defaults_applied.standard_deny_rules).toBe(true);

  const advanced = await runScript('hatch-report.ts', { args });
  expect(advanced.exitCode).toBe(0);
  expect(JSON.parse(advanced.stdout)).not.toHaveProperty('defaults_applied');
});
