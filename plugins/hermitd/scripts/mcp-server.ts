// MCP stdio control surface — discover, observe, and wake hermits without
// coupling to `.hermit/` internals.
//
// Launch: `.hermit/bin/hermitd-run mcp-server --roots <dir,dir>`
// Inventory is explicit (arg wins over HERMIT_MCP_ROOTS). Stdout is JSON-RPC
// frames only; logs go to stderr. The process never writes under a hermit root.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { flagEq, flagValue, readJson } from './lib/cli';
import { isContainer } from './lib/container';
import { readConfigRaw } from './lib/config-read';
import { LIVENESS_FRESH_SECS, sharedLivenessAgeSecs } from './lib/liveness';
import { isPaused } from './lib/pause';
import { postToSession } from './lib/peer-post';
import { readRuntimeState, type RuntimeRead } from './lib/runtime';
import { findResident } from './lib/session-registry';
import { readTaskReports } from './lib/task-report';
import { readExecution } from './lib/tasks';

type Json = any;

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dir, '..');
const WAKE_TOKEN = 'HEARTBEAT_EVALUATE';
const BRIEF_CAP_BYTES = 16 * 1024;
const RELAY_TIMEOUT_MS = 15_000;
// This is an `initialize`-handshake server, so the advertised range is bounded
// on both ends. Ceiling: 2026-07-28 is stateless and has no initialize/ping at
// all (its spec dir drops lifecycle.mdx and carries the version in per-request
// _meta), so advertising it would strand modern-only clients on this server's
// "not initialized" rejection. Floor: revisions before 2025-06-18 require
// receiving JSON-RPC batches, which this server rejects with -32600.
const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
];
// The latest version this server speaks; offered to a client that asked for one
// we do not support, per the lifecycle rule below.
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const ROOT_PROP = {
  type: 'object',
  properties: {
    root: { type: 'string', description: 'Absolute project root from list_hermits (must be in the configured inventory)' },
  },
  required: ['root'],
};

const TOOLS = [
  {
    name: 'list_hermits',
    description: 'List the hermits in this server\'s configured inventory.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_status',
    description: 'Runtime digest, task records, pause, liveness, and resident process for one hermit.',
    inputSchema: ROOT_PROP,
  },
  {
    name: 'get_health',
    description: 'Availability facet plus doctor-report diagnostics. Stale liveness is unknown, never down.',
    inputSchema: ROOT_PROP,
  },
  {
    name: 'get_brief',
    description: 'Task records plus last-brief.json, or the latest task record if no brief is stored.',
    inputSchema: ROOT_PROP,
  },
  {
    name: 'get_version',
    description: 'Loaded plugin version vs the version applied in this hermit\'s config, plus runtime floors.',
    inputSchema: ROOT_PROP,
  },
  {
    name: 'wake',
    description: 'Post HEARTBEAT_EVALUATE to the stamped inbox socket. Refuses while paused. Never claims delivery.',
    inputSchema: ROOT_PROP,
  },
];

function pluginVersion(): string {
  const raw = readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'));
  return typeof raw?.version === 'string' ? raw.version : '0.0.0';
}

function hermitDir(projectRoot: string): string {
  return path.join(projectRoot, '.hermit');
}

function stateDir(projectRoot: string): string {
  return path.join(projectRoot, '.hermit', 'state');
}

// Resolves once the most recent frame has been handed to the OS. process.stdout
// writes to a pipe are asynchronous on macOS, so the shutdown path must await
// this before process.exit() or a one-shot client loses its last reply.
let lastWrite: Promise<void> = Promise.resolve();

function send(msg: Json): void {
  lastWrite = new Promise((resolve) => {
    process.stdout.write(JSON.stringify(msg) + '\n', () => resolve());
  });
}

