import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  parseHarnessCommand,
  writePendingCommand,
  readPendingCommand,
  clearPendingCommand,
  renderCommand,
  writeSwitchVerify,
  readSwitchVerify,
  clearSwitchVerify,
  COMMAND_MARKER_TTL_SECS,
  SWITCH_VERIFY_TTL_SECS,
  normalizePermissionMode,
  permissionModeRefusal,
  writeSkillRelay,
  readSkillRelay,
  clearSkillRelay,
  SKILL_RELAY_TTL_SECS,
} from '../scripts/lib/harness-command';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cmd-'));
}

describe('parseHarnessCommand grammar', () => {
  test('accepts the six bare/arg forms', () => {
    expect(parseHarnessCommand('/clear')).toEqual({ command: '/clear', arg: null });
    expect(parseHarnessCommand('/compact')).toEqual({ command: '/compact', arg: null });
    expect(parseHarnessCommand('/model opus')).toEqual({ command: '/model', arg: 'opus' });
    expect(parseHarnessCommand('/effort high')).toEqual({ command: '/effort', arg: 'high' });
    expect(parseHarnessCommand('/permission-mode plan')).toEqual({
      command: '/permission-mode',
      arg: 'plan',
    });
    expect(parseHarnessCommand('/advisor opus')).toEqual({ command: '/advisor', arg: 'opus' });
  });

  // The whole point of dropping the tier list: a new model must not need a code change.
  test('accepts arbitrary future model names and effort levels', () => {
    expect(parseHarnessCommand('/model fable')).toEqual({ command: '/model', arg: 'fable' });
    expect(parseHarnessCommand('/effort ultracode')).toEqual({ command: '/effort', arg: 'ultracode' });
  });

  // Same grammar as /model: no advisor value list, so a new advisor alias (or CC's own
  // "off" to clear the selection) never needs a code change here.
  test('accepts advisor aliases including off, without a value list', () => {
    expect(parseHarnessCommand('/advisor fable')).toEqual({ command: '/advisor', arg: 'fable' });
    expect(parseHarnessCommand('/advisor sonnet')).toEqual({ command: '/advisor', arg: 'sonnet' });
    expect(parseHarnessCommand('/advisor off')).toEqual({ command: '/advisor', arg: 'off' });
    expect(parseHarnessCommand('/advisor claude-opus-5')).toEqual({
      command: '/advisor',
      arg: 'claude-opus-5',
    });
  });

  // Bracketed aliases are real (this repo's own sessions run claude-opus-5[1m]).
  test('accepts bracketed model aliases', () => {
    expect(parseHarnessCommand('/model opus[1m]')).toEqual({ command: '/model', arg: 'opus[1m]' });
    expect(parseHarnessCommand('/model claude-opus-5[1m]')).toEqual({
      command: '/model',
      arg: 'claude-opus-5[1m]',
    });
  });

  test('rejects an arg-command with no arg, and a bare-command with one', () => {
    expect(parseHarnessCommand('/model')).toBeNull();
    expect(parseHarnessCommand('/effort')).toBeNull();
    expect(parseHarnessCommand('/clear now')).toBeNull();
    expect(parseHarnessCommand('/compact everything')).toBeNull();
    // A bare /advisor opens Claude Code's interactive picker — a real blocking dialog
    // (CC 2.1.240, probe-verified) nobody unattended could answer. Must stay null.
    expect(parseHarnessCommand('/advisor')).toBeNull();
    expect(parseHarnessCommand('/advisor opus sonnet')).toBeNull();
  });

  test('rejects bare words — strict slash grammar', () => {
    expect(parseHarnessCommand('clear')).toBeNull();
    expect(parseHarnessCommand('compact')).toBeNull();
    expect(parseHarnessCommand('model opus')).toBeNull();
  });

  test('rejects prose that merely mentions a command', () => {
    expect(parseHarnessCommand('please /clear the context')).toBeNull();
    expect(parseHarnessCommand('can you /model opus for me')).toBeNull();
  });

  // These are the ones that would reach a live pane. A newline would submit early and
  // turn the remainder into its own prompt.
  test('rejects injection-shaped args', () => {
    expect(parseHarnessCommand('/model opus\n/clear')).toBeNull();
    expect(parseHarnessCommand('/model opus /clear')).toBeNull();
    expect(parseHarnessCommand('/model `whoami`')).toBeNull();
    expect(parseHarnessCommand('/model opus;ls')).toBeNull();
    expect(parseHarnessCommand('/model $(id)')).toBeNull();
    expect(parseHarnessCommand(`/model ${'a'.repeat(65)}`)).toBeNull();
    expect(parseHarnessCommand('/advisor opus\n/clear')).toBeNull();
    expect(parseHarnessCommand('/advisor `whoami`')).toBeNull();
    expect(parseHarnessCommand('/advisor $(id)')).toBeNull();
  });

  test('rejects unknown slash commands', () => {
    expect(parseHarnessCommand('/exit')).toBeNull();
    expect(parseHarnessCommand('/login')).toBeNull();
    expect(parseHarnessCommand('/hermitd:brief')).toBeNull();
  });

  test('accepts doctor and checkup as the canonical bare doctor command', () => {
    expect(parseHarnessCommand('/doctor')).toEqual({ command: '/doctor', arg: null });
    expect(parseHarnessCommand('/checkup')).toEqual({ command: '/doctor', arg: null });
    expect(parseHarnessCommand('/doctor now')).toBeNull();
  });

  // /code-review is model-invocable, so it is NOT relayed: it falls through to the model
  // as an ordinary chat message and runs through the Skill tool. A null here is the
  // contract, not an oversight — re-adding a branch would silently restore the relay.
  test('code-review falls through to the model instead of being relayed', () => {
    expect(parseHarnessCommand('/code-review')).toBeNull();
    expect(parseHarnessCommand('/code-review low')).toBeNull();
    expect(parseHarnessCommand('/review low')).toBeNull();
    expect(parseHarnessCommand('/code-review ultra')).toBeNull();
    expect(parseHarnessCommand('/code-review low --post')).toBeNull();
  });

  // Splitting on a literal ' ' made padding whitespace a parse failure, and a parse
  // failure is a fallthrough to the model rather than a refusal.
  test('padding whitespace does not slip a token past the grammar', () => {
    expect(parseHarnessCommand('/model  sonnet')).toEqual({ command: '/model', arg: 'sonnet' });
    expect(parseHarnessCommand('/model\tsonnet')).toEqual({ command: '/model', arg: 'sonnet' });
    // A mobile keyboard's non-breaking space is padding too, not a token.
    expect(parseHarnessCommand('/model\u00a0sonnet')).toEqual({ command: '/model', arg: 'sonnet' });
    expect(parseHarnessCommand('/doctor  ')).toEqual({ command: '/doctor', arg: null });
    // Still exactly-two-token for /advisor: a bare one must never reach the picker.
    expect(parseHarnessCommand('/advisor   ')).toBeNull();
  });
});

