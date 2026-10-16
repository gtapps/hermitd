// Read/write for state/context-surface.json — the hermit's recorded fixed-surface
// upper bound, derived by cost-tracker at each compaction boundary as
// (earliest post-boundary call's input+cache) − compactMetadata.postTokens.
// Single writer: cost-tracker (Stop hook). Readers: hermitd-watchdog's compact
// gate and doctor-check. Lives in its own file (not watchdog-state.json or
// runtime.json) so it survives boots and /clear and never races the watchdog's
// whole-file tick rewrites.
//
// The stored value is an UPPER bound: the first post-boundary call also carries
// the wake's own messages (~11-12k measured live), so consumers subtracting it
// get a lower bound on compactible conversation. prev holds the previous
// reading for doctor's informational growth display.

import fs from 'node:fs';
import path from 'node:path';
import { writeAlertState } from './alert-state';

type Json = any;

export interface ContextSurface {
  surface_upper_bound_tokens: number;
  post_tokens: number;
  boundary_at: string;
  observed_at: string;
  prev: { surface_upper_bound_tokens: number; boundary_at: string } | null;
}

export function contextSurfacePath(hermitDir: string): string {
  return path.join(hermitDir, 'state', 'context-surface.json');
}

/** Parsed record, or null on missing/malformed/implausible content — consumers
 *  must degrade to their assumed-surface fallback, never throw or gate on garbage. */
export function readContextSurface(hermitDir: string): ContextSurface | null {
  try {
    const raw: Json = JSON.parse(fs.readFileSync(contextSurfacePath(hermitDir), 'utf-8'));
    if (!raw || typeof raw.surface_upper_bound_tokens !== 'number'
      || !Number.isFinite(raw.surface_upper_bound_tokens) || raw.surface_upper_bound_tokens <= 0) return null;
    return raw as ContextSurface;
  } catch {
    return null;
  }
}

/** Atomic write via lib/alert-state.ts's generic atomic-JSON writer: PID-specific
 *  temp (a shared temp name lets two concurrent writers publish a zero-length
 *  record — see lib/runtime.ts), chmod 0600 before rename. Fail-open: cost tracking must
 *  never break on a surface-write failure, and writeAlertState swallows errors. */
export function writeContextSurface(hermitDir: string, data: ContextSurface): void {
  writeAlertState(contextSurfacePath(hermitDir), data);
}
