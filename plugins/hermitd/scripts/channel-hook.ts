import fs from 'node:fs';
import path from 'node:path';
import { homeSeedBlock, replyToolChannel } from './lib/channel-config';
import { safe } from './lib/sanitize';
import { hermitDir, transcriptPath, readTailLines, turnPromptText } from './lib/cc-compat';
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
 * - Seeding default_chat_id from chat_id in tool input (config.json) — but
 *   ONLY when the reply was sent during a turn that a matching inbound
 *   envelope actually opened (see isEligibleInboundReply). A proactive send
 *   (routine wake, heartbeat, scheduled brief) carries no inbound envelope at
 *   all, or one from a different chat, and must never be mistaken for the
 *   operator choosing a home.
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
// this hook seeds default_chat_id, that
// silently leaves proactive outbound unconfigured.
const TAIL_BYTES = 512 * 1024;

function readConfig(): Json | null {
  return readConfigRaw(HERMIT_DIR);
}

function writeConfig(config: Json, before: Json): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  auditConfigChange(HERMIT_DIR, before, config, 'channel-hook');
}

export function seedDefaultChatId(config: Json, channelKey: string, chatId: Json, isInboundReply: boolean): boolean {
  const channel = config.channels[channelKey];
  if (!chatId) return false;
  // Channel plugins may deliver numeric IDs; config IDs are always strings.
  const id = String(chatId);
  const block = homeSeedBlock(channel, id);
  if (block === 'pinned') return false;
  if (!isInboundReply) {
    process.stderr.write(
      `[channel-hook] skipped ${channelKey}.default_chat_id — ${safe(id)} reply wasn't opened by a matching inbound message\n`
    );
    return false;
  }
  if (block === 'maintainer') {
    process.stderr.write(
      `[channel-hook] skipped ${channelKey}.default_chat_id — ${safe(id)} is the maintainer chat\n`
    );
    return false;
  }
  channel.default_chat_id = id;
  process.stderr.write(`[channel-hook] seeded ${channelKey}.default_chat_id = ${safe(id)}\n`);
  return true;
}

function updateLastReplyAt(channelKey: string, ts: string, inboundChat?: string): void {
  try {
    let activity: Json = {};
    try {
      activity = JSON.parse(fs.readFileSync(ACTIVITY_PATH, 'utf8'));
    } catch {}

    if (!activity[channelKey]) activity[channelKey] = {};
    activity[channelKey].last_reply_at = ts;
    if (inboundChat) activity[channelKey].last_inbound_reply = { chat_id: inboundChat, at: ts };

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
        `[channel-hook] undetermined ${channelKey}.default_chat_id — ${safe(chatId)} found no turn boundary in the last ${TAIL_BYTES} transcript bytes\n`
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

      const home = config.channels[channelKey].default_chat_id;
      const unseeded = home == null || home === '';
      // Seeding and two-way proof both concern the home chat; the eligibility check
      // walks the transcript tail, so other chats' replies skip it.
      const isInboundReply = !!chatId && (unseeded || String(chatId) === String(home))
        && isEligibleInboundReply(event, channelKey, chatId, config);
      if (unseeded) {
        // Snapshot before seeding so the audit attributes the home to this hook.
        const configBefore = structuredClone(config);
        if (seedDefaultChatId(config, channelKey, chatId, isInboundReply)) writeConfig(config, configBefore);
      }

      const ts = new Date().toISOString();
      const repliedHome = isInboundReply && String(chatId) === String(config.channels[channelKey].default_chat_id);
      updateLastReplyAt(channelKey, ts, repliedHome ? String(chatId) : undefined);
      appendReplyEvent(channelKey, ts);
    } catch (e) {
      // Silently ignore errors — don't block the agent
    }
  });
}

// Guard so importing this module (e.g. a unit test of seedDefaultChatId or
// isEligibleInboundReply) doesn't run the hook. Direct execution as a hook
// keeps import.meta.main true.
if (import.meta.main) main();
