// Contract tests for scripts/stop-failure-stamp.ts, the StopFailure hook that
// records CC's typed failure category for the watchdog to classify from.
// Exercised as a subprocess (stdin in, state file + exit code out), the same
// boundary Claude Code sees. The hook records only: every case exits 0 with
// empty stdout, and nothing is sent anywhere.

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { runScript } from './helpers/run';
import { withDir } from './helpers/workdir';
import { markGuest } from '../scripts/lib/guest-marker';

const stateFile = (dir: string) => path.join(dir, '.hermit', 'state', 'stop-failure.json');
const readStamp = (dir: string) => JSON.parse(fs.readFileSync(stateFile(dir), 'utf8'));

// Captured live (tmux probe, CC 2.1.261). The key is `error`, not the `error_type`
// the docs list, and `error_details` is absent — both pinned here on purpose.
const STOP_FAILURE_PAYLOAD = {
  hook_event_name: 'StopFailure',
  error: 'model_not_found',
  session_id: '63d3ccda-cd07-4fd0-a88c-e56ac4ca311a',
  last_assistant_message: "There's an issue with the selected model (not-a-real-model-xyz). It may not exist or you may not have access to it. Run /model to pick a different model.",
};

const run = (dir: string, stdin: string) =>
  runScript('stop-failure-stamp.ts', { stdin, cwd: dir });

describe('stop-failure-stamp', () => {
  test('a resident session stamps exactly the four contract fields', withDir(async (dir) => {
    const r = await run(dir, JSON.stringify(STOP_FAILURE_PAYLOAD));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');

    const stamp = readStamp(dir);
    expect(Object.keys(stamp).sort()).toEqual(['at', 'error', 'last_assistant_message', 'session_id']);
    expect(stamp.error).toBe('model_not_found');
    expect(stamp.session_id).toBe(STOP_FAILURE_PAYLOAD.session_id);
    expect(stamp.last_assistant_message).toBe(STOP_FAILURE_PAYLOAD.last_assistant_message);
    // The watchdog compares this against the newest transcript record, so it has
    // to parse — localISOStamp's offset has no colon, which Date.parse still takes.
    expect(Number.isNaN(Date.parse(stamp.at))).toBe(false);
  }));

  // Residency gate: one hermit folder, one writer. A guest stamping here would
  // hand the watchdog a failure from a session it does not supervise.
  test('a guest session writes nothing', withDir(async (dir) => {
    markGuest(path.join(dir, '.hermit', 'state'), STOP_FAILURE_PAYLOAD.session_id);

    const r = await run(dir, JSON.stringify(STOP_FAILURE_PAYLOAD));
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(stateFile(dir))).toBe(false);
  }));

  // A subagent's failure carries the parent's session_id plus its own agent_id (probed
  // on CC 2.1.323). It must not stamp the resident or mark its in-flight turn idle.
  test('a subagent failure leaves the stamp and the execution state alone', withDir(async (dir) => {
    const stateDir = path.join(dir, '.hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const execution = JSON.stringify({ state: 'in_flight', turn_id: 't1', cc_session_id: STOP_FAILURE_PAYLOAD.session_id }) + '\n';
    fs.writeFileSync(path.join(stateDir, 'execution.json'), execution);

    const r = await run(dir, JSON.stringify({ ...STOP_FAILURE_PAYLOAD, agent_id: 'afa1815e2f1379a86', agent_type: 'probeagent' }));
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(stateFile(dir))).toBe(false);
    expect(fs.readFileSync(path.join(stateDir, 'execution.json'), 'utf8')).toBe(execution);
  }));

  // `agent_type` alone also appears on main-session hooks under `--agent`.
  test('agent_type without an agent_id, or an empty agent_id, still stamps', withDir(async (dir) => {
    for (const extra of [{ agent_type: 'main-agent' }, { agent_id: '' }]) {
      fs.rmSync(stateFile(dir), { force: true });
      const r = await run(dir, JSON.stringify({ ...STOP_FAILURE_PAYLOAD, ...extra }));
      expect(r.exitCode).toBe(0);
      expect(readStamp(dir).session_id).toBe(STOP_FAILURE_PAYLOAD.session_id);
    }
  }));

  test('the message is bounded at 300 characters', withDir(async (dir) => {
    const long = 'x'.repeat(500);
    const r = await run(dir, JSON.stringify({ ...STOP_FAILURE_PAYLOAD, last_assistant_message: long }));
    expect(r.exitCode).toBe(0);
    expect(readStamp(dir).last_assistant_message).toBe('x'.repeat(300));
  }));

  test('a payload without a message stamps null rather than dropping the field', withDir(async (dir) => {
    const { last_assistant_message, ...rest } = STOP_FAILURE_PAYLOAD;
    const r = await run(dir, JSON.stringify(rest));
    expect(r.exitCode).toBe(0);
    expect(readStamp(dir).last_assistant_message).toBeNull();
  }));

  // These scripts are reachable through the wildcarded `bun */scripts/*.ts*` grant,
  // so a payload that isn't a genuine StopFailure must not manufacture an outage the
  // watchdog then notifies the operator about.
  test('a payload that is not a StopFailure event writes nothing', withDir(async (dir) => {
    const r = await run(dir, JSON.stringify({ ...STOP_FAILURE_PAYLOAD, hook_event_name: 'Stop' }));
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(stateFile(dir))).toBe(false);
  }));

  test('malformed stdin writes nothing and still exits 0', withDir(async (dir) => {
    const r = await run(dir, '{broken');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(stateFile(dir))).toBe(false);
  }));

  test('empty stdin writes nothing and still exits 0', withDir(async (dir) => {
    const r = await run(dir, '');
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(stateFile(dir))).toBe(false);
  }));
});