describe('permission-mode targets', () => {
  test('normalises the spellings an operator actually types', () => {
    expect(normalizePermissionMode('acceptEdits')).toBe('acceptEdits');
    expect(normalizePermissionMode('accept-edits')).toBe('acceptEdits');
    expect(normalizePermissionMode('ACCEPTEDITS')).toBe('acceptEdits');
    expect(normalizePermissionMode('auto')).toBe('auto');
    // The status bar calls `default` "manual mode", so operators do too.
    expect(normalizePermissionMode('manual')).toBe('default');
    expect(normalizePermissionMode('nonsense')).toBeNull();
  });

  test('allows only the three recoverable modes', () => {
    expect(permissionModeRefusal('default')).toBeNull();
    expect(permissionModeRefusal('acceptEdits')).toBeNull();
    expect(permissionModeRefusal('auto')).toBeNull();
  });

  // plan mode would take the channel down with it: replies are refused and an
  // unanswerable approval prompt can wedge the turn that delivery depends on.
  test('refuses plan, and says why in terms the operator can act on', () => {
    const refusal = permissionModeRefusal('plan');
    expect(refusal).toContain('replying');
    expect(refusal).toContain('default');
  });

  test('refuses privilege escalation and modes outside the cycle', () => {
    expect(permissionModeRefusal('bypassPermissions')).toContain('terminal');
    expect(permissionModeRefusal('dontAsk')).toContain('not reachable mid-session');
    expect(permissionModeRefusal('sudo')).toContain('not a permission mode');
  });
});

describe('pending-command marker', () => {
  test('does not read native commands from the Stop marker', () => {
    const root = tmpRoot();
    for (const command of ['/model', '/effort', '/compact', '/clear', '/advisor']) {
      writePendingCommand(root, { command, arg: null, by: 'op', requested_at: new Date().toISOString() });
      expect(readPendingCommand(root)).toBeNull();
    }
    fs.rmSync(root, { recursive: true });
  });

  test('round-trips and renders', () => {
    const root = tmpRoot();
    const entry = { command: '/permission-mode', arg: 'auto', by: 'op', requested_at: new Date().toISOString() };
    expect(writePendingCommand(root, entry)).toBe(true);
    expect(readPendingCommand(root)).toEqual(entry);
    expect(renderCommand(entry)).toBe('/permission-mode auto');
    fs.rmSync(root, { recursive: true });
  });

  test('renders a bare command without a trailing space', () => {
    expect(renderCommand({ command: '/clear', arg: null })).toBe('/clear');
  });

  test('absent marker reads as null', () => {
    const root = tmpRoot();
    expect(readPendingCommand(root)).toBeNull();
    fs.rmSync(root, { recursive: true });
  });

  test('marker past its TTL is ignored — a request is a moment, not a standing order', () => {
    const root = tmpRoot();
    const stale = new Date(Date.now() - (COMMAND_MARKER_TTL_SECS + 60) * 1000).toISOString();
    writePendingCommand(root, { command: '/permission-mode', arg: 'auto', by: 'op', requested_at: stale });
    expect(readPendingCommand(root)).toBeNull();
    fs.rmSync(root, { recursive: true });
  });

  test('malformed marker reads as null rather than throwing', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'state'), { recursive: true });
    fs.writeFileSync(path.join(root, 'state', 'pending-harness-command.json'), '{not json');
    expect(readPendingCommand(root)).toBeNull();
    fs.rmSync(root, { recursive: true });
  });

  test('clear removes it', () => {
    const root = tmpRoot();
    writePendingCommand(root, { command: '/permission-mode', arg: 'auto', by: 'op', requested_at: new Date().toISOString() });
    expect(readPendingCommand(root)).not.toBeNull();
    clearPendingCommand(root);
    expect(readPendingCommand(root)).toBeNull();
    fs.rmSync(root, { recursive: true });
  });
});

