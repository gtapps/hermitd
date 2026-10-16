import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { checkClassifierDenials, checkStateFiles, resolvePaths } from '../scripts/doctor-check';
import { freshDirFactory } from './helpers/workdir';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');
const { freshDir, cleanup } = freshDirFactory('hermit-classifier-denials-');
afterAll(cleanup);

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();

type Row = { ts: string; tool: string; prog?: string };

/** Seed the event log with `rows` ('missing' writes no file at all) and run the check. */
function scenario(rows: Row[] | 'missing' | 'unreadable' | string) {
  const projectRoot = freshDir();
  const hermitDir = path.join(projectRoot, '.hermit');
  const stateDir = path.join(hermitDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'permission-denied-events.jsonl');
  if (rows === 'unreadable') {
    fs.writeFileSync(file, '');
    fs.chmodSync(file, 0o000);
  } else if (typeof rows === 'string' && rows !== 'missing') {
    fs.writeFileSync(file, rows);
  } else if (Array.isArray(rows)) {
    fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  }
  return checkClassifierDenials(resolvePaths(hermitDir, PLUGIN_ROOT));
}

/** n denials on one tool, `gapMin` apart, newest first at `startMin` ago. */
const spread = (n: number, gapMin: number, startMin = 1, tool = 'Bash', prog: string | null = 'bun'): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    ts: minutesAgo(startMin + i * gapMin),
    tool,
    ...(prog ? { prog } : {}),
  }));

describe('doctor classifier-denials check', () => {
  test('absent file is ok', () => {
    const result = scenario('missing');
    expect(result.status).toBe('ok');
    expect(result.tier).toBe('maintainer');
    expect(result.detail).toBe('no classifier denials recorded in 7d');
  });

  test('an unreadable file warns rather than reading as a clean all-ok', () => {
    if (process.getuid?.() === 0) return; // root ignores the mode bits
    const result = scenario('unreadable');
    expect(result.status).toBe('warn');
    expect(result.tier).toBe('maintainer');
    expect(result.detail).toContain('check failed');
  });

  test('a malformed line is skipped, the good rows still count, and it is named', () => {
    const good = spread(3, 60);
    const result = scenario(good.map(r => JSON.stringify(r)).join('\n') + '\n{torn\n');
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('3 denials in 7d');
    expect(result.detail).toContain('1 unreadable row(s)');
  });

  test('a window of only malformed lines warns instead of reporting a clean all-ok', () => {
    // The regression that matters: skipping torn lines silently would report
    // "no classifier denials" over a damaged log — a false all-clear on the one
    // check whose job is to not under-report.
    const result = scenario('{torn\nnot json at all\n{"ts":"nope","tool":"Bash"}\n');
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('no readable classifier denials in 7d');
    expect(result.detail).toContain('3 unreadable row(s)');
  });

  test('a well-formed row that is merely out of window is not counted as unreadable', () => {
    const result = scenario([
      ...spread(3, 60),
      { ts: daysAgo(9), tool: 'Bash', prog: 'bun' },
    ]);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('3 denials in 7d');
    expect(result.detail).not.toContain('unreadable');
  });

  test('below the reporting floor stays ok but still renders the count', () => {
    const result = scenario(spread(2, 60));
    expect(result.status).toBe('ok');
    expect(result.tier).toBe('maintainer');
    expect(result.detail).toBe('2 denials in 7d — Bash: bun ×2; largest cluster 1 in 10 min');
  });

  test('the floor is reached by total alone, with every denial its own cluster', () => {
    const result = scenario(spread(3, 60));
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('largest cluster 1 in 10 min');
  });

  test('the floor is reached by a cluster alone', () => {
    const result = scenario(spread(2, 2));
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('largest cluster 2 in 10 min');
  });

  test('three inside ten minutes fails, correlating without asserting a stall', () => {
    const result = scenario(spread(3, 2));
    expect(result.status).toBe('fail');
    // Tagged on every status, not only the loud ones: the skill splits its notice on
    // this key, so an ok row that later warns must never change audience.
    expect(result.tier).toBe('maintainer');
    expect(result.detail).toContain('largest cluster 3 in 10 min');
    expect(result.detail).toContain('around where auto mode falls back to prompting');
    // A cluster is not the documented consecutive-denial count, so the row must
    // not claim this session actually stalled.
    expect(result.detail).not.toContain('session may have stalled');
  });

  test('a cluster spanning more than ten minutes warns rather than failing', () => {
    const result = scenario(spread(3, 6)); // 0, 6, 12 minutes — no 3 inside any 10
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('largest cluster 2 in 10 min');
  });

  test('a three-denial burst older than a day warns rather than failing', () => {
    const result = scenario(spread(3, 2, 25 * 60));
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('largest cluster 3 in 10 min (last 24h: 0)');
    expect(result.detail).not.toContain('falls back to prompting');
  });

  test('a cluster is cross-tool, which the old per-tool count could not see', () => {
    const result = scenario([
      { ts: minutesAgo(1), tool: 'Bash', prog: 'bun' },
      { ts: minutesAgo(3), tool: 'Read' },
      { ts: minutesAgo(5), tool: 'Edit' },
    ]);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('largest cluster 3 in 10 min');
  });

  test('tools are listed by count desc with their program breakdown', () => {
    const result = scenario([
      ...spread(5, 60, 1, 'Bash', 'bun'),
      ...spread(2, 60, 400, 'Bash', 'python3'),
      ...spread(2, 60, 700, 'mcp__discord__reply', null),
    ]);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain(
      '9 denials in 7d — Bash: bun ×5, python3 ×2; mcp__discord__reply ×2;',
    );
  });

  test('more tools than the display limit fold into +N more', () => {
    const result = scenario(
      ['A', 'B', 'C', 'D', 'E'].map((tool, i) => ({ ts: minutesAgo(60 * (i + 1)), tool })),
    );
    expect(result.detail).toContain('+2 more');
  });

  test('a long tool key is elided while the cluster count survives', () => {
    const long = 'mcp__' + 'x'.repeat(54);
    const result = scenario([
      ...spread(3, 60, 1, long, null),
      ...spread(3, 60, 400, long + 'y', null),
      ...spread(3, 60, 700, long + 'z', null),
    ]);
    expect(result.detail.length).toBeLessThanOrEqual(200);
    expect(result.detail).toContain('largest cluster 1 in 10 min');
  });

  test('rows older than 7 days are ignored', () => {
    const result = scenario([
      { ts: daysAgo(8), tool: 'Bash', prog: 'bun' },
      { ts: daysAgo(9), tool: 'Bash', prog: 'bun' },
    ]);
    expect(result.status).toBe('ok');
    expect(result.detail).toBe('no classifier denials recorded in 7d');
  });
});

