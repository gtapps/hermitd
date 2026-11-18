import path from 'node:path';
import { pinStateDirOrExit } from './lib/cc-compat';
import { emitJson, exitError } from './lib/cli';
import { readConfigRaw } from './lib/config-read';
import { isGuest } from './lib/guest-marker';
import { parseExpectPairs, requestRestart } from './lib/request-restart';
import { readRuntimeJson } from './lib/runtime';

// A session launched from the resident's pane, or a `claude --bg` helper, inherits
// HERMIT_MANAGED, so only the SessionStart residency verdict (keyed by session id)
// tells the resident apart. An unknown id reads as resident, matching `isGuest`.
if (import.meta.main) {
  const [dirArg, ...flags] = process.argv.slice(2);
  if (!dirArg) exitError();
  const hermitDir = pinStateDirOrExit(dirArg);
  if (flags[0] !== '--when-quiet') {
    const check = flags[0] === '--check';
    const rest = check ? flags.slice(1) : flags;
    if (rest.length !== 0 && (rest.length !== 2 || rest[0] !== '--session-id' || !rest[1])) exitError();
    const guest = isGuest(path.join(hermitDir, 'state'), rest[1]);
    if (check) emitJson({ status: guest ? 'guest' : 'resident' });
    if (guest) emitJson({ status: 'refused', reason: 'guest_session' });
    if (!requestRestart(hermitDir, 'requested')) exitError('watchdog_missing');
    emitJson({ status: 'requested' });
  }
  const expect = parseExpectPairs(flags.slice(1));
  if (!expect) exitError();
  if (readConfigRaw(hermitDir)?.always_on !== true) emitJson({ status: 'refused', reason: 'interactive' });
  const runtime = readRuntimeJson(path.join(hermitDir, 'state'));
  if (!runtime) emitJson({ status: 'refused', reason: 'not_running' });
  if (!requestRestart(hermitDir, 'requested', { expect, boot: runtime.session_pid })) exitError('watchdog_missing');
  emitJson({ status: 'requested', when: 'quiet' });
}
