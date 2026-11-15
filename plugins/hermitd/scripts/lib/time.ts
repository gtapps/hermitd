// Returns 'HH:MM' in the given IANA timezone, or null on error.
// Normalises Intl's '24:xx' (some locales emit this for midnight) to '00:xx'.
// Optional ref date; defaults to now.
function currentHHMM(timezone: string, ref?: Date): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(ref || new Date());
    const h = String(parts.find(p => p.type === 'hour')?.value ?? '0').padStart(2, '0');
    const m = String(parts.find(p => p.type === 'minute')?.value ?? '0').padStart(2, '0');
    return (h === '24' ? '00' : h) + ':' + m;
  } catch {
    return null;
  }
}

// currentHHMM but guaranteed non-null: falls back to UTC 'HH:MM' on timezone error.
// Shared by the PreCompact hook and the watchdog, which both need a definite stamp.
function currentHHMMOrUTC(timezone: string, ref?: Date): string {
  return currentHHMM(timezone, ref) ?? (ref ?? new Date()).toISOString().slice(11, 16);
}

// Returns today (or `ref`) as 'YYYY-MM-DD' in the given timezone.
function todayYMD(timezone: string, ref: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(ref);
  } catch {
    return ref.toISOString().slice(0, 10);
  }
}

// Returns the calendar day before today (or before `ref`) as 'YYYY-MM-DD' in the given
// timezone. Resolve the local date first, then step back one calendar day on the date
// parts — never by subtracting 24h from the instant. A spring-forward day is only 23
// real hours, so instant arithmetic lands two calendar days back whenever the local
// time of day is smaller than the offset shift (00:30 local on the day after a
// forward jump). Date.UTC handles month and year rollover.
function yesterdayYMD(timezone: string, ref: Date = new Date()): string {
  const [y, m, d] = todayYMD(timezone, ref).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

// Returns the 'YYYY-MM' (year-month) for `ref` in the given timezone.
function thisMonthYYYYMM(timezone: string, ref: Date = new Date()): string {
  return todayYMD(timezone, ref).slice(0, 7);
}

// Extract {year, month, day} for `ref` as observed in `timezone`. Shared by
// thisWeekKey and nextBoundaryISO so both start from the same local calendar
// date. Falls back to UTC components on any Intl failure.
function localYMDParts(timezone: string, ref: Date): { y: number; mo: number; d: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(ref);
    const get = (t: string) => parseInt(parts.find(p => p.type === t)!.value, 10);
    return { y: get('year'), mo: get('month'), d: get('day') };
  } catch {
    return { y: ref.getUTCFullYear(), mo: ref.getUTCMonth() + 1, d: ref.getUTCDate() };
  }
}

// Returns the ISO-8601 week key ('YYYY-Www') for `ref`'s local calendar date
// in `timezone`. Uses the standard nearest-Thursday algorithm on the
// tz-resolved Y-M-D — day-of-week/week-number arithmetic needs only the
// calendar date, not a time-of-day, so this runs on a UTC-anchored Date
// purely as a calendar-math scratch value (no further tz lookups needed).
function thisWeekKey(timezone: string, ref: Date = new Date()): string {
  const { y, mo, d } = localYMDParts(timezone, ref);
  const date = new Date(Date.UTC(y, mo - 1, d));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const weekNum = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${date.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// Resolves the UTC instant at which `timezone` reads the given local wall-clock
// time (y-mo-d hh:mm:ss). Standard guess-and-correct approach (no tz database
// library available — Bun-stdlib-only): treat the wall-clock values as if they
// were already UTC, format that guess back through the real timezone, and
// shift by the observed delta. Converges in one correction for every real
// IANA zone (all of which have offsets constant across the correction window,
// bar the exact DST-transition second — an accepted, rare edge case).
function zonedTimeToUtcMs(y: number, mo: number, d: number, hh: number, mm: number, ss: number, timezone: string): number {
  const asUTC = Date.UTC(y, mo - 1, d, hh, mm, ss);
  let ms = asUTC;
  for (let i = 0; i < 2; i++) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(new Date(ms));
      const get = (t: string) => parseInt(parts.find(p => p.type === t)!.value, 10);
      const observedUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
      const diff = asUTC - observedUTC;
      if (diff === 0) break;
      ms += diff;
    } catch {
      return asUTC;
    }
  }
  return ms;
}

// Returns the ISO instant of the next calendar boundary (local midnight) after
// `ref`, in `timezone`: 'day' -> tomorrow, 'week' -> next Monday (always a full
// week ahead if `ref` itself is a Monday), 'month' -> the 1st of next month.
// Used to compute a budget pause's auto-resume point.
function nextBoundaryISO(timezone: string, unit: 'day' | 'week' | 'month', ref: Date = new Date()): string {
  const { y, mo, d } = localYMDParts(timezone, ref);
  let ny = y, nmo = mo, nd = d;
  if (unit === 'day') {
    nd += 1;
  } else if (unit === 'week') {
    const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay(); // 0=Sun..6=Sat
    const daysUntilMonday = ((1 - dow) + 7) % 7 || 7; // always strictly ahead, even if ref is Monday
    nd += daysUntilMonday;
  } else {
    nmo += 1;
    nd = 1;
  }
  // Normalize month/day overflow (e.g. nmo=13, or nd past the month's length)
  // via a UTC Date — JS Date arithmetic auto-rolls these correctly.
  const norm = new Date(Date.UTC(ny, nmo - 1, nd));
  const ms = zonedTimeToUtcMs(norm.getUTCFullYear(), norm.getUTCMonth() + 1, norm.getUTCDate(), 0, 0, 0, timezone);
  return new Date(ms).toISOString();
}

