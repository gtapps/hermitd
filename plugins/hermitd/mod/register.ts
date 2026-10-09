import type { EngineInterface, Register } from 'claude-code';

type Command = { command: string; arg: string | null };
type Outcome = Command & { status: 'ok' | 'failed' | 'unknown'; text: string };
type Request = {
  commands: Command[];
  by?: string;
  reply_to?: { source: string; chat_id: string };
  requested_at?: string;
};
type Decision = Request & {
  decision: 'pass' | 'run' | 'refuse' | 'ok' | 'send_failed';
  reason?: string;
  text?: string;
  silent?: boolean;
};
const DEADLINE_MS = 120_000;

// Only a cheap shape filter here. The bridge owns envelope parsing, addressing,
// authorization and residency; ordinary prompts never start a process.
export function isCommandPrompt(text: string): boolean {
  const body = /^\s*<channel\b[^>]*>([\s\S]*)<\/channel>\s*$/.exec(text)?.[1] ?? '';
  return /^(?:(?:<@!?\d+>|@\S+)\s*)?!(?:model|effort|compact|clear|advisor|doctor|checkup)(?:@[^\s]+)?(?:\s|$)/i.test(body.trim());
}

export function classifyStdout(command: string, text: string): 'ok' | 'failed' {
  const success = command === '/model' ? /^Set model to\b/i.test(text)
    : command === '/effort' ? /^Set effort level to\b/i.test(text)
    : command === '/advisor' ? /^(?:Advisor set to\b|Advisor (?:disabled|turned off)\b)/i.test(text)
    : command === '/clear' && text === '';
  return success ? 'ok' : 'failed';
}

async function bridge($: EngineInterface, verb: string, payload = ''): Promise<Decision> {
  const result = await $.process.run([
    'bash', `${$.plugin.root}/scripts/hermitd-exec.sh`, 'harness-mod', verb,
    await $.session.id(), payload,
  ], { cwd: await $.session.cwd() });
  if (result.exitCode !== 0 || !result.stdout.trim()) throw new Error(`Harness bridge ${verb} failed`);
  return JSON.parse(result.stdout);
}

const queue: Request[] = [];
let request: Request | undefined;
let outcomes: Outcome[] = [];
let active: {
  command: Command;
  resolved: boolean;
  evidence?: { status: 'ok' | 'failed'; text: string };
  stdoutStarted: boolean;
  expectedModel: string | null;
  timer: { cancel(): void };
} | undefined;
let approval: string | null = null;
let claiming = false;
let dispatching = false;

async function finalize($: EngineInterface, input: unknown) {
  const result = await bridge($, 'finalize', JSON.stringify(input));
  if (result.decision === 'send_failed') {
    await $.prompt.submit({ text: `Relay this harness command result once to ${JSON.stringify(result.reply_to)}: ${JSON.stringify(result.text)}. Do not run the command again.` });
  }
}

async function finish($: EngineInterface, outcome: Outcome) {
  if (!active || !request) return;
  active.timer.cancel();
  active = undefined;
  approval = null;
  outcomes.push(outcome);
  try {
    // A dependent effort leg is never run after a failed or uncertain model leg.
    if (outcome.status !== 'ok' || outcomes.length === request.commands.length) {
      const completed = request;
      const results = outcomes;
      request = undefined;
      outcomes = [];
      await finalize($, { ...completed, outcomes: results });
    }
  } finally {
    // A failed reply must not strand the requests queued behind this one.
    schedule($);
  }
}

function observe($: EngineInterface) {
  if (!active?.resolved || !active.evidence) return;
  const current = active;
  // Finish outside the observing hook, so the next command cannot re-enter it.
  $.clock.after(0, () => {
    if (active === current) return finish($, { ...current.command, ...current.evidence! });
  });
}

async function dispatch($: EngineInterface) {
  if (active || dispatching) return;
  request ??= queue.shift();
  if (!request) return;
  const command = request.commands[outcomes.length];
  if (command.command === '/doctor') return runDoctor($, request);
  const current = {
    command, resolved: false, stdoutStarted: false, expectedModel: null as string | null,
    evidence: undefined as { status: 'ok' | 'failed'; text: string } | undefined,
    timer: $.clock.after(DEADLINE_MS, () => {
      if (active === current) return finish($, { ...command, status: 'unknown', text: '' });
    }),
  };
  active = current;
  dispatching = true;
  approval = command.command === '/model' ? command.arg : null;
  try {
    const running = $.command.run({ command: command.command.slice(1), args: command.arg ?? '' });
    // An ack failure leaves the request for a later claim; it says nothing about this run.
    if (request.requested_at && outcomes.length === 0) await bridge($, 'ack', request.requested_at).catch(() => undefined);
    await running;
    if (active !== current) return;
    current.resolved = true;
    observe($);
  } catch (error) {
    if (active === current) await finish($, { ...command, status: 'failed', text: String(error) });
  } finally {
    dispatching = false;
    if (!active) schedule($);
  }
}

