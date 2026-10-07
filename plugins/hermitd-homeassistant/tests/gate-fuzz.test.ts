// WP8 property tests for the TS safety hooks (fast-check, devDependency at
// the repo root — test-only, the hooks themselves stay dependency-free).
//
// Core property under test: the mcp gate is FAIL-CLOSED. Arbitrary / garbage
// stdin must never produce an allow verdict, never crash the runner, and
// never hang. In Claude Code PreToolUse semantics:
//   exit 0 + empty stdout            -> allow (tool call proceeds)
//   exit 0 + permissionDecision JSON -> ask
//   exit 2                            -> block
//   any other exit                    -> NON-blocking error = fail-open (the
//                                        bug the Python gate shipped with)
// so the gate must only ever exit 0 (for verifiably-safe targets) or 2.

import { afterAll, expect, test } from 'bun:test';
import fc from 'fast-check';
import { join } from 'node:path';

import { cleanEnv, cleanupTmp, makeHaConfig } from './helpers';

const MCP_HOOK = join(import.meta.dir, '..', 'hooks', 'mcp-safety-gate.ts');
const CURL_HOOK = join(import.meta.dir, '..', 'hooks', 'curl-host-gate.ts');

const MAX_STDIN_BYTES = 8 * 1024; // bound input sizes — no multi-MB fuzz cases
const TIMEOUT_MS = 10_000; // no-hang bound per spawn

afterAll(cleanupTmp);

// An isolated tmp root carrying an explicit strict config, never a repo-internal
// path: projectRoot() walks up to 8 ancestor dirs looking for
// .hermit/config.json, and import.meta.dir sits well within that
// range of this repo's own root — an operator with a hermit hatched there would
// have silently flipped every "under strict" assertion below to ask mode.
const STRICT_CWD = makeHaConfig('strict');

async function runGate(hook: string, stdin: string) {
  const r = Bun.spawn([process.execPath, hook], {
    stdin: Buffer.from(stdin.slice(0, MAX_STDIN_BYTES), 'utf8'),
    env: cleanEnv(),
    cwd: STRICT_CWD,
    timeout: TIMEOUT_MS,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exit, stdout, stderr] = await Promise.all([
    r.exited,
    new Response(r.stdout).text(),
    new Response(r.stderr).text(),
  ]);
  return { exit, stdout, stderr };
}

/** Reference oracle for "does this payload contain resolvable entity ids" —
 *  mirrors the documented stdin contract, not the implementation. */
function oracleExtractIds(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return [];
  const toolInput = (payload as Record<string, unknown>)['tool_input'];
  if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) return [];
  const ids: string[] = [];
  const collect = (val: unknown) => {
    if (typeof val === 'string' && val.includes('.')) ids.push(val);
    else if (Array.isArray(val)) {
      for (const v of val) if (typeof v === 'string' && v.includes('.')) ids.push(v);
    }
  };
  const ti = toolInput as Record<string, unknown>;
  collect(ti['entity_id']);
  collect(ti['device_id']);
  const target = ti['target'];
  if (typeof target === 'object' && target !== null && !Array.isArray(target)) {
    collect((target as Record<string, unknown>)['entity_id']);
  }
  return ids;
}

// The gate allowlists read-only HA tools (no entity_id, never actuate) before
// the fail-closed branch. They are the one no-id exception to "must block", so
// the fail-closed property excludes them. Astronomically unlikely for fast-check
// to synthesize these exact names, but the precondition keeps the property true.
const READONLY_TOOLS = new Set([
  'mcp__homeassistant__GetLiveContext',
  'mcp__homeassistant__GetDateTime',
  'mcp__homeassistant__homeassistant__GetLiveContext',
  'mcp__homeassistant__llm__GetDateTime',
]);
function isReadonlyTool(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  const name = (payload as Record<string, unknown>)['tool_name'];
  return typeof name === 'string' && READONLY_TOOLS.has(name);
}

