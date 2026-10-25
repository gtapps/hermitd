import { mutateTask } from '../scripts/lib/tasks';
// Interactive stdio coverage for scripts/mcp-server.ts. runScript() waits for
// exit on a finite stdin buffer, so these tests drive Bun.spawn with a piped
// stdin and wait for the matching-id reply line (same arrival-polling pattern
// as tests/peer-post.test.ts waitForLines).

import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN_ROOT, SCRIPTS_DIR, runScript } from './helpers/run';
import { setupWorkdir, writeConfig } from './helpers/workdir';
import { LIVENESS_FRESH_SECS } from '../scripts/lib/liveness';
import { setPause } from '../scripts/lib/pause';
import { userMessageLine } from '../scripts/lib/peer-post';
import { localIdentity } from './helpers/registry-fixture';

type Json = any;

const SCRIPT = path.join(SCRIPTS_DIR, 'mcp-server.ts');
const PLUGIN_VERSION = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf-8'),
).version;
const HERMIT_META = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'hermit-meta.json'), 'utf-8'),
);

const tmpdirs: string[] = [];
afterAll(() => {
  for (const d of tmpdirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

function hermit(dir: string, ...p: string[]): string {
  return path.join(dir, '.hermit', ...p);
}

function writeJson(p: string, value: Json): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + '\n');
}

function writeAged(file: string, ageSecs: number, contents = '{}'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  const when = (Date.now() - ageSecs * 1000) / 1000;
  fs.utimesSync(file, when, when);
}

function writeResident(wdDir: string, entryPatch: Json, runtimePatch: Json = {}): { ident: Json; configDir: string } {
  const configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-reg-')));
  tmpdirs.push(configDir);
  fs.mkdirSync(path.join(configDir, 'sessions'), { recursive: true });
  const ident = localIdentity();
  writeJson(path.join(configDir, 'sessions', `${ident.pid}.json`), {
    ...ident,
    kind: 'interactive',
    cwd: wdDir,
    name: 'resident',
    messagingSocketPath: '/tmp/unused.sock',
    ...entryPatch,
  });
  writeJson(hermit(wdDir, 'state', 'runtime.json'), {
    runtime_mode: 'tmux',
    session_pid: ident.pid,
    config_dir: configDir,
    ...runtimePatch,
  });
  return { ident, configDir };
}

type Inbox = { socketPath: string; lines: string[]; close: () => void };

async function inboxServer(): Promise<Inbox> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-wake-'));
  tmpdirs.push(dir);
  const socketPath = path.join(dir, 'inbox.sock');
  const lines: string[] = [];
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    lines,
    close: () => {
      server.close();
    },
  };
}

async function waitForLines(lines: string[], n: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (lines.length < n && Date.now() < deadline) await Bun.sleep(10);
}

class McpSession {
  proc: ReturnType<typeof Bun.spawn>;
  lines: string[] = [];
  stderrChunks: string[] = [];
  private nextId = 1;

  constructor(proc: ReturnType<typeof Bun.spawn>) {
    this.proc = proc;
    void collectLines(piped(proc.stdout), this.lines);
    void collectLines(piped(proc.stderr), this.stderrChunks);
  }

  static start(args: string[] = [], env: Record<string, string> = {}): McpSession {
    const proc = Bun.spawn({
      cmd: [process.execPath, SCRIPT, ...args],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, ...env },
    });
    return new McpSession(proc);
  }

  writeRaw(line: string): void {
    (this.proc.stdin as unknown as { write(s: string): void }).write(line.endsWith('\n') ? line : line + '\n');
  }

  notify(method: string, params?: Json): void {
    const msg: Json = { jsonrpc: '2.0', method };
    if (params !== undefined) msg.params = params;
    this.writeRaw(JSON.stringify(msg));
  }

  async rpc(method: string, params?: Json, id?: number | string): Promise<Json> {
    const useId = id ?? this.nextId++;
    const msg: Json = { jsonrpc: '2.0', id: useId, method };
    if (params !== undefined) msg.params = params;
    this.writeRaw(JSON.stringify(msg));
    return this.waitForId(useId);
  }

  async waitForId(id: number | string | null, timeoutMs = 4000): Promise<Json> {
    const deadline = Date.now() + timeoutMs;
    const seen = new Set<number>();
    while (Date.now() < deadline) {
      for (let i = 0; i < this.lines.length; i++) {
        if (seen.has(i)) continue;
        try {
          const obj = JSON.parse(this.lines[i]);
          if (obj && obj.id === id) return obj;
        } catch {}
        seen.add(i);
      }
      await Bun.sleep(10);
    }
    throw new Error(
      `timeout waiting for id=${JSON.stringify(id)}; stdout=${JSON.stringify(this.lines)}; stderr=${this.stderrChunks.join('\n')}`,
    );
  }

  async waitForErrorIdNull(timeoutMs = 4000): Promise<Json> {
    return this.waitForId(null, timeoutMs);
  }

  async close(): Promise<number> {
    try { (this.proc.stdin as unknown as { end(): void }).end(); } catch {}
    return await this.proc.exited;
  }

  kill(): void {
    try { this.proc.kill(); } catch {}
  }
}

