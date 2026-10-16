// Shared <channel ...>body</channel> envelope parser — used by every
// UserPromptSubmit hook that reacts to an inbound channel message
// (the channel-reply-reminder, channel-status-responder and pause-keyword
// stages in lib/prompt-stages/).
// A single copy so the attribute regex and body-extraction rule can't drift
// out of sync between callers.
//
// Fields are returned raw (unclamped, unsanitized) — callers that display
// them (e.g. in an LLM-facing reminder) are responsible for their own
// sanitize/length-clamp; callers that only compare or log them (auth gates,
// episodic capture) use them as-is, matching pre-extraction behavior.

export interface ChannelEnvelope {
  attributes: string;
  source: string;
  /** `source` normalized to the config-key form — see normalizeChannelSource(). */
  sourceKey: string;
  chatId: string;
  /**
   * Canonical sender identity for auth gates — the `user_id` attribute when the
   * wire carries one, else `user`. Never match `user` when `user_id` is present:
   * `user` is an attacker-chosen display name (a Discord username can be all
   * digits), so accepting either would let a stranger impersonate an
   * allowlisted numeric id. Null when neither attribute carries a value, and
   * also when `user_id` is duplicated — both fail closed against a configured
   * allowlist.
   */
  userId: string | null;
  /** Raw `user` attribute — human-readable display name, never an auth input. */
  userName: string | null;
  messageId: string | null;
  /** The mapped `attributes.thread_id` value when the channel maps one and the tag carries exactly one. */
  thread: string | null;
  ts: string | null;
  body: string;
}

/**
 * The harness injects channel envelopes with a plugin-qualified source
 * (`plugin:<plugin-name>:<server-name>`, e.g. `plugin:discord:discord`,
 * `plugin:voice:voice` — verified live across every fleet hermit), but
 * `config.json` keys `channels` by the bare server name (what `hatch` writes).
 * Any lookup that indexes `config.channels` by an envelope's raw `source`
 * therefore misses for every real inbound message — the root cause of #634.
 *
 * Returns the captured server name for a two-segment `plugin:` source;
 * anything else (already-bare, or an unrecognized future shape) passes
 * through unchanged, so a caller's own lookup fails closed on unfamiliar
 * input rather than this function guessing.
 *
 * This is the single normalizer for the wire source shape: lib/trigger-source.ts's
 * classifySource calls it too (for cost-attribution bucketing), so config lookup
 * and cost attribution can't drift apart on how they parse a `plugin:` source.
 */
export function normalizeChannelSource(source: string): string {
  const m = /^plugin:[^:]+:([^:]+)$/.exec(source);
  return m ? m[1] : source;
}

/** Every value of a quoted attribute, in source order (`[]` when absent). */
function attrValues(attrs: string, name: string): string[] {
  const all = attrs.match(new RegExp(`\\b${name}="[^"]*"`, 'g')) ?? [];
  return all.map(a => a.slice(name.length + 2, -1));
}

/**
 * Parses a prompt that starts with a <channel source="..." chat_id="..." ...>
 * opening tag. Returns null when the prompt doesn't start with such a tag, or
 * when the mandatory chat_id attribute is absent.
 *
 * The attribute regex handles `>` inside quoted attribute values (e.g.
 * adversarial chat_id values containing XML-like tags).
 */
export function parseChannelEnvelope(prompt: string, config?: any): ChannelEnvelope | null {
  const tagMatch = prompt.match(/^\s*<channel\s+((?:"[^"]*"|[^>])*)\s*>/);
  if (!tagMatch) return null;

  const attrs = tagMatch[1];
  const sourceMatch = attrs.match(/\bsource="([^"]*)"/);
  const source = sourceMatch ? sourceMatch[1] : '';
  const sourceKey = normalizeChannelSource(source);
  const mapping = config?.channels?.[sourceKey]?.attributes;
  const chatIds = attrValues(attrs, mapping?.chat_id ?? 'chat_id');
  if (!chatIds.length) return null;
  // `user` is an attacker-chosen display name, so on a channel that doesn't
  // escape it a name containing a quote can close its own attribute and inject a
  // second `user_id="<allowlisted id>"`. A duplicated attribute therefore voids
  // that identity outright — first-match-wins would hand the gate the injected
  // copy, and falling back to `user` would hand it the very name that smuggled
  // it in. An empty (not duplicated) `user_id` is just a missing id, so it still
  // falls back.
  const userIds = attrValues(attrs, mapping?.user_id ?? 'user_id');
  const users = attrValues(attrs, mapping?.user ?? 'user');
  const userName = users.length === 1 ? users[0] || null : null;
  const userId = userIds.length > 1 ? null : userIds[0] || userName;
  const messageIds = attrValues(attrs, mapping?.message_id ?? 'message_id');
  const threads = mapping?.thread_id ? attrValues(attrs, mapping.thread_id) : [];
  const tsMatch = attrs.match(/\bts="([^"]*)"/);

  let body = prompt.slice(tagMatch[0].length);
  const closeIdx = body.indexOf('</channel>');
  if (closeIdx !== -1) body = body.slice(0, closeIdx);

  return {
    attributes: attrs,
    source,
    sourceKey,
    chatId: chatIds[0],
    userId,
    userName,
    messageId: messageIds[0] ?? null,
    thread: threads.length === 1 ? threads[0] : null,
    ts: tsMatch ? tsMatch[1] : null,
    body: body.trim(),
  };
}

/**
 * Best-effort human-readable sender label for display/logging — display name,
 * else the raw id, else the channel source, else 'channel'. Never an auth
 * input (see `userId` above); callers apply their own sanitize/length-clamp.
 */
export function senderLabel(env: ChannelEnvelope): string {
  // `source` is '' (not null) when the attribute is absent, so the last leg has
  // to be `||` — `??` would hand callers an empty label.
  return env.userName ?? env.userId ?? (env.source || 'channel');
}


/** Read one unambiguous attribute from the original channel tag. */
export function envelopeAttr(env: ChannelEnvelope, name: string): string | null {
  const values = attrValues(env.attributes, name);
  return values.length === 1 ? values[0] : null;
}
