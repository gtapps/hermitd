// `<sourceKey>:<chat_id>`. The source half is a config key, so it stays bare word
// characters; the chat-id half has to admit what real channels hand out — Discord
// snowflakes and Telegram's negative ids, but also iMessage GUIDs (`iMessage;-;+1555…`)
// and whatever a marketplace channel plugin supplies. The charset stays free of
// whitespace, colons, and markup so the key can still be interpolated into
// model-facing context and split back apart on its single separator.
export function isKey(key: unknown): key is string {
  return typeof key === 'string' && /^[\w-]+:[\w.~+@;=-]{1,128}$/.test(key);
}

export function checkKey(key: string): void {
  if (!isKey(key)) throw new Error('invalid_key');
}


export function conversationKey(sourceKey: string, chatId: string, thread?: string | null): string {
  return `${sourceKey}:${chatId}${thread == null ? '' : `~${thread}`}`;
}

/** Take a key apart: the first `:` ends the source, the first `~` after it starts the thread. Does not validate. */
export function parseKey(key: string): { source: string; chat: string; thread?: string } {
  const colon = key.indexOf(':');
  const rest = key.slice(colon + 1);
  const tilde = rest.indexOf('~');
  return {
    source: colon < 0 ? key : key.slice(0, colon),
    chat: tilde < 0 ? rest : rest.slice(0, tilde),
    thread: tilde < 0 ? undefined : rest.slice(tilde + 1),
  };
}

/** The key without its thread: the whole chat a thread belongs to. */
export function baseChat(key: string): string {
  const tilde = key.indexOf('~');
  return tilde < 0 ? key : key.slice(0, tilde);
}
