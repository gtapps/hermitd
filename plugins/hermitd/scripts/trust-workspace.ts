import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pinStateDirOrExit } from './lib/cc-compat';
import { readFrontmatter } from './lib/frontmatter';
import { isDict } from './lib/channel-config';
import { emitJson, exitError, failJson } from './lib/cli';
import { ClaudeStateError, markWorkspaceTrusted, readClaudeState, updateClaudeState, writeJsonKeepingMode } from './lib/claude-state';

type CheckResult =
  | { status: 'refused'; reason: 'outside_launch_root' | 'not_a_repository' | 'not_repository_root' | 'local_settings_tracked' }
  | { status: 'eligible'; key: string; repo_config: string[]; mcp_servers: string[]; activates: Activates };

// An unreviewed repository's config can name a core.fsmonitor command, which any
// index read would run before the operator has approved anything.
function git(cwd: string, ...args: string[]) {
  return spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8', timeout: 5000 });
}

function mcpServers(root: string): string[] {
  const file = path.join(root, '.mcp.json');
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

interface Activates {
  hooks: string[];
  allow_rules: string[];
  additional_directories: string[];
  env_keys: string[];
  helper_commands: string[];
  mcp_commands: string[];
  agent_hooks: string[];
  unreadable: string[];
  truncated: boolean;
}

/** Disclosure data only: values are never evaluated or executed. */
function activationSummary(root: string): Activates {
  const out: Activates = { hooks: [], allow_rules: [], additional_directories: [], env_keys: [],
    helper_commands: [], mcp_commands: [], agent_hooks: [], unreadable: [], truncated: false };
  const add = (list: string[], value: unknown) => {
    if (value === undefined) return;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (list.length >= 20) { out.truncated = true; return; }
    if (text.length > 500) out.truncated = true;
    list.push(text.slice(0, 500));
  };
  const hooks = (value: unknown, list: string[], file: string) => {
    if (!isDict(value)) return;
    for (const [event, entries] of Object.entries(value as Record<string, any>)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!Array.isArray(entry?.hooks)) continue;
        for (const hook of entry.hooks) add(list, `${file}: ${event} ${JSON.stringify(hook)}`);
      }
    }
  };
  for (const file of ['.claude/settings.json', '.claude/settings.local.json']) {
    if (!fs.existsSync(path.join(root, file))) continue;
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
      if (!isDict(settings)) throw new Error('invalid_settings');
      hooks(settings.hooks, out.hooks, file);
      for (const rule of Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : []) add(out.allow_rules, rule);
      for (const dir of Array.isArray(settings.permissions?.additionalDirectories) ? settings.permissions.additionalDirectories : []) add(out.additional_directories, dir);
      if (isDict(settings.env)) for (const key of Object.keys(settings.env)) add(out.env_keys, key);
      for (const key of ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'otelHeadersHelper', 'enabledPlugins', 'extraKnownMarketplaces']) {
        if (settings[key] !== undefined) add(out.helper_commands, `${file}: ${key}: ${JSON.stringify(settings[key])}`);
      }
      for (const key of ['statusLine', 'subagentStatusLine', 'fileSuggestion']) {
        if (settings[key]?.command !== undefined) add(out.helper_commands, `${file}: ${key}: ${settings[key].command}`);
      }
    } catch { add(out.unreadable, file); }
  }
  const mcp = path.join(root, '.mcp.json');
  if (fs.existsSync(mcp)) {
    const servers = JSON.parse(fs.readFileSync(mcp, 'utf8')).mcpServers;
    for (const [name, server] of Object.entries(servers) as [string, any][]) {
      const { command, args, url, headersHelper } = server ?? {};
      if (command !== undefined || url !== undefined || headersHelper !== undefined) {
        add(out.mcp_commands, `${name}: ${JSON.stringify({ command, args, url, headersHelper })}`);
      }
    }
  }
  // Claude Code scans these trees recursively, and both file kinds can carry hooks.
  const under = (dir: string, match: (name: string) => boolean) => {
    if (!fs.existsSync(path.join(root, dir))) return [];
    const names = fs.readdirSync(path.join(root, dir), { recursive: true }) as string[];
    return names.filter(match).sort().map(name => `${dir}/${name}`);
  };
  const files = [
    ...under('.claude/agents', name => name.endsWith('.md')),
    ...under('.claude/skills', name => path.basename(name) === 'SKILL.md'),
  ];
  if (files.length > 20) out.truncated = true;
  for (const file of files.slice(0, 20)) {
    const full = path.join(root, file);
    const fm = readFrontmatter(full);
    if (fm?.hooks === undefined) continue;
    try {
      // The shared reader identifies the field; YAML preserves its nested hook structure.
      const content = fs.readFileSync(full, 'utf8');
      const end = content.indexOf('\n---', 3);
      const parsed = Bun.YAML.parse(content.slice(4, end)) as any;
      hooks(parsed?.hooks, out.agent_hooks, file);
    } catch { add(out.unreadable, file); }
  }
  return out;
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
  const refs = git(target, 'rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir');
  if (refs.status !== 0) return refused('not_a_repository');
  const [toplevel, gitDir, common] = refs.stdout.trim().split('\n').map((ref) => fs.realpathSync(path.resolve(target, ref)));
  // The helper loads configuration from its launch folder, not the repository root.
  if (toplevel !== target) return refused('not_repository_root');
  // Trust alone is keyed on the main checkout; a linked worktree has its own configuration.
  const linked = gitDir !== common && path.basename(common) === '.git';
  const key = linked ? path.dirname(common) : toplevel;
  if (!underRoot(key)) return refused('outside_launch_root');
  const mcp_servers = mcpServers(target);
  if (mcp_servers.length) {
    const tracked = git(target, 'ls-files', '--error-unmatch', '--', '.claude/settings.local.json');
    if (tracked.status === 0) return refused('local_settings_tracked');
    if (tracked.status !== 1) throw new Error('git_failed');
  }
  const repo_config = ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json']
    .filter((name) => fs.existsSync(path.join(target, name)));
  return { status: 'eligible', key, repo_config, mcp_servers, activates: activationSummary(target) };
}