function piped(stream: ReturnType<typeof Bun.spawn>['stdout']): ReadableStream<Uint8Array> {
  if (stream instanceof ReadableStream) return stream;
  throw new Error('expected piped stdio');
}

async function collectLines(stream: ReadableStream<Uint8Array>, lines: string[]): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    }
    if (buf) lines.push(buf);
  } catch { /* stream closed */ }
}

async function handshake(session: McpSession, version = '2025-11-25'): Promise<Json> {
  const init = await session.rpc('initialize', {
    protocolVersion: version,
    capabilities: {},
    clientInfo: { name: 'mcp-server-test', version: '0' },
  });
  session.notify('notifications/initialized');
  return init;
}

async function callTool(session: McpSession, name: string, args: Json = {}): Promise<Json> {
  return session.rpc('tools/call', { name, arguments: args });
}

function toolBody(reply: Json): Json {
  expect(reply.error).toBeUndefined();
  expect(reply.result).toBeTruthy();
  const result = reply.result;
  expect(result.content).toEqual([{ type: 'text', text: result.content[0].text }]);
  expect(result.structuredContent).toEqual(JSON.parse(result.content[0].text));
  return result.structuredContent;
}

describe('handshake', () => {
  test('initialize echoes a supported protocolVersion, capabilities.tools, and plugin version', async () => {
    const s = McpSession.start();
    try {
      const init = await handshake(s);
      expect(init.result.protocolVersion).toBe('2025-11-25');
      expect(init.result.capabilities).toEqual({ tools: {} });
      expect(init.result.serverInfo).toEqual({ name: 'hermitd', version: PLUGIN_VERSION });
      const pong = await s.rpc('ping');
      expect(pong.result).toEqual({});
      const listed = await s.rpc('tools/list');
      expect(listed.result.tools.map((t: Json) => t.name)).toEqual([
        'list_hermits', 'get_status', 'get_health', 'get_brief', 'get_version', 'wake',
      ]);
    } finally {
      await s.close();
    }
  });

  test('an older supported protocolVersion is echoed back unchanged', async () => {
    const s = McpSession.start();
    try {
      const init = await handshake(s, '2025-06-18');
      expect(init.result.protocolVersion).toBe('2025-06-18');
      const listed = await s.rpc('tools/list');
      expect(listed.result.tools).toHaveLength(6);
    } finally {
      await s.close();
    }
  });

  // 2025-06-18/2025-11-25 lifecycle: an unsupported version is answered with a
  // successful result naming a version the server does speak, never an error.
  test('unsupported protocolVersion negotiates down to the latest supported', async () => {
    const s = McpSession.start();
    try {
      const reply = await s.rpc('initialize', { protocolVersion: '1900-01-01', capabilities: {}, clientInfo: { name: 't', version: '0' } });
      expect(reply.error).toBeUndefined();
      expect(reply.result.protocolVersion).toBe('2025-11-25');
    } finally {
      await s.close();
    }
  });

  test('batch-era and stateless-era protocolVersions both negotiate down', async () => {
    for (const requested of ['2025-03-26', '2024-11-05', '2026-07-28']) {
      const s = McpSession.start();
      try {
        const reply = await s.rpc('initialize', { protocolVersion: requested, capabilities: {}, clientInfo: { name: 't', version: '0' } });
        expect(reply.result.protocolVersion).toBe('2025-11-25');
      } finally {
        await s.close();
      }
    }
  });

  test('malformed line → parse error with id null, process stays up', async () => {
    const s = McpSession.start();
    try {
      s.writeRaw('not-json');
      const err = await s.waitForErrorIdNull();
      expect(err.error.code).toBe(-32700);
      expect(err.id).toBeNull();
      const init = await handshake(s);
      expect(init.result.protocolVersion).toBe('2025-11-25');
    } finally {
      await s.close();
    }
  });

  test('unknown method → -32601, process stays up', async () => {
    const s = McpSession.start();
    try {
      await handshake(s);
      const reply = await s.rpc('no/such/method');
      expect(reply.error.code).toBe(-32601);
      const pong = await s.rpc('ping');
      expect(pong.result).toEqual({});
    } finally {
      await s.close();
    }
  });

  test('tools/call before initialize → protocol error', async () => {
    const s = McpSession.start();
    try {
      const reply = await callTool(s, 'list_hermits');
      expect(reply.error.code).toBe(-32600);
      const init = await handshake(s);
      expect(init.result.protocolVersion).toBe('2025-11-25');
    } finally {
      await s.close();
    }
  });

  test('stdin EOF shuts down cleanly', async () => {
    const s = McpSession.start();
    await handshake(s);
    const code = await s.close();
    expect(code).toBe(0);
  });
});

