#!/usr/bin/env bun
/**
 * fitness-lab — deterministic statistics + CRUD for the fitness hermit.
 *
 * Moves every reproducible Strava computation out of skill prose so raw streams
 * never enter model context and the metrics are reproducible. Skills call one
 * subcommand and interpret the JSON; the coaching narrative stays in the skill.
 *
 * Shape mirrors docker-preflight.ts: pure exported functions + an
 * `if (import.meta.main)` CLI. Zero runtime deps — only node:*, Bun/global fetch.
 *
 * Subcommands (each prints one JSON object, or bare OK, to stdout):
 *   analyze <activity-id|latest>   per-activity metrics
 *   weekly-load [--weeks N]         summary-activity load aggregation (default 4)
 *   weekly-patterns                 filesystem-only cardiac-drift trend (no token)
 *   rpe <activity-id|latest> <rpe> [notes...]   upsert subjective RPE + notes
 *   env-check                       hatch: which Strava .env keys are missing (names only)
 *   mcp-config                      hatch: write the strava entry into .mcp.json (no values printed)
 *
 * Common flags:
 *   --project-root <path>   default process.cwd(); .env + .hermit/ live there
 *
 * Env:
 *   STRAVA_API_BASE     test seam; default https://www.strava.com/api/v3
 *   STRAVA_MCP_CONFIG   test seam; default ~/.config/strava-mcp/config.json
 *
 * Token resolution (getAccessToken): the Strava MCP server (@r-huijts/strava-mcp-server)
 * auto-refreshes the OAuth token on 401 and persists it to its own config file
 * (STRAVA_MCP_CONFIG), independent of this project's .env. To avoid reading a token
 * that's gone stale the moment the MCP server refreshes, getAccessToken prefers a
 * non-expired token from that config file and falls back to <project-root>/.env's
 * STRAVA_ACCESS_TOKEN (read-only parse) only when the config file is absent, unparseable,
 * or its token is expired.
 *
 * Error contract (deliberately NOT docker-preflight's always-exit-0 — the skill
 * must branch on hard auth failure):
 *   success                    → exit 0
 *   HTTP 401/403 or no token   → {"error":"strava_auth:<recovery>"} exit 1
 *   bad arguments              → {"error":"usage:<usage>"} or {"error":"invalid_activity_id:<arg>"} exit 1
 *   any other fetch/parse fail → {"error":"fetch:<detail>"} exit 1
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Thresholds — every magic number transcribed from the skill prose lives here
// and is ECHOED in `analyze` output so coaching prose can cite them without a
// second copy. Sources cited inline as skills/<skill>/SKILL.md.
// ---------------------------------------------------------------------------
export const THRESHOLDS = {
  // activity-deep-dive §4b — session-kind classification
  INTERVAL_MIN_CYCLES: 3, // ≥3 repeated high→low→high HR cycles
  INTERVAL_MIN_DIFFERENTIAL_BPM: 15, // ≥15 bpm work-vs-recovery differential
  SEGMENT_WINDOWS: 10, // 8–12 equal windows when lap data is sparse
  MIN_LAPS_FOR_SEGMENTS: 3, // below this, window the HR stream instead
  // activity-deep-dive §4c — terrain classification (elev_gain_per_km)
  TRAIL_ELEV_GAIN_PER_KM_TRAILRUN: 10, // TrailRun + ≥10 → trail
  TRAIL_ELEV_GAIN_PER_KM_FALLBACK: 20, // any running activity ≥20 → trail
  // activity-deep-dive §5 — cadence
  CADENCE_SINGLE_LEG_MEDIAN: 130, // median < 130 → single-leg RPM, ×2
  CADENCE_DOUBLE_FACTOR: 2,
  CADENCE_LOW_SPM: 170, // avg < 170 → over-striding flag (road only)
  CADENCE_HIGH_CV_PCT: 8, // CV > 8% → high variability flag (road only)
  // activity-deep-dive §5 — pace/HR efficiency
  EFFICIENCY_PRIOR_COUNT: 4, // up to 4 most recent same-sport priors
  // activity-deep-dive §5 — cardiac drift
  CARDIAC_DRIFT_WINDOW_PCT: 0.2, // first/last 20% of the HR stream
  CARDIAC_DRIFT_FLAG_BPM: 10, // drift > 10 bpm → flag
  CARDIAC_DRIFT_PACE_TOLERANCE_SEC: 15, // flag only when first/last-20% pace within ±15 sec/km
  // activity-deep-dive §5 — GAP estimate
  GAP_ELEV_COEFF: 0.008, // equiv_flat_km = dist_km + 0.008 × elev_gain_m
  // activity-deep-dive §5 — recovery estimate (1–5) band boundaries
  // Read as: band = max across three ladders (Z3+% , Z4+% , duration).
  RECOVERY_Z3_PLUS_MODERATE_PCT: 5, // ≥5 → band 2
  RECOVERY_Z3_PLUS_QUALITY_PCT: 20, // ≥20 → band 3
  RECOVERY_Z3_PLUS_HARD_PCT: 50, // >50 → band 4 (exactly 50 stays band 3, per "20–50% Z3")
  RECOVERY_Z4_PLUS_QUALITY_PCT: 0, // >0 (any Z4) → band 3
  RECOVERY_Z4_PLUS_HARD_PCT: 10, // >10 → band 4
  RECOVERY_Z4_PLUS_RACE_PCT: 20, // >20 → band 5
  RECOVERY_HARD_DURATION_MIN: 90, // >90 min AND already hard (intensity band ≥3) → band 4; else → band 2
  RECOVERY_WINDOW_HOURS: { 1: 24, 2: 36, 3: 48, 4: 72, 5: null } as Record<number, number | null>,
  // activity-deep-dive §5 — trail recovery extension (elev_gain_per_km)
  TRAIL_RECOVERY_EXT_LOW_ELEV: 15, // <15 → no extension
  TRAIL_RECOVERY_EXT_HIGH_ELEV: 30, // 15..<30 → +1 day; ≥30 → +1–2 days
  // activity-deep-dive §5 — trail HR/altitude coupling (Pearson r of HR vs altitude)
  HR_ALTITUDE_TRACK_CORR: 0.3, // r ≥ 0.3 → HR broadly tracks the climb/descent (heuristic)
} as const;

// The exact operator-facing recovery message the fitness-brief surfaces on a Strava
// disconnect (the channel-notify variant). Emitted verbatim on any auth failure. Kept as a
// plain quoted string (it contains backticks — not a template literal).
export const AUTH_RECOVERY_MESSAGE =
  'Strava disconnected. Refresh `STRAVA_ACCESS_TOKEN` / `STRAVA_REFRESH_TOKEN` in `.env`, then run `/hermitd-fitness:hatch` to rewrite `.mcp.json`.';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export class StravaAuthError extends Error {}
export class StravaFetchError extends Error {}

// ---------------------------------------------------------------------------
// .env parsing (read-only) + fetch helper
// ---------------------------------------------------------------------------
export function parseEnv(projectRoot: string): Record<string, string> {
  const out: Record<string, string> = {};
  const envPath = path.join(projectRoot, '.env');
  let text: string;
  try {
    text = fs.readFileSync(envPath, 'utf-8');
  } catch {
    return out;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    } else {
      val = val.replace(/\s+#.*$/, '');
    }
    out[key] = val;
  }
  return out;
}

// ---------------------------------------------------------------------------
// hatch: .env check + .mcp.json strava entry, so hatch never holds the secrets.
// Results carry key names only, never values.
// ---------------------------------------------------------------------------
export const STRAVA_ENV_KEYS = [
  'STRAVA_CLIENT_ID',
  'STRAVA_CLIENT_SECRET',
  'STRAVA_ACCESS_TOKEN',
  'STRAVA_REFRESH_TOKEN',
] as const;

const missingStravaKeys = (env: Record<string, string>): string[] =>
  STRAVA_ENV_KEYS.filter((k) => !env[k] || env[k] === 'replace_me');

export function envCheck(projectRoot: string): 'OK' | { status: 'missing_keys'; missing: string[] } {
  const missing = missingStravaKeys(parseEnv(projectRoot));
  return missing.length === 0 ? 'OK' : { status: 'missing_keys', missing };
}

export type McpConfigResult =
  | { server: 'strava'; action: 'added' | 'replaced' | 'updated' | 'skipped' }
  | { status: 'missing_keys'; missing: string[] }
  | { error: 'invalid_mcp_json' };

/** Adds a missing `strava` entry, replaces one still carrying `${...}`
 *  placeholders, refreshes only the four credentials of a literal entry when
 *  they differ from `.env` (keeping a pinned command/args), and skips it
 *  otherwise. */
