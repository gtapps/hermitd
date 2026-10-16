import path from 'node:path';
import { readConfigRaw } from './config-read';
import { readJson } from './cli';
import { deriveDuties } from './tasks';
import { lastRoutineEventWithTimestamp } from './routines/history';
import { effectiveHeartbeatMode } from './heartbeat/control';

export function dutySummary(dir: string): string[] {
  const config = readConfigRaw(dir) ?? {};
  const mode = effectiveHeartbeatMode(dir);
  const routines = readJson(path.join(dir, 'state/routine-monitor.runtime.json'));
  return deriveDuties(dir).map(duty => {
    const heartbeat = duty.name === 'heartbeat';
    const routine = config.routines?.find((entry: any) => `routine:${entry.id}` === duty.name);
    const requested = heartbeat
      ? `enabled=${config.heartbeat?.enabled !== false}, every=${config.heartbeat?.every ?? '30m'}, mode=${mode}`
      : routine ? `enabled=${routine.enabled !== false}, schedule=${routine.schedule ?? '?'}, mode=${routines?.mode ?? 'unknown'}` : 'configured';
    const live = readJson(path.join(dir, 'state', heartbeat ? 'heartbeat-liveness.json' : 'routine-monitor-liveness.json'));
    const lastEvent = routine
      ? lastRoutineEventWithTimestamp(path.join(dir, 'state/routine-metrics.jsonl'), routine.id)
      : duty.last_verdict;
    return `${duty.name}: requested ${requested}; observed pid=${typeof live?.pid === 'number' ? live.pid : 'unknown'}, last_woke=${duty.last_run ?? 'unknown'}, last_event=${lastEvent ?? 'unknown'}`;
  });
}