const RUNS = Number(process.env.GATE_FUZZ_RUNS ?? 100);

// Each property spawns the hook subprocess RUNS times (~5-20s of real work), so
// it needs a budget well above bun's 5s default — otherwise it flakes under the
// full suite's concurrent load even though the assertions themselves pass.
const FUZZ_TIMEOUT_MS = 60_000;

test('mcp gate: arbitrary raw stdin never crashes, never hangs, never fails open', async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ maxLength: 2_000 }), async (raw) => {
      const r = await runGate(MCP_HOOK, raw);
      // Never any exit code other than 0 (allow/ask) or 2 (block) — anything
      // else is a non-blocking hook error, i.e. fail-open.
      expect([0, 2]).toContain(r.exit);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Unparseable stdin must always block.
        expect(r.exit).toBe(2);
        expect(r.stdout).toBe('');
        return;
      }
      if (oracleExtractIds(parsed).length === 0 && !isReadonlyTool(parsed)) {
        // No resolvable entity ids -> fail-closed, no decision emitted.
        // (Read-only allowlisted tools are the one exception.)
        expect(r.exit).toBe(2);
        expect(r.stdout).toBe('');
      }
    }),
    { numRuns: RUNS },
  );
}, FUZZ_TIMEOUT_MS);

test('mcp gate: arbitrary JSON payloads without resolvable ids always block', async () => {
  await fc.assert(
    fc.asyncProperty(fc.jsonValue({ maxDepth: 4 }), async (value) => {
      const stdin = JSON.stringify(value);
      fc.pre(stdin !== undefined && stdin.length <= MAX_STDIN_BYTES);
      fc.pre(oracleExtractIds(value).length === 0);
      fc.pre(!isReadonlyTool(value));
      const r = await runGate(MCP_HOOK, stdin);
      expect(r.exit).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).not.toBe('');
    }),
    { numRuns: RUNS },
  );
}, FUZZ_TIMEOUT_MS);

test('mcp gate: any payload carrying a sensitive entity id blocks under strict', async () => {
  const sensitiveId = fc.oneof(
    fc.constant('lock.front_door'),
    fc.constant('alarm_control_panel.home'),
    fc.string({ maxLength: 40 }).map((s) => `lock.${s.replace(/[ ]/g, '')}`),
  );
  const safeNoise = fc.array(
    fc.string({ maxLength: 30 }).map((s) => `light.${s.replace(/[ ]/g, '')}`),
    { maxLength: 5 },
  );
  await fc.assert(
    fc.asyncProperty(sensitiveId, safeNoise, fc.boolean(), async (sid, noise, viaTarget) => {
      const payload = viaTarget
        ? { tool_input: { entity_id: noise, target: { entity_id: sid } } }
        : { tool_input: { entity_id: [...noise, sid] } };
      const r = await runGate(MCP_HOOK, JSON.stringify(payload));
      expect(r.exit).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('Blocked sensitive entities');
    }),
    { numRuns: RUNS },
  );
}, FUZZ_TIMEOUT_MS);

test('curl gate: arbitrary raw stdin never exits nonzero and never grants without a needle', async () => {
  await fc.assert(
    fc.asyncProperty(fc.string({ maxLength: 2_000 }), async (raw) => {
      const r = await runGate(CURL_HOOK, raw);
      expect(r.exit).toBe(0);
      if (r.stdout !== '') {
        // An allow decision may only appear when the Bash command string
        // contains one of the default loopback needles (cleanEnv() has no
        // HOMEASSISTANT_* vars set).
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        expect(parsed['tool_name']).toBe('Bash');
        const command = (parsed['tool_input'] as Record<string, unknown>)['command'] as string;
        const hit = ['http://127.0.0.1:8123', 'http://localhost:8123', 'http://[::1]:8123'].some(
          (n) => command.includes(n),
        );
        expect(hit).toBe(true);
      }
    }),
    { numRuns: RUNS },
  );
}, FUZZ_TIMEOUT_MS);