export function writeMcpConfig(projectRoot: string): McpConfigResult {
  const env = parseEnv(projectRoot);
  const missing = missingStravaKeys(env);
  if (missing.length > 0) return { status: 'missing_keys', missing };

  const mcpPath = path.join(projectRoot, '.mcp.json');
  let doc: unknown = {};
  if (fs.existsSync(mcpPath)) {
    try {
      doc = JSON.parse(fs.readFileSync(mcpPath, 'utf-8'));
    } catch {
      doc = null;
    }
  }
  const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObject(doc) || (doc.mcpServers != null && !isObject(doc.mcpServers))) {
    return { error: 'invalid_mcp_json' };
  }
  const servers: Record<string, unknown> = (doc.mcpServers ??= {});
  const creds: Record<string, string> = Object.fromEntries(STRAVA_ENV_KEYS.map((k) => [k, env[k]]));
  const existing = servers.strava;
  let action: 'added' | 'replaced' | 'updated';
  if (isObject(existing) && !JSON.stringify(existing).includes('${')) {
    const current = isObject(existing.env) ? existing.env : {};
    if (STRAVA_ENV_KEYS.every((k) => current[k] === creds[k])) {
      return { server: 'strava', action: 'skipped' };
    }
    servers.strava = { ...existing, env: { ...current, ...creds } };
    action = 'updated';
  } else {
    action = existing === undefined ? 'added' : 'replaced';
    servers.strava = { command: 'npx', args: ['-y', '@r-huijts/strava-mcp-server'], env: creds };
  }
  fs.writeFileSync(mcpPath, `${JSON.stringify(doc, null, 2)}\n`);
  return { server: 'strava', action };
}

function mcpConfigPath(): string {
  return process.env.STRAVA_MCP_CONFIG || path.join(os.homedir(), '.config', 'strava-mcp', 'config.json');
}

/** Non-expired accessToken from the Strava MCP server's own refreshed config, or null. */
function readMcpConfigToken(): string | null {
  let parsed: { accessToken?: string; expiresAt?: number };
  try {
    parsed = JSON.parse(fs.readFileSync(mcpConfigPath(), 'utf-8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.accessToken) return null;
  // Require a numeric, non-expired expiresAt: a token we can't date isn't
  // verifiably "non-expired", so fall back to .env rather than trust it forever.
  if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= Date.now() / 1000 + 60) return null;
  return parsed.accessToken;
}

export function getAccessToken(projectRoot: string): string | null {
  const mcpToken = readMcpConfigToken();
  if (mcpToken) return mcpToken;
  const v = parseEnv(projectRoot)['STRAVA_ACCESS_TOKEN'];
  return v && v !== 'replace_me' ? v : null;
}

function apiBase(): string {
  return process.env.STRAVA_API_BASE || 'https://www.strava.com/api/v3';
}

async function stravaGet(
  token: string,
  endpoint: string,
  params?: Record<string, string | number>,
): Promise<any> {
  const url = new URL(apiBase() + endpoint);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  } catch (e) {
    throw new StravaFetchError(`network error on ${endpoint}: ${(e as Error).message}`);
  }
  if (res.status === 401 || res.status === 403) throw new StravaAuthError();
  if (!res.ok) throw new StravaFetchError(`HTTP ${res.status} on ${endpoint}`);
  try {
    return await res.json();
  } catch (e) {
    throw new StravaFetchError(`bad JSON on ${endpoint}: ${(e as Error).message}`);
  }
}

async function resolveLatestId(token: string): Promise<number> {
  const acts = await stravaGet(token, '/athlete/activities', { per_page: 1 });
  if (!Array.isArray(acts) || acts.length === 0)
    throw new StravaFetchError('no recent activities to resolve "latest"');
  return acts[0].id;
}

// ---------------------------------------------------------------------------
// Pure statistics — all exported and unit-tested against synthetic inputs.
// ---------------------------------------------------------------------------
export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Population standard deviation (÷N, not sample ÷N−1). */
export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mu = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - mu) ** 2)));
}

