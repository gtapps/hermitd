#!/usr/bin/env bun
/**
 * The connector's in-agent channel: a stdio MCP server that turns each message from
 * the trusted server into one channel event, and gives the agent a `reply` tool.
 *
 * It dials the Unix socket named by HERMIT_CONNECTOR_SOCKET (set by core's launcher):
 * `GET /events?after=<id>&instance=<id>` (long poll) and `POST /replies`. Sign-in,
 * pairing and the message record live in the trusted server, outside the agent's
 * reach; this side holds no state. Bun built-ins only.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const SOCKET = process.env.HERMIT_CONNECTOR_SOCKET || '';

/**
 * Claude Code starts this server in every session that enables the plugin, but only a session
 * launched with it in a channel flag delivers its events. The parent `claude` command line is the
 * one place that differs, so any other session stays idle and never takes a message.
 */
function launchedAsChannel(): boolean {
  let args: string;
  try { args = readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8').replace(/\0/g, ' '); }
  catch { args = spawnSync('ps', ['-o', 'args=', '-p', String(process.ppid)], { encoding: 'utf8' }).stdout ?? ''; }
  return args.includes('plugin:hermitd-connector@');
}
const INSTANCE = randomBytes(8).toString('hex');
const RETRY_MS = 2000;

const INSTRUCTIONS = [
  'Messages from the connector arrive as <channel source="connector" chat_id="..." message_id="..." user="..."> tags.',
  'They come from people talking to you from their own AI app, often by voice; the assistant in that app relays your words to them.',
  'Your text in this session never reaches them; only the reply tool does. Answer every message with it, passing the chat_id from the tag and, when it helps, reply_to with its message_id.',
  'Keep answers short and easy to say aloud. Each chat is one person; never mention another chat in it.',
].join(' ');

const REPLY_TOOL = {
  name: 'reply',
  description: 'Send a message to a person in their connector chat. Pass chat_id from the channel tag; reply_to is the message_id you are answering.',
  inputSchema: {
    type: 'object',
    properties: {
      chat_id: { type: 'string' },
      text: { type: 'string' },
      reply_to: { type: 'string' },
    },
    required: ['chat_id', 'text'],
  },
};

const send = (message: unknown): void => { process.stdout.write(JSON.stringify(message) + '\n'); };
const result = (id: unknown, value: object) => send({ jsonrpc: '2.0', id, result: value });
const toolText = (text: string, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

async function reply(args: any): Promise<object> {
  if (!SOCKET) return toolText('The connector is not set up for this agent.', true);
  if (typeof args?.chat_id !== 'string' || typeof args?.text !== 'string' || !args.text) return toolText('chat_id and text are required.', true);
  try {
    const res = await fetch('http://connector/replies', {
      unix: SOCKET, method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: args.chat_id, text: args.text, ...(typeof args.reply_to === 'string' ? { reply_to: args.reply_to } : {}) }),
    });
    const body = await res.json() as { status?: string; error?: string };
    return res.ok ? toolText(body.status ?? 'queued') : toolText(`Not sent: ${body.error ?? res.status}`, true);
  } catch {
    return toolText('Not sent: the connector server is not running.', true);
  }
}

let polling = false;
async function poll(): Promise<void> {
  if (polling || !SOCKET || !launchedAsChannel()) return;
  polling = true;
  let after = 0;
  for (;;) {
    try {
      const res = await fetch(`http://connector/events?after=${after}&instance=${INSTANCE}`, { unix: SOCKET });
      if (!res.ok) throw new Error(String(res.status));
      const { events } = await res.json() as { events: any[] };
      for (const event of events) {
        after = Math.max(after, event.id);
        send({
          jsonrpc: '2.0', method: 'notifications/claude/channel',
          params: {
            content: event.text,
            meta: { chat_id: event.chat_id, message_id: event.message_id, user_id: event.user_id, user: event.user, ts: event.ts, via: event.via },
          },
        });
      }
    } catch {
      await Bun.sleep(RETRY_MS);
    }
  }
}

async function handle(message: any): Promise<void> {
  const { id, method, params } = message;
  if (method === 'notifications/initialized') { void poll(); return; }
  if (id === undefined || id === null) return;
  if (method === 'initialize') {
    return result(id, {
      protocolVersion: params?.protocolVersion ?? '2025-06-18',
      capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
      serverInfo: { name: 'connector', version: '0.0.1' },
      instructions: INSTRUCTIONS,
    });
  }
  if (method === 'ping') return result(id, {});
  if (method === 'tools/list') return result(id, { tools: [REPLY_TOOL] });
  if (method === 'tools/call') {
    if (params?.name !== 'reply') return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Unknown tool' } });
    return result(id, await reply(params.arguments));
  }
  // Claude Code also sends requests this server does not implement, such as server/discover.
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let message: unknown;
    try { message = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    void handle(message);
  }
});
process.stdin.on('end', () => process.exit(0));
