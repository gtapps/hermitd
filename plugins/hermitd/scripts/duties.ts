import { pinStateDirOrExit } from './lib/cc-compat';
import { exitError, printJson } from './lib/cli';
import { dutyRows } from './lib/duty-summary';
import { deriveDuties, recordWatchDuty, reportTaskError } from './lib/tasks';

try {
  const [verb, dirArg, ...args] = process.argv.slice(2);
  if (!dirArg) exitError();
  const dir = pinStateDirOrExit(dirArg);
  if (verb === 'summary' && args.length === 0) printJson({ rows: dutyRows(dir) });
  else if (verb === 'list' && args.every(arg => arg === '--json')) console.log(JSON.stringify({ rows: deriveDuties(dir) }));
  else if (verb === 'record' && args.length === 4 && args[0] === 'watch' && args[2] === '--verdict' && args[1] && args[3].trim()) {
    recordWatchDuty(dir, args[1], args[3]);
    console.log(JSON.stringify({ id: args[1], last_verdict: args[3] }));
  } else throw new Error('invalid_arguments');
} catch (error) { reportTaskError(error); }
