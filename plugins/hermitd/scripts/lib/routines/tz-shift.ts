// `routines.ts tz-shift "<cron-expr>" "<from-tz>"` — rewrites a 5-field cron
// expression from one IANA timezone to the machine's local timezone.
// Stdout: {"cron":"<shifted>"}, or the original cron plus `"warning":"unshiftable_cron"`
// and a prose `detail` when it passes through unchanged. A malformed cron or an unparseable
// HERMIT_CRON_TZ_SHIFT_NOW prints {"error":...} at exit 1.
//
// The shift arithmetic itself lives in lib/cron-shift.ts, shared with
// lib/routines/registry.ts; this is only its CLI face.

import { validateCronSchedule } from '../../validate-config';
import { shiftCron } from '../cron-shift';
import { exitError, printJson } from '../cli';

function resolveMachineTz(): string | null {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; }
  catch { return null; }
}

export function run(args: string[]): void {
  const [cronExpr, fromTz] = args;

  if (!cronExpr) exitError();

  let ref: Date;
  if (process.env.HERMIT_CRON_TZ_SHIFT_NOW) {
    ref = new Date(process.env.HERMIT_CRON_TZ_SHIFT_NOW);
    if (isNaN(ref.getTime())) exitError('invalid_now');
  } else {
    ref = new Date();
  }

  const validErr = validateCronSchedule(cronExpr);
  if (validErr) exitError(`invalid_cron:${validErr}`);

  const machineTz = resolveMachineTz();
  if (!machineTz) {
    printJson({ cron: cronExpr, warning: 'unshiftable_cron', detail: 'could not resolve machine timezone' });
    return;
  }

  const { result, warn } = shiftCron(cronExpr, fromTz || '', machineTz, ref);
  printJson(warn ? { cron: result, warning: 'unshiftable_cron', detail: warn } : { cron: result });
}
