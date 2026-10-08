// Tests for fitness-lab.ts — run with: bun scripts/fitness-lab.test.ts
//
// Pure-function layer: synthetic inputs, exact computed values (the formulas
// transcribed from the fitness SKILL.md prose).
// Contract layer: a Bun.serve() Strava fixture + Bun.spawn of the CLI, asserting
// JSON shape, the 401→exit-1 + exact-message contract, and filesystem CRUD.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  THRESHOLDS,
  AUTH_RECOVERY_MESSAGE,
  getAccessToken,
  median,
  detectSessionKind,
  classifyTerrain,
  zoneBreakdown,
  cadenceStats,
  cadenceFlags,
  efficiency,
  cardiacDrift,
  hrAltitudeCorr,
  vam,
  gapPerKm,
  recoveryBand,
  recoveryWindow,
  extractDrift,
  readDrift,
  isStrictlyIncreasing,
  weeklyPatterns,
  aggregateWeeklyLoad,
} from './fitness-lab';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}
function eq(name: string, actual: unknown, expected: unknown) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
}

// ---------------------------------------------------------------------------
console.log('\nbasic stats:');
eq('median odd', median([1, 5, 2]), 2);

console.log('\ncardiac drift (linear ramp, signed):');
const ramp = Array.from({ length: 20 }, (_, i) => 140 + i); // 140..159
// first4 mean 141.5, last4 mean 157.5 → drift +16, flagged
eq('drift +16 rising', cardiacDrift(ramp), { drift_bpm: 16, flagged: true });
const falling = Array.from({ length: 20 }, (_, i) => 159 - i); // 159..140
eq('drift -16 falling (sign preserved)', cardiacDrift(falling), { drift_bpm: -16, flagged: false });
ok('drift null on short stream', cardiacDrift([150, 151]) === null);
// pace guard: same +16 HR ramp, but a big negative split (slow→fast) suppresses the flag
const negSplit = Array.from({ length: 20 }, (_, i) => 2.5 + i * 0.1); // 2.5→4.4 m/s: pace drops ~90 s/km
eq('drift value still reported under pace guard', cardiacDrift(ramp, negSplit)!.drift_bpm, 16);
eq('flag suppressed on negative split (pace-confounded)', cardiacDrift(ramp, negSplit)!.flagged, false);
// steady pace (within ±15 s/km) leaves the flag intact
const steadyPace = Array.from({ length: 20 }, () => 3.3);
eq('flag intact at steady pace', cardiacDrift(ramp, steadyPace)!.flagged, true);

console.log('\ninterval detection:');
eq(
  '3 cycles + big differential → interval',
  detectSessionKind([160, 130, 160, 130, 160, 130, 160]),
  { kind: 'interval', cycles: 3, differential_bpm: 30, work_bouts: 4, work_hrs: [160, 160, 160, 160] },
);
// work_hrs carries the per-bout progression even when HR windows (not laps) fed us
eq(
  'rising work bouts → work_hrs progression',
  detectSessionKind([150, 130, 160, 128, 170, 132, 168]).work_hrs,
  [150, 160, 170, 168],
);
const twoCycle = detectSessionKind([160, 130, 160, 130, 160]);
eq('2 cycles → steady', { kind: twoCycle.kind, cycles: twoCycle.cycles }, { kind: 'steady', cycles: 2 });
// Boundary: 3 cycles, differential exactly 15 → interval; 14 → steady
eq(
  '15 bpm differential → interval',
  detectSessionKind([157, 142, 157, 142, 157, 142, 157]).kind,
  'interval',
);
eq(
  '14 bpm differential → steady',
  detectSessionKind([156, 142, 156, 142, 156, 142, 156]).kind,
  'steady',
);

console.log('\nterrain:');
eq('flat Run → road', classifyTerrain('Run', 0, 10).terrain, 'road');
eq('Run 40m/km fallback → trail', classifyTerrain('Run', 400, 10).terrain, 'trail');
eq('flat TrailRun (5m/km) → road', classifyTerrain('TrailRun', 50, 10).terrain, 'road');
eq('TrailRun exactly 10m/km → trail', classifyTerrain('TrailRun', 100, 10).terrain, 'trail');

