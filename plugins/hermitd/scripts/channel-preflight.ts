import fs from 'node:fs';
import path from 'node:path';
import { readConfigRaw } from './lib/config-read';
import { channelStateDir, readChannelToken } from './lib/channel-token';
import { CHANNEL_PREFLIGHTS } from './lib/channel-probe';

export async function preflight(hermitDir: string, channel: string) {
  const entry = readConfigRaw(hermitDir)?.channels?.[channel];
  let twoWay = 'not_proven';
  try {
    const activity = JSON.parse(fs.readFileSync(path.join(hermitDir, 'state/channel-activity.json'), 'utf8'));
    const proof = activity[channel]?.last_inbound_reply;
    // A reply older than the saved token came from whichever bot held the previous one.
    const tokenSavedAt = fs.statSync(path.join(channelStateDir(hermitDir, channel, entry), '.env'), { throwIfNoEntry: false })?.mtimeMs ?? 0;
    if (entry?.default_chat_id && proof?.chat_id === entry.default_chat_id && Date.parse(proof.at) >= tokenSavedAt) twoWay = 'proven';
  } catch {}
  const result = (status: 'ready' | 'action_needed' | 'not_checked', reason: string, fix: string, warnings: string[] = [], extra = {}) =>
    ({ status, reason, fix, warnings, two_way: twoWay, ...extra });
  const platform = CHANNEL_PREFLIGHTS[channel];
  if (!platform) return result('not_checked', 'no_probe', 'follow_plugin_setup');
  const token = readChannelToken(hermitDir, channel, entry);
  if (!token) return result('action_needed', 'no_token', 'set_token');
  const probe = platform.probe(token);
  try {
    const response = await fetch(probe.url, { headers: probe.headers, signal: AbortSignal.timeout(5000) });
    if (platform.rejected.includes(response.status)) return result('action_needed', 'token_rejected', 'replace_token');
    if (!response.ok) return result('action_needed', 'api_error', 'retry_check');
    const { failure, warnings = [], invite } = platform.inspect(await response.json());
    const extra = invite ? { invite } : {};
    if (failure) return result('action_needed', failure.reason, failure.fix, warnings, extra);
    return result('ready', 'checks_passed', 'none', warnings, extra);
  } catch {
    return result('action_needed', 'probe_failed', 'check_network_and_retry');
  }
}

if (import.meta.main) {
  const [dir, channel] = process.argv.slice(2);
  if (!dir || !channel) { console.log(JSON.stringify({ error: 'usage' })); process.exitCode = 1; }
  else console.log(JSON.stringify(await preflight(path.resolve(dir), channel)));
}
