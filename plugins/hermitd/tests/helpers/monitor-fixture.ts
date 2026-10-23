import fs from 'node:fs';
import path from 'node:path';
import { resolvePaths } from '../../scripts/doctor-check';
import { heartbeatCommand, heartbeatInterval, PLUGIN_ROOT } from '../../scripts/lib/heartbeat/monitor-cmd';
import { routineCommand } from '../../scripts/lib/routines/arm';

export type FixtureOpts = {
  bootId?: string | null;
  heartbeatBootId?: string | null;
  routineBootId?: string | null;
  routineMode?: string;
  heartbeatEnabled?: boolean;
  heartbeatTickAgoSecs?: number | null;
  routineTickAgoSecs?: number | null;
  heartbeatStartedAgoSecs?: number;
  routineStartedAgoSecs?: number;
  omitHeartbeatRuntime?: boolean;
  commandDrift?: boolean;
  intervalDrift?: boolean;
  routineLaunchDrift?: boolean;
};

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value));
}

/** Per-monitor override wins; explicit null omits boot_id entirely; undefined falls back to the shared id. */
function resolveBootId(specific: string | null | undefined, fallback: string | null | undefined): string | undefined {
  if (specific !== null && specific !== undefined) return specific;
  if (specific === undefined && fallback) return fallback;
  return undefined;
}

export function monitorFixture(freshDir: () => string, opts: FixtureOpts = {}) {
  const dir = freshDir();
  const hermitDir = path.join(dir, '.hermit');
  const stateDir = path.join(hermitDir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  const config = {
    heartbeat: { enabled: opts.heartbeatEnabled ?? true, every: '30m' },
    routines: [
      { id: 'hermitd:doctor', enabled: true, schedule: '10 9 * * 1', skill: 'hermitd:hermit-doctor' },
    ],
  };
  writeJson(path.join(hermitDir, 'config.json'), config);
  writeJson(path.join(stateDir, 'runtime.json'), {
    version: 1,
    runtime_mode: 'interactive',
  });

  const ago = (secs: number) => new Date(Date.now() - secs * 1000).toISOString();
  const heartbeatRuntime: Record<string, unknown> = {
    description: 'heartbeat-monitor',
    started_at: ago(opts.heartbeatStartedAgoSecs ?? 3600),
    interval: heartbeatInterval(config) + (opts.intervalDrift ? 1 : 0),
    command: opts.commandDrift ? 'old-command' : heartbeatCommand(hermitDir, config),
    launch: 'native',
  };
  const heartbeatBootId = resolveBootId(opts.heartbeatBootId, opts.bootId);
  if (heartbeatBootId !== undefined) heartbeatRuntime.boot_id = heartbeatBootId;
  if (!opts.omitHeartbeatRuntime) writeJson(path.join(stateDir, 'heartbeat-monitor.runtime.json'), heartbeatRuntime);
  if (opts.heartbeatTickAgoSecs !== null) writeJson(path.join(stateDir, 'heartbeat-liveness.json'), { last_peek_at: ago(opts.heartbeatTickAgoSecs ?? 0) });

  const routineRuntime: Record<string, unknown> = {
    description: 'routine-monitor',
    mode: opts.routineMode ?? 'monitor',
    started_at: ago(opts.routineStartedAgoSecs ?? 3600),
    interval: 60,
    command: opts.commandDrift ? 'old-command' : routineCommand(hermitDir),
    launch: opts.routineLaunchDrift ? 'old-launch' : 'native',
  };
  const routineBootId = resolveBootId(opts.routineBootId, opts.bootId);
  if (routineBootId !== undefined) routineRuntime.boot_id = routineBootId;
  writeJson(path.join(stateDir, 'routine-monitor.runtime.json'), routineRuntime);
  if (opts.routineTickAgoSecs !== null) writeJson(path.join(stateDir, 'routine-monitor-liveness.json'), { last_peek_at: ago(opts.routineTickAgoSecs ?? 0) });

  if (opts.bootId) {
    fs.writeFileSync(path.join(stateDir, '.boot-id'), opts.bootId + '\n');
  }

  return { hermitDir, config, paths: resolvePaths(hermitDir, PLUGIN_ROOT) };
}