console.log('\ncadence CV:');
// [170,180,190,160]: median 175 (no double), avg 175, σ=√125≈11.18, cv≈6.39
eq('cadence stats', cadenceStats([170, 180, 190, 160]), { avg: 175, sd: 11.2, cv: 6.4, doubled: false });
// single-leg RPM doubling: median 60 < 130 → ×2 → 120 each
eq('cadence doubling', cadenceStats([60, 60, 60, 60]), { avg: 120, sd: 0, cv: 0, doubled: true });
eq('cadence null on empty', cadenceStats([]), null);
eq('cadence flags: over-striding', cadenceFlags(160, 5), ['over-striding']);
eq('cadence flags: high variability', cadenceFlags(180, 10), ['high-variability']);
eq('cadence flags: none', cadenceFlags(175, 6.4), []);

console.log('\nzone breakdown:');
const zb = [
  { min: 0, max: 120 },
  { min: 120, max: 140 },
  { min: 140, max: 160 },
  { min: 160, max: 180 },
  { min: 180, max: -1 },
];
const zones = zoneBreakdown([100, 130, 150, 150, 170, 190], zb);
eq('zone3 pct', zones.find((z) => z.zone === 3)?.pct, 33.3);
eq('zone5 pct (max=-1 open top)', zones.find((z) => z.zone === 5)?.pct, 16.7);

console.log('\nefficiency:');
const eff = efficiency(
  { avgSpeedMs: 3.0, avgHr: 150 },
  [
    { avgSpeedMs: 2.8, avgHr: 148 },
    { avgSpeedMs: 3.2, avgHr: 152 },
  ],
);
eq('priors_used', eff.priors_used, 2);
eq('current ratio', eff.current, 0.037);
ok('delta negative (more efficient than priors mean)', (eff.delta_pct ?? 0) < 0);
eq('efficiency drops priors with no HR', efficiency({ avgSpeedMs: 3, avgHr: 150 }, [{ avgSpeedMs: 3, avgHr: 0 }]).priors_used, 0);

console.log('\nVAM + GAP:');
eq('VAM 600m in 1h', vam(600, 3600), 600);
eq('GAP per km', gapPerKm(10, 500, 3000), 214); // equiv 14km, 3000/14

console.log('\nHR/altitude coupling (trail):');
// HR rises monotonically with altitude → perfect positive r → tracks
eq(
  'HR tracks the climb (r=1)',
  hrAltitudeCorr([140, 150, 160, 170], [100, 110, 120, 130]),
  { corr: 1, tracks: 'tracks' },
);
// HR falls while altitude climbs → negative r → decoupled
eq(
  'HR decoupled from terrain (inverse)',
  hrAltitudeCorr([170, 160, 150, 140], [100, 110, 120, 130]),
  { corr: -1, tracks: 'decoupled' },
);
ok('null on flat HR (no variance)', hrAltitudeCorr([150, 150, 150, 150], [100, 110, 120, 130]) === null);
ok('null on too-short stream', hrAltitudeCorr([150], [100]) === null);
// misaligned lengths align to the shorter; invalid HR samples are dropped
eq(
  'aligns to shorter stream, drops invalid HR',
  hrAltitudeCorr([0, 150, 160, 170], [100, 110, 120, 130, 140])!.tracks,
  'tracks',
);

console.log('\nrecovery band (max across ladders):');
eq('band 1 easy', recoveryBand({ z3PlusPct: 0, z4PlusPct: 0, durationMin: 30 }), 1);
eq('band 2 moderate', recoveryBand({ z3PlusPct: 10, z4PlusPct: 0, durationMin: 30 }), 2);
eq('band 3 quality (Z3+ ≥20)', recoveryBand({ z3PlusPct: 30, z4PlusPct: 0, durationMin: 30 }), 3);
eq('band 3 any-Z4', recoveryBand({ z3PlusPct: 10, z4PlusPct: 3, durationMin: 30 }), 3);
eq('band 4 hard (Z3+ >50)', recoveryBand({ z3PlusPct: 60, z4PlusPct: 0, durationMin: 30 }), 4);
eq('band 3 exactly 50% Z3 (not >50)', recoveryBand({ z3PlusPct: 50, z4PlusPct: 0, durationMin: 40 }), 3);
// duration ladder honours "> 90 min HARD": long easy run → band 2, long hard run → band 4
eq('band 2 long easy run (>90 min, no intensity)', recoveryBand({ z3PlusPct: 0, z4PlusPct: 0, durationMin: 120 }), 2);
eq('band 4 long hard run (>90 min + quality intensity)', recoveryBand({ z3PlusPct: 30, z4PlusPct: 0, durationMin: 120 }), 4);
eq('band 5 race (Z4+ >20)', recoveryBand({ z3PlusPct: 60, z4PlusPct: 25, durationMin: 30 }), 5);
eq('band 3 window road', recoveryWindow(3, 'road', 0).window, '48h');
eq('band 3 window trail +1 day', recoveryWindow(3, 'trail', 20).trail_extended, true);
eq('band 5 window', recoveryWindow(5, 'road', 0).window, '5–7 days');

