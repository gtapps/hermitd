import path from 'node:path';
import { ARG_RE, renderCommand } from './lib/harness-command';
import { enqueue } from './lib/harness-mod';
import { readRuntimeJson } from './lib/runtime';
import { exitError, failJson, printJson } from './lib/cli';

const [hermitDir, ...args] = process.argv.slice(2);
if (!hermitDir) exitError();
let model: string | undefined;
let effort: string | undefined;
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i];
  const value = args[i + 1];
  if (flag !== '--model' && flag !== '--effort') exitError('invalid_flag');
  if (!value || !ARG_RE.test(value)) exitError('invalid_argument');
  if (flag === '--model') model = value;
  else effort = value;
}
if (!model && !effort) exitError('missing_model_or_effort');
const root = path.resolve(hermitDir);
const runtime = readRuntimeJson(path.join(root, 'state'));
if (!runtime) exitError('no_runtime');
const commands = [
  ...(model ? [{ command: '/model', arg: model }] : []),
  ...(effort ? [{ command: '/effort', arg: effort }] : []),
];
try {
  const queued = enqueue(root, { source: 'terminal', by: 'terminal', commands });
  printJson(queued.status === 'queued' ? { status: 'armed', commands: commands.map(renderCommand) } : queued);
} catch (error) {
  failJson(error);
}
