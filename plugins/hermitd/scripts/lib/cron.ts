// 5-field cron schedules evaluated by Bun.cron.parse in a target timezone (null tz → machine-local).
// Hermit keeps its numeric dialect: a schedule validateCronSchedule rejects (names, macros, DOM and
// DOW both restricted) never fires, and neither does an unknown timezone, so callers fail closed.
import { validateCronSchedule } from '../validate-config';

function nextAfter(schedule: string, tz: string | null, after: Date): Date | null {
  try {
    return Bun.cron.parse(schedule, after, tz === null ? {} : { tz });
  } catch {
    return null; // unknown timezone
  }
}

/** First fire strictly after `after`, or null. */
export function nextFire(schedule: string, tz: string | null, after: Date): Date | null {
  return validateCronSchedule(schedule) ? null : nextAfter(schedule, tz, after);
}

/** Up to the `count` latest fires in (from, until], oldest first. */
export function latestFires(schedule: string, tz: string | null, from: Date, until: Date, count: number): Date[] {
  if (validateCronSchedule(schedule)) return [];
  const fires: Date[] = [];
  for (let d = nextAfter(schedule, tz, from); d && d.getTime() <= until.getTime(); d = nextAfter(schedule, tz, d)) {
    fires.push(d);
    if (fires.length > count) fires.shift();
  }
  return fires;
}
