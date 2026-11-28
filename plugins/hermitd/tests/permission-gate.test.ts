import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { APPROVAL_FAILURE, APPROVAL_TIMEOUT, APPROVAL_WORKER } from '../mod/approval-messages';
import { transcriptDirFor } from '../scripts/lib/cc-compat';
import { MAX_HOOK_STDIN } from '../scripts/lib/hook-input';
import { permissionGate } from '../scripts/permission-gate';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';

const { freshDir, cleanup } = freshDirFactory('permission-gate-');
afterAll(cleanup);
const resident = { session_id: 'resident' };

function fixture(mode: string, marker: string | null = mode) {
  const cwd = freshDir();
  const dir = path.join(cwd, '.hermit');
  const state = path.join(dir, 'state');
  const channel = path.join(cwd, 'channel');
  const config = path.join(cwd, 'claude');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(channel);
  fs.writeFileSync(path.join(channel, 'access.json'), JSON.stringify({ allowFrom: ['admin'] }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ approvals: mode,
    channels: { custom: { maintainer_channel_id: 'console', state_dir: channel } } }));
  fs.writeFileSync(path.join(state, 'runtime.json'), JSON.stringify({ cc_session_id: 'resident', config_dir: config }));
  if (marker !== null) fs.writeFileSync(path.join(state, 'harness-mod-loaded.json'),
    JSON.stringify({ ...resident, queue: 1, approvals: marker || undefined }));
  const transcripts = transcriptDirFor(cwd, config);
  fs.mkdirSync(transcripts, { recursive: true });
  function turn(kind: string, content: string) {
    fs.writeFileSync(path.join(transcripts, 'resident.jsonl'), JSON.stringify({ type: 'user', origin: { kind }, message: { content } }));
  }
  async function call(input: string | object, job = '') {
    const r = await runScript('permission-gate.ts', { cwd, env: { AGENT_DIR: dir, CLAUDE_JOB_DIR: job },
      stdin: typeof input === 'string' ? input : JSON.stringify(input) });
    expect(r.exitCode).toBe(0);
    return r.stdout ? JSON.parse(r.stdout) : undefined;
  }
  return { dir, turn, call };
}

function denied(message: string) {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } };
}

test('resident uses its loaded mode, including legacy markers', async () => {
  for (const marker of ['personal', '']) {
    expect(await fixture('team', marker).call({ ...resident, agent_id: 'child' })).toBeUndefined();
  }
});

test('typed resident and ordinary guest keep the prompt', async () => {
  const f = fixture('team');
  f.turn('human', 'typed');
  expect(await f.call(resident)).toBeUndefined();
  expect(await f.call({ session_id: 'guest' })).toBeUndefined();
});

test('background job without a marker and resident subagent are denied', async () => {
  expect(await fixture('team', null).call({ session_id: 'job' }, 'job-dir')).toEqual(denied(APPROVAL_WORKER));
  expect(await fixture('personal', 'team').call({ ...resident, agent_id: 'child' })).toEqual(denied(APPROVAL_WORKER));
});

test('paired maintainer prompt waits 60 seconds and a wait failure refuses', async () => {
  const f = fixture('team');
  f.turn('channel', '<channel source="custom" chat_id="console" user_id="admin">yes</channel>');
  const before = process.env.AGENT_DIR;
  process.env.AGENT_DIR = f.dir;
  try {
    const waits: number[] = [];
    expect(await permissionGate(resident, f.dir, async ms => { waits.push(ms); })).toEqual(denied(APPROVAL_TIMEOUT));
    expect(waits).toEqual([60_000]);
    expect(await permissionGate(resident, f.dir, async () => { throw new Error('wait failed'); })).toEqual(denied(APPROVAL_FAILURE));
  } finally {
    if (before === undefined) delete process.env.AGENT_DIR;
    else process.env.AGENT_DIR = before;
  }
});

for (const mode of ['team', 'personal']) {
  test(`malformed and oversized input use ${mode} config`, async () => {
    const f = fixture(mode);
    for (const input of ['{', JSON.stringify({ data: 'a'.repeat(MAX_HOOK_STDIN) })]) {
      expect(await f.call(input)).toEqual(mode === 'team' ? denied(APPROVAL_FAILURE) : undefined);
    }
  });
}
