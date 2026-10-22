import type { EngineInterface, Register } from 'claude-code';

type Command = { command: string; arg: string | null };
type Leg = { command: string; status: 'ok' | 'failed' | 'unknown' | 'skipped'; text: string; submitted_at?: string };
type Entry = {
  id: string;
  source: string;
  commands: Command[];
  legs?: Leg[];
};
type Decision = Partial<Entry> & {
  decision: 'pass' | 'run' | 'refuse' | 'ok' | 'queued' | 'send_failed';
  reason?: string;
  text?: string;
  silent?: boolean;
  state?: string;
  reply_to?: { source: string; chat_id: string };
  relays?: { text: string; reply_to: { source: string; chat_id: string } }[];
};
const TICK_MS = 2000;
// The deadline only records an uncertain outcome; the run keeps its slot until it settles.
const deadlineFor = (command: Command) => command.command === '/compact' ? 300_000 : 120_000;
const SKILL_RE = /^\/[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/i;
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// Only a cheap shape filter here. The bridge owns envelope parsing, addressing,
// authorization and residency; ordinary prompts never start a process.
export function isCommandPrompt(text: string): boolean {
  const body = /^\s*<channel\b[^>]*>([\s\S]*)<\/channel>\s*$/.exec(text)?.[1] ?? '';
  return /^(?:(?:<@!?\d+>|@\S+)\s*)?!(?:model|effort|compact|clear|advisor|doctor|checkup)(?:@[^\s]+)?(?:\s|$)/i.test(body.trim());
}

export function classifyStdout(command: string, text: string): 'ok' | 'failed' {
  const success = command === '/model' ? /^Set model to\b/i.test(text)
    : command === '/advisor' ? /^(?:Advisor set to\b|Advisor (?:disabled|turned off)\b)/i.test(text)
    : command === '/reload-plugins' ? /^Reloaded:/.test(text)
    : command === '/clear' && text === '';
  return success ? 'ok' : 'failed';
}

async function bridge($: EngineInterface, verb: string, payload = ''): Promise<Decision> {
  const [id, cwd] = await Promise.all([$.session.id(), $.session.cwd()]);
  const result = await $.process.run([
    'bash', `${$.plugin.root}/scripts/hermitd-exec.sh`, 'harness-mod', verb, id, payload,
  ], { cwd });
  if (result.exitCode !== 0 || !result.stdout.trim()) throw new Error(`Harness bridge ${verb} failed`);
  return JSON.parse(result.stdout);
}

let timer: { cancel(): void } | undefined;
let stateDir: string | undefined;
let lastId: string | undefined;
let recovered = false;
let ticking = false;
// The main loop's running turn, from turn.start; subagent turns never gate the queue.
let mainTurn: string | undefined;
let request: Entry | undefined;
let legs: Leg[] = [];
// One $.command.run outstanding at a time, held until it settles.
let running = false;
let active: {
  command: Command;
  resolved: boolean;
  evidence?: Leg;
  stdoutStarted: boolean;
  expectedModel: string | null;
  timer: { cancel(): void };
} | undefined;
let approval: string | null = null;
// The resident's chat-set effort, applied per main-thread request; the session's own level stays.
let effort: string | undefined;

const busy = () => !!(request || running || active);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

// A reply the channel could not take is handed to the session to relay once.
async function relay($: EngineInterface, result: Pick<Decision, 'text' | 'reply_to'>) {
  await $.prompt.submit({ text: `Relay this harness command result once to ${JSON.stringify(result.reply_to)}: ${JSON.stringify(result.text)}. Do not run the command again.` });
}

// Requests the queue settled without running answer their chat from the claim or recover call.
async function relayUnanswered($: EngineInterface, result: Decision) {
  for (const failed of result.relays ?? []) await relay($, failed);
}

async function finalize($: EngineInterface, input: unknown) {
  const result = await bridge($, 'finalize', JSON.stringify(input));
  if (result.decision === 'send_failed') await relay($, result);
}

// Stops at the first leg that is not ok: a dependent leg never runs after an uncertain one.
async function settle($: EngineInterface, leg: Leg) {
  const current = request;
  if (!current) return;
  legs.push(leg);
  try {
    if (leg.status !== 'ok' || legs.length === current.commands.length) {
      const done = legs;
      request = undefined;
      legs = [];
      await finalize($, { id: current.id, legs: done });
    } else {
      // Progress survives a reload that replaces this copy, so the next copy knows where it stopped.
      await bridge($, 'leg', JSON.stringify({ id: current.id, legs }));
    }
  } finally {
    // A failed reply must not strand the work queued behind this one.
    schedule($);
  }
}

async function finish($: EngineInterface, leg: Leg) {
  if (!active) return;
  active.timer.cancel();
  active = undefined;
  approval = null;
  await settle($, leg);
}

function observe($: EngineInterface) {
  if (!active?.resolved || !active.evidence) return;
  const current = active;
  // Finish outside the observing hook, so the next command cannot re-enter it.
  $.clock.after(0, () => {
    if (active === current) return finish($, current.evidence!);
  });
}

async function dispatch($: EngineInterface) {
  if (!request || active || running) return;
  const command = request.commands[legs.length];
  if (command.command === '/doctor') return runDoctor($, request);
  if (command.command === '/effort') return setEffort($, command.arg ?? '');
  const current = {
    command, resolved: false, stdoutStarted: false, expectedModel: null as string | null,
    evidence: undefined as Leg | undefined,
    timer: $.clock.after(deadlineFor(command), () => {
      if (active === current) return finish($, { command: command.command, status: 'unknown', text: 'deadline reached' });
    }),
  };
  active = current;
  running = true;
  approval = command.command === '/model' ? command.arg : null;
  try {
    await $.command.run({ command: command.command.slice(1), args: command.arg ?? '' });
    if (active !== current) return;
    current.resolved = true;
    // A skill is a prompt for the model: resolving at submit is all a run reports.
    if (SKILL_RE.test(command.command)) current.evidence = { command: command.command, status: 'ok', text: 'submitted', submitted_at: new Date().toISOString() };
    observe($);
  } catch (error) {
    if (active === current) await finish($, { command: command.command, status: 'failed', text: errorText(error) });
  } finally {
    running = false;
    if (!active) schedule($);
  }
}

// /doctor is a prompt-type command: run resolves at submit and prints no stdout, and its
// own turn replies to the chat through the skill-relay marker written first.
async function runDoctor($: EngineInterface, doctor: Entry) {
  running = true;
  let leg: Leg;
  try {
    // The bridge answers `pass` rather than exiting non-zero when it cannot record the target.
    if ((await bridge($, 'relay', JSON.stringify(doctor))).decision !== 'ok') throw new Error('Reply target not recorded');
    await $.command.run({ command: 'doctor', args: '' });
    leg = { command: '/doctor', status: 'ok', text: 'submitted', submitted_at: new Date().toISOString() };
  } catch (error) {
    leg = { command: '/doctor', status: 'failed', text: errorText(error) };
  } finally {
    running = false;
  }
  await settle($, leg).catch(() => undefined);
}

// /effort with a warm cache opens a confirmation no mod can answer and rewrites the user's
// default, so the level is applied to each request instead and kept in state for a reload.
async function setEffort($: EngineInterface, level: string) {
  running = true;
  let leg: Leg;
  try {
    if (!EFFORT_LEVELS.has(level)) throw new Error(`Unknown effort level: ${level}`);
    if (!stateDir) throw new Error('No resident state directory');
    await $.fs.write(`${stateDir}/effort-override.json`, JSON.stringify({ level, set_at: new Date().toISOString() }) + '\n');
    effort = level;
    leg = { command: '/effort', status: 'ok', text: `Effort set to ${level}; the status line still shows the launch level` };
  } catch (error) {
    leg = { command: '/effort', status: 'failed', text: errorText(error) };
  } finally {
    running = false;
  }
  await settle($, leg).catch(() => undefined);
}

async function readEffort($: EngineInterface, dir: string) {
  try {
    const level = JSON.parse(String(await $.fs.read(`${dir}/effort-override.json`))).level;
    effort = EFFORT_LEVELS.has(level) ? level : undefined;
  } catch {
    effort = undefined;
  }
}

// A pause ends the running turn natively: a dialog it holds closes unanswered, and
// later commands keep working, which an Escape keystroke would not allow.
async function runPause($: EngineInterface, entry: Decision) {
  let leg: Leg = { command: 'turn.abort', status: 'ok', text: 'no turn' };
  if (mainTurn) {
    try {
      await $.turn.abort({ turnId: mainTurn });
      leg = { ...leg, text: 'turn aborted' };
    } catch (error) {
      leg = { ...leg, status: 'failed', text: errorText(error) };
    }
  }
  await finalize($, { id: entry.id, legs: [leg] });
}

function schedule($: EngineInterface) {
  $.clock.after(0, () => dispatch($));
}

function start($: EngineInterface, entry: Decision) {
  request = { id: entry.id!, source: entry.source!, commands: entry.commands ?? [] };
  legs = [...(entry.legs ?? [])];
  schedule($);
}

// Called once per session id, never per tick: a guest session costs one process per id change.
// A bridge failure is not a verdict, so the next tick tries the same id again.
async function loadedFor($: EngineInterface, id: string) {
  lastId = id;
  const result = await bridge($, 'loaded').catch(error => {
    lastId = undefined;
    throw error;
  });
  if (result.decision !== 'ok' || !result.state) {
    stateDir = undefined;
    return;
  }
  stateDir = result.state;
  await readEffort($, result.state);
  if (recovered) return;
  recovered = true;
  const resumed = await bridge($, 'recover');
  await relayUnanswered($, resumed);
  if (resumed.decision === 'run' && !busy()) start($, resumed);
}

async function hasPause($: EngineInterface, dir: string, names: string[]): Promise<boolean> {
  for (const name of names) {
    try {
      if (JSON.parse(String(await $.fs.read(`${dir}/${name}`))).source === 'pause') return true;
    } catch {}
  }
  return false;
}

async function tick($: EngineInterface) {
  if (ticking) return;
  ticking = true;
  try {
    const id = await $.session.id();
    if (id !== lastId) await loadedFor($, id).catch(() => undefined);
    if (!stateDir) return;
    const dir = `${stateDir}/harness-queue`;
    const names = (await $.fs.list(dir).catch(() => [])).filter(e => e.kind === 'file' && e.name.endsWith('.json')).map(e => e.name);
    if (names.length === 0) return;
    // Idle: the claim itself puts a pause first. Mid-turn or mid-run, only a pause may
    // go ahead, so the files are read for one only then.
    const idle = !mainTurn && !busy();
    if (!idle && !(await hasPause($, dir, names))) return;
    const claimed = await bridge($, 'claim', idle ? '' : 'pause');
    await relayUnanswered($, claimed);
    if (claimed.decision !== 'run') return;
    if (claimed.source === 'pause') await runPause($, claimed);
    else start($, claimed);
  } catch {
    // The next tick tries again; a bridge failure must not stop the timer.
  } finally {
    ticking = false;
  }
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
    if (result.decision === 'queued') {
      $.clock.after(0, () => tick($));
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
      active.evidence = { command: '/model', status: 'ok', text: `Model switched to ${active.command.arg}` };
      observe($);
    }
    return result;
  });

  on('session.append', async ($, e, next) => {
    const result = await next(e);
    // A rejected command (such as `/model` with an unknown model) appends system rows with
    // engine origin; the command-name and args match below still ties them to this run.
    const own = (e.origin.kind === 'engine' && e.message?.type === 'system')
      || (e.origin.kind === 'plugin' && e.origin.name === $.plugin.name);
    if (!active || e.door !== 'command' || !own) return result;
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
    if (command === '/compact' || SKILL_RE.test(command)) return result;
    const observed = stdout[1];
    const status = classifyStdout(command, observed);
    // A cleared context is reported from classic.SessionStart, once the resident id is current.
    if (command === '/clear' && status === 'ok') return result;
    active.evidence = { command, status, text: observed };
    observe($);
    return result;
  });

  on('session.compact', async ($, e, next) => {
    const result = await next(e);
    if (active?.command.command === '/compact' && typeof result.tokensBefore === 'number' && typeof result.tokensAfter === 'number') {
      active.evidence = { command: '/compact', status: 'ok', text: `Compacted ${result.tokensBefore} to ${result.tokensAfter} tokens` };
      observe($);
    }
    return result;
  });

  on('session.start', async ($, e, next) => {
    const result = await next(e);
    timer ??= $.clock.every(TICK_MS, () => tick($));
    await loadedFor($, await $.session.id()).catch(() => undefined);
    return result;
  });

  // A /clear or a forked resume changes the session id, and session.start can run before
  // the plugin's own SessionStart command hook restamps the resident id. next(e) resolves
  // after that hook, while session.end and $.command.run resolve before it starts.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e);
    if (e.source === 'clear' && active?.command.command === '/clear') {
      active.evidence = { command: '/clear', status: 'ok', text: 'Context cleared' };
      observe($);
    }
    $.clock.after(0, async () => loadedFor($, await $.session.id()).catch(() => undefined));
    return result;
  });

  // Subagents keep their own level, and a model with no effort setting is sent none.
  on('turn.step', async function* ($, e, next) {
    return yield* next(effort && e.agentId === undefined && e.effort !== undefined ? { ...e, effort } : e);
  });

  on('turn.start', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId === undefined) mainTurn = e.turnId;
    return result;
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (!e.agentId) {
      mainTurn = undefined;
      // A request queued mid-turn is claimed now, before the next turn can start.
      $.clock.after(0, () => tick($));
    }
    return result;
  });
};
