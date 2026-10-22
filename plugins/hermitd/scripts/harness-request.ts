#!/usr/bin/env bun
// Usage: hermitd-run harness-request <command> [arg] [--then <command> [arg]]
//          [--source update] [--expect-version <v>] [--wait <seconds>]
// Queues a harness command for the core mod; with --wait, prints its outcome.
import { hermitDir } from './lib/cc-compat';
import { exitError, failJson, printJson } from './lib/cli';
import { enqueue, failedLeg, legReason, readOutcome, type QueueSource } from './lib/harness-mod';

const SOURCES: QueueSource[] = ['terminal', 'update'];
const commands: { command: string; arg: string | null }[] = [];
let source: QueueSource = 'terminal';
let expectVersion: string | undefined;
let wait: number | undefined;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const token = args[i];
  if (token === '--then') continue;
  if (token === '--source' || token === '--expect-version' || token === '--wait') {
    const value = args[++i];
    if (!value) exitError('invalid_flag');
    if (token === '--source') {
      if (!SOURCES.includes(value as QueueSource)) exitError('invalid_source');
      source = value as QueueSource;
    } else if (token === '--expect-version') expectVersion = value;
    else {
      if (!/^\d+$/.test(value)) exitError('invalid_wait');
      wait = Number(value);
    }
    continue;
  }
  if (token.startsWith('--')) exitError('invalid_flag');
  // A command opens a leg; the next bare token, if any, is its argument.
  if (commands.length === 0 || args[i - 1] === '--then') commands.push({ command: token, arg: null });
  else if (commands.at(-1)!.arg === null) commands.at(-1)!.arg = token;
  else exitError('invalid_argument');
}
if (commands.length === 0) exitError('missing_command');

const dir = hermitDir();
let id = '';
try {
  const queued = enqueue(dir, { source, commands, ...(expectVersion ? { expect_version: expectVersion } : {}) });
  if (queued.status !== 'queued' || wait === undefined) {
    printJson(queued);
    process.exit(0);
  }
  id = queued.id;
} catch (error) {
  failJson(error);
  process.exit();
}

const deadline = Date.now() + wait * 1000;
for (;;) {
  const outcome = readOutcome(dir, id);
  if (outcome) {
    const failed = failedLeg(outcome);
    printJson(!failed ? { status: 'ok' } : { status: failed.status, reason: legReason(failed), ...(failed.text ? { text: failed.text } : {}) });
    break;
  }
  if (Date.now() >= deadline) {
    printJson({ status: 'unknown', reason: 'wait_timeout' });
    break;
  }
  await Bun.sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
}