console.log('\nsigned-drift ordering + parsing:');
eq('extract signed +14', extractDrift('Cardiac drift: +14 bpm (flag if > 10 bpm)'), 14);
eq('extract signed -5', extractDrift('Cardiac drift: -5 bpm'), -5);
eq('extract missing', extractDrift('Recovery: 3/5'), null);
eq('-5 < +2 monotonic', isStrictlyIncreasing([-5, 2, 3, 4]), true);
eq('flat pair breaks', isStrictlyIncreasing([4, 7, 7, 13]), false);
eq('falling pair breaks', isStrictlyIncreasing([4, 7, 6, 13]), false);

console.log('\nweekly-load aggregation:');
const wlActs = [
  { start_date_local: '2026-06-01T07:00:00Z', distance: 10000, moving_time: 3000, total_elevation_gain: 50, average_heartrate: 150, max_heartrate: 175 },
  { start_date_local: '2026-06-03T07:00:00Z', distance: 5000, moving_time: 1500, total_elevation_gain: 20, average_heartrate: 130, max_heartrate: 160 },
];
const wl = aggregateWeeklyLoad(wlActs, zb, 4);
eq('4 calendar weeks incl. rest weeks', wl.weeks.length, 4);
eq('latest week active, km summed', wl.weeks[0].km, 15);
eq('older rest weeks included as empty rows', wl.weeks[1].activities, 0);
ok('tss_proxy computed', wl.weeks[0].tss_proxy > 0);

// interior rest week is surfaced (gap between active weeks), not compressed away
const gapActs = [
  { start_date_local: '2026-06-01T07:00:00Z', distance: 10000, moving_time: 3000, total_elevation_gain: 0, average_heartrate: 150, max_heartrate: 175 },
  { start_date_local: '2026-05-18T07:00:00Z', distance: 8000, moving_time: 2400, total_elevation_gain: 0, average_heartrate: 145, max_heartrate: 170 },
];
const gapWl = aggregateWeeklyLoad(gapActs, zb, 3);
eq('gap spans exactly 3 consecutive weeks', gapWl.weeks.length, 3);
eq('interior rest week empty', gapWl.weeks[1].activities, 0);
eq('older active week km present', gapWl.weeks[2].km, 8);

