// Typed `/hermitd:hermit-update`: runs the project's updater without its prompt and
// reports the history row it wrote. The updater requests the follow-up restart itself.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pinStateDirOrExit } from './lib/cc-compat';
import { emitJson, exitError } from './lib/cli';
import { isContainer } from './lib/container';

function historyLines(file: string): string[] {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
}

if (import.meta.main) {
  const [dirArg, ...extra] = process.argv.slice(2);
  if (!dirArg || extra.length) exitError();
  const hermitDir = pinStateDirOrExit(dirArg);
  if (isContainer()) emitJson({ status: 'refused', reason: 'host_only' });
  const history = path.join(hermitDir, 'state', 'update-history.jsonl');
  const before = historyLines(history).length;
  const result = spawnSync(path.join(hermitDir, 'bin', 'hermitd-update'), ['--yes'], {
    cwd: path.dirname(hermitDir), stdio: ['ignore', 'ignore', 'ignore'],
  });
  const after = historyLines(history);
  let update: unknown = null;
  if (after.length > before) {
    try { update = JSON.parse(after[after.length - 1]!); } catch { update = null; }
  }
  emitJson({ status: 'done', exit_code: result.status ?? 1, update });
}