function rpcResult(id: Json, result: Json): Json {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: Json, code: number, message: string, data?: Json): Json {
  const error: Json = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function toolResult(obj: Json, isError = false): Json {
  const result: Json = {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    structuredContent: obj,
  };
  if (isError) result.isError = true;
  return result;
}

function toolError(message: string): Json {
  return toolResult({ error: message }, true);
}

function loadInventory(rootsRaw: string | undefined): string[] {
  if (!rootsRaw || !rootsRaw.trim()) return [];
  const parts = rootsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    let resolved: string;
    try {
      resolved = fs.realpathSync(p);
    } catch {
      throw new Error(`root not found: ${p}`);
    }
    if (seen.has(resolved)) throw new Error(`duplicate root: ${resolved}`);
    const marker = path.join(resolved, '.hermit');
    let st: fs.Stats | undefined;
    try { st = fs.statSync(marker); } catch {}
    if (!st?.isDirectory()) throw new Error(`not a hermit root (missing .hermit/): ${resolved}`);
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function resolveInventoryRoot(rootArg: unknown, inventory: string[]): string | Json {
  if (typeof rootArg !== 'string' || !rootArg.trim()) return toolError('root is required');
  let resolved: string;
  try {
    resolved = fs.realpathSync(rootArg);
  } catch {
    return toolError(`root is not in the configured inventory: ${rootArg}`);
  }
  if (!inventory.includes(resolved)) {
    return toolError(`root is not in the configured inventory: ${rootArg}`);
  }
  return resolved;
}

function agentName(hermit: string): string | null {
  const cfg = readConfigRaw(hermit);
  return typeof cfg?.agent_name === 'string' && cfg.agent_name.trim() ? cfg.agent_name : null;
}

function residentOf(runtime: Json): Json | null {
  const entry = findResident(runtime, runtime?.config_dir);
  if (!entry) return null;
  return { status: entry.status, statusUpdatedAt: entry.statusUpdatedAt, pid: entry.pid };
}

function loadStatus(hermit: string): Json {
  // Bounded like task-report.ts: records are never pruned, and this lands in the caller's context.
  const tasks = readTaskReports(hermit)
    .sort((a, b) => (b.closed_at ?? b.opened_at).localeCompare(a.closed_at ?? a.opened_at));
  return { execution: readExecution(hermit), tasks: tasks.slice(0, 20), tasks_omitted: Math.max(0, tasks.length - 20) };
}

function runtimeDigest(runtime: RuntimeRead): Json {
  if (runtime.kind === 'missing') return { kind: 'missing' };
  if (runtime.kind === 'invalid') return { kind: 'invalid', reason: runtime.reason };
  const d = runtime.data;
  return {
    kind: 'ok',
    runtime_mode: typeof d.runtime_mode === 'string' && d.runtime_mode ? d.runtime_mode : 'unknown',
    shutdown_completed_at: typeof d.shutdown_completed_at === 'string' && d.shutdown_completed_at
      ? d.shutdown_completed_at
      : null,
  };
}

function utf8Truncate(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return { text: s, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

function listHermits(inventory: string[]): Json {
  return {
    hermits: inventory.map((root) => {
      const hermit = hermitDir(root);
      const runtime = readRuntimeState(stateDir(root));
      const mode = runtime.kind === 'ok' && typeof runtime.data.runtime_mode === 'string' && runtime.data.runtime_mode
        ? runtime.data.runtime_mode
        : 'unknown';
      return {
        root,
        name: agentName(hermit),
        runtime_mode: mode,
        liveness_age_secs: sharedLivenessAgeSecs(hermit),
        paused: isPaused(hermit).paused,
      };
    }),
  };
}

function getStatus(root: string): Json {
  const hermit = hermitDir(root);
  const runtime = readRuntimeState(stateDir(root));
  return {
    root,
    runtime: runtimeDigest(runtime),
    status: loadStatus(hermit),
    paused: isPaused(hermit).paused,
    liveness_age_secs: sharedLivenessAgeSecs(hermit),
    resident: runtime.kind === 'ok' ? residentOf(runtime.data) : null,
  };
}

function getHealth(root: string): Json {
  const hermit = hermitDir(root);
  const runtime = readRuntimeState(stateDir(root));
  const age = sharedLivenessAgeSecs(hermit);
  const shutdown = runtime.kind === 'ok' && typeof runtime.data.shutdown_completed_at === 'string'
    && runtime.data.shutdown_completed_at
    ? runtime.data.shutdown_completed_at
    : null;
  const resident = runtime.kind === 'ok' ? residentOf(runtime.data) : null;
  const fresh = age !== null && age < LIVENESS_FRESH_SECS;
  let state: 'alive' | 'reported_down' | 'unknown';
  if (fresh || resident) state = 'alive';
  else if (shutdown) state = 'reported_down';
  else state = 'unknown';

  return {
    availability: {
      state,
      liveness_age_secs: age,
      liveness_fresh_secs: LIVENESS_FRESH_SECS,
      shutdown_completed_at: shutdown,
      resident,
    },
    diagnostics: loadDiagnostics(hermit),
  };
}

function loadDiagnostics(hermit: string): Json {
  const raw = readJson(path.join(hermit, 'state', 'doctor-report.json'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const ts = typeof raw.ts === 'string' ? raw.ts : null;
  const checks = Array.isArray(raw.checks) ? raw.checks : [];
  const counts: Record<string, number> = {};
  const failing: string[] = [];
  for (const c of checks) {
    if (!c || typeof c !== 'object') continue;
    const status = typeof c.status === 'string' ? c.status : 'unknown';
    counts[status] = (counts[status] ?? 0) + 1;
    if (status === 'fail' && typeof c.id === 'string') failing.push(c.id);
  }
  let age_secs: number | null = null;
  if (ts) {
    const t = Date.parse(ts);
    if (!Number.isNaN(t)) age_secs = (Date.now() - t) / 1000;
  }
  return { ts, age_secs, counts, failing };
}

function getBrief(root: string): Json {
  const hermit = hermitDir(root);
  const lastBrief = loadLastBrief(hermit);
  if (lastBrief) {
    const cap = utf8Truncate(lastBrief.text, BRIEF_CAP_BYTES);
    return {
      status: loadStatus(hermit),
      last_brief: { kind: lastBrief.kind, text: cap.text, generated_at: lastBrief.generated_at, truncated: cap.truncated },
      report: null,
    };
  }
  return {
    status: loadStatus(hermit),
    last_brief: null,
    report: loadLatestReport(hermit),
  };
}

function loadLastBrief(hermit: string): { kind: string | null; text: string; generated_at: string | null } | null {
  const raw = readJson(path.join(hermit, 'state', 'last-brief.json'));
  if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string') return null;
  return {
    kind: typeof raw.kind === 'string' ? raw.kind : null,
    text: raw.text,
    generated_at: typeof raw.generated_at === 'string' ? raw.generated_at : null,
  };
}

function loadLatestReport(hermit: string): Json {
  const reports = readTaskReports(hermit).sort((a, b) => b.opened_at.localeCompare(a.opened_at));
  const report = reports[0];
  if (!report) return null;
  const cap = utf8Truncate([report.title, ...report.lessons].join('\n'), BRIEF_CAP_BYTES);
  return { ...report, summary: cap.text, truncated: cap.truncated };
}

function getVersion(root: string): Json {
  const plugin = readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json')) ?? {};
  const meta = readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'hermit-meta.json')) ?? {};
  const cfg = readConfigRaw(hermitDir(root));
  const applied = cfg?._hermit_versions?.['hermitd'];
  return {
    loaded: typeof plugin.version === 'string' ? plugin.version : null,
    applied: typeof applied === 'string' ? applied : null,
    required_bun_version: typeof meta.required_bun_version === 'string' ? meta.required_bun_version : null,
    min_claude_code_version: typeof meta.min_claude_code_version === 'string' ? meta.min_claude_code_version : null,
    contract_version: 1,
  };
}

// `delivery` is the discriminator; pause state is not echoed here. A `paused`
// key would be true exactly when `delivery === 'suppressed'`, and inviting
// consumers to branch on it hides the flushed/unreachable split that matters.
function wakeResult(write_status: 'flushed' | 'unreachable'): Json {
  return { write_status, delivery: 'unconfirmed' };
}

function relayWake(projectRoot: string): Json {
  const r = spawnSync('docker', [
    'compose', '-f', 'docker-compose.hermit.yml', 'exec', '-T', 'hermit',
    '.hermit/bin/hermitd-run', 'mcp-server', '--wake-local',
  ], {
    cwd: projectRoot,
    // spawnSync's `cwd` does not update PWD, and the compose template
    // interpolates ${PWD} (bind mount + working_dir). Inherited from an
    // orchestrator that spawned this server elsewhere, that resolves to the
    // wrong tree — or, when PWD is absent entirely, to an empty volume spec
    // compose rejects outright.
    env: { ...process.env, PWD: projectRoot },
    timeout: RELAY_TIMEOUT_MS,
    stdio: 'ignore',
  });
  return wakeResult(!r.error && r.status === 0 ? 'flushed' : 'unreachable');
}

async function localWake(projectRoot: string): Promise<Json> {
  const runtime = readRuntimeState(stateDir(projectRoot));
  const sock = runtime.kind === 'ok' ? runtime.data.inbox_socket : null;
  if (typeof sock !== 'string' || !sock) return wakeResult('unreachable');
  const verdict = await postToSession(sock, WAKE_TOKEN);
  return wakeResult(verdict === 'sent' ? 'flushed' : 'unreachable');
}

async function toolWake(root: string): Promise<Json> {
  if (isPaused(hermitDir(root)).paused) {
    return { delivery: 'suppressed', reason: 'paused' };
  }
  const runtime = readRuntimeState(stateDir(root));
  const mode = runtime.kind === 'ok' ? runtime.data.runtime_mode : null;
  if (mode === 'docker' && !isContainer()) return relayWake(root);
  return localWake(root);
}

async function runWakeLocal(projectRoot: string): Promise<boolean> {
  // The relay already gated on pause before spawning this, so this is a no-op
  // there — it closes the hole for a direct `--wake-local` invocation, which
  // must not spend a paid turn the operator explicitly stopped.
  if (isPaused(hermitDir(projectRoot)).paused) {
    process.stderr.write('[mcp-server] wake suppressed: hermit is paused\n');
    return false;
  }
  const result = await localWake(projectRoot);
  return result.write_status === 'flushed';
}

async function dispatchTool(name: string, args: Json, inventory: string[]): Promise<Json> {
  if (name === 'list_hermits') return toolResult(listHermits(inventory));
  const resolved = resolveInventoryRoot(args?.root, inventory);
  if (typeof resolved !== 'string') return resolved;
  if (name === 'get_status') return toolResult(getStatus(resolved));
  if (name === 'get_health') return toolResult(getHealth(resolved));
  if (name === 'get_brief') return toolResult(getBrief(resolved));
  if (name === 'get_version') return toolResult(getVersion(resolved));
  if (name === 'wake') return toolResult(await toolWake(resolved));
  return toolError(`Unknown tool: ${name}`);
}

function handleInitialize(id: Json, params: Json, ctx: { initialized: boolean }): Json {
  const requested = params?.protocolVersion;
  // 2025-06-18 and 2025-11-25 lifecycle: an unsupported version is not an
  // error. "The server MUST respond with another protocol version it supports
  // ... If the client does not support the version in the server's response,
  // it SHOULD disconnect." Answering -32022 instead would deny a legacy client
  // the chance to negotiate down; that code belongs to the stateless revision.
  const agreed = typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
  ctx.initialized = true;
  return rpcResult(id, {
    protocolVersion: agreed,
    capabilities: { tools: {} },
    serverInfo: { name: 'hermitd', version: pluginVersion() },
  });
}

async function handleLine(line: string, ctx: { inventory: string[]; initialized: boolean }): Promise<void> {
  if (!line.trim()) return;
  let msg: Json;
  try {
    msg = JSON.parse(line);
  } catch {
    send(rpcError(null, -32700, 'Parse error'));
    return;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    send(rpcError(null, -32600, 'Invalid Request'));
    return;
  }
  const isNotification = !('id' in msg);
  const id = isNotification ? undefined : msg.id;
  if (typeof msg.method !== 'string') {
    if (!isNotification) send(rpcError(id ?? null, -32600, 'Invalid Request'));
    return;
  }
  const method: string = msg.method;
  const params = msg.params;

  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (isNotification) return;

  if (method === 'initialize') {
    send(handleInitialize(id, params, ctx));
    return;
  }
  if (method === 'ping') {
    send(rpcResult(id, {}));
    return;
  }
  if ((method === 'tools/list' || method === 'tools/call') && !ctx.initialized) {
    send(rpcError(id, -32600, 'Server not initialized'));
    return;
  }
  if (method === 'tools/list') {
    send(rpcResult(id, { tools: TOOLS }));
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    if (typeof name !== 'string' || !TOOLS.some((t) => t.name === name)) {
      send(rpcError(id, -32601, `Unknown tool: ${name}`));
      return;
    }
    const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    // Every request must get a reply: an unexpected throw inside a handler
    // would otherwise reach the chain's catch, log to stderr, and leave the
    // client waiting on an id that never comes back.
    try {
      send(rpcResult(id, await dispatchTool(name, args, ctx.inventory)));
    } catch (err: any) {
      send(rpcError(id, -32603, `Internal error: ${err?.message ?? err}`));
    }
    return;
  }
  send(rpcError(id, -32601, `Method not found: ${method}`));
}

function startServer(inventory: string[]): void {
  const ctx = { inventory, initialized: false };
  const rl = readline.createInterface({ input: process.stdin });
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    chain = chain.then(() => handleLine(line, ctx)).catch((err: any) => {
      process.stderr.write(`[mcp-server] ${err?.message ?? err}\n`);
    });
  });
  rl.on('close', () => {
    void chain.then(() => lastWrite).then(() => process.exit(0));
  });
}

function main(): void {
  const argv = process.argv.slice(2);
  const wakeLocal = argv.includes('--wake-local');
  const rootsArg = flagValue(argv, '--roots') ?? flagEq(argv, 'roots');
  const rootsRaw = rootsArg !== undefined ? rootsArg : process.env.HERMIT_MCP_ROOTS;

  if (wakeLocal) {
    void runWakeLocal(process.cwd()).then((ok) => process.exit(ok ? 0 : 1));
    return;
  }

  // A valueless `--roots` (typo, or a trailing flag) must not slide into the
  // env fallback and come up as a server that silently sees no hermits.
  if (argv.includes('--roots') && flagValue(argv, '--roots') === undefined) {
    process.stderr.write('[mcp-server] --roots requires a comma-separated list of project roots\n');
    process.exit(1);
    return;
  }

  let inventory: string[];
  try {
    inventory = loadInventory(rootsRaw);
  } catch (e: any) {
    process.stderr.write(`[mcp-server] ${e.message}\n`);
    process.exit(1);
    return;
  }
  startServer(inventory);
}

if (import.meta.main) main();
