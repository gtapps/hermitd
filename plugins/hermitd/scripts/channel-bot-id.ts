// channel-bot-id.ts — capture a channel bot's own platform identity.
//
// A mention-gated channel guarantees the inbound message mentions the bot, but
// nothing tells the model which id is "me": the envelope carries the *sender*
// only, and the channel plugin keeps its own account in memory (never in
// access.json). So a hermit can read `<@its-own-id>` and conclude the request
// belongs to somebody else. This script asks the platform who the token
// belongs to and records it under the channel's config entry, where
// lib/prompt-stages/channel-reply-reminder.ts can surface it.
//
// Run at pairing time (channel-setup / docker-setup) and by hermit-evolve's
// backfill. Best-effort by contract: any failure prints
// {"status":"skip","reason":"<token>","channel":…} and exits 0, because a hermit
// that can't learn its own id must still finish setup. Success prints
// {"channel","bot_user_id","bot_username","written"}.
//
// Usage: bun channel-bot-id.ts <hermit-dir> <channel> [--write]
//
// The bot token never reaches stdout: Telegram embeds it in the probe URL, so
// no URL and no fetch error message is ever printed — only a fixed reason.

import fs from 'node:fs';
import path from 'node:path';
import { readConfigRaw } from './lib/config-read';
import { auditConfigChange } from './lib/config-audit';
import { readChannelToken } from './lib/channel-token';
import { CHANNEL_PROBES, extractBotIdentity } from './lib/channel-probe';
import { emitJson, exitError } from './lib/cli';

const TIMEOUT_MS = Number(process.env.HERMIT_DOCTOR_LIVENESS_TIMEOUT_MS) || 5000;

function skip(channel: string | undefined, reason: string): never {
  return emitJson({ status: 'skip', reason, channel: channel ?? null });
}

async function main(): Promise<void> {
  // Positionals only — a `--write` written before them (the natural flag order)
  // must not be read as the hermit dir.
  const [hermitDirArg, channel] = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const write = process.argv.includes('--write');
  if (!hermitDirArg || !channel) exitError();

  const hermitDir = path.resolve(hermitDirArg);
  const config = readConfigRaw(hermitDir);
  const entry = config?.channels?.[channel];
  if (!entry || typeof entry !== 'object') skip(channel, 'no_channel_entry');

  const buildProbe = CHANNEL_PROBES[channel];
  // Not an error: iMessage has no bot account to ask about, and a third-party
  // channel has no probe here. Both still work — the reminder matches whatever
  // the entry carries, so the operator can set the keys by hand.
  if (!buildProbe) skip(channel, 'no_identity_probe');

  const token = readChannelToken(hermitDir, channel, entry);
  if (!token) skip(channel, 'no_token');

  const probe = buildProbe(token);
  let body: any;
  try {
    const resp = await fetch(probe.url, { headers: probe.headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!resp.ok) skip(channel, `http_${resp.status}`);
    body = await resp.json();
  } catch (e: any) {
    // Never interpolate the error: a Telegram fetch failure can echo the URL,
    // and the URL carries the token.
    skip(channel, e?.name === 'TimeoutError' ? 'probe_timeout' : 'probe_network_error');
  }

  const { id, username } = extractBotIdentity(channel, body);
  if (!id) skip(channel, 'no_bot_id');

  let written = false;
  if (write) {
    // Merge into the existing entry — never replace it. Re-running setup after
    // a bot swap must overwrite a stale id, so this is write-always, not
    // write-once.
    const before = structuredClone(config);
    entry.bot_user_id = id;
    if (username) entry.bot_username = username;
    else delete entry.bot_username;
    // Atomic write, matching every other config.json writer (hatch-config.ts,
    // evolve-finalize.ts, settings-edit.ts): a torn write must never leave the
    // file unparseable for every later run.
    const configPath = path.join(hermitDir, 'config.json');
    const tmp = configPath + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, configPath);
    } catch {
      // Same cleanup the sibling writers do: a failed write must not leave a
      // half-written config.json.tmp behind in the state dir.
      try { fs.unlinkSync(tmp); } catch {}
      skip(channel, 'config_write_failed');
    }
    auditConfigChange(hermitDir, before, config, 'channel-bot-id');
    written = true;
  }

  emitJson({ channel, bot_user_id: id, bot_username: username ?? null, written });
}

main().catch(() => skip(undefined, 'capture_failed'));
