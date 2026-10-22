#!/usr/bin/env bun
/**
 * Graceful shutdown for the resident.
 *
 * Runs the configured shutdown skill through the core mod (lib/shutdown.ts) and waits
 * for its turn to settle before stopping the tmux session.
 *
 * Usage:
 *     bun scripts/hermitd-stop.ts              # graceful shutdown
 *     bun scripts/hermitd-stop.ts --force      # immediate kill
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gracefulShutdown } from './lib/shutdown';
import { acquireLock, releaseLock } from './lib/lockfile';
import { settleConfig, readConfigRaw } from './lib/config-read';
import { auditConfigChange } from './lib/config-audit';
import { localISOStamp } from './lib/time';
import { readRuntimeJson, updateRuntimeField, STATE_DIR, LIFECYCLE_LOCK } from './lib/runtime';
import { tmuxSessionAlive, getSessionName } from './lib/tmux';
import { paneRootPids, collectTree, verifyTreeExited } from './lib/proc';
import { residentLiveness, REAL_LIVENESS_DEPS } from './lib/resident-liveness';

type Json = any;

const CONFIG_PATH = '.hermit/config.json';
const DEFAULT_TIMEOUT = 60; // seconds to wait for graceful close

function loadConfig(): { config: Json; raw: Json } {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log('[hermit] No config found. Is this a hermit project?');
    process.exit(1);
  }
  // Malformed JSON no longer aborts the stop — settle to defaults so a broken
  // config can't strand a running session. The exact on-disk object travels
  // beside the settled read-view so saveConfig() never persists settling
  // artifacts (see saveConfig). raw === null means unparseable. Both views come
  // from one read, so they always describe the same snapshot.
  const raw = readConfigRaw(path.dirname(CONFIG_PATH));
  return { config: settleConfig(raw ?? undefined), raw };
}

// `always_on` is the only field the stop flow mutates, so it is patched onto the
// RAW object and that is what gets written. Persisting the settled read-view
// instead would bake read-path normalization into the operator's file: a
// non-array `routines` would be written back as `[]` (every routine gone), a
// mistyped `budget.daily_usd: "5"` as `null`, and an unparseable config as a
// full set of template defaults. A config we could not parse is left untouched.
function saveConfig(config: Json, raw: Json): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const before = structuredClone(raw);
  raw.always_on = config.always_on;
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + '\n');
    auditConfigChange(path.dirname(CONFIG_PATH), before, raw, 'hermitd-stop');
  } catch {}
}

function acquireLifecycleLock(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (!acquireLock(LIFECYCLE_LOCK)) {
    console.log('[hermit] Another lifecycle operation in progress. Aborting.');
    process.exit(1);
  }
}

function releaseLifecycleLock(): void {
  releaseLock(LIFECYCLE_LOCK);
}

function tmux(args: string[]): void {
  spawnSync('tmux', args, { stdio: 'inherit' });
}

/** Print the survivor warning + manual kill hint. */
function warnSurvivors(pids: number[]): void {
  console.log(`[hermit] WARNING: ${pids.length} process(es) survived stop: ${pids.join(' ')}`);
  console.log(`[hermit] A claude process may still be running. Verify and finish manually: kill -9 ${pids.join(' ')}`);
}

