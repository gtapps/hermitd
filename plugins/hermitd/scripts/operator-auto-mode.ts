#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isDict } from './lib/channel-config';
import { readConfigRaw } from './lib/config-read';
import { emitJson, exitError } from './lib/cli';
import { readRuntimeJson } from './lib/runtime';
import { generatedAutoMode, LISTS, mergeOperatorAutoMode } from './lib/settings/operator-auto-mode';

type List = typeof LISTS[number];

function readOperator(): { value?: unknown; error?: string } {
  let raw: string;
  try {
    raw = fs.readFileSync('.hermit/claude-settings.json', 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    return { error: 'settings:unreadable' };
  }
  try {
    const settings = JSON.parse(raw);
    if (!isDict(settings)) return { error: 'settings:not_object' };
    return { value: settings.autoMode };
  } catch {
    return { error: 'settings:malformed_json' };
  }
}

function invalidAutoMode(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isDict(value)) return 'autoMode:not_object';
  const operator = value as Record<string, unknown>;
  for (const list of LISTS) {
    if (!(list in operator)) continue;
    const entries = operator[list];
    if (!Array.isArray(entries) || !entries.every((entry) => typeof entry === 'string')) return `${list}:not_string_array`;
  }
  return null;
}

function check(): never {
  const operator = readOperator();
  const reason = operator.error ?? invalidAutoMode(operator.value);
  if (reason) return emitJson({ status: 'invalid', reason });
  const runtime = readRuntimeJson();
  const config = readConfigRaw('.hermit');
  const applies = runtime?.runtime_mode === 'interactive' || config?.watchdog?.enabled !== true ? 'next_start' : 'quiet_restart';
  return emitJson({ status: 'ok', applies });
}

function critique(list: List, text: string): never {
  const operator = readOperator();
  if (operator.error || invalidAutoMode(operator.value)) return emitJson({ status: 'unchecked', reason: 'cli_error' });
  const merged = mergeOperatorAutoMode(generatedAutoMode(readConfigRaw('.hermit') ?? {}), operator.value);
  const entries = merged.autoMode[list];
  merged.autoMode[list] = [...(Array.isArray(entries) ? entries : []), text];
  const scratch = path.resolve('.hermit/state', `operator-auto-mode-critique-${randomUUID()}.json`);
  let result: object = { status: 'unchecked', reason: 'cli_error' };
  let created = false;
  try {
    fs.mkdirSync(path.dirname(scratch), { recursive: true });
    fs.writeFileSync(scratch, JSON.stringify({ autoMode: merged.autoMode }), { flag: 'wx', mode: 0o600 });
    created = true;
    const override = Number(process.env.HERMIT_AUTO_MODE_CRITIQUE_TIMEOUT_MS);
    const timeout = Number.isFinite(override) && override > 0 ? override : 60_000;
    const child = spawnSync('claude', ['--settings', scratch, 'auto-mode', 'critique', '--model', 'sonnet'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL',
    });
    const code = (child.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ETIMEDOUT') result = { status: 'unchecked', reason: 'timeout' };
    else if (code === 'ENOENT') result = { status: 'unchecked', reason: 'claude_missing' };
    else if (!child.error && child.status === 0) {
      result = { status: 'checked', list, text, critique: child.stdout.trim().slice(0, 4000) };
    }
  } catch {
    result = { status: 'unchecked', reason: 'cli_error' };
  } finally {
    if (created) {
      try { fs.unlinkSync(scratch); } catch { result = { status: 'unchecked', reason: 'cli_error' }; }
    }
  }
  return emitJson(result);
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === 'check') check();
if (args.length === 5 && args[0] === 'critique') {
  const flags = args.slice(1);
  if (new Set([flags[0], flags[2]]).size !== 2 || !flags.includes('--list') || !flags.includes('--text')) exitError('invalid_arguments');
  const list = flags[flags.indexOf('--list') + 1];
  const text = flags[flags.indexOf('--text') + 1];
  if (!LISTS.some((value) => value === list) || !text?.trim()) exitError('invalid_arguments');
  critique(list as List, text);
}
exitError('invalid_arguments');
