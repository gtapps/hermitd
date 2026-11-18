import { pinStateDirOrExit } from './lib/cc-compat';
import { emitJson, exitError } from './lib/cli';
import { requestRestart } from './lib/request-restart';

if (import.meta.main) {
  const [hermitDir, ...extra] = process.argv.slice(2);
  if (!hermitDir || extra.length) exitError();
  if (!requestRestart(pinStateDirOrExit(hermitDir), 'requested')) exitError('watchdog_missing');
  emitJson({ status: 'requested' });
}