console.log('\ngetAccessToken (MCP config vs .env fallback):');
{
  const envProj = fs.mkdtempSync(path.join(os.tmpdir(), 'fitness-lab-token-'));
  fs.writeFileSync(path.join(envProj, '.env'), 'STRAVA_ACCESS_TOKEN=env-token\n');
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fitness-lab-mcpcfg-'));
  const configPath = path.join(configDir, 'config.json');
  const prevConfig = process.env.STRAVA_MCP_CONFIG;

  process.env.STRAVA_MCP_CONFIG = path.join(configDir, 'missing.json');
  eq('missing config file → .env fallback', getAccessToken(envProj), 'env-token');

  process.env.STRAVA_MCP_CONFIG = configPath;
  fs.writeFileSync(configPath, JSON.stringify({ accessToken: 'mcp-token', expiresAt: Date.now() / 1000 + 3600 }));
  eq('fresh config token wins over .env', getAccessToken(envProj), 'mcp-token');

  fs.writeFileSync(configPath, JSON.stringify({ accessToken: 'mcp-token', expiresAt: Date.now() / 1000 - 3600 }));
  eq('expired config token → .env fallback', getAccessToken(envProj), 'env-token');

  fs.writeFileSync(configPath, 'not json');
  eq('unparseable config → .env fallback', getAccessToken(envProj), 'env-token');

  fs.writeFileSync(configPath, JSON.stringify({ accessToken: 'mcp-token' }));
  eq('config token without expiresAt → .env fallback', getAccessToken(envProj), 'env-token');

  const noEnvProj = fs.mkdtempSync(path.join(os.tmpdir(), 'fitness-lab-noenv-'));
  process.env.STRAVA_MCP_CONFIG = path.join(configDir, 'missing.json');
  eq('no config, no .env → null', getAccessToken(noEnvProj), null);

  fs.writeFileSync(path.join(noEnvProj, '.env'), 'STRAVA_ACCESS_TOKEN=replace_me\n');
  eq('no config, .env placeholder → null', getAccessToken(noEnvProj), null);

  if (prevConfig === undefined) delete process.env.STRAVA_MCP_CONFIG;
  else process.env.STRAVA_MCP_CONFIG = prevConfig;

  fs.rmSync(envProj, { recursive: true });
  fs.rmSync(configDir, { recursive: true });
  fs.rmSync(noEnvProj, { recursive: true });
}

// ===========================================================================
// Contract layer
// ===========================================================================
const SCRIPT = path.join(import.meta.dir, 'fitness-lab.ts');

function tmpProject(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fitness-lab-'));
  fs.writeFileSync(path.join(d, '.env'), 'STRAVA_ACCESS_TOKEN=test-token\n');
  return d;
}