describe('list_hermits + get_status', () => {
  test('seeded fixture root: name, runtime_mode, pause, status fields, structuredContent mirror', async () => {
    const wd = setupWorkdir();
    tmpdirs.push(wd.dir);
    writeConfig(wd.dir, { agent_name: 'FixtureBot' });
    writeJson(hermit(wd.dir, 'state', 'runtime.json'), {
      runtime_mode: 'tmux',
      shutdown_completed_at: null,
    });
    const status = {
      updated: '2026-09-01T12:00:00.000Z',
      session_id: 'S-007',
      status: 'in_progress',
      task: 'ship the surface',
      tasks_completed: 3,
      cost_usd: 1.25,
      tokens: 4000,
      operator_turns: 2,
      blockers: null,
    };
    writeAged(hermit(wd.dir, 'sessions', '.status.json'), 15, JSON.stringify(status));
    writeAged(hermit(wd.dir, 'state', '.heartbeat'), 15, '');

    const s = McpSession.start(['--roots', wd.dir]);
    try {
      await handshake(s);
      const listed = toolBody(await callTool(s, 'list_hermits'));
      expect(listed.hermits).toHaveLength(1);
      expect(listed.hermits[0].root).toBe(wd.dir);
      expect(listed.hermits[0].name).toBe('FixtureBot');
      expect(listed.hermits[0].runtime_mode).toBe('tmux');
      expect(listed.hermits[0].paused).toBe(false);
      expect(listed.hermits[0].liveness_age_secs).toBeGreaterThanOrEqual(0);
      expect(listed.hermits[0].liveness_age_secs).toBeLessThan(120);

      const st = toolBody(await callTool(s, 'get_status', { root: wd.dir }));
      expect(st.root).toBe(wd.dir);
      expect(st.runtime).toEqual({
        kind: 'ok',
        runtime_mode: 'tmux',
        shutdown_completed_at: null,
      });
      expect(st.status.tasks).toEqual([]);
      expect(st.status.execution.state).toBe('unknown');
      expect(st.paused).toBe(false);
      expect(st.resident).toBeNull();
    } finally {
      await s.close();
    }
  });

  test('empty root degrades to unknown, not dead', async () => {
    const wd = setupWorkdir();
    tmpdirs.push(wd.dir);
    const s = McpSession.start(['--roots', wd.dir]);
    try {
      await handshake(s);
      const listed = toolBody(await callTool(s, 'list_hermits'));
      expect(listed.hermits[0].name).toBeNull();
      expect(listed.hermits[0].runtime_mode).toBe('unknown');
      expect(listed.hermits[0].liveness_age_secs).toBeNull();
      expect(listed.hermits[0].paused).toBe(false);

      const st = toolBody(await callTool(s, 'get_status', { root: wd.dir }));
      expect(st.runtime).toEqual({ kind: 'missing' });
      expect(st.status.tasks).toEqual([]);
      expect(st.resident).toBeNull();
      expect(st.liveness_age_secs).toBeNull();
    } finally {
      await s.close();
    }
  });

  test('invalid runtime is distinct from missing', async () => {
    const wd = setupWorkdir();
    tmpdirs.push(wd.dir);
    fs.writeFileSync(hermit(wd.dir, 'state', 'runtime.json'), '{not json');
    const s = McpSession.start(['--roots', wd.dir]);
    try {
      await handshake(s);
      const st = toolBody(await callTool(s, 'get_status', { root: wd.dir }));
      expect(st.runtime.kind).toBe('invalid');
      expect(typeof st.runtime.reason).toBe('string');
    } finally {
      await s.close();
    }
  });

  test('root outside inventory is a tool error, not a protocol error', async () => {
    const wd = setupWorkdir();
    tmpdirs.push(wd.dir);
    const outsider = setupWorkdir();
    tmpdirs.push(outsider.dir);
    const s = McpSession.start(['--roots', wd.dir]);
    try {
      await handshake(s);
      const reply = await callTool(s, 'get_status', { root: outsider.dir });
      expect(reply.error).toBeUndefined();
      expect(reply.result.isError).toBe(true);
      const body = JSON.parse(reply.result.content[0].text);
      expect(body.error).toContain('not in the configured inventory');
      expect(reply.result.structuredContent).toEqual(body);
    } finally {
      await s.close();
    }
  });

  test('resident enrichment uses the stamped config_dir, not the server default', async () => {
    const wd = setupWorkdir();
    tmpdirs.push(wd.dir);
    const { ident } = writeResident(wd.dir, {
      status: 'idle',
      statusUpdatedAt: 1_700_000_000_000,
    }, {});
    const s = McpSession.start(['--roots', wd.dir]);
    try {
      await handshake(s);
      const st = toolBody(await callTool(s, 'get_status', { root: wd.dir }));
      expect(st.resident).toEqual({
        status: 'idle',
        statusUpdatedAt: 1_700_000_000_000,
        pid: ident.pid,
      });
    } finally {
      await s.close();
    }
  });

  // A resident started without CLAUDE_CONFIG_DIR has no stamp; its registry lives
  // in the default config dir the server resolves for itself.
  test('resident enrichment without a stamped config_dir uses the default config dir', async () => {
    const wd = setupWorkdir();
    tmpdirs.push(wd.dir);
    const { ident, configDir } = writeResident(wd.dir, { status: 'busy', statusUpdatedAt: 1_700_000_000_000 }, { config_dir: undefined });
    const s = McpSession.start(['--roots', wd.dir], { CLAUDE_CONFIG_DIR: configDir });
    try {
      await handshake(s);
      const st = toolBody(await callTool(s, 'get_status', { root: wd.dir }));
      expect(st.resident).toEqual({ status: 'busy', statusUpdatedAt: 1_700_000_000_000, pid: ident.pid });
    } finally {
      await s.close();
    }
  });

  test('--roots wins over HERMIT_MCP_ROOTS; duplicates and non-hermit roots fail at startup', async () => {
    const a = setupWorkdir();
    const b = setupWorkdir();
    tmpdirs.push(a.dir, b.dir);
    const viaArg = await runScript('mcp-server.ts', {
      args: ['--roots', a.dir],
      env: { HERMIT_MCP_ROOTS: b.dir },
      stdin: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }) + '\n',
    });
    expect(viaArg.exitCode).toBe(0);
    const init = JSON.parse(viaArg.stdout.trim().split('\n')[0]);
    expect(init.result.protocolVersion).toBe('2025-11-25');

    const dup = await runScript('mcp-server.ts', { args: ['--roots', `${a.dir},${a.dir}`] });
    expect(dup.exitCode).toBe(1);
    expect(dup.stderr).toContain('duplicate root');

    const missing = await runScript('mcp-server.ts', {
      args: ['--roots', path.join(os.tmpdir(), 'no-such-hermit-root-' + Date.now())],
    });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('root not found');

    const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-empty-')));
    tmpdirs.push(empty);
    const notHermit = await runScript('mcp-server.ts', { args: ['--roots', empty] });
    expect(notHermit.exitCode).toBe(1);
    expect(notHermit.stderr).toContain('not a hermit root');
  });
});

