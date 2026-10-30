import fs from 'node:fs';
import path from 'node:path';
import { readConfigRaw } from './lib/config-read';
import { readChannelToken } from './lib/channel-token';
import { CHANNEL_PROBES } from './lib/channel-probe';

export async function preflight(hermitDir: string, channel: string) {
  const entry = readConfigRaw(hermitDir)?.channels?.[channel];
  let twoWay = 'not_proven';
  try {
    const activity = JSON.parse(fs.readFileSync(path.join(hermitDir, 'state/channel-activity.json'), 'utf8'));
    if (entry?.default_chat_id && activity[channel]?.last_inbound_reply?.chat_id === entry.default_chat_id) twoWay = 'proven';
  } catch {}
  const result = (status: 'ready' | 'action_needed' | 'not_checked', reason: string, fix: string, warnings: string[] = [], extra = {}) =>
    ({ status, reason, fix, warnings, two_way: twoWay, ...extra });
  if (!CHANNEL_PROBES[channel]) return result('not_checked', 'no_probe', 'follow_plugin_setup');
  const token = readChannelToken(hermitDir, channel, entry);
  if (!token) return result('action_needed', 'no_token', 'set_token');
  const probe = channel === 'discord' ? {
    url: `${process.env.HERMIT_DOCTOR_DISCORD_API || 'https://discord.com/api/v10'}/applications/@me`,
    headers: { Authorization: `Bot ${token}` },
  } : CHANNEL_PROBES[channel](token);
  try {
    const response = await fetch(probe.url, { headers: probe.headers, signal: AbortSignal.timeout(5000) });
    if (response.status === 401 || response.status === 403) return result('action_needed', 'token_rejected', 'replace_token');
    if (!response.ok) return result('action_needed', 'api_error', 'retry_check');
    const body: any = await response.json();
    if (channel === 'telegram' && body.ok !== true) return result('action_needed', 'token_rejected', 'replace_token');
    const warnings: string[] = [];
    let invite: string | undefined;
    if (channel === 'discord') {
      if (!body.id || !/^\d+$/.test(String(body.id))) return result('action_needed', 'invalid_response', 'retry_check');
      invite = `https://discord.com/oauth2/authorize?client_id=${body.id}&scope=bot&permissions=3072`;
      if (body.bot_public) warnings.push('bot_public');
      if (!(body.approximate_guild_count > 0)) warnings.push('no_guilds');
      if (!((Number(body.flags) || 0) & ((1 << 18) | (1 << 19)))) {
        return result('action_needed', 'message_content_intent_off', 'enable_message_content_intent', warnings, { invite });
      }
    }
    return result('ready', 'checks_passed', 'none', warnings, invite ? { invite } : {});
  } catch {
    return result('action_needed', 'probe_failed', 'check_network_and_retry');
  }
}

if (import.meta.main) {
  const [dir, channel] = process.argv.slice(2);
  if (!dir || !channel) { console.log(JSON.stringify({ error: 'usage' })); process.exitCode = 1; }
  else console.log(JSON.stringify(await preflight(path.resolve(dir), channel)));
}