function guardState<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ClaudeStateError) throw new Error('invalid_state');
    throw error;
  }
}

function isTrusted(key: string): boolean {
  return guardState(() => !markWorkspaceTrusted(readClaudeState(), key));
}

export async function trustWorkspace(key: string, { settleMs = 3000 } = {}): Promise<number> {
  let writes = 0;
  for (let round = 0; round < 2; round++) {
    if (guardState(() => updateClaudeState((state) => markWorkspaceTrusted(state, key)))) writes++;
    // Claude Code exposes no signal that a pre-warmed worker has refreshed.
    await Bun.sleep(settleMs);
    if (isTrusted(key)) return writes;
  }
  throw new Error('seed_lost');
}

function localSettings(root: string): Record<string, unknown> {
  const file = path.join(root, '.claude/settings.local.json');
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

function approveMcp(root: string, names: string[], settings: Record<string, unknown>): void {
  const result = git(root, 'rev-parse', '--git-path', 'info/exclude');
  if (result.status !== 0) throw new Error('git_failed');
  const exclude = path.resolve(root, result.stdout.trim());
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
  const file = path.join(root, '.claude/settings.local.json');
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
    const settings = result.mcp_servers.length ? localSettings(dir) : null;
    isTrusted(result.key); // a malformed state file fails here, before the clone changes
    if (settings) approveMcp(dir, result.mcp_servers, settings);
    const writes = await trustWorkspace(result.key);
    emitJson({ status: 'recorded', key: result.key, writes, mcp_approved: result.mcp_servers });
  } catch (error) {
    failJson(error);
  }
}