async function run(args: string[], base?: string): Promise<{ code: number; out: string }> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  // Isolate from any real ~/.config/strava-mcp/config.json on the host machine —
  // contract tests must exercise the .env fixture token, not a live operator credential.
  env.STRAVA_MCP_CONFIG = path.join(os.tmpdir(), `fitness-lab-no-mcp-config-${process.pid}.json`);
  if (base) env.STRAVA_API_BASE = base;
  else delete env.STRAVA_API_BASE;
  const proc = Bun.spawn(['bun', SCRIPT, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  return { code, out };
}

const DETAILS = {
  id: 123,
  name: 'Morning Run',
  sport_type: 'Run',
  type: 'Run',
  start_date_local: '2026-06-01T07:00:00Z',
  distance: 10000,
  moving_time: 3000,
  elapsed_time: 3100,
  average_heartrate: 150,
  max_heartrate: 175,
  total_elevation_gain: 50,
  average_speed: 3.33,
};
const LAPS = [
  { lap_index: 1, average_heartrate: 145, max_heartrate: 160, distance: 2500, moving_time: 750, elapsed_time: 760 },
  { lap_index: 2, average_heartrate: 150, max_heartrate: 165, distance: 2500, moving_time: 750, elapsed_time: 755 },
  { lap_index: 3, average_heartrate: 155, max_heartrate: 170, distance: 2500, moving_time: 750, elapsed_time: 758 },
  { lap_index: 4, average_heartrate: 158, max_heartrate: 175, distance: 2500, moving_time: 750, elapsed_time: 760 },
];
const STREAMS = {
  heartrate: { data: Array.from({ length: 20 }, (_, i) => 140 + i) },
  cadence: { data: Array.from({ length: 20 }, () => 88) },
  velocity_smooth: { data: Array.from({ length: 20 }, () => 3.3) },
  altitude: { data: Array.from({ length: 20 }, (_, i) => 100 + i) },
};
const ZONES = {
  heart_rate: {
    zones: [
      { min: 0, max: 120 },
      { min: 120, max: 140 },
      { min: 140, max: 160 },
      { min: 160, max: 180 },
      { min: 180, max: -1 },
    ],
  },
};
const SUMMARIES = [
  { id: 200, sport_type: 'Run', type: 'Run', start_date_local: '2026-05-30T07:00:00Z', distance: 8000, moving_time: 2500, total_elevation_gain: 30, average_heartrate: 148, max_heartrate: 172, average_speed: 3.2 },
  { id: 201, sport_type: 'Run', type: 'Run', start_date_local: '2026-05-28T07:00:00Z', distance: 6000, moving_time: 1900, total_elevation_gain: 20, average_heartrate: 145, max_heartrate: 168, average_speed: 3.15 },
  { id: 202, sport_type: 'Run', type: 'Run', start_date_local: '2026-05-25T07:00:00Z', distance: 12000, moving_time: 3800, total_elevation_gain: 60, average_heartrate: 152, max_heartrate: 176, average_speed: 3.1 },
];

function makeServer(mode: 'ok' | 'auth' | 'zones-auth') {
  return Bun.serve({
    port: 0,
    fetch(req) {
      if (mode === 'auth') return new Response('unauthorized', { status: 401 });
      const p = new URL(req.url).pathname;
      const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
      // 'zones-auth' models a token with activity scope but not profile:read_all —
      // /athlete/zones 401s while everything else succeeds.
      if (p === '/athlete/zones' && mode === 'zones-auth')
        return new Response('unauthorized', { status: 401 });
      if (p === '/athlete/zones') return json(ZONES);
      if (p === '/athlete/activities') return json(SUMMARIES);
      const m = p.match(/^\/activities\/(\d+)(\/laps|\/streams)?$/);
      if (m) {
        if (m[2] === '/laps') return json(LAPS);
        if (m[2] === '/streams') return json(STREAMS);
        return json(DETAILS);
      }
      return new Response('not found', { status: 404 });
    },
  });
}

console.log('\ncontract: analyze (happy path):');
{
  const server = makeServer('ok');
  const base = `http://localhost:${server.port}`;
  const proj = tmpProject();
  const { code, out } = await run(['analyze', '123', '--project-root', proj], base);
  server.stop(true);
  ok('exit 0', code === 0, `code ${code}, out ${out.slice(0, 200)}`);
  let j: any = {};
  try {
    j = JSON.parse(out);
  } catch {}
  eq('meta.activity_id', j?.meta?.activity_id, 123);
  ok('session_kind present', j?.session_kind === 'interval' || j?.session_kind === 'steady');
  ok('zones is array of 5', Array.isArray(j?.zones) && j.zones.length === 5);
  ok('thresholds echoed', j?.thresholds?.INTERVAL_MIN_CYCLES === 3);
  ok('warnings is array', Array.isArray(j?.warnings));
  ok('laps trimmed (no raw stream arrays)', Array.isArray(j?.laps) && j.laps.length === 4 && !('data' in (j.laps[0] || {})));
  ok('efficiency priors used', j?.efficiency?.priors_used >= 1);
  ok('work_segment_hrs present (interval progression source)', Array.isArray(j?.session_detail?.work_segment_hrs));
  ok('hr_altitude null on road', j?.hr_altitude === null);
  fs.rmSync(proj, { recursive: true });
}

console.log('\ncontract: analyze latest:');
{
  const server = makeServer('ok');
  const base = `http://localhost:${server.port}`;
  const proj = tmpProject();
  const { code, out } = await run(['analyze', 'latest', '--project-root', proj], base);
  server.stop(true);
  ok('exit 0 on latest', code === 0, out.slice(0, 200));
  fs.rmSync(proj, { recursive: true });
}

console.log('\ncontract: 401 auth failure:');
{
  const server = makeServer('auth');
  const base = `http://localhost:${server.port}`;
  const proj = tmpProject();
  const { code, out } = await run(['analyze', '123', '--project-root', proj], base);
  server.stop(true);
  ok('exit 1 on 401', code === 1);
  let j: any = {};
  try {
    j = JSON.parse(out);
  } catch {}
  eq('error kind', j?.error, 'strava_auth');
  eq('verbatim recovery message', j?.message, AUTH_RECOVERY_MESSAGE);
  fs.rmSync(proj, { recursive: true });
}

console.log('\ncontract: partial-scope 401 on /athlete/zones propagates (not swallowed):');
{
  // Regression: a 401 on an optionalFetch call (zones) must surface as strava_auth
  // exit 1, not be swallowed into a soft warning that silently understates recovery.
  const server = makeServer('zones-auth');
  const base = `http://localhost:${server.port}`;
  const proj = tmpProject();
  const { code, out } = await run(['analyze', '123', '--project-root', proj], base);
  server.stop(true);
  ok('exit 1 on zones 401', code === 1, `code ${code}, out ${out.slice(0, 200)}`);
  let j: any = {};
  try {
    j = JSON.parse(out);
  } catch {}
  eq('zones 401 → strava_auth', j?.error, 'strava_auth');
  fs.rmSync(proj, { recursive: true });
}

console.log('\ncontract: missing token → strava_auth:');
{
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'fitness-lab-notoken-')); // no .env
  const { code, out } = await run(['analyze', '123', '--project-root', proj], 'http://localhost:1');
  ok('exit 1 no token', code === 1);
  let j: any = {};
  try {
    j = JSON.parse(out);
  } catch {}
  eq('missing token maps to strava_auth', j?.error, 'strava_auth');
  fs.rmSync(proj, { recursive: true });
}

