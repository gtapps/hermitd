// Tool sign-in authority and delivery instructions, resolved at the tool boundary.
import { runHook } from './lib/hook-input';
import { turnConversation } from './settings-gate';

const INSTRUCTION = 'Do not show the sign-in link: a callback pasted in chat cannot finish this sign-in. Tell the asker an admin must reconnect the tool from the agent\'s terminal. Notify the admin through .hermit/bin/hermitd-run channel-send .hermit --notice with JSON {"maintainer":<request to reconnect the tool with /mcp at the agent\'s terminal, without the link>} on stdin. Count it as sent only if status is delivered. Make the reply reflect the send result.';

export function main(payload: any): void {
  const turn = turnConversation(payload);
  // A wake has no sender and no person at the keyboard, so it proves nothing about authority, and neither does a turn it joined.
  const origin = turn.kind !== 'unknown' && !turn.proven ? { kind: 'unknown' as const } : turn;
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
  // A session with a channel refuses a callback pasted into the conversation, so only /mcp at the terminal can finish.
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PostToolUse', additionalContext: INSTRUCTION,
  } }) + '\n');
}

if (import.meta.main) runHook(main, () => {
  // Oversize input cannot establish either the event or the sender's authority.
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'ask',
    permissionDecisionReason: 'Tool sign-in origin could not be proven: hook input too large.',
  } }) + '\n');
});