/**
 * Session-kind classification (activity-deep-dive §4b). Operates on per-segment
 * average HR (laps' average_heartrate, or windowed HR-stream averages).
 *
 * Midline = (max + min)/2. Each segment labelled H (≥ midline) or L (< midline).
 * A "cycle" is an L-run flanked by H-runs on both sides (a high→low→high dip).
 * Interval iff cycles ≥ MIN_CYCLES AND (mean(H) − mean(L)) ≥ MIN_DIFFERENTIAL.
 */
export function detectSessionKind(segmentHrs: number[]): {
  kind: 'interval' | 'steady';
  cycles: number;
  differential_bpm: number;
  work_bouts: number;
  work_hrs: number[];
} {
  const valid = segmentHrs.filter((h) => Number.isFinite(h) && h > 0);
  if (valid.length < 3)
    return { kind: 'steady', cycles: 0, differential_bpm: 0, work_bouts: 0, work_hrs: [] };
  const midline = (Math.max(...valid) + Math.min(...valid)) / 2;
  // Collapse consecutive same labels into runs, keeping each run's members so the
  // per-work-bout HR progression survives whether laps or HR-windows fed us.
  const runs: { label: 'H' | 'L'; values: number[] }[] = [];
  for (const h of valid) {
    const label = h >= midline ? 'H' : 'L';
    const last = runs[runs.length - 1];
    if (last && last.label === label) last.values.push(h);
    else runs.push({ label, values: [h] });
  }
  // Cycles = L-runs flanked by H on both sides.
  let cycles = 0;
  for (let i = 1; i < runs.length - 1; i++) {
    if (runs[i].label === 'L' && runs[i - 1].label === 'H' && runs[i + 1].label === 'H') cycles++;
  }
  const workRuns = runs.filter((r) => r.label === 'H');
  const work_bouts = workRuns.length;
  // Mean HR of each work bout in order — the I1→IN progression the skill renders.
  const work_hrs = workRuns.map((r) => Math.round(mean(r.values)));
  const highs = valid.filter((h) => h >= midline);
  const lows = valid.filter((h) => h < midline);
  const differential_bpm = Math.round(mean(highs) - mean(lows));
  const kind =
    cycles >= THRESHOLDS.INTERVAL_MIN_CYCLES &&
    differential_bpm >= THRESHOLDS.INTERVAL_MIN_DIFFERENTIAL_BPM
      ? 'interval'
      : 'steady';
  return { kind, cycles, differential_bpm, work_bouts, work_hrs };
}

/** Terrain classification (activity-deep-dive §4c). */
export function classifyTerrain(
  sportType: string,
  totalElevationGainM: number,
  distanceKm: number,
): { terrain: 'road' | 'trail'; elev_gain_per_km: number } {
  const elev_gain_per_km = distanceKm > 0 ? totalElevationGainM / distanceKm : 0;
  const isRunning = ['Run', 'TrailRun', 'VirtualRun'].includes(sportType);
  const trail =
    (sportType === 'TrailRun' &&
      elev_gain_per_km >= THRESHOLDS.TRAIL_ELEV_GAIN_PER_KM_TRAILRUN) ||
    (isRunning && elev_gain_per_km >= THRESHOLDS.TRAIL_ELEV_GAIN_PER_KM_FALLBACK);
  return { terrain: trail ? 'trail' : 'road', elev_gain_per_km };
}

/** HR zone breakdown vs athlete zone boundaries (activity-deep-dive §5). */
export function zoneBreakdown(
  hrData: number[],
  zoneBounds: { min: number; max: number }[],
): { zone: number; pct: number }[] {
  const counts = new Array(zoneBounds.length).fill(0);
  let total = 0;
  for (const hr of hrData) {
    if (!Number.isFinite(hr) || hr <= 0) continue;
    for (let i = 0; i < zoneBounds.length; i++) {
      const { min, max } = zoneBounds[i];
      const inZone = hr >= min && (max < 0 || hr < max);
      if (inZone) {
        counts[i]++;
        total++;
        break;
      }
    }
  }
  return counts.map((c, i) => ({
    zone: i + 1,
    pct: total ? Math.round((c / total) * 1000) / 10 : 0,
  }));
}

/** Cadence stats (activity-deep-dive §5). CV = σ/μ × 100 with population σ. */
export function cadenceStats(cadenceData: number[]): {
  avg: number;
  sd: number;
  cv: number;
  doubled: boolean;
} | null {
  const raw = cadenceData.filter((c) => Number.isFinite(c) && c > 0);
  if (raw.length === 0) return null;
  const doubled = median(raw) < THRESHOLDS.CADENCE_SINGLE_LEG_MEDIAN;
  const series = doubled ? raw.map((c) => c * THRESHOLDS.CADENCE_DOUBLE_FACTOR) : raw;
  const avg = mean(series);
  const sd = stddev(series);
  const cv = avg ? (sd / avg) * 100 : 0;
  return {
    avg: Math.round(avg * 10) / 10,
    sd: Math.round(sd * 10) / 10,
    cv: Math.round(cv * 10) / 10,
    doubled,
  };
}