// /doctor is a prompt-type command: run resolves at submit and prints no stdout, and its
// own turn replies to the chat through the skill-relay marker written first.
async function runDoctor($: EngineInterface, doctor: Request) {
  request = undefined;
  dispatching = true;
  try {
    // The bridge answers `pass` rather than exiting non-zero when it cannot record the target.
    if ((await bridge($, 'relay', JSON.stringify(doctor))).decision !== 'ok') throw new Error('Reply target not recorded');
    await $.command.run({ command: 'doctor', args: '' });
  } catch (error) {
    await finalize($, { ...doctor, outcomes: [{ ...doctor.commands[0], status: 'failed', text: String(error) }] }).catch(() => undefined);
  } finally {
    dispatching = false;
    schedule($);
  }
}

function schedule($: EngineInterface) {
  $.clock.after(0, () => dispatch($));
}

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'channel') {
      // Only the engine stamps a channel origin; an envelope from any other origin is forged.
      return /^\s*<channel\s/.test(e.text) ? { drop: 'Channel envelope from a non-channel origin' } : next(e);
    }
    if (!isCommandPrompt(e.text)) return next(e);
    const result = await bridge($, 'intake', e.text);
    if (result.decision === 'pass') return next(e);
    if (result.decision === 'run') {
      queue.push(result);
      schedule($);
    } else if (result.decision === 'refuse' && !result.silent) {
      $.clock.after(0, () => finalize($, result));
    }
    return { drop: 'Harness command handled by the native executor' };
  });

  on('classic.PreModelSwitch', async ($, e, next) => {
    const result = await next(e);
    if (result.block || result.permissionDecision === 'deny' || result.permissionDecision === 'ask') return result;
    if (approval !== null && e.requested_model === approval) {
      if (active) active.expectedModel = typeof e.to_model === 'string' ? e.to_model : null;
      approval = null;
      return { permissionDecision: 'allow' };
    }
    return result;
  });

  on('classic.PostModelSwitch', async ($, e, next) => {
    const result = await next(e);
    if (active?.command.command === '/model' && active.expectedModel !== null && e.to_model === active.expectedModel) {
      active.evidence = { status: 'ok', text: `Model switched to ${active.command.arg}` };
      observe($);
    }
    return result;
  });

  on('session.append', async ($, e, next) => {
    const result = await next(e);
    if (!active || e.door !== 'command' || e.origin.kind !== 'plugin' || e.origin.name !== $.plugin.name) return result;
    const content = e.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter((part: { type: string }) => part.type === 'text').map((part: { text: string }) => part.text).join('\n') : '';
    const dispatched = /<command-name>([^<]+)<\/command-name>/.exec(text);
    if (dispatched) {
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? '';
      active.stdoutStarted = dispatched[1] === active.command.command && args === (active.command.arg ?? '');
    }
    const stdout = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(text);
    if (!stdout || !active.stdoutStarted) return result;
    const command = active.command.command;
    if (command === '/compact') return result;
    const observed = stdout[1];
    const status = classifyStdout(command, observed);
    // A cleared context is reported from classic.SessionStart, once the resident id is current.
    if (command === '/clear' && status === 'ok') return result;
    active.evidence = { status, text: observed };
    observe($);
    return result;
  });

  on('session.compact', async ($, e, next) => {
    const result = await next(e);
    if (active?.command.command === '/compact' && typeof result.tokensBefore === 'number' && typeof result.tokensAfter === 'number') {
      active.evidence = { status: 'ok', text: `Compacted ${result.tokensBefore} to ${result.tokensAfter} tokens` };
      observe($);
    }
    return result;
  });

  on('session.start', async ($, e, next) => {
    const result = await next(e);
    await bridge($, 'loaded');
    return result;
  });

  // A /clear changes the session id without another session.start. The plugin's own
  // SessionStart command hook restamps the resident id; next(e) resolves after it, while
  // session.end and $.command.run resolve before it starts.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e);
    if (e.source === 'clear') {
      if (active?.command.command === '/clear') {
        active.evidence = { status: 'ok', text: 'Context cleared' };
        observe($);
      }
      $.clock.after(0, () => bridge($, 'loaded'));
    }
    return result;
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId || e.reason !== 'answer' || claiming || active || request || queue.length) return result;
    claiming = true;
    try {
      const claimed = await bridge($, 'claim');
      if (claimed.decision === 'run') {
        queue.push(claimed);
        schedule($);
      }
    } finally { claiming = false; }
    return result;
  });
};
