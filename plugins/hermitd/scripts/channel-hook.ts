import fs from 'node:fs';
import path from 'node:path';
import { replyToolChannel } from './lib/channel-config';
import { safe } from './lib/sanitize';
import { hermitDir, transcriptPath, readTailLines, turnPromptText, sessionId } from './lib/cc-compat';
import { readConfigRaw } from './lib/config-read';
import { auditConfigChange } from './lib/config-audit';
import { parseChannelEnvelope } from './lib/channel-envelope';
import { logMessage, isLoggingEnabled } from './lib/channel-log';
import { ensureLedgerFile } from './lib/append-jsonl';

type Json = any;

/**
 * PostToolUse hook for channel reply tools (Discord, Telegram, etc.).
 *
 * Runs after any channel MCP reply tool call. Handles:
 * - Episodic capture of the outbound reply text (PROP-010, best-effort — see
 *   scripts/lib/channel-log.ts). Runs before the "channel configured" gate
 *   below so replies on not-yet-configured channels are still captured.
 * - Persisting dm_channel_id from chat_id in tool input (config.json) — but
 *   ONLY when the reply was sent during a turn that a matching inbound
 *   envelope actually opened (see isEligibleInboundReply). A proactive send
 *   (routine wake, heartbeat, scheduled brief) carries no inbound envelope at
 *   all, or one from a different chat, and must never be mistaken for the
 *   operator having moved their primary DM.
 * - Updating last_reply_at timestamp (state/channel-activity.json)
 * - Appending an outbound-send event to state/channel-replies.jsonl. The ledger has no
 *   reader today: reflect's routine-ROI engagement join was removed because these rows
 *   record the hermit's own sends, so they cannot measure operator engagement.
 *
 * The config-persistence steps below only act once the channel is already
 * configured in config.json — episodic capture is the one exception.
 */

const HERMIT_DIR = hermitDir();
const CONFIG_PATH = path.join(HERMIT_DIR, 'config.json');
const ACTIVITY_PATH = path.join(HERMIT_DIR, 'state', 'channel-activity.json');
const REPLIES_PATH = path.join(HERMIT_DIR, 'state', 'channel-replies.jsonl');
const MAX_STDIN = 64 * 1024;
// 512KB matches cost-tracker's calibrated window for the same walk-back-to-the-
// turn-boundary job. A channel reply lands at the END of a channel-responder
// turn that already absorbed a skill body and several tool results; a window
// that doesn't reach that turn's opening envelope fails the gate — and since
// this hook is the only writer of dm_channel_id and default_chat_id, that
// silently leaves proactive outbound unconfigured.
const TAIL_BYTES = 512 * 1024;

function readConfig(): Json | null {
  return readConfigRaw(HERMIT_DIR);
}

function writeConfig(config: Json, before: Json): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  auditConfigChange(HERMIT_DIR, before, config, 'channel-hook');
}

export function persistDmChannelId(config: Json, channelKey: string, chatId: Json, isInboundReply: boolean): boolean {
  if (!chatId) return false;

  // Coerce to string (mirrors the log path's String() at the outbound-capture
  // block): a channel plugin delivering a numeric chat_id must not write a
  // number into config.json — the sender allow-list gate compares IDs as
  // strings, and a numeric dm_channel_id also fails validate-config.
  const id = String(chatId);
  const channel = config.channels[channelKey];
  if (channel.dm_channel_id === id) return false;

  // A proactive/scheduled send (routine wake, heartbeat, a brief fired on a
  // timer) opens its own turn with no matching inbound envelope — replying
  // there is not evidence the operator moved their primary DM. Generalizes
  // the maintainer_channel_id exemption below: any outbound chat_id reached
  // without a same-chat inbound trigger is a known, deliberate second
  // destination, not a relocation signal. See main()'s isEligibleInboundReply.
  if (!isInboundReply) {
    process.stderr.write(
      `[channel-hook] skipped ${channelKey}.dm_channel_id — ${safe(id)} reply wasn't opened by a matching inbound message\n`
    );
    return false;
  }

  // The maintainer chat must never be adopted as the primary bidirectional
  // chat — default_chat_id binds operator *control* authority in
  // lib/channel-auth.ts isTrustedController, and maintainer_channel_id is
  // outbound routing for technical alerts. Replying into the maintainer chat
  // must not re-learn it as the DM channel and collapse them into one.
  const maintainer = channel.maintainer_channel_id;
  if (maintainer != null && String(maintainer) === id) {
    process.stderr.write(
      `[channel-hook] skipped ${channelKey}.dm_channel_id — ${safe(id)} is the maintainer chat\n`
    );
    return false;
  }

  // Seed the pinned proactive home once, then never move it: unattended sends
  // (briefings, notices) resolve through default_chat_id, so a message from a
  // second chat must not relocate them. On a first pairing this chat is the
  // home; on an install that predates the pin the *incumbent* chat wins —
  // the message that diverts dm_channel_id is never the one that decides
  // where briefings live. Moving it afterwards is a terminal-only
  // hermit-settings action.
  if (channel.default_chat_id == null) {
    const incumbent = channel.dm_channel_id == null ? null : String(channel.dm_channel_id);
    // A dm_channel_id already clobbered to the maintainer chat (validate-config
    // warns on it) must not become the permanent home either.
    const usable = incumbent != null && !(maintainer != null && String(maintainer) === incumbent);
    channel.default_chat_id = usable ? incumbent : id;
    process.stderr.write(
      `[channel-hook] seeded ${channelKey}.default_chat_id = ${safe(channel.default_chat_id)}\n`
    );
  }

  channel.dm_channel_id = id;
  process.stderr.write(
    `[channel-hook] saved ${channelKey}.dm_channel_id = ${safe(id)}\n`
  );
  return true;
}

