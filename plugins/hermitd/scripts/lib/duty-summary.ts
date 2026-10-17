import path from 'node:path';
import { readConfigRaw } from './config-read';
import { readJson } from './cli';
import { deriveDuties } from './tasks';
import { lastRoutineEventWithTimestamp } from './routines/history';
import { effectiveHeartbeatMode } from './heartbeat/control';

export interface DutyRow { name: string; enabled?: boolean; every?: string; schedule?: string | null; mode?: string | null; pid: number | null; last_woke: string | null; last_event: string | null }

/** Each duty's requested schedule and mode beside its observed liveness; `null` is unknown. */
export function dutyRows(dir: string): DutyRow[] {
  const config = readConfigRaw(dir) ?? {};
  const mode = effectiveHeartbeatMode(dir);
  const routines = readJson(path.join(dir, 'state/routine-monitor.runtime.json'));
  return deriveDuties(dir).map(duty => {
    const heartbeat = duty.name === 'heartbeat';
    const routine = config.routines?.find((entry: any) => `routine:${entry.id}` === duty.name);
    const requested = heartbeat
      ? { enabled: config.heartbeat?.enabled !== false, every: config.heartbeat?.every ?? '30m', mode }
      : routine ? { enabled: routine.enabled !== false, schedule: routine.schedule ?? null, mode: routines?.mode ?? null } : {};
    const live = readJson(path.join(dir, 'state', heartbeat ? 'heartbeat-liveness.json' : 'routine-monitor-liveness.json'));
    const lastEvent = routine
      ? lastRoutineEventWithTimestamp(path.join(dir, 'state/routine-metrics.jsonl'), routine.id)
      : duty.last_verdict;
    return { name: duty.name, ...requested, pid: typeof live?.pid === 'number' ? live.pid : null, last_woke: duty.last_run ?? null, last_event: lastEvent ?? null };
  });
}

/** The weekly review's Duties lines, rendered from dutyRows. */
export function dutySummary(dir: string): string[] {
  return dutyRows(dir).map(row => {
    const requested = row.every !== undefined
      ? `enabled=${row.enabled}, every=${row.every}, mode=${row.mode}`
      : row.enabled !== undefined ? `enabled=${row.enabled}, schedule=${row.schedule ?? '?'}, mode=${row.mode ?? 'unknown'}` : 'configured';
    return `${row.name}: requested ${requested}; observed pid=${row.pid ?? 'unknown'}, last_woke=${row.last_woke ?? 'unknown'}, last_event=${row.last_event ?? 'unknown'}`;
  });
}
