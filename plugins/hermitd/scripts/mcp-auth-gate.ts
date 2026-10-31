// Tool sign-in authority and delivery instructions, resolved at the tool boundary.
import { runHook } from './lib/hook-input';
import { turnConversation } from './settings-gate';
import { readConfigRaw } from './lib/config-read';
import { hermitDir } from './lib/cc-compat';
import { resolveMaintainerTarget } from './resolve-outbound-channel';

const LINK_MESSAGE = 'Every message containing a sign-in link must say: paste the callback address back in a chat that reaches the agent; the account used serves every chat and routine, so prefer a dedicated account over a personal login; forward the link if the tool belongs to someone else\'s account.';
const NOTICE = '.hermit/bin/hermitd-run channel-send .hermit --notice';
const DELIVERY = 'Count it as sent only if status is delivered and result.maintainer.route is maintainer_channel. For any other result, report the failure to the asker and stop; never fall back to the asking chat.';

export function main(payload: any): void {
  const origin = turnConversation(payload);
  if (payload.hook_event_name === 'PreToolUse') {
    if (origin.kind === 'terminal' || (origin.kind === 'channel' && origin.canCompleteAuthentication)) return;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: origin.kind === 'channel' ? 'deny' : 'ask',
      permissionDecisionReason: origin.kind === 'channel'
        ? 'Only an admin may complete tool sign-in. Ask an admin to reconnect the tool.'
        : 'Tool sign-in origin could not be proven. An approver must authorize binding this account.',
    } }) + '\n');
    return;
  }
  if (payload.hook_event_name !== 'PostToolUse' || origin.kind === 'terminal') return;
  // An unproven origin may be a chat, so it gets the non-admin handling.
  const admin = origin.kind === 'channel' && origin.canCompleteAuthentication;
  const maintainer = resolveMaintainerTarget(readConfigRaw(hermitDir())?.channels);
  let instruction: string;
  if (maintainer) {
    instruction = `Do not show the sign-in link in the asking chat. Send the link to the admin through ${NOTICE}, with JSON {"maintainer":<link message>,"sensitive":true} on stdin. ${DELIVERY} ${LINK_MESSAGE}`;
    if (!admin) instruction += ' Tell the asker an admin must reconnect the tool.';
  } else if (admin) {
    instruction = `Show the sign-in link here. ${LINK_MESSAGE}`;
  } else {
    instruction = `Do not show the sign-in link. Tell the asker an admin must reconnect the tool. Notify the admin through ${NOTICE} with JSON {"maintainer":<request to reconnect, without the link>,"sensitive":true} on stdin. Count it as sent only if status is delivered. Make the reply reflect the send result.`;
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PostToolUse', additionalContext: instruction,
  } }) + '\n');
}

if (import.meta.main) runHook(main, () => {
  // Oversize input cannot establish either the event or the sender's authority.
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'ask',
    permissionDecisionReason: 'Tool sign-in origin could not be proven: hook input too large.',
  } }) + '\n');
});
