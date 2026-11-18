// Hosts the netguard DNS allowlist carries for enabled features. Shared by the
// security overlay renderer and doctor so the rendered list and the health
// check agree on what an enabled channel or transcription needs.

import { getEnabledChannels } from './channel-config';

type Json = any;

/** Hosts each channel's API needs; channels not listed contribute none. */
const CHANNEL_DOMAINS: Record<string, string[]> = {
  discord: ['discord.com', 'discordapp.com', 'discord.gg'],
  telegram: ['telegram.org'],
};

/** Voice-note engine and model downloads, plus the credential-enabled cloud fallback. */
const TRANSCRIPTION_DOMAINS = [
  'archive.ubuntu.com', 'ports.ubuntu.com', 'huggingface.co', 'hf.co', 'api.groq.com', 'api.openai.com',
];

/** Every host a built-in feature can add, enabled or not. */
export const BUILTIN_FEATURE_HOSTS: readonly string[] = [...Object.values(CHANNEL_DOMAINS).flat(), ...TRANSCRIPTION_DOMAINS];

/** Allowlist domains the settled config's enabled features need, by group. */
export function featureDomains(config: Json): { channels: string[]; transcription: string[] } {
  return {
    channels: getEnabledChannels(config).flatMap((c) => CHANNEL_DOMAINS[c] ?? []),
    transcription: config.transcription?.enabled !== false ? TRANSCRIPTION_DOMAINS : [],
  };
}
