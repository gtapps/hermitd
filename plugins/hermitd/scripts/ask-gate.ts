// Suppress EPIPE errors (e.g. when stdout pipe closes early in tests)
process.stdout.on('error', () => {});

// PreToolUse hook (matcher "AskUserQuestion") — binds the last unbound
// synchronous-ask path on unattended sessions, denying the call with a redirect
// to the channel reply tool and the micro-proposal bridge. PROP-017 covers hermit-owned
// skills cooperatively (Step-0 marker + static contract test); this gate
// binds everything else — built-ins, other plugins' skills, spontaneous
// model-initiated questions — the caller surface that grows with every
// plugin the operator installs.
//
// Deny mechanics mirror pause-gate.ts: probe-verified
// (compiled/spike-channel-stop-probe-2026-07-03.md) that a PreToolUse exit-2
// deny is binding within one tool call with zero model cooperation. The
// deny-steering behavior specific to this gate — does the model retry the
// tool or follow the reason into an alternate action — is probe-verified in
// compiled/spike-ask-gate-probe-2026-07-05.md: it does not retry.
//
// Only denies when there's actually somewhere for the question to go AND this
// is genuinely the unattended surface: always_on config, an eligible outbound
// channel, the operator hasn't opted out (ask_gate:false / HERMIT_ASK_GATE=off),
// and the process carries the HERMIT_MANAGED marker. That marker is stamped into
// the managed session's tmux env-file by hermitd-start (never settings.local.json
// or the docker-compose env block), so it identifies THIS process as the
// background session rather than relying on the project-wide always_on flag —
// which every `claude` in the dir reads alike. A hand-launched maintenance
// `claude` (or a `docker exec` shell) lacks the marker and is left untouched, so
// its interactive AskUserQuestion flows (/hermit-evolve, /hermit-settings,
// /docker-setup, ...) are not denied out from under a present operator.
//
// Fail direction: lean allow. A false "attended" (allowed but nobody watching)
// is backstopped by the watchdog's stall-question detector, which fail-loudly
// notifies the operator. A false "unattended" (denied with a human present) has
// no backstop — it just breaks the flow. So every ambiguity resolves to allow.
//
// Fail-open: any error here (bad stdin, missing/corrupt config) resolves to
// exit 0 (allow) — a hook must never block Claude Code.

import { hermitDir } from './lib/cc-compat';
import { readSettledConfig } from './lib/config-read';
import { channelLikelyDown } from './lib/channel-health';
import { resolve as resolveOutboundChannel } from './resolve-outbound-channel';
import { runHook } from './lib/hook-input';

const proposalPath = "'" + `${import.meta.dir}/proposal.ts`.replaceAll("'", "'\\''") + "'";
const REDIRECT_REASON =
  'No interactive operator on this surface (always-on channel session). Do not retry ' +
  'AskUserQuestion. Instead: (1) send the question via the channel reply tool; (2) queue it ' +
  'durably by running `bun ' + proposalPath + ' queue-micro ' +
  '.hermit` with a heredoc payload {"tier":1,"question":"...","options":[...],"chat":"<sourceKey>:<chat_id>"} ' +
  '(chat: the asking chat) — ' +
  'never hand-edit state/micro-proposals.json; (3) continue other work — the answer arrives as a ' +
  'channel message. If a human operator is in fact attending this terminal, they can relaunch ' +
  'with HERMIT_ASK_GATE=off to disable this gate for that session.';

function main(payload: any): void {
  const toolName = payload && typeof payload.tool_name === 'string' ? payload.tool_name : '';
  if (toolName !== 'AskUserQuestion') return; // allow (defensive; matcher already scopes)

  // Pure-env gates first — they exclude every attended session (where an
  // interactive AskUserQuestion actually fires) without touching the disk.
  if (process.env.HERMIT_ASK_GATE === 'off') return; // explicit per-session escape hatch
  // Identity gate: only the managed unattended session carries HERMIT_MANAGED
  // (stamped into its tmux env-file by hermitd-start). Its absence means an
  // attended `claude` — leave interactive AskUserQuestion flows alone.
  if (process.env.HERMIT_MANAGED !== '1') return;

  const dir = hermitDir();
  const config = readSettledConfig(dir); // settled: absent/malformed -> defaults (always_on false -> allow)

  if (config.always_on !== true) return; // interactive/terminal session — untouched
  if (config.ask_gate === false) return; // explicit config escape hatch

  const target = resolveOutboundChannel(config.channels);
  if (!target) return; // no redirect target — denying would strand the question

  // "Configured" is not "reachable": if the channel's recent sends have been
  // failing (e.g. a revoked bot token), don't deny toward a dead channel — allow
  // the question to render in the pane, where the watchdog stall backstop catches
  // it. Denying here would strand it (deny + undeliverable redirect = silence).
  if (channelLikelyDown(dir, target.id)) return;

  process.stderr.write(`${REDIRECT_REASON}\n`);
  process.exit(2);
}

runHook(main);
