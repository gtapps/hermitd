#!/usr/bin/env bun
// PreToolUse hook: gate mcp__homeassistant__* calls targeting sensitive entities.
//
// Default-deny chokepoint for the whole homeassistant MCP server: the matcher
// covers every mcp__homeassistant__* call, and the read-only tools
// (GetLiveContext/GetDateTime) are allow-listed here in the gate rather than
// excluded by the matcher. Tool IDs assume the HA MCP Server is registered in
// Claude Code under the name 'homeassistant'.
//
// WP8 port of hooks/mcp-safety-gate.py. Imports the policy from ../src/policy
// (same plugin, same language) — the Python original imported the deleted
// ha_agent_lab.policy package, which never resolved on standard operator
// installs (no PYTHONPATH in hooks.json, package never pip-installed by
// hatch), so an ImportError crashed the hook with exit 1. Claude Code treats
// non-2 nonzero hook exits as NON-blocking, i.e. the gate failed OPEN. This
// port makes the gate self-contained and genuinely fail-closed.
//
// Reads tool call JSON from stdin. Extracts entity references from the tool
// input parameters and checks each against src/policy.
//
// Behavior depends on `ha_safety_mode` in .hermit/config.json:
//   - "strict" (default): sensitive entities → exit 2 (block, reason on stderr)
//   - "ask": sensitive entities → emit `permissionDecision: "ask"` JSON so
//     Claude Code prompts the operator before allowing the call
//
// Fail-safe: blocks (exit 2) on any parse error or unresolvable target. The
// dial does NOT relax this — it only changes how concrete sensitive entity
// IDs are handled.
//
// Output stays byte-identical to the Python hook (json.dumps default
// separators + ensure_ascii), pinned by tests/gate-corpus.test.ts.
// Deliberate divergence from the Python original: a valid-JSON payload that
// is not an object (e.g. `[]`, `"x"`, `42`, `null`) crashed Python with an
// uncaught AttributeError (exit 1 → fail-open); here it blocks (exit 2).

import { readFileSync, writeSync } from 'node:fs';

import {
  PermissionDecision,
  assistControl,
  classifyEntity,
  extractEntityIds,
  hasUnresolvableTarget,
  isHassIntentTool,
  isReadOnlyTool,
  isWellFormedEntityId,
  safetyMode,
} from '../src/policy';
import { projectRoot } from '../src/config';

// Emitted on both fail-closed branches (hard unresolvable target + opaque
// tool with no concrete target). Pinned to one literal so the two paths can't
// drift — gate-corpus asserts byte-equality against the retired Python gate.
const NO_RESOLVABLE_TARGET_MSG =
  'Cannot verify target safety: no resolvable entity IDs found ' +
  '(area_id / device_id targets are not evaluated). Use a proposal instead.';

/** Encode a string exactly like CPython json.dumps (ensure_ascii=True). */
export function pyJsonString(s: string): string {
  const SHORT: Record<string, string> = {
    '\\': '\\\\',
    '"': '\\"',
    '\b': '\\b',
    '\t': '\\t',
    '\n': '\\n',
    '\f': '\\f',
    '\r': '\\r',
  };
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    const code = s.charCodeAt(i);
    if (SHORT[ch] !== undefined) {
      out += SHORT[ch];
    } else if (code >= 0x20 && code <= 0x7e) {
      out += ch;
    } else {
      // Python escapes everything outside printable ASCII, including DEL and
      // astral chars (emitted as their UTF-16 surrogate pair, same as here).
      out += `\\u${code.toString(16).padStart(4, '0')}`;
    }
  }
  return out + '"';
}

function fail(message: string): never {
  // The exit code IS the fail-closed contract. A stderr write can itself throw
  // (closed fd / broken pipe = EPIPE/EBADF) — if that escaped, the process
  // would exit 1, which Claude Code treats as NON-blocking (fail-open). Never
  // let the diagnostic write decide the exit.
  try {
    writeSync(2, `${message}\n`);
  } catch {}
  process.exit(2);
}

// Emit a PreToolUse "ask" decision. Byte-identical to the Python gate's
// json.dumps(...) of the same dict: `, ` / `: ` separators + ensure_ascii.
// Called inside main()'s try so a writeSync EPIPE is caught and fails closed.
function emitAsk(reason: string): never {
  const encoded = pyJsonString(reason);
  writeSync(
    1,
    '{"hookSpecificOutput": {"hookEventName": "PreToolUse", ' +
      '"permissionDecision": "ask", ' +
      `"permissionDecisionReason": ${encoded}}}\n`,
  );
  process.exit(0);
}

