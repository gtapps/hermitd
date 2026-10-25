import fs from 'node:fs';
import path from 'node:path';
import { agentId, hermitDir, sessionId } from './lib/cc-compat';
import { isGuest } from './lib/guest-marker';
import { runHook } from './lib/hook-input';
import { REVIEW_CALLS } from './lib/learned-skills';
import { skillTarget } from './skill-guard';

runHook(payload => {
  const hermit = hermitDir();
  const state = path.join(hermit, 'state');
  if (agentId(payload) || isGuest(state, sessionId(payload)) || skillTarget(payload, hermit)) return;
  const counter = path.join(state, 'skill-review-counter');
  // Only reaching the threshold matters; stop growing once it is met.
  try { if (fs.statSync(counter).size >= REVIEW_CALLS) return; } catch { /* first call */ }
  fs.appendFileSync(counter, '1');
});