/** Road cadence flags (suppressed on trail — thresholds are road-calibrated). */
export function cadenceFlags(avg: number, cv: number): string[] {
  const flags: string[] = [];
  if (avg < THRESHOLDS.CADENCE_LOW_SPM) flags.push('over-striding');
  if (cv > THRESHOLDS.CADENCE_HIGH_CV_PCT) flags.push('high-variability');
  return flags;
}

/** Pace (min/km) from average_speed (m/s). */
export function paceMinPerKm(avgSpeedMs: number): number {
  return avgSpeedMs > 0 ? 1000 / avgSpeedMs / 60 : 0;
}

/**
 * Pace/HR efficiency (activity-deep-dive §5). ratio = pace / avgHR; lower is
 * more efficient. Priors are summary activities (same sport, current excluded).
 */
export function efficiency(
  current: { avgSpeedMs: number; avgHr: number },
  priors: { avgSpeedMs: number; avgHr: number }[],
): {
  current: number | null;
  prior_mean: number | null;
  delta_pct: number | null;
  priors_used: number;
} {
  const ratioOf = (a: { avgSpeedMs: number; avgHr: number }) => {
    const pace = paceMinPerKm(a.avgSpeedMs);
    return a.avgHr > 0 && pace > 0 ? pace / a.avgHr : null;
  };
  const cur = ratioOf(current);
  const priorRatios = priors
    .slice(0, THRESHOLDS.EFFICIENCY_PRIOR_COUNT)
    .map(ratioOf)
    .filter((r): r is number => r !== null);
  const prior_mean = priorRatios.length ? mean(priorRatios) : null;
  const delta_pct =
    cur !== null && prior_mean !== null && prior_mean !== 0
      ? Math.round(((cur - prior_mean) / prior_mean) * 1000) / 10
      : null;
  return {
    current: cur !== null ? Math.round(cur * 10000) / 10000 : null,
    prior_mean: prior_mean !== null ? Math.round(prior_mean * 10000) / 10000 : null,
    delta_pct,
    priors_used: priorRatios.length,
  };
}

/**
 * Cardiac drift (activity-deep-dive §5): last-20% avg − first-20% avg HR, signed.
 * Per the SKILL, the flag only fires "at similar pace (±15 sec/km)": a negative
 * split raises HR for pacing reasons, not aerobic decoupling, so drift over a
 * material pace change is reported but NOT flagged. When no velocity data is
 * supplied the pace guard is skipped (flag on drift alone).
 */
export function cardiacDrift(
  hrData: number[],
  velocityData: number[] = [],
): { drift_bpm: number; flagged: boolean } | null {
  const hr = hrData.filter((h) => Number.isFinite(h) && h > 0);
  const w = Math.floor(hr.length * THRESHOLDS.CARDIAC_DRIFT_WINDOW_PCT);
  if (w < 1) return null;
  const first = hr.slice(0, w);
  const last = hr.slice(hr.length - w);
  const drift_bpm = Math.round(mean(last) - mean(first));
  // Pace guard: suppress the flag when first/last-20% pace differs by > tolerance.
  const v = velocityData.filter((x) => Number.isFinite(x) && x > 0);
  const vw = Math.floor(v.length * THRESHOLDS.CARDIAC_DRIFT_WINDOW_PCT);
  const vFirst = v.slice(0, vw);
  const vLast = v.slice(v.length - vw);
  const paceConfounded =
    vw >= 1 &&
    Math.abs(1000 / mean(vLast) - 1000 / mean(vFirst)) > THRESHOLDS.CARDIAC_DRIFT_PACE_TOLERANCE_SEC;
  return { drift_bpm, flagged: drift_bpm > THRESHOLDS.CARDIAC_DRIFT_FLAG_BPM && !paceConfounded };
}

/** VAM — vertical ascent m/h (trail, activity-deep-dive §5). */
export function vam(totalElevationGainM: number, movingTimeS: number): number | null {
  if (movingTimeS <= 0) return null;
  return Math.round(totalElevationGainM / (movingTimeS / 3600));
}

/** GAP per km in seconds (trail, activity-deep-dive §5). */
export function gapPerKm(
  distanceKm: number,
  totalElevationGainM: number,
  movingTimeS: number,
): number | null {
  const equivFlatKm = distanceKm + THRESHOLDS.GAP_ELEV_COEFF * totalElevationGainM;
  if (equivFlatKm <= 0) return null;
  return Math.round(movingTimeS / equivFlatKm);
}

/**
 * HR-vs-altitude coupling (trail, activity-deep-dive §5). On trail the first/last-20%
 * cardiac-drift split is confounded by the climb profile, so the skill instead reports
 * whether HR broadly tracked the terrain. This reduces the two streams (aligned by
 * index) to a single Pearson r so the raw time-series never enter model context:
 * positive → HR rose on climbs / fell on descents (expected); near-zero/negative →
 * decoupled. Returns null when either stream is too short or flat to correlate.
 */
export function hrAltitudeCorr(
  hrData: number[],
  altitudeData: number[],
): { corr: number; tracks: 'tracks' | 'decoupled' } | null {
  const n = Math.min(hrData.length, altitudeData.length);
  const hr: number[] = [];
  const alt: number[] = [];
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(hrData[i]) && hrData[i] > 0 && Number.isFinite(altitudeData[i])) {
      hr.push(hrData[i]);
      alt.push(altitudeData[i]);
    }
  }
  if (hr.length < 2) return null;
  const sdHr = stddev(hr);
  const sdAlt = stddev(alt);
  if (sdHr === 0 || sdAlt === 0) return null; // flat HR or flat altitude — no signal
  const mh = mean(hr);
  const ma = mean(alt);
  const covMean = mean(hr.map((h, i) => (h - mh) * (alt[i] - ma)));
  const corr = Math.round((covMean / (sdHr * sdAlt)) * 100) / 100;
  return { corr, tracks: corr >= THRESHOLDS.HR_ALTITUDE_TRACK_CORR ? 'tracks' : 'decoupled' };
}