function main(): void {
  let payload: unknown;
  try {
      payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    fail('Failed to parse hook input');
  }
  // Fail-closed hardening over the Python original (which crashed exit 1 /
  // fail-open here): valid JSON that is not an object is still unparseable
  // as a hook payload — block it.
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    fail('Failed to parse hook input');
  }

  // Everything past parsing runs under a catch-all: classifyEntity reads
  // config/.env from disk, and an uncaught I/O error (EACCES, EISDIR, TOCTOU
  // ENOENT) would exit 1 — which Claude Code treats as NON-blocking. A safety
  // gate must never fail open on an internal error.
  try {
    const toolName = (payload as Record<string, unknown>)['tool_name'];

    // Read-only tools (GetLiveContext/GetDateTime) carry no entity_id and never
    // actuate. The widened matcher routes them here — allow before any target
    // evaluation. isReadOnlyTool strips the mcp__homeassistant__ prefix so both
    // bare and qualified names match READ_ONLY_TOOLS in policy.ts.
    if (typeof toolName === 'string' && isReadOnlyTool(toolName)) {
      process.exit(0);
    }

    let toolInput = (payload as Record<string, unknown>)['tool_input'];
    if (typeof toolInput !== 'object' || toolInput === null || Array.isArray(toolInput)) {
      toolInput = {};
    }

    const entityIds = extractEntityIds(toolInput as Record<string, unknown>);
    const resolved = entityIds.filter(isWellFormedEntityId);

    // Hard fail-closed, every mode: a malformed entity_id slipped through
    // (e.g. `.lock`), or an area/floor/label/device selector fanned out to an
    // entity set we cannot enumerate here. The mode dial deliberately does not
    // relax this — an unverifiable fan-out could hit a sensitive entity.
    if (
      resolved.length !== entityIds.length ||
      hasUnresolvableTarget(toolInput as Record<string, unknown>, new Set(resolved))
    ) {
      fail(NO_RESOLVABLE_TARGET_MSG);
    }

    const root = projectRoot();

    // Opaque tool: no targeting selector and no concrete entity_id (e.g. a
    // script-derived MCP tool, which carries only its own fields). We can't
    // classify it by entity. Script tools are mode-dependent: prompt under
    // ask, hard-block under strict. A `Hass*` intent tool targets by
    // `name`/`area` — when `ha_assist_control_enabled` is set the operator
    // delegates target resolution to HA's own Assist/expose-to-Assist gate
    // and we pass through; when the opt-in is absent (default) `Hass*` stays
    // hard-blocked because we cannot enumerate its fan-out entity set.
    // Garbage with no tool_name also always fails closed.
    if (resolved.length === 0) {
      const isHassIntent = typeof toolName === 'string' && isHassIntentTool(toolName);
      if (isHassIntent && assistControl(root)) {
        process.exit(0);
      }
      const isScriptTool = typeof toolName === 'string' && !isHassIntent;
      if (isScriptTool && safetyMode(root) === 'ask') {
        emitAsk(`Unverified tool call: ${toolName} (no concrete entity target)`);
      }
      fail(NO_RESOLVABLE_TARGET_MSG);
    }

    const hits: Array<[string, PermissionDecision]> = [];
    for (const eid of entityIds) {
      const [sev] = classifyEntity(eid, root);
      if (sev !== PermissionDecision.ALLOW) hits.push([eid, sev]);
    }

    if (hits.length === 0) {
      process.exit(0);
    }

    // All hits share the same decision under the two-tier model; the current
    // mode applies uniformly to every sensitive entity in this call.
    const currentSev = hits[0]![1];
    const names = hits.map(([e]) => e).join(', ');

    if (currentSev === PermissionDecision.DENY) {
      fail(`Blocked sensitive entities: ${names}. Use a proposal instead.`);
    }

    emitAsk(`Sensitive entities: ${names}`);
  } catch (e: any) {
    fail(`Cannot verify target safety: internal error (${e?.code ?? 'unknown'}). Use a proposal instead.`);
  }
}

if (import.meta.main) {
  main();
}
