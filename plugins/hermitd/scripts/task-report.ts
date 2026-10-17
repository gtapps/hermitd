import { assertStateDir, pinStateDirOrExit } from './lib/cc-compat';
import { readTaskReports } from './lib/task-report';

try {
  const [dirArg, ...args] = process.argv.slice(2);
  if (!dirArg || !assertStateDir(dirArg)) throw new Error('invalid_state_dir');
  let limit = 20;
  let recent = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--recent') recent = true;
    else if (arg === '--limit') limit = Number(args.shift());
    else throw new Error('invalid_arguments');
  }
  if (!Number.isInteger(limit) || limit < 1) throw new Error('invalid_limit');
  const records = readTaskReports(pinStateDirOrExit(dirArg, 'task-report'))
    .filter(record => !recent || record.outcome !== 'open')
    .sort((a, b) => (b.closed_at ?? b.opened_at).localeCompare(a.closed_at ?? a.opened_at));
  console.log(JSON.stringify({ rows: records.slice(0, limit), total: records.length, omitted: Math.max(0, records.length - limit) }));
} catch (error: any) { console.error(error.message); process.exitCode = 2; }