// Local timestamp in Python's time.strftime('%Y-%m-%dT%H:%M:%S%z') shape
// (no colon in the offset) — runtime.json's established format.
function localISOStamp(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}

// UTC timestamp in Python's time.strftime('%Y-%m-%dT%H:%M:%SZ', gmtime()) shape.
function utcISOStamp(ref?: Date): string {
  return (ref ?? new Date()).toISOString().slice(0, 19) + 'Z';
}

// HHMMSS (6 digits) in `timezone`, or UTC on any Intl failure. Normalises Intl's
// '24' hour (some locales emit this for midnight) to '00', matching currentHHMM's
// convention above. Used by lib/prop-id.ts for the proposal-ID timestamp suffix.
// `now` is injectable so collision-suffix behavior is deterministically testable.
function nowHHMMSS(timezone: string, now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(now);
    const get = (t: string) => String(parts.find(p => p.type === t)?.value ?? '0').padStart(2, '0');
    const h = get('hour') === '24' ? '00' : get('hour');
    return h + get('minute') + get('second');
  } catch {
    return now.toISOString().slice(11, 19).replace(/:/g, '');
  }
}

// ISO 8601 with a colon-delimited offset (e.g. `2026-07-20T11:12:08+01:00`) in
// `timezone`, or `+00:00` on any Intl failure — the proposal frontmatter/Operator
// Decision timestamp convention. Distinct from localISOStamp (process-local tz,
// no-colon offset — runtime.json's format) and utcISOStamp (always UTC, `Z` suffix).
// Intl's `timeZoneName: 'longOffset'` emits `GMT+01:00` / bare `GMT` for UTC —
// strip the `GMT` prefix and map bare `GMT` to `+00:00`.
function zonedISOStamp(timezone: string, d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      timeZoneName: 'longOffset',
    }).formatToParts(d);
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
    const hour = get('hour') === '24' ? '00' : get('hour');
    const offsetRaw = get('timeZoneName').replace(/^GMT/, '');
    const offset = offsetRaw === '' ? '+00:00' : offsetRaw;
    return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}${offset}`;
  } catch {
    return d.toISOString().replace(/\.\d{3}Z$/, '+00:00');
  }
}

// Parses a duration string like "30s", "5m", "2h" to milliseconds.
// Returns defaultMs on any parse failure.
function parseDuration(str: unknown, defaultMs: number): number {
  if (typeof str !== 'string') return defaultMs;
  const m = str.trim().match(/^(\d+)\s*([smh])$/i);
  if (!m) return defaultMs;
  const mult = ({ s: 1000, m: 60000, h: 3600000 } as Record<string, number>)[m[2].toLowerCase()];
  return parseInt(m[1], 10) * mult;
}

// Elapsed ms from a date-less 'HH:MM' stamp to `nowHHMM`, resolved as the
// stamp's most recent past occurrence (mod 24h) — a stamp numerically after
// nowHHMM is yesterday's, not the future. Used where a Progress Log's [HH:MM]
// entries carry no date.
function elapsedSinceHHMM(nowHHMM: string, stampHHMM: string): number {
  const toMin = (s: string) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  let diffMin = toMin(nowHHMM) - toMin(stampHHMM);
  if (diffMin < 0) diffMin += 1440;
  return diffMin * 60000;
}

// Parse the minute/hour fields of a simple numeric 5-field cron schedule
// (e.g. "0 0 * * *"). Shared by hermitd-watchdog.ts (cron proximity)
// and the channel-status-responder stage (next-routine line) — both only need the
// fixed-time case, not full cron range/step/list support.
function parseSimpleCronTime(schedule: string): { hour: number; minute: number } | null {
  const parts = String(schedule).trim().split(/\s+/);
  if (parts.length < 2) return null;
  const minute = parseInt(parts[0], 10);
  const hour = parseInt(parts[1], 10);
  if (isNaN(minute) || isNaN(hour) || minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  return { hour, minute };
}

// Friendly "YYYY-MM-DD HH:MM" rendering of an ISO instant in `timezone`. Plain
// HH:MM is ambiguous for a resume boundary that's days or weeks out ("until 00:00"
// reads as minutes away), so pause/budget messages that print an auto-resume time
// use this dated form.
function friendlyBoundary(iso: string, timezone: string): string {
  const d = new Date(iso);
  const date = todayYMD(timezone, d);
  const hhmm = currentHHMM(timezone, d) ?? '';
  return `${date} ${hhmm}`.trim();
}

// Resolves "now" as epoch ms: real wall-clock, overridable by HERMIT_NOW for
// deterministic tests. Same override convention as archive-shell.ts/
// lib/routines/due.ts (which return Date) — centralized here so
// a caller wanting an epoch number doesn't need its own inline copy.
function resolveHermitNowMs(): number {
  if (process.env.HERMIT_NOW) {
    const d = new Date(process.env.HERMIT_NOW).getTime();
    if (!isNaN(d)) return d;
  }
  return Date.now();
}

export { currentHHMM, currentHHMMOrUTC, nowHHMMSS, zonedISOStamp, todayYMD, yesterdayYMD, thisWeekKey, thisMonthYYYYMM, nextBoundaryISO, localISOStamp, utcISOStamp, parseDuration, parseSimpleCronTime, friendlyBoundary, resolveHermitNowMs, elapsedSinceHHMM };

// Both presentation and scheduling must accept a stored zone.
export function isUsableTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    Bun.cron.parse('0 0 * * *', new Date(), { tz: value });
    return true;
  } catch {
    return false;
  }
}

export function machineTimeZone(): string | null {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isUsableTimeZone(zone) ? zone : null;
}