function updateLastReplyAt(channelKey: string, ts: string): void {
  try {
    let activity: Json = {};
    try {
      activity = JSON.parse(fs.readFileSync(ACTIVITY_PATH, 'utf8'));
    } catch {}

    if (!activity[channelKey]) activity[channelKey] = {};
    activity[channelKey].last_reply_at = ts;

    fs.writeFileSync(ACTIVITY_PATH, JSON.stringify(activity, null, 2) + '\n');
  } catch {}
}

function appendReplyEvent(channelKey: string, ts: string): void {
  try {
    const entry = JSON.stringify({ ts, channel: channelKey, event: 'reply' });
    ensureLedgerFile(REPLIES_PATH);
    fs.appendFileSync(REPLIES_PATH, entry + '\n', 'utf8');
  } catch {}
}

export function persistIntakeAck(
  hermitDir: string,
  text: unknown,
  channel: string,
  chatId: unknown,
  sessionId: string | null,
): void {
  try {
    if (typeof text !== 'string' || !text.trim().toLowerCase().startsWith('on it')) return;
    const ackPath = path.join(hermitDir, 'state', 'intake-acks.jsonl');
    ensureLedgerFile(ackPath);
    fs.appendFileSync(ackPath, JSON.stringify({
      at: new Date().toISOString(),
      channel,
      chat_id: chatId != null ? String(chatId) : '',
      session_id: sessionId,
    }) + '\n');
  } catch { /* fail-open */ }
}

// Was this reply sent during a turn that a matching inbound envelope actually
// opened? Reads only a tail window of the transcript (TAIL_BYTES) — cheap
// enough to run on every reply, unlike a whole-session read — finds the
// boundary prompt that started the CURRENT turn (mirrors cost-tracker.ts's
// resolveTurnSource/turnPromptText usage), and requires that prompt to be a
// <channel> envelope from the SAME chat this reply is going to. A routine
// wake, heartbeat, or scheduled brief opens its turn on something else
// entirely (or nothing at all within the window) and is correctly ineligible.
export function isEligibleInboundReply(event: Json, channelKey: string, chatId: Json, config: Json = readConfig()): boolean {
  try {
    const tPath = transcriptPath(event);
    if (!tPath) return false;

    const { lines } = readTailLines(tPath, TAIL_BYTES);

    const prompt = turnPromptText(lines, lines.length);
    // No boundary in the window means "couldn't tell", not "wasn't inbound" —
    // still fail closed, but say so, or a turn too large for TAIL_BYTES looks
    // identical to a proactive send in the log.
    if (!prompt.boundaryFound) {
      process.stderr.write(
        `[channel-hook] undetermined ${channelKey}.dm_channel_id — ${safe(chatId)} found no turn boundary in the last ${TAIL_BYTES} transcript bytes\n`
      );
      return false;
    }

    const envelope = parseChannelEnvelope(prompt.text, config);
    if (!envelope) return false;

    return envelope.sourceKey === channelKey && envelope.chatId === String(chatId ?? '');
  } catch {
    return false;
  }
}

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    raw += chunk;
    if (raw.length > MAX_STDIN) process.exit(0);
  });
  process.stdin.on('end', () => {
    try {
      const event = JSON.parse(raw);
      const toolName = event.tool_name || '';
      const input = event.tool_input || {};

      const config = readConfig();
      const channelKey = replyToolChannel(toolName, config);
      if (!channelKey) return;

      const chatId = input[config?.channels?.[channelKey]?.attributes?.chat_id ?? 'chat_id'];

      persistIntakeAck(HERMIT_DIR, input.text, channelKey, chatId, sessionId(event));

      // Episodic capture (PROP-010) — deliberately before the "channel
      // configured" gate below, so replies on not-yet-configured channels
      // are still captured. Best-effort; never throws past this block.
      try {
        const text = input.text;
        if (isLoggingEnabled(config, channelKey) && typeof text === 'string' && text) {
          const result = logMessage(HERMIT_DIR, {
            source: channelKey,
            chat_id: chatId != null ? String(chatId) : '',
            direction: 'out',
            text,
          });
          if (!result.ok) {
            process.stderr.write(`[channel-log] outbound capture failed: ${result.error}\n`);
          }
        }
      } catch (e: any) {
        process.stderr.write(`[channel-log] outbound capture failed: ${e?.message || e}\n`);
      }

      if (!config || !config.channels || !config.channels[channelKey]) return;

      let dirty = false;

      // Snapshot before persistDmChannelId mutates in place, so the audit ledger
      // can attribute the learned dm_channel_id to this hook.
      const configBefore = structuredClone(config);
      const isInboundReply = isEligibleInboundReply(event, channelKey, chatId, config);
      dirty = persistDmChannelId(config, channelKey, chatId, isInboundReply) || dirty;
      if (dirty) writeConfig(config, configBefore);

      const ts = new Date().toISOString();
      updateLastReplyAt(channelKey, ts);
      appendReplyEvent(channelKey, ts);
    } catch (e) {
      // Silently ignore errors — don't block the agent
    }
  });
}

// Guard so importing this module (e.g. a unit test of persistDmChannelId or
// isEligibleInboundReply) doesn't run the hook. Direct execution as a hook
// keeps import.meta.main true.
if (import.meta.main) main();
