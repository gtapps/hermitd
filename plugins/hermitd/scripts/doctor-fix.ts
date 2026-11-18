// Typed `/hermitd:doctor-fix`: runs this plugin's `hermitd doctor --fix` for the project
// and relays doctor's own lines. The exit code reflects remaining findings, not success.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pinStateDirOrExit } from './lib/cc-compat';
import { emitJson, exitError } from './lib/cli';
import { isContainer } from './lib/container';

const MAX_LINES = 40;

if (import.meta.main) {
  const [dirArg, ...extra] = process.argv.slice(2);
  if (!dirArg || extra.length) exitError();
  const hermitDir = pinStateDirOrExit(dirArg);
  if (isContainer()) emitJson({ status: 'refused', reason: 'host_only' });
  const result = spawnSync(process.execPath, [path.join(import.meta.dir, 'hermitd-cli.ts'), 'doctor', '--fix'], {
    cwd: path.dirname(hermitDir), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.split('\n').map(line => line.trimEnd()).filter(Boolean);
  emitJson({ status: 'done', exit_code: result.status ?? 1, lines: lines.slice(-MAX_LINES) });
}
