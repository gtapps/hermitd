import { resolve as resolveHomeTarget } from '../resolve-outbound-channel';
import { conversationKey } from './conversation-key';
/** The home chat used for unattended operator contact. */
export function homeChatKey(channels: unknown): string | null {
  const target = resolveHomeTarget(channels);
  return target ? conversationKey(target.id, target.chat_id) : null;
}
