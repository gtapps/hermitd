#!/usr/bin/env bun
// Usage: bun approval-notice.ts <hermit-dir>
// Tells the operator's maintainer chat that a Docker change waits for a terminal approval.
// The host runs it inside the agent's container when a lifecycle command stopped with no
// terminal to ask. Fixed catalog text, no model turn. Prints the sender's verdict: `OK`
// when delivered, else {"error":"<token>"} at exit 1.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { exitError } from './lib/cli';
import { readSettledConfig } from './lib/config-read';
import { LOCKED, loadMessages } from './lib/messages';

if (import.meta.main) {
  const hermitDir = process.argv[2];
  if (!hermitDir || process.argv.length > 3) exitError('usage');
  let language: unknown;
  try { language = readSettledConfig(hermitDir).language; } catch {}
  const text = loadMessages(hermitDir, language).t('docker_approval_pending', { approve: LOCKED.host_approve });
  const sent = spawnSync(process.execPath, [path.join(import.meta.dir, 'channel-send.ts'), hermitDir, '--tier', 'maintainer', '-'], {
    input: text, encoding: 'utf8', timeout: 15000,
  });
  const verdict = (sent.stdout ?? '').trim().split('\n').pop() || JSON.stringify({ error: sent.error ? 'send_failed' : 'no_output' });
  console.log(verdict);
  process.exit(verdict === 'OK' ? 0 : 1);
}
