import fs from 'node:fs';
import path from 'node:path';
import { isDict } from './channel-config';
import { writeFileAtomic } from './md-write';
import { claudeStateFile } from './setup-token';

type Json = any;

export class ClaudeStateError extends Error {}

export function writeJsonKeepingMode(file: string, value: Json): void {
  let mode: number | undefined;
  try {
    mode = fs.statSync(file).mode & 0o7777;
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n', mode);
  if (mode !== undefined) fs.chmodSync(file, mode);
}

export function withClaudeStateLock<T>(file: string, action: () => T): T {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = Date.now() + 2000;
  let acquired = false;
  while (true) {
    try {
      fs.mkdirSync(lock);
      acquired = true;
      break;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      Bun.sleepSync(Math.min(50, remaining));
    }
  }
  try {
    return action();
  } finally {
    if (acquired) fs.rmdirSync(lock);
  }
}

export function readClaudeState(file = claudeStateFile()): Json {
  let state: Json = {};
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!isDict(state)) throw new ClaudeStateError('invalid Claude Code state');
  return state;
}

export function updateClaudeState(apply: (state: Json) => boolean, file = claudeStateFile()): boolean {
  return withClaudeStateLock(file, () => {
    const state = readClaudeState(file);
    if (!apply(state)) return false;
    writeJsonKeepingMode(file, state);
    return true;
  });
}

export function markWorkspaceTrusted(state: Json, project: string): boolean {
  if ('projects' in state && !isDict(state.projects)) throw new ClaudeStateError('invalid Claude Code state');
  const projects = state.projects ?? {};
  if (project in projects && !isDict(projects[project])) throw new ClaudeStateError('invalid project state');
  if (projects[project]?.hasTrustDialogAccepted === true) return false;
  state.projects = { ...projects, [project]: { ...projects[project], hasTrustDialogAccepted: true } };
  return true;
}
