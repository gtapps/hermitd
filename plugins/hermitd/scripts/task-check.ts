import path from 'node:path';
import { hermitDir } from './lib/cc-compat';
import { runEvidence } from './lib/evidence-runner';
import { scanForInjection } from './lib/injection-scan';
import { mutateTask, reportTaskError, TASK_ID } from './lib/tasks';

async function main(): Promise<void> {
  const [id, ...extra] = process.argv.slice(2);
  if (!id || !TASK_ID.test(id) || extra.length) throw new Error('invalid_id');
  const dir = hermitDir();
  const snapshot = mutateTask(dir, 'check-snapshot', id, {}, '') as { check: string | null; result_rev: number; status: string };
  if (snapshot.status !== 'open' || !snapshot.check) throw new Error('no_open_check');
  const hit = scanForInjection(snapshot.check);
  const result = hit
    ? { exit: 1, output: `injection-suspect:${hit.cls}` }
    : await runEvidence(snapshot.check, path.dirname(dir), 30);
  // Recorded in-process, never through task.ts: task.ts is pre-approved, so a CLI verb would let
  // a turn close a task by check without running it. Each mutateTask call holds the lock briefly.
  console.log(JSON.stringify(mutateTask(dir, 'check-result', id, {
    'result-rev': String(snapshot.result_rev), exit: String(result.exit), 'output-stdin': true,
  }, result.output)));
}
main().catch(reportTaskError);
