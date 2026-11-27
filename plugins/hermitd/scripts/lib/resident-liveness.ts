import { LIVENESS_FRESH_SECS, sharedLivenessAgeSecs } from './liveness';
import { tmuxSessionAlive } from './tmux';

export type LivenessState = 'none' | 'alive' | 'cleanly-stopped' | 'interactive' | 'orphan' | 'dead';
export type LivenessDeps = { tmuxAlive(s: string): boolean; livenessAgeSecs(): number | null };
export type LivenessEvidence = { runtimeMode: string | null; tmuxAlive: boolean; livenessAgeSecs: number | null; fresh: boolean; cleanlyStopped: boolean };
export type LivenessVerdict = { state: LivenessState; evidence: LivenessEvidence };

export function residentLiveness(
  runtime: { runtime_mode?: unknown; shutdown_completed_at?: unknown } | null,
  sessionName: string,
  deps: LivenessDeps,
): LivenessVerdict {
  const runtimeMode = typeof runtime?.runtime_mode === 'string' ? runtime.runtime_mode : null;
  const age = deps.livenessAgeSecs();
  const evidence: LivenessEvidence = {
    runtimeMode,
    tmuxAlive: sessionName ? deps.tmuxAlive(sessionName) : false,
    livenessAgeSecs: age,
    fresh: age !== null && age < LIVENESS_FRESH_SECS,
    cleanlyStopped: Boolean(runtime?.shutdown_completed_at),
  };
  // Fresh activity without tmux reads as an orphan even when runtime.json lost its
  // mode: restarting or marking stopped over it would spawn a second claude.
  const state: LivenessState = evidence.tmuxAlive ? 'alive'
    : evidence.cleanlyStopped ? 'cleanly-stopped'
    : runtimeMode === 'interactive' ? 'interactive'
    : evidence.fresh ? 'orphan'
    : !runtimeMode ? 'none' : 'dead';
  return { state, evidence };
}

export type BootOwner = { mode: string; age_secs: number | null; via: 'tmux' | 'liveness' };

/**
 * The live instance of another runtime that owns this state folder, or null when
 * `target` may boot here: the one boot-ownership verdict every boot path asks.
 * A live host tmux session counts only for a Docker boot (a host boot over its
 * own session is serialized by the lifecycle lock); callers inside a container,
 * which cannot see host tmux, supply a tmux probe that returns false.
 */
export function bootOwner(verdict: LivenessVerdict, target: string): BootOwner | null {
  const e = verdict.evidence;
  if (!e.runtimeMode || e.runtimeMode === target) return null;
  const age = e.livenessAgeSecs === null ? null : Math.round(e.livenessAgeSecs);
  if (target === 'docker' && e.tmuxAlive) return { mode: e.runtimeMode, age_secs: age, via: 'tmux' };
  if (!e.cleanlyStopped && e.fresh) return { mode: e.runtimeMode, age_secs: age, via: 'liveness' };
  return null;
}

export function REAL_LIVENESS_DEPS(hermitRoot?: string): LivenessDeps {
  return { tmuxAlive: tmuxSessionAlive, livenessAgeSecs: () => sharedLivenessAgeSecs(hermitRoot) };
}