async function main(): Promise<void> {
  const force = process.argv.includes('--force');

  const { config, raw } = loadConfig();
  acquireLifecycleLock();
  const sessionName = getSessionName(config);

  const liveness = residentLiveness(readRuntimeJson(), sessionName, REAL_LIVENESS_DEPS());
  if (liveness.state !== 'alive') {
    if (liveness.state === 'interactive') {
      // Claude is still running in the operator's terminal — don't corrupt
      // lifecycle truth. The Stop hook (triggered when Claude exits) owns
      // the transition to idle.
      console.log('[hermit] Hermit is running in interactive mode.');
      console.log('[hermit] Terminate the Claude process in your terminal (Ctrl+C).');
      config.always_on = false;
      saveConfig(config, raw);
      releaseLifecycleLock();
      process.exit(0);
    }
    // No tmux session — but fresh state activity means a detached claude may
    // still be alive (the orphan case: tmux gone, process survived). Marking it
    // "stopped" here would make runtime.json lie. Report the likely orphan and
    // exit non-zero without touching lifecycle truth.
    const age = liveness.evidence.livenessAgeSecs;
    if (liveness.state === 'orphan') {
      console.log(`[hermit] No tmux session "${sessionName}", but state activity ${Math.round(age!)}s ago — a detached claude may still be running.`);
      console.log('[hermit] Find it:  pgrep -af "claude --channels"');
      console.log('[hermit] Not marking stopped. Kill that process, or ignore if this is another runtime (then re-run).');
      releaseLifecycleLock();
      process.exitCode = 1;
      return;
    }

    console.log(`[hermit] No running session: ${sessionName}`);
    config.always_on = false;
    saveConfig(config, raw);
    updateRuntimeField({
      shutdown_completed_at: localISOStamp(),
      transition: null,
      transition_target: null,
      transition_started_at: null,
    });
    releaseLifecycleLock();
    process.exit(0);
  }

  if (force) {
    console.log(`[hermit] Force-killing session: ${sessionName}`);
    config.always_on = false;
    saveConfig(config, raw);
    // Capture the pane's process tree BEFORE killing the session so we can
    // verify the claude process actually died rather than orphaning.
    const tree = collectTree(paneRootPids(sessionName));
    tmux(['kill-session', '-t', sessionName]);
    const { orphaned, reportedPids } = await verifyTreeExited(tree);

    const updates: Json = {
      shutdown_requested_at: localISOStamp(),
      transition: null,
      transition_target: null,
      transition_started_at: null,
    };
    if (orphaned) {
      warnSurvivors(reportedPids);
      updates.last_error = 'orphaned_process';
      // Leave shutdown_completed_at unset — a live process
      // means the hermit is NOT stopped, and shutdown_requested_at stays set so
      // the watchdog won't restart over it.
      updateRuntimeField(updates);
      process.exitCode = 1;
    } else {
      console.log(`[hermit] Process tree verified exited (${tree.pids.length} processes).`);
      updates.shutdown_completed_at = localISOStamp();
      updates.last_error = 'unclean_shutdown';
      updateRuntimeField(updates);
      console.log('[hermit] Warning: resident was force-stopped.');
    }
    releaseLifecycleLock();
    return;
  }

  // Mark shutdown requested in runtime.json
  updateRuntimeField({ shutdown_requested_at: localISOStamp() });

  // Capture the pane's process tree while the session is still alive, so the
  // survivor check at the end can tell "closed cleanly" from "orphaned".
  const stopTree = collectTree(paneRootPids(sessionName));

  releaseLifecycleLock();

  // The shutdown skill runs through the core mod's queue once no turn is running, and
  // only the turn it started settles this wait.
  console.log(`[hermit] Waiting up to ${DEFAULT_TIMEOUT}s for execution to settle...`);
  const shutdown = await gracefulShutdown(path.resolve(path.dirname(CONFIG_PATH)), { timeoutSecs: DEFAULT_TIMEOUT });
  const settled = shutdown.status === 'settled';
  if (shutdown.skill !== 'none' && shutdown.skill !== 'ok') console.log(`[hermit] Shutdown skill ${shutdown.skill}${shutdown.reason ? ` (${shutdown.reason})` : ''}.`);
  if (!settled) console.log(`[hermit] Timeout after ${DEFAULT_TIMEOUT}s. Killing session.`);

  // Re-acquire lock for final state writes and cleanup
  acquireLifecycleLock();

  // Reset always_on flag
  config.always_on = false;
  saveConfig(config, raw);

  // Kill tmux session
  if (tmuxSessionAlive(sessionName)) {
    tmux(['kill-session', '-t', sessionName]);
    console.log(`[hermit] tmux session "${sessionName}" terminated.`);
  }

  // Verify the captured process tree actually exited (terminating any survivor).
  const { orphaned, reportedPids } = await verifyTreeExited(stopTree);

  const shutdownUpdates: Json = {
    transition: null,
    transition_target: null,
    transition_started_at: null,
  };
  if (orphaned) {
    // A live process means NOT stopped — keep shutdown_requested_at set (it
    // inhibits watchdog restart) and don't claim completion or idle.
    warnSurvivors(reportedPids);
    shutdownUpdates.last_error = 'orphaned_process';
    updateRuntimeField(shutdownUpdates);
    process.exitCode = 1;
  } else {
    console.log(`[hermit] Process tree verified exited (${stopTree.pids.length} processes).`);
    shutdownUpdates.shutdown_completed_at = localISOStamp();
    shutdownUpdates.last_error = settled ? null : 'unclean_shutdown';
    updateRuntimeField(shutdownUpdates);
  }

  releaseLifecycleLock();
}

if (import.meta.main) {
  await main();
}
