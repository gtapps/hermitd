import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pinStateDirOrExit } from './lib/cc-compat';
import { isDict } from './lib/channel-config';
import { emitJson, exitError, failJson } from './lib/cli';
import { ClaudeStateError, markWorkspaceTrusted, updateClaudeState, writeJsonKeepingMode } from './lib/claude-state';

type CheckResult =
  | { status: 'refused'; reason: 'outside_launch_root' | 'not_a_repository' | 'local_settings_tracked' }
  | { status: 'eligible'; key: string; repo_config: string[]; mcp_servers: string[] };

function git(cwd: string, ...args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 });
}

function mcpServers(key: string): string[] {
  const file = path.join(key, '.mcp.json');
  if (!fs.existsSync(file)) return [];
  let config: unknown;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('invalid_mcp_config');
  }
  if (!isDict(config) || !isDict((config as { mcpServers?: unknown }).mcpServers)) {
    throw new Error('invalid_mcp_config');
  }
  return Object.keys((config as { mcpServers: object }).mcpServers);
}

function checkWorkspace(stateDir: string, dir: string): CheckResult {
  const refused = (reason: Extract<CheckResult, { status: 'refused' }>['reason']): CheckResult => ({ status: 'refused', reason });
  if (!path.isAbsolute(dir)) return refused('not_a_repository');
  let target: string;
  try {
    target = fs.realpathSync(dir);
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return refused('not_a_repository');
    throw error;
  }
  const launchRoot = fs.realpathSync(path.dirname(stateDir));
  const underRoot = (p: string) => {
    const relative = path.relative(launchRoot, p);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  if (!underRoot(target)) return refused('outside_launch_root');
  const top = git(target, 'rev-parse', '--show-toplevel');
  if (top.status !== 0) return refused('not_a_repository');
  const toplevel = fs.realpathSync(top.stdout.trim());
  const gitAbs = (flag: string) => {
    const result = git(target, 'rev-parse', flag);
    if (result.status !== 0) throw new Error('git_failed');
    return fs.realpathSync(path.resolve(target, result.stdout.trim()));
  };
  const [gitDir, common] = ['--git-dir', '--git-common-dir'].map(gitAbs);
  const linked = gitDir !== common && path.basename(common) === '.git';
  const key = linked ? path.dirname(common) : toplevel;
  if (!underRoot(key)) return refused('outside_launch_root');
  const mcp_servers = mcpServers(key);
  if (mcp_servers.length) {
    const tracked = git(key, 'ls-files', '--error-unmatch', '--', '.claude/settings.local.json');
    if (tracked.status === 0) return refused('local_settings_tracked');
    if (tracked.status !== 1) throw new Error('git_failed');
  }
  const repo_config = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json']
    .filter((name) => fs.existsSync(path.join(key, name)));
  return { status: 'eligible', key, repo_config, mcp_servers };
}

function updateState(apply: (state: unknown) => boolean): boolean {
  try {
    return updateClaudeState(apply);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ClaudeStateError) throw new Error('invalid_state');
    throw error;
  }
}

function isTrusted(key: string): boolean {
  let trusted = false;
  updateState((state) => {
    trusted = !markWorkspaceTrusted(state, key);
    return false;
  });
  return trusted;
}

export async function trustWorkspace(key: string, { settleMs = 3000 } = {}): Promise<number> {
  let writes = 0;
  for (let round = 0; round < 2; round++) {
    if (updateState((state) => markWorkspaceTrusted(state, key))) writes++;
    // Claude Code exposes no signal that a pre-warmed worker has refreshed.
    await Bun.sleep(settleMs);
    if (isTrusted(key)) return writes;
  }
  throw new Error('seed_lost');
}

function localSettings(key: string): Record<string, unknown> {
  const file = path.join(key, '.claude/settings.local.json');
  let settings: unknown = {};
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      if (error instanceof SyntaxError) throw new Error('invalid_local_settings');
      throw error;
    }
  }
  if (!isDict(settings)) throw new Error('invalid_local_settings');
  const record = settings as Record<string, unknown>;
  if (record.enabledMcpjsonServers !== undefined &&
      (!Array.isArray(record.enabledMcpjsonServers) || !record.enabledMcpjsonServers.every((name: unknown) => typeof name === 'string'))) {
    throw new Error('invalid_local_settings');
  }
  return record;
}

function approveMcp(key: string, names: string[], settings: Record<string, unknown>): void {
  const result = git(key, 'rev-parse', '--git-path', 'info/exclude');
  if (result.status !== 0) throw new Error('git_failed');
  const exclude = path.resolve(key, result.stdout.trim());
  let content = '';
  try {
    content = fs.readFileSync(exclude, 'utf8');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const line = '/.claude/settings.local.json';
  if (!content.split(/\r?\n/).includes(line)) {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `${content && !content.endsWith('\n') ? '\n' : ''}${line}\n`);
  }
  const file = path.join(key, '.claude/settings.local.json');
  const prior = (settings.enabledMcpjsonServers ?? []) as string[];
  settings.enabledMcpjsonServers = [...new Set([...prior, ...names])];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonKeepingMode(file, settings);
}

if (import.meta.main) {
  const [verb, state, dir, ...extra] = process.argv.slice(2);
  if ((verb !== 'check' && verb !== 'apply') || !state || !dir || extra.length) exitError('usage');
  const stateDir = pinStateDirOrExit(state);
  try {
    const result = checkWorkspace(stateDir, dir);
    if (result.status === 'refused' || verb === 'check') emitJson(result);
    const settings = result.mcp_servers.length ? localSettings(result.key) : null;
    isTrusted(result.key); // a malformed state file fails here, before the clone changes
    if (settings) approveMcp(result.key, result.mcp_servers, settings);
    const writes = await trustWorkspace(result.key);
    emitJson({ status: 'recorded', key: result.key, writes, mcp_approved: result.mcp_servers });
  } catch (error) {
    failJson(error);
  }
}
