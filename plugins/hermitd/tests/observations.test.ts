import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import { runScript, runPinnedScript } from './helpers/run';
import { withDir, hermit, write } from './helpers/workdir';

describe('observations.ts observe', () => {
  async function observe(stateDir: string, source: string, label: string, ...flags: string[]) {
    // observations.ts pins its state-dir argv; AGENT_DIR is the sanctioned override.
    return runPinnedScript('observations.ts', stateDir, ['observe', stateDir, source, ...flags], { stdin: label });
  }
  const ledgerOf = (dir: string) => hermit(dir, 'state', 'observations.jsonl');

  test('observations (apostrophe in label survives)', withDir(async (dir) => {
    const r = await observe(hermit(dir), 'reflect-noticed', "bob's pattern", '--origin=own-work');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('OK');
    const line = JSON.parse(fs.readFileSync(ledgerOf(dir), 'utf-8').trim());
    expect(line.pattern).toBe("bob's pattern");
    expect(line.source).toBe('reflect-noticed');
    expect(line.origin).toBe('own-work');
  }));

  test('observations (double-quote and dollar sign survive)', withDir(async (dir) => {
    // Dollar signs must not expand. Under the old argv mode this was a live hazard;
    // stdin delivery makes it structurally impossible.
    const label = 'spend spiked: $5.00 vs "median" $3.50';
    const r = await observe(hermit(dir), 'quick-deferral', label);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(fs.readFileSync(ledgerOf(dir), 'utf-8').trim()).pattern).toBe(label);
  }));

  test('observations stamps the configured local date in session_id', withDir(async (dir) => {
    write(hermit(dir, 'config.json'), JSON.stringify({ timezone: 'Pacific/Honolulu' }));
    await observe(hermit(dir), 'quick-deferral', 'a label');
    const line = JSON.parse(fs.readFileSync(ledgerOf(dir), 'utf-8').trim());
    expect(line.session_id).toBe(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Pacific/Honolulu', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(line.ts)));
    expect(line.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  }));

  test('observations defaults to UTC without runtime or config', withDir(async (dir) => {
    await observe(hermit(dir), 'quick-deferral', 'a label');
    const line = JSON.parse(fs.readFileSync(ledgerOf(dir), 'utf-8').trim());
    expect(line.session_id).toBe(line.ts.slice(0, 10));
  }));

  test('observations ignores retained report identity', withDir(async (dir) => {
    write(hermit(dir, 'sessions', 'S-010-REPORT.md'), '# S-010\n');
    await observe(hermit(dir), 'quick-deferral', 'a label');
    const line = JSON.parse(fs.readFileSync(ledgerOf(dir), 'utf-8').trim());
    expect(line.session_id).toBe(line.ts.slice(0, 10));
  }));

  test('observations (deterministic sources are not invocable from the CLI)', withDir(async (dir) => {
    // cost-spike/behavior-digest/startup-drift are derived from data the model does
    // not hold; only the scripts that compute them may write them.
    for (const source of ['cost-spike', 'behavior-digest', 'startup-drift']) {
      const r = await observe(hermit(dir), source, 'forged');
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.stdout)).toEqual({ error: `invalid_source:${source}` });
    }
    expect(fs.existsSync(ledgerOf(dir))).toBe(false);
  }));

  test('observations (origin rejected on a source that never carries it)', withDir(async (dir) => {
    const r = await observe(hermit(dir), 'quick-deferral', 'a label', '--origin=own-work');
    expect(JSON.parse(r.stdout)).toEqual({ error: 'origin_not_allowed:quick-deferral' });
    expect(fs.existsSync(ledgerOf(dir))).toBe(false);
  }));

  test('observations (skill-preference sources accepted: pending and applied)', withDir(async (dir) => {
    for (const source of ['skill-preference', 'skill-preference-applied']) {
      const r = await observe(hermit(dir), source, 'skill-preference:email-draft', '--origin=own-work');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('OK');
    }
    const lines = fs.readFileSync(ledgerOf(dir), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.source)).toEqual(['skill-preference', 'skill-preference-applied']);
    expect(lines.every((l) => l.pattern === 'skill-preference:email-draft')).toBe(true);
  }));

  test('observations rejects the retired procedure source', withDir(async (dir) => {
    const r = await observe(hermit(dir), 'procedure-noticed', 'old-procedure', '--origin=own-work');
    expect(r.exitCode).toBe(1);
  }));

  test('observations rejects the retired correction source', withDir(async (dir) => {
    const r = await observe(hermit(dir), 'skill-correction', 'skill-correction:reflect', '--origin=own-work');
    expect(r.exitCode).toBe(1);
    expect(fs.existsSync(ledgerOf(dir))).toBe(false);
  }));

  test('observations (invalid origin value rejected)', withDir(async (dir) => {
    const r = await observe(hermit(dir), 'reflect-noticed', 'reflect-label', '--origin=elsewhere');
    expect(JSON.parse(r.stdout)).toEqual({ error: 'invalid_origin:elsewhere' });
    expect(fs.existsSync(ledgerOf(dir))).toBe(false);
  }));

  test('observations (empty and multiline labels write nothing)', withDir(async (dir) => {
    expect(JSON.parse((await observe(hermit(dir), 'quick-deferral', '   ')).stdout)).toEqual({ error: 'empty_pattern' });
    expect(JSON.parse((await observe(hermit(dir), 'quick-deferral', 'a\nb')).stdout)).toEqual({ error: 'multiline_pattern' });
    expect(fs.existsSync(ledgerOf(dir))).toBe(false);
  }));

  test('observations (over-long label rejected, ledger untouched)', withDir(async (dir) => {
    const r = await observe(hermit(dir), 'quick-deferral', 'x'.repeat(201));
    expect(JSON.parse(r.stdout)).toEqual({ error: 'pattern_too_long:201' });
    expect(fs.existsSync(ledgerOf(dir))).toBe(false);
  }));

  test('observations (a rejected row exits 1 with its error token)', withDir(async (dir) => {
    const r = await observe(hermit(dir), 'bogus-source', 'label');
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: 'invalid_source:bogus-source' });
  }));

  test('observations (mis-invocation exits 1 so a broken call site is loud)', withDir(async (dir) => {
    const r = await runPinnedScript('observations.ts', hermit(dir), ['observe', hermit(dir)], { stdin: 'label' });
    expect(r.exitCode).toBe(1);
  }));

  // observations.ts is reachable through a pre-approved
  // `Bash(bun */scripts/observations.ts observe*)` grant that covers every
  // argument after the verb (docs/security.md § Script Argument Trust).
  test('state-dir pin: refuses a ledger belonging to another project', withDir(async (mine) => {
    await withDir(async (victim) => {
      // AGENT_DIR pins hermitDir() to `mine`; argv still names `victim`.
      const r = await runScript('observations.ts', {
        args: ['observe', hermit(victim), 'reflect-noticed', '--origin=own-work'],
        env: { AGENT_DIR: hermit(mine) },
        stdin: 'attacker row',
      });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toStartWith('{"error":"foreign_state_dir:');
      expect(fs.existsSync(ledgerOf(victim))).toBe(false);
    })();
  }));

  // The `scanArgvFreeText` lint that used to live here is deliberately gone, not
  // retargeted. It existed to police free-text fields passed through single-quoted
  // argv — a hazard that only exists because an argv mode existed. observations.ts
  // takes the label on stdin and nothing else, so there is no shape left to lint;
  // a guard here would assert against a code path the interface cannot express.
  // The remaining structural guarantees are covered by the cases above.
});
