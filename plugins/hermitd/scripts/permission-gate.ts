import { APPROVAL_FAILURE, APPROVAL_TIMEOUT, APPROVAL_WORKER } from '../mod/approval-messages';
import { agentId, hermitDir, sessionId } from './lib/cc-compat';
import { readSettledConfig } from './lib/config-read';
import { OVERSIZE, readHookInput } from './lib/hook-input';
import { residentMarker } from './model-switch-gate';

function deny(message: string) {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } };
}

export async function permissionGate(input: unknown, dir: string, sleep: (ms: number) => Promise<void>) {
  let gated = false;
  try {
    if (input === OVERSIZE || !input || typeof input !== 'object' || Array.isArray(input)) {
      if (readSettledConfig(dir).approvals === 'team') return deny(APPROVAL_FAILURE);
      return;
    }
    const id = sessionId(input);
    const resident = residentMarker(dir, id);
    const mode = resident ? resident.approvals : readSettledConfig(dir).approvals;
    if (mode !== 'team') return;
    if (agentId(input) != null || (!resident && process.env.CLAUDE_JOB_DIR)) return deny(APPROVAL_WORKER);
    if (!resident || !id) return;
    gated = true;
    const { run } = await import('./harness-mod');
    const policy = await run('park', id, '{"event":"prompt"}') as { decision: string; reason?: string; after_seconds?: number };
    if (policy.decision === 'pass') return;
    if (policy.decision === 'deny' && policy.reason) return deny(policy.reason);
    if (policy.decision === 'decline' && policy.after_seconds === 60) {
      await sleep(policy.after_seconds * 1000);
      return deny(APPROVAL_TIMEOUT);
    }
    return deny(APPROVAL_FAILURE);
  } catch {
    if (gated) return deny(APPROVAL_FAILURE);
  }
}

if (import.meta.main) {
  const input = await readHookInput();
  const result = await permissionGate(input, hermitDir(), ms => Bun.sleep(ms));
  if (result) console.log(JSON.stringify(result));
}
