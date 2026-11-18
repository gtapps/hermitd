import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { actSurfaceLine } from '../scripts/lib/act-surface';
import { runScript } from './helpers/run';

const maintained = { discord: { maintainer_channel_id: '900' } };

for (const [label, config, reachable, expected] of [
  ['technical keeps the default', { operator_profile: 'technical', channels: maintained }, true, null],
  ['non-technical with a maintainer chat, app unreachable', { operator_profile: 'non-technical', channels: maintained }, false, 'provider (maintainer chat discord:900)'],
  ['non-technical with a maintainer chat, app reachable', { operator_profile: 'non-technical', channels: maintained }, true, 'provider (maintainer chat discord:900)'],
  ['a disabled maintainer channel does not count', { operator_profile: 'non-technical', channels: { discord: { enabled: false, maintainer_channel_id: '900' } } }, false, null],
  ['non-technical, no maintainer chat, app reachable', { operator_profile: 'non-technical', channels: {} }, true, 'claude_app'],
  ['non-technical with no channel at all', { operator_profile: 'non-technical' }, true, 'claude_app'],
  ['non-technical, no maintainer chat, app unreachable', { operator_profile: 'non-technical', channels: {} }, false, null],
] as const) {
  test(`act surface: ${label}`, () => {
    const line = actSurfaceLine(config, () => reachable);
    if (expected === null) expect(line).toBeNull();
    else expect(line).toStartWith(`act_surface: ${expected}`);
  });
}

test('startup context carries the act surface line on a reachable non-technical install only', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'act-surface-'));
  try {
    const hermit = path.join(dir, '.hermit');
    fs.mkdirSync(hermit);
    const write = (config: object) => fs.writeFileSync(path.join(hermit, 'config.json'), JSON.stringify(config));
    const env = { HERMIT_RESIDENT: '1', CLAUDE_CONFIG_DIR: path.join(dir, 'cc'), ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_USE_BEDROCK: '', CLAUDE_CODE_USE_VERTEX: '', CLAUDE_CODE_USE_FOUNDRY: '' };
    const run = (source: string) => runScript('startup-context.ts', { cwd: dir, env, stdin: JSON.stringify({ source, session_id: 'resident' }) });

    // Remote Control starts only when config.json sets `remote`, and only on a claude.ai sign-in.
    for (const unreachable of [{ auth_mode: 'login' }, { auth_mode: 'token', remote: true }]) {
      write({ operator_profile: 'non-technical', channels: {}, ...unreachable, _hermit_versions: { hermitd: '0.0.1' } });
      expect((await run('startup')).stdout).not.toContain('act_surface');
    }

    write({ operator_profile: 'non-technical', auth_mode: 'login', remote: true, channels: {}, _hermit_versions: { hermitd: '0.0.1' } });
    const full = await run('startup');
    expect(full.exitCode).toBe(0);
    expect(full.stdout).toContain('---Operator Preferences---\nact_surface: claude_app');
    expect((await run('compact')).stdout).toContain('act_surface: claude_app');

    write({ operator_profile: 'technical', auth_mode: 'login', remote: true, _hermit_versions: { hermitd: '0.0.1' } });
    expect((await run('startup')).stdout).not.toContain('act_surface');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
