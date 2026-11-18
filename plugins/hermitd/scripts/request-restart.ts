import path from 'node:path';
import { pinStateDirOrExit } from './lib/cc-compat';
import { emitJson, exitError } from './lib/cli';
import { isGuest } from './lib/guest-marker';
import { requestRestart } from './lib/request-restart';

// A session launched from the resident's pane, or a `claude --bg` helper, inherits
// HERMIT_MANAGED, so only the SessionStart residency verdict (keyed by session id)
// tells the resident apart. An unknown id reads as resident, matching `isGuest`.
if (import.meta.main) {
  const [hermitDir, ...rest] = process.argv.slice(2);
  const check = rest[0] === '--check';
  const flags = check ? rest.slice(1) : rest;
  if (!hermitDir || (flags.length !== 0 && (flags.length !== 2 || flags[0] !== '--session-id'))) exitError();
  const dir = pinStateDirOrExit(hermitDir);
  const guest = isGuest(path.join(dir, 'state'), flags[1]);
  if (check) emitJson({ status: guest ? 'guest' : 'resident' });
  else if (guest) emitJson({ status: 'refused', reason: 'guest_session' });
  else if (!requestRestart(dir, 'requested')) exitError('watchdog_missing');
  else emitJson({ status: 'requested' });
}
