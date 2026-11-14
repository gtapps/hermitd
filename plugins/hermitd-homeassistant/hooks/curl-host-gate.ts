// PreToolUse hook: auto-approve curl/wget calls that target the HA instance.
//
// WP8 port of hooks/curl-host-gate.py (standalone, stdlib-only — kept
// self-contained here too; the naive .env parser below deliberately matches
// the Python hook's own parser, NOT src/config.ts's python-dotenv semantics).
//
// Reads tool call JSON from stdin. If the Bash command string contains
// a known HA URL (from .env or env vars), emits a JSON allow decision.
// Otherwise exits silently (default permission behavior continues).
//
// Fail-open: any exception logs to stderr and exits 0. (This gate only ever
// ADDS an allow for HA-bound curl/wget; failing open means falling back to
// the normal permission flow, never granting anything.)
//
// Stdout stays byte-identical to the Python hook (pinned by
// tests/gate-corpus.test.ts). Stderr diagnostics on the exception path
// necessarily differ (CPython vs Bun error strings); the verdict — no
// decision, exit 0 — is identical.

import { readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

function loadEnvFile(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return result;
  }
  for (let line of text.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    // Python: val.strip().strip("'\"") — strips ALL leading/trailing quote chars.
    const val = line
      .slice(eq + 1)
      .trim()
      .replace(/^['"]+/, '')
      .replace(/['"]+$/, '');
    if (key) result[key] = val;
  }
  return result;
}

function buildNeedles(): string[] {
  const projectDir = process.env['CLAUDE_PROJECT_DIR'] ?? '';
  const fileVars = projectDir ? loadEnvFile(join(projectDir, '.env')) : {};
  const envVars: Record<string, string | undefined> = { ...fileVars, ...process.env }; // process env wins

  const needles: string[] = [];
  for (const key of ['HOMEASSISTANT_URL', 'HOMEASSISTANT_LOCAL_URL', 'HOMEASSISTANT_REMOTE_URL']) {
    const val = (envVars[key] ?? '').replace(/\/+$/, '');
    if (val) needles.push(val);
  }

  if (needles.length === 0) {
    return ['http://127.0.0.1:8123', 'http://localhost:8123', 'http://[::1]:8123'];
  }

  return [...new Set(needles)];
}

function main(): void {
  try {
    const payload: unknown = JSON.parse(readFileSync(0, 'utf8'));
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new TypeError('hook payload is not an object');
    }

    if ((payload as Record<string, unknown>)['tool_name'] !== 'Bash') {
      process.exit(0);
    }

    const toolInput = (payload as Record<string, unknown>)['tool_input'];
    let command = '';
    if (typeof toolInput === 'object' && toolInput !== null && !Array.isArray(toolInput)) {
      // Mirror Python's .get("command", ""): missing key -> ""; a present
      // non-string (incl. null) raised TypeError -> exception path.
      const cmd = (toolInput as Record<string, unknown>)['command'];
      if (cmd === undefined) command = '';
      else if (typeof cmd !== 'string') throw new TypeError('command is not a string');
      else command = cmd;
    } else if (toolInput !== undefined) {
      throw new TypeError('tool_input is not an object');
    }

    if (buildNeedles().some((needle) => command.includes(needle))) {
      // Byte-identical to Python's json.dumps(...) (all-ASCII fixed fields).
      writeSync(
        1,
        '{"hookSpecificOutput": {"hookEventName": "PreToolUse", ' +
          '"permissionDecision": "allow", ' +
          '"permissionDecisionReason": "curl/wget targets Home Assistant URL"}}\n',
      );
    }
  } catch (exc) {
    writeSync(2, `curl-host-gate: ${exc instanceof Error ? exc.message : String(exc)}\n`);
  }

  process.exit(0);
}

if (import.meta.main) {
  main();
}
