import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { actSurfaceLine } from '../scripts/lib/act-surface';
import { runScript } from './helpers/run';

const maintained = { discord: { maintainer_channel_id: '900' } };

for (const [label, config, auth, expected] of [
  ['technical keeps the default', { operator_profile: 'technical', channels: maintained }, 'login', null],
  ['non-technical with a maintainer chat on a token', { operator_profile: 'non-technical', channels: maintained }, 'token', 'provider (maintainer chat discord:900)'],
  ['non-technical with a maintainer chat on a login', { operator_profile: 'non-technical', channels: maintained }, 'login', 'provider (maintainer chat discord:900)'],
  ['a disabled maintainer channel does not count', { operator_profile: 'non-technical', channels: { discord: { enabled: false, maintainer_channel_id: '900' } } }, 'token', null],
  ['non-technical login with no maintainer chat', { operator_profile: 'non-technical', channels: {} }, 'login', 'claude_app'],
  ['non-technical with no channel at all', { operator_profile: 'non-technical' }, 'login', 'claude_app'],
  ['non-technical login with remote off', { operator_profile: 'non-technical', remote: false }, 'login', null],
  ['non-technical token with no maintainer chat', { operator_profile: 'non-technical', channels: {} }, 'token', null],
  ['non-technical env credential', { operator_profile: 'non-technical' }, 'external', null],
] as const) {
  test(`act surface: ${label}`, () => {
    const line = actSurfaceLine(config, () => auth);
    if (expected === null) expect(line).toBeNull();
    else expect(line).toStartWith(`act_surface: ${expected}`);
  });
}

test('startup context carries the act surface line and points the upgrade notice at it', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'act-surface-'));
  try {
    const hermit = path.join(dir, '.hermit');
    fs.mkdirSync(hermit);
    const write = (config: object) => fs.writeFileSync(path.join(hermit, 'config.json'), JSON.stringify(config));
    const env = { HERMIT_RESIDENT: '1', CLAUDE_CONFIG_DIR: path.join(dir, 'cc'), ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' };
    const run = (source: string) => runScript('startup-context.ts', { cwd: dir, env, stdin: JSON.stringify({ source, session_id: 'resident' }) });

    write({ operator_profile: 'non-technical', auth_mode: 'login', channels: {}, _hermit_versions: { hermitd: '0.0.1' } });
    const full = await run('startup');
    expect(full.exitCode).toBe(0);
    expect(full.stdout).toContain('---Operator Preferences---\nact_surface: claude_app');
    expect(full.stdout).toContain('/hermitd:hermit-evolve, worded per act_surface.');
    expect((await run('compact')).stdout).toContain('act_surface: claude_app');

    write({ operator_profile: 'technical', auth_mode: 'login', _hermit_versions: { hermitd: '0.0.1' } });
    const technical = await run('startup');
    expect(technical.stdout).not.toContain('act_surface');
    expect(technical.stdout).toContain('/hermitd:hermit-evolve in a terminal or the Claude app.');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
