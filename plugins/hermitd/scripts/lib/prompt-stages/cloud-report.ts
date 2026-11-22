import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { bridgeSessionId, parseReport, readCloudBindings } from '../cloud-bindings';
import type { StageContext, StageResult } from './types';

const PREFIX = '<cross-session-message from="bridge:';
const END = '</cross-session-message>';
const INGEST = path.resolve(import.meta.dirname, '../../cloud-session.ts');

function spawnIngest(dir: string, from: string, promptId: string, text: string): void {
  // Give the detached child a regular stdin fd. A pipe write could still be
  // pending when the hook exits, cutting off the last part of a report.
  const spool = path.join(dir, 'state', '.cloud-report-' + randomUUID());
  fs.writeFileSync(spool, text, { mode: 0o600, flag: 'wx' });
  try {
    const fd = fs.openSync(spool, 'r');
    try {
      fs.unlinkSync(spool);
      const child = spawn(process.execPath, [INGEST, 'ingest', dir, '--from', from, '--prompt-id', promptId], {
        cwd: path.dirname(dir), stdio: [fd, 'ignore', 'ignore'], detached: true,
      });
      child.on('error', () => {});
      child.unref();
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    fs.rmSync(spool, { force: true });
  }
}

export function run(ctx: StageContext, dispatch = spawnIngest): StageResult | void {
  if (!ctx.prompt.startsWith(PREFIX) || !ctx.promptId) return;
  const wrapper = /^<cross-session-message from="(bridge:session_[A-Za-z0-9]+)"(?: [^>\r\n]*)?>\r?\n/.exec(ctx.prompt);
  if (!wrapper) return;
  const from = wrapper[1];
  const sessionId = bridgeSessionId(from);
  const wrapped = ctx.prompt.slice(wrapper[0].length);
  const trimmed = wrapped.trimEnd();
  const text = trimmed.endsWith(END) ? trimmed.slice(0, -END.length) : wrapped;
  const report = parseReport(text);
  if (!report || !['result', 'needs-input', 'note'].includes(report.kind)) return;

  let entry;
  try {
    entry = readCloudBindings(ctx.dir).findLast(row => row.session_id === sessionId && row.task === report.task);
  } catch {
    return;
  }
  if (!entry) return;
  try {
    if (!entry.ingested.includes(ctx.promptId)) dispatch(ctx.dir, from, ctx.promptId, text);
  } catch { /* The body stays out of the model after a binding match. */ }
  return { block: 'Cloud helper report intercepted' };
}
