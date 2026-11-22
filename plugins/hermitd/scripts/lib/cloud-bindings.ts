// Cloud helper bindings and report parsing, shared by `cloud-session` and the
// UserPromptSubmit stage that intercepts cloud helper reports.
import fs from 'node:fs';
import path from 'node:path';
import { TASK_ID } from './tasks';

export const ENV_ID = /^env_[A-Za-z0-9]+$/;
export const ENV_NAME = /^[A-Za-z0-9._-]{1,64}$/;
const SESSION_ID = /^session_[A-Za-z0-9]+$/;

export type Binding = {
  session_id: string;
  task: string;
  helper: string;
  environment: string;
  started_at: string;
  ingested: string[];
};

export function bindingFile(dir: string): string {
  return path.join(dir, 'state', 'cloud-sessions.json');
}

export function readCloudBindings(dir: string): Binding[] {
  try {
    return JSON.parse(fs.readFileSync(bindingFile(dir), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function bridgeSessionId(from: string): string | undefined {
  const id = from.slice('bridge:'.length);
  return from.startsWith('bridge:') && SESSION_ID.test(id) ? id : undefined;
}

export function parseReport(text: string) {
  const newline = text.indexOf('\n');
  const header = newline === -1 ? text : text.slice(0, newline);
  const match = /^TASK_REPORT (\S+) (\S+)\r?$/.exec(header);
  if (!match || !TASK_ID.test(match[1])) return null;
  return { task: match[1], kind: match[2], body: newline === -1 ? '' : text.slice(newline + 1) };
}
