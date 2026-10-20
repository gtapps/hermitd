import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScript, SCRIPTS_DIR } from './helpers/run';

const hermit = (dir: string, ...parts: string[]) => path.join(dir, '.hermit', ...parts);
function withTmp(fn: (dir: string) => Promise<void>) {
  return async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-monitor-emissions-')));
    fs.mkdirSync(hermit(dir, 'state'), { recursive: true });
    try { await fn(dir); } finally { fs.rmSync(dir, { recursive: true }); }
  };
}

// -------------------------------------------------------
// monitor-emission drift guard: every scheduler notification string emitted by
// heartbeat-monitor.sh / routine-monitor.sh / routine-due.ts must be dropped by
// record-operator-action.ts's isRoutinePrompt. Prevents a future emission-grammar
// rename from making scheduler activity look like operator activity.
// -------------------------------------------------------

describe('record-operator-action: monitor emission strings stay in sync', () => {
  function extractEchoLiterals(file: string): string[] {
    const src = fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf-8');
    const literals: string[] = [];
    for (const m of src.matchAll(/echo "((?:HEARTBEAT|ROUTINE)_[A-Z_]+[^"]*)"/g)) {
      literals.push(m[1].replace(/\$\{[^}]*\}|\$[a-zA-Z_]+/g, 'x'));
    }
    return literals;
  }

  // The watchdog posts its wedge wake straight onto the session's inbox socket
  // rather than typing it, so the body is a TS constant, not a shell echo. Same
  // contract as the emitters: renaming it without teaching isRoutinePrompt would
  // make every socket wake read as operator activity.
  function extractWedgeWakeToken(): string {
    const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'hermitd-watchdog.ts'), 'utf-8');
    const m = src.match(/const WEDGE_WAKE_TOKEN = '([^']+)'/);
    if (!m) throw new Error('WEDGE_WAKE_TOKEN not found in hermitd-watchdog.ts');
    return m[1];
  }

  const literals = [
    ...extractEchoLiterals('heartbeat-monitor.sh'),
    ...extractEchoLiterals('routine-monitor.sh'),
    extractWedgeWakeToken(),
    'WATCH_EVENT [hermit-watch:sample] (Sample watch) line',
    'WATCH_MONITOR_ERROR: sample exit code 1',
  ];

  // The wake is only useful if the model's routing rule recognizes it, and that
  // rule is written against the monitor's own token — so the two must be the
  // same string, not merely both droppable.
  test('the watchdog socket wake reuses a heartbeat-monitor emission verbatim', () => {
    expect(extractEchoLiterals('heartbeat-monitor.sh')).toContain(extractWedgeWakeToken());
  });

  test('sweep finds the known monitor emission literals', () => {
    expect(literals.length).toBeGreaterThanOrEqual(4); // EVALUATE, 2x ERROR variants, MONITOR_ERROR
  });

  // routine-due.ts builds its line from a template literal rather than a bare echo —
  // assert the grammar anchor is still present in source.
  test('routine-due.ts still emits the ROUTINE_DUE [hermit-routine: grammar', () => {
    const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'lib', 'routines', 'due.ts'), 'utf-8');
    expect(src).toContain('ROUTINE_DUE ');
    expect(src).toContain('[hermit-routine:');
  });

  test('watch poller keeps both emission grammar anchors', () => {
    const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'watch-monitor.ts'), 'utf-8');
    expect(src).toContain('WATCH_EVENT [hermit-watch:');
    expect(src).toContain('WATCH_MONITOR_ERROR: ');
  });

  for (const literal of [...new Set([...literals, 'ROUTINE_DUE [hermit-routine:x]'])]) {
    test(`monitor emission "${literal}" is dropped by record-operator-action.ts`, withTmp(async (dir) => {
      const r = await runScript('record-operator-action.ts', {
        stdin: JSON.stringify({ prompt: literal }),
        cwd: dir,
      });
      expect(r.exitCode).toBe(0);
      expect(fs.existsSync(hermit(dir, 'state', 'last-operator-action.json'))).toBe(false);
    }));
  }

  // Delivery-shape matrix. The emitters above are correct and always were — what
  // broke in production was the ENVELOPE the harness wraps them in before the
  // prompt reaches this hook. Captured live 2026-08-19 on CC 2.1.235; a guard that
  // only feeds bare literals is structurally blind to that class of drift.
  const envelope = (event: string) =>
    `<task-notification>\n<task-id>bc568nhi2</task-id>\n<summary>Monitor event: "routine-monitor"</summary>\n<event>${event}</event>\nIf this event is something the user would act on now, send a PushNotification.\n</task-notification>`;

  for (const literal of [...new Set([...literals, 'ROUTINE_DUE [hermit-routine:x]'])]) {
    test(`task-notification-wrapped "${literal}" is dropped by record-operator-action.ts`, withTmp(async (dir) => {
      const r = await runScript('record-operator-action.ts', {
        stdin: JSON.stringify({ prompt: envelope(literal) }),
        cwd: dir,
      });
      expect(r.exitCode).toBe(0);
      expect(fs.existsSync(hermit(dir, 'state', 'last-operator-action.json'))).toBe(false);
    }));
  }

  // Subagent / background-task completions carry NO hermit sentinel at all, so the
  // emitter-derived list above can never cover them. This is the second half of the
  // production bug: such a completion stamped the operator clock 40ms after arriving.
  test('subagent-completion notification (no hermit grammar) is dropped', withTmp(async (dir) => {
    const prompt = '<task-notification>\n<task-id>a22f60f</task-id>\n<tool-use-id>toolu_abc</tool-use-id>\n<status>completed</status>\n<summary>Agent "reflect routine" came to rest</summary>\n</task-notification>';
    const r = await runScript('record-operator-action.ts', { stdin: JSON.stringify({ prompt }), cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(hermit(dir, 'state', 'last-operator-action.json'))).toBe(false);
  }));

  // The envelope rule is anchored, NOT containment, and the sentinel rules stay
  // anchored too. A real operator asking about a sentinel is an operator: dropping
  // their prompt would suppress real operator activity. Deliberate
  // trade — see the comment block in record-operator-action.ts.
  test('operator prose quoting a sentinel still counts as operator activity', withTmp(async (dir) => {
    const prompt = 'why did ROUTINE_DUE [hermit-routine:reflect] fire twice last night?';
    const r = await runScript('record-operator-action.ts', { stdin: JSON.stringify({ prompt }), cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(hermit(dir, 'state', 'last-operator-action.json'))).toBe(true);
  }));

  for (const token of ['WATCH_EVENT [hermit-watch:sample]', 'WATCH_MONITOR_ERROR: sample']) {
    test(`operator prose quoting ${token} counts as activity`, withTmp(async dir => {
      await runScript('record-operator-action.ts', { stdin: JSON.stringify({ prompt: `why did ${token} appear?` }), cwd: dir });
      expect(fs.existsSync(hermit(dir, 'state', 'last-operator-action.json'))).toBe(true);
    }));
  }

  test('operator prose mentioning task-notification still counts as operator activity', withTmp(async (dir) => {
    const prompt = 'the task-notification envelope is what broke the filter — can you explain it?';
    const r = await runScript('record-operator-action.ts', { stdin: JSON.stringify({ prompt }), cwd: dir });
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(hermit(dir, 'state', 'last-operator-action.json'))).toBe(true);
  }));
});

