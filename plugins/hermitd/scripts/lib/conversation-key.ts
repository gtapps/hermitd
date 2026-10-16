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