describe('doctor state check — JSONL validation', () => {
  /** Seed one state/<name> with `body` and run the state-integrity check. */
  function stateScenario(name: string, body: string) {
    const projectRoot = freshDir();
    const hermitDir = path.join(projectRoot, '.hermit');
    fs.mkdirSync(path.join(hermitDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(hermitDir, 'state', name), body);
    return checkStateFiles(resolvePaths(hermitDir, PLUGIN_ROOT));
  }

  test('a newline-terminated malformed line is caught, not skipped as a torn tail', () => {
    // The whole file is one complete row. Dropping the last line unconditionally
    // meant a single-row corrupt ledger validated nothing and reported clean.
    const result = stateScenario('observations.jsonl', '{torn\n');
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('observations.jsonl');
  });

  test('a terminated malformed final row is caught even with valid history above it', () => {
    // The production shape: a real ledger plus one corrupt but newline-terminated
    // last row. Dropping the last line unconditionally validated only the history
    // and missed the damage.
    const result = stateScenario(
      'observations.jsonl',
      JSON.stringify({ ts: '2026-08-28T10:00:00Z' }) + '\n{torn\n',
    );
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('observations.jsonl');
  });

  test('an unterminated final line is still tolerated as a partial write', () => {
    const result = stateScenario(
      'observations.jsonl',
      JSON.stringify({ ts: '2026-08-28T10:00:00Z' }) + '\n{"ts":"2026-08-2',
    );
    expect(result.status).not.toBe('fail');
  });

  test('a malformed row that is not last is caught regardless of termination', () => {
    const result = stateScenario(
      'observations.jsonl',
      '{torn\n' + JSON.stringify({ ts: '2026-08-28T11:00:00Z' }) + '\n',
    );
    expect(result.status).toBe('fail');
  });

  test('a corrupt row is cited by file and line', () => {
    const row = JSON.stringify({ ts: '2026-08-28T10:00:00Z' });
    const result = stateScenario('observations.jsonl', `${row}\n${row}\n{torn\n`);
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('observations.jsonl:3');
  });

  test('NUL bytes ahead of an intact row warn with a repair that clears them', () => {
    const row = JSON.stringify({ ts: '2026-08-28T10:00:00Z' });
    const result = stateScenario('watchdog-events.jsonl', `${row}\n${'\0'.repeat(83)}${row}\n${row}\n`);
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('watchdog-events.jsonl:2');
    const fix = result.detail.split('; fix: ')[1];
    expect(fix).toContain("tr -d '\\000'");
    const run = Bun.spawnSync(['sh', '-c', fix]);
    expect(run.exitCode).toBe(0);
    const file = path.join(fix.match(/^cd '([^']+)'/)![1], 'watchdog-events.jsonl');
    expect(fs.existsSync(`${file}.bak`)).toBe(true);
    for (const line of fs.readFileSync(file, 'utf8').trim().split('\n')) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test('a corrupt row still fails when another ledger only has NUL leftovers', () => {
    const projectRoot = freshDir();
    const stateDir = path.join(projectRoot, '.hermit', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'watchdog-events.jsonl'), '\0\0{"a":1}\n');
    fs.writeFileSync(path.join(stateDir, 'observations.jsonl'), '{"a":1}\n{torn\n');
    const result = checkStateFiles(resolvePaths(path.join(projectRoot, '.hermit'), PLUGIN_ROOT));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('observations.jsonl:2');
  });
});