describe('switch-verify marker', () => {
  const verifyPath = (root: string) => path.join(root, 'state', 'harness-switch-verify.json');

  test('round-trips a delivered switch', () => {
    const root = tmpRoot();
    const entry = {
      command: '/model',
      arg: 'fable',
      by: 'op',
      delivered_at: new Date().toISOString(),
    };
    expect(writeSwitchVerify(root, entry)).toBe(true);
    expect(readSwitchVerify(root)).toEqual(entry);
    fs.rmSync(root, { recursive: true });
  });

  test('absent marker reads as null', () => {
    const root = tmpRoot();
    expect(readSwitchVerify(root)).toBeNull();
    fs.rmSync(root, { recursive: true });
  });

  test('malformed marker reads as null rather than throwing', () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, 'state'), { recursive: true });
    fs.writeFileSync(verifyPath(root), '{not json');
    expect(readSwitchVerify(root)).toBeNull();
    fs.rmSync(root, { recursive: true });
  });

  // Nothing else consumes this file, so an expired one must not linger on disk.
  test('marker past its TTL reads as null AND is deleted', () => {
    const root = tmpRoot();
    const stale = new Date(Date.now() - (SWITCH_VERIFY_TTL_SECS + 60) * 1000).toISOString();
    writeSwitchVerify(root, { command: '/model', arg: 'fable', by: 'op', delivered_at: stale });
    expect(readSwitchVerify(root)).toBeNull();
    expect(fs.existsSync(verifyPath(root))).toBe(false);
    fs.rmSync(root, { recursive: true });
  });

  // The verify marker outlives the 1h delivery TTL on purpose: it records a fact to
  // observe, and expiring it while the session idled reproduced the stale-answer bug.
  test('marker older than the delivery TTL but within its own TTL still reads', () => {
    const root = tmpRoot();
    const overnight = new Date(Date.now() - (COMMAND_MARKER_TTL_SECS + 3600) * 1000).toISOString();
    writeSwitchVerify(root, { command: '/model', arg: 'fable', by: 'op', delivered_at: overnight });
    expect(readSwitchVerify(root)?.arg).toBe('fable');
    fs.rmSync(root, { recursive: true });
  });

  test('clear removes it', () => {
    const root = tmpRoot();
    writeSwitchVerify(root, {
      command: '/effort',
      arg: 'high',
      by: 'op',
      delivered_at: new Date().toISOString(),
    });
    clearSwitchVerify(root);
    expect(readSwitchVerify(root)).toBeNull();
    fs.rmSync(root, { recursive: true });
  });

  // Singleton, matching the pending marker: two switches collapse to the last.
  test('a second switch overwrites the first', () => {
    const root = tmpRoot();
    const now = new Date().toISOString();
    writeSwitchVerify(root, { command: '/model', arg: 'fable', by: 'op', delivered_at: now });
    writeSwitchVerify(root, { command: '/model', arg: 'opus', by: 'op', delivered_at: now });
    expect(readSwitchVerify(root)?.arg).toBe('opus');
    fs.rmSync(root, { recursive: true });
  });
});

describe('skill-relay marker', () => {
  const relayPath = (root: string) => path.join(root, 'state', 'pending-skill-relay.json');

  test('round-trips a delivered skill command', () => {
    const root = tmpRoot();
    const entry = {
      command: '/doctor',
      arg: null,
      by: 'op',
      reply_to: { source: 'discord', chat_id: 'chat-456' },
      delivered_at: new Date().toISOString(),
    };
    expect(writeSkillRelay(root, entry)).toBe(true);
    expect(readSkillRelay(root)).toEqual(entry);
    clearSkillRelay(root);
    expect(readSkillRelay(root)).toBeNull();
    fs.rmSync(root, { recursive: true });
  });

  test('an expired relay reads as null and is deleted', () => {
    const root = tmpRoot();
    const stale = new Date(Date.now() - (SKILL_RELAY_TTL_SECS + 60) * 1000).toISOString();
    writeSkillRelay(root, {
      command: '/doctor',
      arg: null,
      by: 'op',
      reply_to: { source: 'telegram', chat_id: 'chat-123' },
      delivered_at: stale,
    });
    expect(readSkillRelay(root)).toBeNull();
    expect(fs.existsSync(relayPath(root))).toBe(false);
    fs.rmSync(root, { recursive: true });
  });
});
