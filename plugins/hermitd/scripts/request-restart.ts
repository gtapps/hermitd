import path from 'node:path';
import { pinStateDirOrExit } from './lib/cc-compat';
import { emitJson, exitError, readJson } from './lib/cli';
import { readConfigRaw } from './lib/config-read';
import { parseExpectPairs, requestRestart } from './lib/request-restart';

if (import.meta.main) {
  const [dirArg, ...flags] = process.argv.slice(2);
  if (!dirArg) exitError();
  const hermitDir = pinStateDirOrExit(dirArg);
  if (!flags.length) {
    if (!requestRestart(hermitDir, 'requested')) exitError('watchdog_missing');
    emitJson({ status: 'requested' });
  }
  const expect = flags[0] === '--when-quiet' ? parseExpectPairs(flags.slice(1)) : null;
  if (!expect) exitError();
  if (readConfigRaw(hermitDir)?.always_on !== true) emitJson({ status: 'refused', reason: 'interactive' });
  const runtime = readJson(path.join(hermitDir, 'state', 'runtime.json'));
  if (!runtime) emitJson({ status: 'refused', reason: 'not_running' });
  if (!requestRestart(hermitDir, 'requested', { expect, boot: runtime.session_pid })) exitError('watchdog_missing');
  emitJson({ status: 'requested', when: 'quiet' });
}