/**
 * Recovery estimate 1–5 (activity-deep-dive §5). Read as the max across three
 * ladders — Z3+% , Z4+% , duration — which captures every OR clause in the
 * SKILL bands. NOTE: the SKILL's band-5 "peak HR > 95% max" clause is OMITTED —
 * Strava's API exposes no athlete max-HR field and the SKILL forbids using the
 * Z5 floor as HRmax, so the clause is uncomputable. Band 5 relies on Z4+% > 20.
 *
 * Duration ladder honours the SKILL's "> 90 min HARD" qualifier: a long session
 * floors to band 4 only when the intensity ladders already reached band ≥3. A
 * long EASY/moderate session (e.g. a 2 h Z1–Z2 long run) floors to band 2 for
 * accumulated volume, not band 4 — so it doesn't recommend 72 h rest after an
 * easy run.
 */
export function recoveryBand(input: {
  z3PlusPct: number;
  z4PlusPct: number;
  durationMin: number;
}): number {
  const T = THRESHOLDS;
  let band = 1;
  // Z3+ ladder
  if (input.z3PlusPct > T.RECOVERY_Z3_PLUS_HARD_PCT) band = Math.max(band, 4);
  else if (input.z3PlusPct >= T.RECOVERY_Z3_PLUS_QUALITY_PCT) band = Math.max(band, 3);
  else if (input.z3PlusPct >= T.RECOVERY_Z3_PLUS_MODERATE_PCT) band = Math.max(band, 2);
  // Z4+ ladder
  if (input.z4PlusPct > T.RECOVERY_Z4_PLUS_RACE_PCT) band = Math.max(band, 5);
  else if (input.z4PlusPct > T.RECOVERY_Z4_PLUS_HARD_PCT) band = Math.max(band, 4);
  else if (input.z4PlusPct > T.RECOVERY_Z4_PLUS_QUALITY_PCT) band = Math.max(band, 3);
  // duration ladder — long+hard → 4; long+easy → at least 2 (not 4)
  if (input.durationMin > T.RECOVERY_HARD_DURATION_MIN) band = Math.max(band, band >= 3 ? 4 : 2);
  return band;
}

/** Recovery window + trail extension (activity-deep-dive §5). */
export function recoveryWindow(
  band: number,
  terrain: 'road' | 'trail',
  elevGainPerKm: number,
): { hours: number | null; window: string; trail_extended: boolean; extension_days: string } {
  const baseHours = THRESHOLDS.RECOVERY_WINDOW_HOURS[band] ?? null;
  let extension_days = '0';
  let trail_extended = false;
  if (terrain === 'trail') {
    if (elevGainPerKm >= THRESHOLDS.TRAIL_RECOVERY_EXT_HIGH_ELEV) {
      extension_days = '1-2';
      trail_extended = true;
    } else if (elevGainPerKm >= THRESHOLDS.TRAIL_RECOVERY_EXT_LOW_ELEV) {
      extension_days = '1';
      trail_extended = true;
    }
  }
  let window: string;
  if (band === 5) window = trail_extended ? '5–7 days (+trail vert)' : '5–7 days';
  else {
    const h = baseHours as number;
    if (!trail_extended) window = `${h}h`;
    else {
      const extLow = 24;
      const extHigh = extension_days === '1-2' ? 48 : 24;
      const lowDays = (h + extLow) / 24;
      const highDays = (h + extHigh) / 24;
      window =
        extLow === extHigh
          ? `${h + extLow}h (+trail vert)`
          : `${lowDays}–${highDays} days (+trail vert)`;
    }
  }
  return { hours: baseHours, window, trail_extended, extension_days };
}

// ---------------------------------------------------------------------------
// weekly-patterns — filesystem only, NO token (weekly-coaching-patterns skill)
// ---------------------------------------------------------------------------
export function parseFrontmatter(text: string): Record<string, string> | null {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return fields;
}

/** Extract a signed integer from a `Cardiac drift: +N bpm` line (sign preserved). */
export function extractDrift(body: string): number | null {
  const m = body.match(/^Cardiac drift:\s*([+-]?\d+)/m);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Frontmatter-first drift read. Falls back to the legacy rendered prose line
 * for notes written before `cardiac_drift_bpm` was in the template.
 */
export function readDrift(fm: Record<string, string>, body: string): number | null {
  const raw = fm.cardiac_drift_bpm?.trim();
  if (raw !== undefined && /^[+-]?\d+$/.test(raw)) return parseInt(raw, 10);
  return extractDrift(body);
}

/** Strict-monotonic increasing across all adjacent pairs. */
export function isStrictlyIncreasing(values: number[]): boolean {
  for (let i = 1; i < values.length; i++) if (values[i] <= values[i - 1]) return false;
  return true;
}

export function weeklyPatterns(projectRoot: string): {
  steady_sessions_found: number;
  series: { file: string; date: string; drift: number }[];
  trend: 'upward' | 'none' | 'insufficient_data';
} {
  const dir = path.join(projectRoot, '.hermit', 'compiled');
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^activity-.*\.md$/.test(f));
  } catch {
    return { steady_sessions_found: 0, series: [], trend: 'insufficient_data' };
  }
  const steady: { file: string; created: string; drift: number | null }[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf-8');
    } catch {
      continue;
    }
    const fm = parseFrontmatter(text);
    if (!fm || fm.type !== 'activity-note' || fm.session_kind !== 'steady') continue;
    const body = text.slice(text.indexOf('\n---\n') + 5);
    steady.push({ file: f, created: fm.created || '', drift: readDrift(fm, body) });
  }
  // Most-recent-first, take 4.
  steady.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
  const top4 = steady.slice(0, 4);
  const steady_sessions_found = steady.length;
  // Oldest→newest for the series, drop entries missing a drift line.
  const ordered = [...top4].reverse();
  const withDrift = ordered.filter((s) => s.drift !== null) as {
    file: string;
    created: string;
    drift: number;
  }[];
  const series = withDrift.map((s) => ({ file: s.file, date: s.created, drift: s.drift }));
  let trend: 'upward' | 'none' | 'insufficient_data';
  if (series.length < 4) trend = 'insufficient_data';
  else trend = isStrictlyIncreasing(series.map((s) => s.drift)) ? 'upward' : 'none';
  return { steady_sessions_found, series, trend };
}

