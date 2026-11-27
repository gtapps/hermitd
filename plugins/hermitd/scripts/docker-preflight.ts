#!/usr/bin/env bun
/**
 * Pre-flight probe for /docker-setup Step 1.
 *
 * Collapses the skill's read-only Step 1 shell probes (docker presence, config
 * existence, WSL path, existing docker files, host ~/.gitconfig, auto-memory
 * seed) into one call so the wizard makes a single Bash round-trip instead of
 * fanning out. The skill still owns every DECISION these signals feed — this
 * script only gathers facts.
 *
 * Usage: bun docker-preflight.ts [project-root] [hermit-state-dir]
 *   project-root defaults to process.cwd(); the skill passes the shell's `$(pwd)`
 *   so the auto-memory path key matches Claude Code's logical-path key.
 *   hermit-state-dir defaults to .hermit.
 *
 * Prints a single JSON object to stdout and always exits 0 — callers inspect
 * fields, not the exit code. Any probe that errors degrades to null/false.
 *   {
 *     "docker_version": "Docker version 27.0.3, build ..." | null,
 *     "config_exists": true,
 *     "is_wsl": false,
 *     "existing": { "dockerfile": false, "entrypoint": false, "compose": false },
 *     "gitconfig_exists": true,
 *     "memory": { "path_key": "-home-user-project", "seed_exists": false },
 *     "live_owner": { "mode": "tmux", "age_secs": 42 | null } | null
 *   }
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readRuntimeJson } from './lib/runtime';
import { residentLiveness, bootOwner, REAL_LIVENESS_DEPS } from './lib/resident-liveness';
import { transcriptDirFor, transcriptPathKey } from './lib/cc-compat';

function dockerVersion(): string | null {
  try {
    const r = spawnSync('docker', ['--version'], { timeout: 5000, encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch {}
  return null;
}

/**
 * A live non-docker instance owning this project's state, or null: the shared
 * bootOwner verdict for a Docker boot, including the host tmux check the
 * container's entrypoint cannot make. Deliberately NOT shouldRefuseBoot: its
 * first branch also refuses when a Docker hermit is running, which is the
 * supported case for re-running /docker-setup over an existing container.
 * `age_secs` is null when a live tmux session has written no liveness file.
 */
function liveOwner(projectRoot: string, hermitDir: string) {
  try {
    const hermitRoot = path.join(projectRoot, hermitDir);
    const rt = readRuntimeJson(path.join(hermitRoot, 'state')) as Record<string, unknown> | null;
    const sessionName = typeof rt?.tmux_session === 'string' ? rt.tmux_session : '';
    const owner = bootOwner(residentLiveness(rt, sessionName, REAL_LIVENESS_DEPS(hermitRoot)), 'docker');
    return owner && { mode: owner.mode, age_secs: owner.age_secs };
  } catch {
    return null;
  }
}

function probe(projectRoot: string, hermitDir: string) {
  const home = os.homedir();
  // Auto-memory seed path key — derived from the project root the skill passes in
  // (the shell's logical `$(pwd)`, the same path Claude Code keys
  // <config-dir>/projects/<key> off), so it matches even when the root is reached
  // through a symlink. Goes through cc-compat so it stays CC's scheme: every
  // non-alphanumeric character maps to '-', dots included. The older
  // `pwd | sed 's|/|-|g'` form replaced slashes only and mis-keyed any dotted path.
  const pathKey = transcriptPathKey(projectRoot);
  return {
    docker_version: dockerVersion(),
    config_exists: fs.existsSync(path.join(projectRoot, hermitDir, 'config.json')),
    is_wsl: projectRoot.startsWith('/mnt/c/') || projectRoot.startsWith('/mnt/d/'),
    existing: {
      dockerfile: fs.existsSync(path.join(projectRoot, 'Dockerfile.hermit')),
      entrypoint: fs.existsSync(path.join(projectRoot, 'docker-entrypoint.hermit.sh')),
      compose: fs.existsSync(path.join(projectRoot, 'docker-compose.hermit.yml')),
    },
    gitconfig_exists: fs.existsSync(path.join(home, '.gitconfig')),
    memory: {
      path_key: pathKey,
      seed_exists: fs.existsSync(path.join(transcriptDirFor(projectRoot), 'memory', 'MEMORY.md')),
    },
    live_owner: liveOwner(projectRoot, hermitDir),
  };
}

export { probe };

if (import.meta.main) {
  const projectRoot = process.argv[2] || process.cwd();
  const hermitDir = process.argv[3] || '.hermit';
  console.log(JSON.stringify(probe(projectRoot, hermitDir)));
  process.exit(0);
}