console.log('\ncontract: weekly-load:');
{
  const server = makeServer('ok');
  const base = `http://localhost:${server.port}`;
  const proj = tmpProject();
  const { code, out } = await run(['weekly-load', '--weeks', '4', '--project-root', proj], base);
  server.stop(true);
  ok('exit 0 weekly-load', code === 0, out.slice(0, 200));
  let j: any = {};
  try {
    j = JSON.parse(out);
  } catch {}
  ok('weeks array', Array.isArray(j?.weeks));
  ok('method documented', typeof j?.method?.tss_proxy === 'string');
  fs.rmSync(proj, { recursive: true });
}

console.log('\ncontract: weekly-patterns (no token, filesystem only):');
{
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'fitness-lab-wp-'));
  const compiled = path.join(proj, '.hermit', 'compiled');
  fs.mkdirSync(compiled, { recursive: true });
  const mk = (id: number, created: string, drift: number) =>
    fs.writeFileSync(
      path.join(compiled, `activity-${id}-${created}.md`),
      `---\ntitle: "x"\ntype: activity-note\ncreated: ${created}T10:00:00Z\nsession_kind: steady\n---\nActivity: x\nCardiac drift: ${drift >= 0 ? '+' : ''}${drift} bpm\n`,
    );
  mk(1, '2026-05-04', 4);
  mk(2, '2026-05-11', 7);
  mk(3, '2026-05-18', 9);
  mk(4, '2026-05-25', 13);
  const { code, out } = await run(['weekly-patterns', '--project-root', proj]);
  ok('exit 0 weekly-patterns', code === 0, out.slice(0, 200));
  let j: any = {};
  try {
    j = JSON.parse(out);
  } catch {}
  eq('steady_sessions_found', j?.steady_sessions_found, 4);
  eq('trend upward', j?.trend, 'upward');
  eq('series length', j?.series?.length, 4);
  eq('series oldest first', j?.series?.[0]?.drift, 4);
  fs.rmSync(proj, { recursive: true });
}

console.log('\nweekly-patterns unit (trail steady excluded → insufficient):');
{
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'fitness-lab-wp2-'));
  const compiled = path.join(proj, '.hermit', 'compiled');
  fs.mkdirSync(compiled, { recursive: true });
  // 3 steady with drift + 1 steady trail (HR/altitude, no drift line) → only 3 usable
  const mk = (id: number, created: string, body: string) =>
    fs.writeFileSync(
      path.join(compiled, `activity-${id}-${created}.md`),
      `---\ntype: activity-note\ncreated: ${created}T10:00:00Z\nsession_kind: steady\n---\n${body}\n`,
    );
  mk(1, '2026-05-04', 'Cardiac drift: +4 bpm');
  mk(2, '2026-05-11', 'Cardiac drift: +7 bpm');
  mk(3, '2026-05-18', 'Cardiac drift: +9 bpm');
  mk(4, '2026-05-25', 'HR/altitude: tracked the climb'); // trail steady, no drift line
  const r = weeklyPatterns(proj);
  eq('steady found 4 but drift series short → insufficient-data', r.trend, 'insufficient-data');
  eq('series only 3 (trail excluded at extraction)', r.series.length, 3);
  fs.rmSync(proj, { recursive: true });
}