// ---------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------
function streamData(streams: any, key: string): number[] {
  const s = streams && streams[key];
  return s && Array.isArray(s.data) ? s.data : [];
}

/**
 * Await a Strava fetch, recording `message` in `warnings` and falling back on any
 * non-auth failure. An auth failure re-throws so the CLI still honours the
 * `strava_auth` exit-1 contract: swallowing a 401 here (e.g. a token missing
 * `profile:read_all` for `/athlete/zones`) would zero out zones and silently
 * understate the recovery band instead of signalling that re-auth is needed.
 */
function optionalFetch<T>(p: Promise<T>, warnings: string[], message: string, fallback: T): Promise<T> {
  return p.catch((e) => {
    if (e instanceof StravaAuthError) throw e;
    warnings.push(message);
    return fallback;
  });
}

export async function analyze(token: string, activityId: number): Promise<any> {
  const warnings: string[] = [];
  const streamKeys = 'heartrate,velocity_smooth,altitude,cadence,watts';

  // `details` is essential (no fallback) but independent of the other four, so it
  // joins the batch rather than serialising an extra round-trip ahead of it.
  const [details, laps, streams, zonesResp, summaries] = await Promise.all([
    stravaGet(token, `/activities/${activityId}`),
    optionalFetch(stravaGet(token, `/activities/${activityId}/laps`), warnings, 'laps unavailable', []),
    optionalFetch(
      stravaGet(token, `/activities/${activityId}/streams`, { keys: streamKeys, key_by_type: 'true' }),
      warnings,
      'streams unavailable',
      {},
    ),
    optionalFetch(stravaGet(token, '/athlete/zones'), warnings, 'athlete zones unavailable', {}),
    optionalFetch(
      stravaGet(token, '/athlete/activities', { per_page: 10 }),
      warnings,
      'summary activities unavailable',
      [],
    ),
  ]);

  const sportType: string = details.sport_type || details.type || 'Unknown';
  const distanceKm = (details.distance || 0) / 1000;
  const movingTimeS = details.moving_time || 0;
  const elevGainM = details.total_elevation_gain || 0;
  const avgHr = details.average_heartrate || 0;
  const maxHr = details.max_heartrate || 0;
  const avgSpeedMs = details.average_speed || 0;

  const hrData = streamData(streams, 'heartrate');
  const cadenceData = streamData(streams, 'cadence');
  if (hrData.length === 0) warnings.push('HR stream absent — zone/drift/interval metrics degraded');

  const { terrain, elev_gain_per_km } = classifyTerrain(sportType, elevGainM, distanceKm);

  // Session kind — prefer laps' average_heartrate, else window the HR stream.
  const lapHrs: number[] = Array.isArray(laps)
    ? laps.map((l: any) => l.average_heartrate).filter((h: any) => Number.isFinite(h) && h > 0)
    : [];
  let segmentHrs: number[];
  if (lapHrs.length >= THRESHOLDS.MIN_LAPS_FOR_SEGMENTS) segmentHrs = lapHrs;
  else if (hrData.length >= THRESHOLDS.SEGMENT_WINDOWS) {
    const size = Math.floor(hrData.length / THRESHOLDS.SEGMENT_WINDOWS);
    segmentHrs = [];
    for (let i = 0; i < THRESHOLDS.SEGMENT_WINDOWS; i++)
      segmentHrs.push(mean(hrData.slice(i * size, (i + 1) * size)));
  } else segmentHrs = [];
  if (segmentHrs.length === 0)
    warnings.push('insufficient HR/lap segments for interval detection — defaulting to steady');
  const session = detectSessionKind(segmentHrs);
  const avgBoutMin =
    session.work_bouts > 0 ? Math.round((movingTimeS / 60 / session.work_bouts) * 10) / 10 : null;

  // Zones
  const zoneBounds: { min: number; max: number }[] =
    (zonesResp &&
      zonesResp.heart_rate &&
      Array.isArray(zonesResp.heart_rate.zones) &&
      zonesResp.heart_rate.zones) ||
    [];
  let zones: { zone: number; pct: number }[] | null = null;
  let z3PlusPct = 0;
  let z4PlusPct = 0;
  if (zoneBounds.length && hrData.length) {
    zones = zoneBreakdown(hrData, zoneBounds);
    z3PlusPct = zones.filter((z) => z.zone >= 3).reduce((a, z) => a + z.pct, 0);
    z4PlusPct = zones.filter((z) => z.zone >= 4).reduce((a, z) => a + z.pct, 0);
  } else if (!zoneBounds.length) warnings.push('athlete zones absent — zone breakdown unavailable');

  // Cadence (running only)
  const isRunning = ['Run', 'TrailRun', 'VirtualRun'].includes(sportType);
  let cadence: { avg: number; sd: number; cv: number; flags: string[] } | null = null;
  if (isRunning) {
    const c = cadenceStats(cadenceData);
    if (c) {
      const flags = terrain === 'trail' ? [] : cadenceFlags(c.avg, c.cv);
      cadence = { avg: c.avg, sd: c.sd, cv: c.cv, flags };
    }
  }

  // Efficiency (priors from summary activities, same sport, current excluded)
  const priors = (Array.isArray(summaries) ? summaries : [])
    .filter((a: any) => a.id !== activityId && (a.sport_type || a.type) === sportType)
    .map((a: any) => ({ avgSpeedMs: a.average_speed || 0, avgHr: a.average_heartrate || 0 }));
  const eff = efficiency({ avgSpeedMs, avgHr }, priors);

  // Cardiac drift (steady semantics; script always computes, skill decides use).
  // Pass velocity so the flag is suppressed on a negative split (pace-confounded).
  const driftResult =
    terrain === 'road' ? cardiacDrift(hrData, streamData(streams, 'velocity_smooth')) : null;

  // Trail-only metrics. On trail the drift split is confounded, so instead reduce
  // HR-vs-altitude to a single coupling figure the coaching note can cite.
  const vamVal = terrain === 'trail' ? vam(elevGainM, movingTimeS) : null;
  const gapVal = terrain === 'trail' ? gapPerKm(distanceKm, elevGainM, movingTimeS) : null;
  const hrAltitude =
    terrain === 'trail' ? hrAltitudeCorr(hrData, streamData(streams, 'altitude')) : null;

  // Recovery
  const band = recoveryBand({ z3PlusPct, z4PlusPct, durationMin: movingTimeS / 60 });
  const rw = recoveryWindow(band, terrain, elev_gain_per_km);

  // Compact laps (never echo raw stream arrays)
  const compactLaps = (Array.isArray(laps) ? laps : []).map((l: any, i: number) => ({
    index: l.lap_index ?? i + 1,
    avg_hr: l.average_heartrate ?? null,
    max_hr: l.max_heartrate ?? null,
    distance_km: l.distance ? Math.round((l.distance / 1000) * 100) / 100 : null,
    moving_time_s: l.moving_time ?? null,
    elapsed_time_s: l.elapsed_time ?? null,
  }));

  return {
    meta: {
      activity_id: activityId,
      name: details.name || '',
      date: details.start_date_local || details.start_date || '',
      sport_type: sportType,
      distance_km: Math.round(distanceKm * 100) / 100,
      moving_time_s: movingTimeS,
      elapsed_time_s: details.elapsed_time || 0,
      avg_hr: avgHr || null,
      max_hr: maxHr || null,
      total_elevation_gain_m: elevGainM,
      elev_gain_per_km: Math.round(elev_gain_per_km * 100) / 100,
    },
    session_kind: session.kind,
    session_detail: {
      cycles: session.cycles,
      differential_bpm: session.differential_bpm,
      work_bouts: session.work_bouts,
      avg_bout_min: avgBoutMin,
      work_segment_hrs: session.work_hrs,
    },
    terrain,
    zones,
    cadence,
    efficiency: eff,
    cardiac_drift_bpm: driftResult ? driftResult.drift_bpm : null,
    cardiac_drift_flagged: driftResult ? driftResult.flagged : false,
    hr_altitude: hrAltitude,
    vam: vamVal,
    gap_per_km: gapVal,
    laps: compactLaps,
    recovery: { band, hours: rw.hours, window: rw.window, trail_extended: rw.trail_extended },
    thresholds: THRESHOLDS,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// weekly-load
// ---------------------------------------------------------------------------
function mondayKey(dateStr: string): string {
  const d = new Date(dateStr);
  const day = (d.getUTCDay() + 6) % 7; // 0 = Monday
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

export function aggregateWeeklyLoad(
  activities: any[],
  zoneBounds: { min: number; max: number }[],
  weeks: number,
): any {
  // Bucket by ISO Monday.
  const byWeek = new Map<string, any[]>();
  for (const a of activities) {
    const dateStr = a.start_date_local || a.start_date;
    if (!dateStr) continue;
    const key = mondayKey(dateStr);
    if (!byWeek.has(key)) byWeek.set(key, []);
    byWeek.get(key)!.push(a);
  }
  // Walk back N CONSECUTIVE calendar weeks from the most recent activity week,
  // including zero-activity rest/deload weeks — so "last N weeks" spans exactly N
  // calendar weeks instead of silently skipping weeks with no runs.
  const dataKeys = [...byWeek.keys()].sort();
  const weekKeys: string[] = [];
  if (dataKeys.length) {
    let cursor = new Date(dataKeys[dataKeys.length - 1] + 'T00:00:00Z').getTime();
    for (let i = 0; i < weeks; i++) {
      weekKeys.push(new Date(cursor).toISOString().slice(0, 10));
      cursor -= 7 * 24 * 60 * 60 * 1000;
    }
  }
  const zoneOf = (hr: number): number | null => {
    if (!zoneBounds.length || !(hr > 0)) return null;
    for (let i = 0; i < zoneBounds.length; i++) {
      const { min, max } = zoneBounds[i];
      if (hr >= min && (max < 0 || hr < max)) return i + 1;
    }
    return null;
  };
  const result = weekKeys.map((wk) => {
    const acts = byWeek.get(wk) ?? [];
    let km = 0;
    let movingMin = 0;
    let elevation = 0;
    let tssProxy = 0;
    const zoneTime = new Array(zoneBounds.length).fill(0);
    let zonedTime = 0;
    for (const a of acts) {
      const distKm = (a.distance || 0) / 1000;
      const mt = (a.moving_time || 0) / 60;
      km += distKm;
      movingMin += mt;
      elevation += a.total_elevation_gain || 0;
      const ah = a.average_heartrate || 0;
      const mh = a.max_heartrate || 0;
      if (ah > 0 && mh > 0) tssProxy += mt * (ah / mh);
      const z = zoneOf(ah);
      if (z !== null) {
        zoneTime[z - 1] += mt;
        zonedTime += mt;
      }
    }
    const zonePct = zoneBounds.length
      ? zoneTime.map((t, i) => ({
          zone: i + 1,
          pct: zonedTime ? Math.round((t / zonedTime) * 1000) / 10 : 0,
        }))
      : null;
    return {
      week_start: wk,
      activities: acts.length,
      km: Math.round(km * 100) / 100,
      moving_time_min: Math.round(movingMin),
      elevation_m: Math.round(elevation),
      zone_pct: zonePct,
      tss_proxy: Math.round(tssProxy * 10) / 10,
    };
  });
  return {
    weeks: result,
    method: {
      zone_pct:
        'avg-HR of each activity bucketed into athlete HR zones, time-weighted by moving_time (approximation — not stream-based, since summary activities carry no HR stream)',
      tss_proxy:
        'Σ (moving_time_min × avg_hr / max_hr) per activity, per week — rolling load proxy (strava-data-cruncher formula), using per-activity max_heartrate',
      weeks:
        'N consecutive calendar weeks ending at the most recent activity week; zero-activity (rest/deload) weeks are included as empty rows, most-recent first. Bounded to the ≤200 most-recent activities.',
    },
  };
}

export async function weeklyLoad(token: string, weeks: number): Promise<any> {
  // ~30 activities/week of headroom (capped at Strava's 200 page max) so a
  // high-frequency / multi-sport athlete doesn't have the oldest weeks in the
  // window render as phantom rest weeks just because the fetch stopped short.
  const perPage = Math.min(200, Math.max(30, weeks * 30));
  const activities = await stravaGet(token, '/athlete/activities', { per_page: perPage });
  let zoneBounds: { min: number; max: number }[] = [];
  try {
    const z = await stravaGet(token, '/athlete/zones');
    if (z && z.heart_rate && Array.isArray(z.heart_rate.zones)) zoneBounds = z.heart_rate.zones;
  } catch (e) {
    // A hard auth failure must surface (exit-1 strava_auth contract), same as
    // analyze's optionalFetch — swallowing it would silently understate load.
    if (e instanceof StravaAuthError) throw e;
    // Any other failure: zone_pct degrades to null; method documents the approximation.
  }
  return aggregateWeeklyLoad(Array.isArray(activities) ? activities : [], zoneBounds, weeks);
}

// ---------------------------------------------------------------------------
// rpe — CRUD on state/activity-notes.json (atomic tmp+rename)
// ---------------------------------------------------------------------------
export function upsertRpe(
  projectRoot: string,
  activityId: number,
  rpe: number,
  notes: string | null,
  recordedAt: string,
): { activity_id: number; written: true; previous: any } {
  const stateDir = path.join(projectRoot, '.hermit', 'state');
  const file = path.join(stateDir, 'activity-notes.json');
  fs.mkdirSync(stateDir, { recursive: true });
  let store: Record<string, any> = {};
  try {
    store = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    store = {};
  }
  const key = String(activityId);
  const previous = store[key] ?? null;
  store[key] = { rpe, notes, recorded_at: recordedAt };
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, file);
  return { activity_id: activityId, written: true, previous };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = 'true';
    } else positionals.push(a);
  }
  return { positionals, flags };
}