describe('get_health, get_brief, get_version', () => {
  test('fresh liveness → alive; doctor report present with failing ids', async () => {
    const wd = setupWorkdir();
    tmpdirs.push(wd.dir);
    writeJson(hermit(wd.dir, 'state', 'runtime.json'), { runtime_mode: 'tmux', shutdown_completed_at: null });
    writeAged(hermit(wd.dir, 'state', 'routine-monitor-liveness.json'), 20);
    const ts = new Date(Date.now() - 30_000).toISOString();
    writeJson(hermit(wd.dir, 'state', 'doctor-report.json'), {
      ts,
      checks: [
        { id: 'runtime', status: 'ok' },
        { id: 'config', status: 'warn' },
        { id: 'hooks', status: 'fail' },
        { id: 'state', status: 'fail' },
      ],
    });
    const s = McpSession.start(['--roots', wd.dir]);
    try {
      await handshake(s);
      const h = toolBody(await callTool(s, 'get_health', { root: wd.dir }));
      expect(h.availability.state).toBe('alive');
      expect(h.availability.liveness_age_secs).toBeLessThan(LIVENESS_FRESH_SECS);
      expect(h.availability.liveness_fresh_secs).toBe(LIVENESS_FRESH_SECS);
      expect(h.diagnostics.ts).toBe(ts);
      expect(h.diagnostics.counts).toEqual({ ok: 1, warn: 1, fail: 2 });
      expect(h.diagnostics.failing).toEqual(['hooks', 'state']);
      expect(h.diagnostics.age_secs).toBeGreaterThanOrEqual(20);
    } finally {
      await s.close();
    }
  });

  test('stale liveness + shutdown stamp → reported_down', async () => {
    const wd = setupWorkdir();
    tmpdirs.push(wd.dir);
    writeJson(hermit(wd.dir, 'state', 'runtime.json'), {
      runtime_mode: 'tmux',
      shutdown_completed_at: '2026-08-01T00:00:00.000Z',
    });
    writeAged(hermit(wd.dir, 'sessions', '.status.json'), LIVENESS_FRESH_SECS + 120);
    const s = McpSession.start(['--roots', wd.dir]);
    try {
      await handshake(s);
      const h = toolBody(await callTool(s, 'get_health', { root: wd.dir }));
      expect(h.availability.state).toBe('reported_down');
      expect(h.availability.shutdown_completed_at).toBe('2026-08-01T00:00:00.000Z');
      expect(h.diagnostics).toBeNull();
    } finally {
      await s.close();
    }
  });

  test('bare stale liveness → unknown, never down; doctor absent → null diagnostics', async () => {
    const wd = setupWorkdir();
    tmpdirs.push(wd.dir);
    writeJson(hermit(wd.dir, 'state', 'runtime.json'), { runtime_mode: 'tmux', shutdown_completed_at: null });
    writeAged(hermit(wd.dir, 'sessions', '.status.json'), LIVENESS_FRESH_SECS + 120);
    const s = McpSession.start(['--roots', wd.dir]);
    try {
      await handshake(s);
      const h = toolBody(await callTool(s, 'get_health', { root: wd.dir }));
      expect(h.availability.state).toBe('unknown');
      expect(h.availability.shutdown_completed_at).toBeNull();
      expect(h.diagnostics).toBeNull();
    } finally {
      await s.close();
    }
  });

  test('validated resident keeps availability alive even when liveness is stale', async () => {
    const wd = setupWorkdir();
    tmpdirs.push(wd.dir);
    const { ident } = writeResident(wd.dir, {
      status: 'busy',
      statusUpdatedAt: Date.now(),
    }, { shutdown_completed_at: '2026-08-01T00:00:00.000Z' });
    writeAged(hermit(wd.dir, 'sessions', '.status.json'), LIVENESS_FRESH_SECS + 120);
    const s = McpSession.start(['--roots', wd.dir]);
    try {
      await handshake(s);
      const h = toolBody(await callTool(s, 'get_health', { root: wd.dir }));
      expect(h.availability.state).toBe('alive');
      expect(h.availability.resident.pid).toBe(ident.pid);
    } finally {
      await s.close();
    }
  });

  test('brief prefers last-brief.json over reports', async () => {
    const wd = setupWorkdir();
    tmpdirs.push(wd.dir);
    writeJson(hermit(wd.dir, 'sessions', '.status.json'), {
      updated: '2026-09-01T12:00:00.000Z',
      session_id: 'S-004',
      status: 'idle',
      task: 'idle',
      tasks_completed: 1,
      cost_usd: 0.1,
      tokens: 10,
      operator_turns: 1,
      blockers: null,
    });
    writeJson(hermit(wd.dir, 'state', 'last-brief.json'), {
      kind: 'morning',
      text: 'Overnight: shipped the hatch.',
      generated_at: '2026-09-01T07:00:00.000Z',
    });
    fs.writeFileSync(hermit(wd.dir, 'sessions', 'S-003-REPORT.md'), '---\nid: S-003\n---\nShould not be used.\n');
    const s = McpSession.start(['--roots', wd.dir]);
    try {
      await handshake(s);
      const b = toolBody(await callTool(s, 'get_brief', { root: wd.dir }));
      expect(b.status.tasks).toEqual([]);
      expect(b.last_brief.text).toBe('Overnight: shipped the hatch.');
      expect(b.last_brief.generated_at).toBe('2026-09-01T07:00:00.000Z');
      expect(b.last_brief.truncated).toBe(false);
      expect(b.report).toBeNull();
    } finally {
      await s.close();
    }
  });

  test('brief uses task records, ignores frozen reports and caps UTF-8 text', async () => {
    const wd = setupWorkdir();
    tmpdirs.push(wd.dir);
    fs.writeFileSync(hermit(wd.dir, 'sessions', 'S-9-REPORT.md'), '---\nid: S-9\nstatus: completed\n---\nNine.\n');
    const body = '🎯' + 'x'.repeat(20_000);
    fs.writeFileSync(
      hermit(wd.dir, 'sessions', 'S-10-REPORT.md'),
      `---\nid: S-10\nstatus: completed\ntask: later\n---\n${body}\n`,
    );
    mutateTask(hermit(wd.dir), 'open', undefined, { title: body, requester: 'operator', done: 'Verified' }, '');
    const s = McpSession.start(['--roots', wd.dir]);
    try {
      await handshake(s);
      const b = toolBody(await callTool(s, 'get_brief', { root: wd.dir }));
      expect(b.last_brief).toBeNull();
      expect(b.report.source_path).toContain('/tasks/T-');
      expect(b.report.outcome).toBe('open');
      expect(b.report.truncated).toBe(true);
      expect(Buffer.byteLength(b.report.summary, 'utf8')).toBeLessThanOrEqual(16 * 1024);
      expect(b.report.summary.includes('\uFFFD')).toBe(false);
    } finally {
      await s.close();
    }
  });

  test('get_version reports loaded vs applied mismatch and floors', async () => {
    const wd = setupWorkdir();
    tmpdirs.push(wd.dir);
    writeConfig(wd.dir, { _hermit_versions: { 'hermitd': '0.0.1' } });
    const s = McpSession.start(['--roots', wd.dir]);
    try {
      await handshake(s);
      const v = toolBody(await callTool(s, 'get_version', { root: wd.dir }));
      expect(v.loaded).toBe(PLUGIN_VERSION);
      expect(v.applied).toBe('0.0.1');
      expect(v.loaded).not.toBe(v.applied);
      expect(v.required_bun_version).toBe(HERMIT_META.required_bun_version);
      expect(v.min_claude_code_version).toBe(HERMIT_META.min_claude_code_version);
      expect(v.contract_version).toBe(1);
    } finally {
      await s.close();
    }
  });
});