console.log('\nreadDrift unit:');
{
  eq('frontmatter value used', readDrift({ cardiac_drift_bpm: '6' }, 'Cardiac drift: +99 bpm'), 6);
  eq('frontmatter zero honored (not falsy fallthrough)', readDrift({ cardiac_drift_bpm: '0' }, 'Cardiac drift: +99 bpm'), 0);
  eq('frontmatter negative honored', readDrift({ cardiac_drift_bpm: '-5' }, ''), -5);
  eq('missing field falls back to body', readDrift({}, 'Cardiac drift: +7 bpm'), 7);
  eq('malformed field falls back to body', readDrift({ cardiac_drift_bpm: 'n/a' }, 'Cardiac drift: +7 bpm'), 7);
  eq('malformed field, no body line, returns null', readDrift({ cardiac_drift_bpm: 'n/a' }, 'no drift here'), null);
}

console.log('\nweekly-patterns unit (mixed frontmatter + legacy prose notes):');
{
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'fitness-lab-wp4-'));
  const compiled = path.join(proj, '.hermit', 'compiled');
  fs.mkdirSync(compiled, { recursive: true });
  const mkFm = (id: number, created: string, drift: number) =>
    fs.writeFileSync(
      path.join(compiled, `activity-${id}-${created}.md`),
      `---\ntype: activity-note\ncreated: ${created}T10:00:00Z\nsession_kind: steady\ncardiac_drift_bpm: ${drift}\n---\nActivity: x\n`,
    );
  const mkProse = (id: number, created: string, drift: number) =>
    fs.writeFileSync(
      path.join(compiled, `activity-${id}-${created}.md`),
      `---\ntype: activity-note\ncreated: ${created}T10:00:00Z\nsession_kind: steady\n---\nActivity: x\nCardiac drift: ${drift >= 0 ? '+' : ''}${drift} bpm\n`,
    );
  mkProse(1, '2026-05-04', 4);
  mkProse(2, '2026-05-11', 7);
  mkFm(3, '2026-05-18', 9);
  mkFm(4, '2026-05-25', 13);
  const r = weeklyPatterns(proj);
  eq('trend upward across mixed readers', r.trend, 'upward');
  fs.rmSync(proj, { recursive: true });
}

console.log('\ncontract: rpe upsert:');
{
  const proj = tmpProject();
  const { code, out } = await run(['rpe', '555', '7', 'heavy', 'legs', '--project-root', proj]);
  ok('exit 0 rpe', code === 0, out.slice(0, 200));
  let j: any = {};
  try {
    j = JSON.parse(out);
  } catch {}
  eq('activity_id', j?.activity_id, 555);
  eq('written', j?.written, true);
  eq('previous null on first write', j?.previous, null);
  const stored = JSON.parse(fs.readFileSync(path.join(proj, '.hermit', 'state', 'activity-notes.json'), 'utf-8'));
  eq('stored rpe', stored['555'].rpe, 7);
  eq('stored notes', stored['555'].notes, 'heavy legs');
  ok('recorded_at present', typeof stored['555'].recorded_at === 'string');
  // overwrite returns previous
  const r2 = await run(['rpe', '555', '9', '--project-root', proj]);
  const j2 = JSON.parse(r2.out);
  eq('previous returned on overwrite', j2?.previous?.rpe, 7);
  const stored2 = JSON.parse(fs.readFileSync(path.join(proj, '.hermit', 'state', 'activity-notes.json'), 'utf-8'));
  eq('notes null when omitted', stored2['555'].notes, null);
  fs.rmSync(proj, { recursive: true });
}

console.log('\ncontract: rpe notes with a "--" token (not swallowed as a flag):');
{
  const proj = tmpProject();
  const { code } = await run(['rpe', '556', '6', 'felt', '--off', 'today', '--project-root', proj]);
  ok('exit 0 rpe with -- note', code === 0);
  const stored = JSON.parse(fs.readFileSync(path.join(proj, '.hermit', 'state', 'activity-notes.json'), 'utf-8'));
  eq('-- note preserved verbatim', stored['556'].notes, 'felt --off today');
  fs.rmSync(proj, { recursive: true });
}

console.log('\ncontract: rpe validation:');
{
  const proj = tmpProject();
  const { code, out } = await run(['rpe', '555', '11', '--project-root', proj]);
  ok('exit 1 on rpe out of range', code === 1);
  eq('fetch error kind', JSON.parse(out)?.error, 'fetch');
  fs.rmSync(proj, { recursive: true });
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
