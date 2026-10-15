// Reading the channels{} block of config.json. Shared by the booter and doctor
// so neither has to import the other.

type Json = any;

/** A valid POSIX shell / env-var identifier. Re-exported by validate-config.ts. */
export const ENV_VAR_RE = /^[A-Z_][A-Z0-9_]*$/;

/** Channels `lib/channel-send.ts` can POST to directly; keep in step with its SENDERS. */
export const DIRECT_SEND_CHANNELS: readonly string[] = ['telegram', 'discord'];

/** Python-style truthiness: empty arrays/objects/strings are falsy. */
export function pyTruthy(v: Json): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === 'object') return Object.keys(v).length > 0;
  return Boolean(v);
}

export function isDict(v: Json): boolean {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** Yield [name, cfg] for channels whose config is a valid dict. */
export function* iterChannelConfigs(config: Json): Generator<[string, Json]> {
  const channels = 'channels' in config ? config.channels : {};
  if (!isDict(channels)) return;
  for (const [name, cfg] of Object.entries(channels)) {
    if (isDict(cfg)) yield [name, cfg];
  }
}

/** Return list of enabled channel names. */
export function getEnabledChannels(config: Json): string[] {
  const names: string[] = [];
  for (const [name, cfg] of iterChannelConfigs(config)) {
    if (pyTruthy('enabled' in cfg ? cfg.enabled : true)) names.push(name);
  }
  return names;
}

/**
 * `<NAME>_STATE_DIR` env key for a channel, or null when the name is not a
 * valid shell identifier. Both bare-host boot paths write these as
 * unquotable `export <key>=...` lines in a sourced env file, so an invalid
 * name must never reach one — it would abort the boot, and a hostile one
 * could inject a command. `apply-settings.ts`'s `channel-env` op must reject
 * the same names at setup time rather than writing a key hermitd-start will
 * silently refuse to export.
 */
export function channelStateDirKey(chName: string): string | null {
  const key = `${chName.toUpperCase()}_STATE_DIR`;
  return ENV_VAR_RE.test(key) ? key : null;
}