function emitError(token: string): never {
  console.log(JSON.stringify({ error: token }));
  process.exit(1);
}

function emitAuth(): never {
  emitError(`strava_auth:${AUTH_RECOVERY_MESSAGE}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positionals, flags } = parseArgs(rest);
  const projectRoot = flags['project-root'] || process.cwd();

  try {
    if (cmd === 'analyze') {
      const arg = positionals[0];
      if (!arg) emitError('usage:analyze <activity-id|latest>');
      const token = getAccessToken(projectRoot);
      if (!token) emitAuth();
      const id = arg === 'latest' ? await resolveLatestId(token) : parseInt(arg, 10);
      if (!Number.isFinite(id)) emitError(`invalid_activity_id:${arg}`);
      console.log(JSON.stringify(await analyze(token, id)));
      process.exit(0);
    } else if (cmd === 'weekly-load') {
      const token = getAccessToken(projectRoot);
      if (!token) emitAuth();
      const weeks = flags['weeks'] ? parseInt(flags['weeks'], 10) : 4;
      console.log(JSON.stringify(await weeklyLoad(token, Number.isFinite(weeks) && weeks >= 1 ? weeks : 4)));
      process.exit(0);
    } else if (cmd === 'weekly-patterns') {
      console.log(JSON.stringify(weeklyPatterns(projectRoot)));
      process.exit(0);
    } else if (cmd === 'rpe') {
      // Notes are free text and may contain tokens like "--off"; parse them from
      // the raw args (only --project-root is a flag here) so parseArgs doesn't
      // swallow a note starting with "--".
      const raw = [...rest];
      const prIdx = raw.indexOf('--project-root');
      if (prIdx >= 0) raw.splice(prIdx, 2);
      const arg = raw[0];
      const rpeRaw = raw[1];
      const notesJoined = raw.slice(2).join(' ').trim();
      const notes = notesJoined.length ? notesJoined : null;
      const rpe = parseInt(rpeRaw, 10);
      if (!arg || rpeRaw === undefined || !Number.isFinite(rpe) || rpe < 1 || rpe > 10)
        emitError('usage:rpe <activity-id|latest> <rpe:1-10> [notes...]');
      let id: number;
      if (arg === 'latest') {
        const token = getAccessToken(projectRoot);
        if (!token) emitAuth();
        id = await resolveLatestId(token);
      } else {
        id = parseInt(arg, 10);
        if (!Number.isFinite(id)) emitError(`invalid_activity_id:${arg}`);
      }
      const result = upsertRpe(projectRoot, id, rpe, notes, new Date().toISOString());
      console.log(JSON.stringify(result));
      process.exit(0);
    } else if (cmd === 'env-check') {
      const result = envCheck(projectRoot);
      console.log(result === 'OK' ? result : JSON.stringify(result));
      process.exit(0);
    } else if (cmd === 'mcp-config') {
      const result = writeMcpConfig(projectRoot);
      if ('error' in result) emitError(result.error);
      console.log(JSON.stringify(result));
      process.exit(0);
    } else {
      emitError(`usage:unknown subcommand ${cmd ?? '(none)'}; expected analyze|weekly-load|weekly-patterns|rpe|env-check|mcp-config`);
    }
  } catch (e) {
    if (e instanceof StravaAuthError) emitAuth();
    emitError(`fetch:${(e as Error).message || String(e)}`);
  }
}

if (import.meta.main) {
  main();
}
