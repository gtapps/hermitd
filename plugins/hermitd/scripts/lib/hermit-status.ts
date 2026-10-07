import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isRunnable, readExecution, readTasks } from './tasks';
import { findResident } from './session-registry';
import { readConfigRaw } from './config-read';

export type Transport = 'up' | 'down' | 'unknown';
export function inspect(command: string, args: string[], cwd: string) {
  return spawnSync(command, args, { cwd, env: { ...process.env }, encoding: 'utf8', timeout: 10000 });
}
export function dockerTransport(project: string): Transport {
  const compose = path.join(project, 'docker-compose.hermit.yml');
  if (!fs.existsSync(compose)) return 'down';
  const args = ['compose', '-f', compose];
  const overlay = path.join(project, 'docker-compose.security.yml');
  if (fs.existsSync(overlay)) args.push('-f', overlay);
  const result = inspect('docker', [...args, 'ps', '--status', 'running', '--format', '{{.Service}}'], project);
  if (result.error || result.status !== 0) return 'unknown';
  return result.stdout.split(/\r?\n/).includes('hermit') ? 'up' : 'down';
}
export function tmuxTransport(project: string, session?: string): Transport {
  if (!session) return 'down';
  const result = inspect('tmux', ['has-session', '-t', `=${session}`], project);
  // No tmux binary means no host session (a Docker host's runtime.json still names the container's).
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return 'down';
  if (result.error || (result.status !== 0 && result.status !== 1)) return 'unknown';
  return result.status === 0 ? 'up' : 'down';
}
export function readRuntime(project: string): { runtime_mode?: string; tmux_session?: string; session_pid?: number; config_dir?: string } {
  try { return JSON.parse(fs.readFileSync(path.join(project, '.hermit/state/runtime.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}
export function projectStatus(project: string) {
  const dir = path.join(project, '.hermit');
  const config = readConfigRaw(dir);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(`Unreadable or invalid config in ${dir}`);
  const runtime = readRuntime(project);
  const docker = fs.existsSync(path.join(project, 'docker-compose.hermit.yml'));
  const execution = readExecution(dir, docker ? {} : { registryFallback: true });
  const records = readTasks(dir);
  const transport = docker ? dockerTransport(project) : runtime.runtime_mode === 'interactive'
    ? (findResident(runtime, runtime.config_dir) ? 'up' : 'down') : tmuxTransport(project, runtime.tmux_session);
  return {
    project_dir: project, name: path.basename(project), agent_name: config.agent_name ?? path.basename(project),
    runtime: runtime.runtime_mode ?? (docker ? 'docker' : 'tmux'), transport,
    execution: execution.state,
    age: execution.at ? Math.max(0, Math.floor((Date.now() - Date.parse(execution.at)) / 1000)) : null,
    open: records.filter(r => r.status === 'open').length, waiting: records.filter(r => r.status === 'open' && r.waiting_on).length,
    working_on: records.find(isRunnable)?.title ?? null,
  };
}
export function renderStatus(rows: Record<string, unknown>[], json = false): string {
  if (json) return JSON.stringify(rows.length === 1 ? rows[0] : rows);
  const columns = ['name', 'runtime', 'transport', 'execution', 'age', 'open', 'waiting', 'working_on', 'state', 'registered'];
  const cells = [columns.map(c => c === 'working_on' ? 'WORKING ON' : c.toUpperCase()), ...rows.map(row => columns.map(c => String(row[c] ?? '-').replace(/[\r\n\t\x1b]/g, ' ')))];
  const widths = columns.map((_, i) => Math.max(...cells.map(row => Bun.stringWidth(row[i]))));
  return cells.map(row => row.map((cell, i) => cell + ' '.repeat(widths[i] - Bun.stringWidth(cell))).join('  ').trimEnd()).join('\n');
}