describe('wake', () => {
  test('posts exact HEARTBEAT_EVALUATE payload and returns flushed', async () => {
    const wd = setupWorkdir();
    tmpdirs.push(wd.dir);
    const inbox = await inboxServer();
    writeJson(hermit(wd.dir, 'state', 'runtime.json'), {
      runtime_mode: 'tmux',
      inbox_socket: inbox.socketPath,
    });
    const s = McpSession.start(['--roots', wd.dir]);
    try {
      await handshake(s);
      const w = toolBody(await callTool(s, 'wake', { root: wd.dir }));
      expect(w).toEqual({ write_status: 'flushed', delivery: 'unconfirmed' });
      await waitForLines(inbox.lines, 1);
      expect(inbox.lines).toHaveLength(1);
      expect(inbox.lines[0]).toBe(userMessageLine('HEARTBEAT_EVALUATE').trimEnd());
    } finally {
      await s.close();
      inbox.close();
    }
  });

  test('closed socket → unreachable', async () => {
    const wd = setupWorkdir();
    tmpdirs.push(wd.dir);
    const deadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-dead-sock-'));
    tmpdirs.push(deadDir);
    writeJson(hermit(wd.dir, 'state', 'runtime.json'), {
      runtime_mode: 'tmux',
      inbox_socket: path.join(deadDir, 'absent.sock'),
    });
    const s = McpSession.start(['--roots', wd.dir]);
    try {
      await handshake(s);
      const w = toolBody(await callTool(s, 'wake', { root: wd.dir }));
      expect(w).toEqual({ write_status: 'unreachable', delivery: 'unconfirmed' });
    } finally {
      await s.close();
    }
  });

  test('paused fixture suppresses with no socket frame', async () => {
    const wd = setupWorkdir();
    tmpdirs.push(wd.dir);
    const inbox = await inboxServer();
    writeJson(hermit(wd.dir, 'state', 'runtime.json'), {
      runtime_mode: 'tmux',
      inbox_socket: inbox.socketPath,
    });
    setPause(hermit(wd.dir), { reason: 'operator', by: 'test' });
    const s = McpSession.start(['--roots', wd.dir]);
    try {
      await handshake(s);
      const w = toolBody(await callTool(s, 'wake', { root: wd.dir }));
      expect(w).toEqual({ delivery: 'suppressed', reason: 'paused' });
      await Bun.sleep(80);
      expect(inbox.lines).toEqual([]);
    } finally {
      await s.close();
      inbox.close();
    }
  });

  test('docker runtime on the host relays via compose exec; argv recorded by a PATH stub', async () => {
    const wd = setupWorkdir();
    tmpdirs.push(wd.dir);
    writeJson(hermit(wd.dir, 'state', 'runtime.json'), {
      runtime_mode: 'docker',
      inbox_socket: '/container/internal.sock',
    });
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-docker-bin-'));
    tmpdirs.push(bin);
    const rec = path.join(bin, 'argv.txt');
    fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash
printf '%s\\n' "$@" > "${rec}"
exit 0
`);
    fs.chmodSync(path.join(bin, 'docker'), 0o755);
    const s = McpSession.start(['--roots', wd.dir], { PATH: `${bin}:${process.env.PATH}` });
    try {
      await handshake(s);
      const w = toolBody(await callTool(s, 'wake', { root: wd.dir }));
      expect(w.write_status).toBe('flushed');
      expect(w.delivery).toBe('unconfirmed');
      const argv = fs.readFileSync(rec, 'utf-8').trim().split('\n');
      expect(argv).toEqual([
        'compose', '-f', 'docker-compose.hermit.yml', 'exec', '-T', 'hermit',
        '.hermit/bin/hermitd-run', 'mcp-server', '--wake-local',
      ]);
    } finally {
      await s.close();
    }
  });

  test('docker stub nonzero → unreachable', async () => {
    const wd = setupWorkdir();
    tmpdirs.push(wd.dir);
    writeJson(hermit(wd.dir, 'state', 'runtime.json'), { runtime_mode: 'docker', inbox_socket: '/x.sock' });
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-docker-bin-'));
    tmpdirs.push(bin);
    fs.writeFileSync(path.join(bin, 'docker'), '#!/usr/bin/env bash\nexit 1\n');
    fs.chmodSync(path.join(bin, 'docker'), 0o755);
    const s = McpSession.start(['--roots', wd.dir], { PATH: `${bin}:${process.env.PATH}` });
    try {
      await handshake(s);
      const w = toolBody(await callTool(s, 'wake', { root: wd.dir }));
      expect(w.write_status).toBe('unreachable');
    } finally {
      await s.close();
    }
  });
});
