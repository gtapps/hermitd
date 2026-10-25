import fs from 'node:fs';
import path from 'node:path';
import { agentId, hermitDir, sessionId } from './lib/cc-compat';
import { isGuest } from './lib/guest-marker';
import { runHook } from './lib/hook-input';
import { skillTarget } from './skill-guard';

runHook(payload => {
  const hermit = hermitDir();
  const state = path.join(hermit, 'state');
  if (agentId(payload) || isGuest(state, sessionId(payload)) || skillTarget(payload, hermit)) return;
  fs.appendFileSync(path.join(state, 'skill-review-counter'), '1');
});
