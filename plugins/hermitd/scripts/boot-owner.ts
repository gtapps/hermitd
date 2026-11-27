#!/usr/bin/env bun
/**
 * May a runtime boot over this state folder? The bootOwner verdict for shell
 * callers: the container entrypoint and `hermitd-docker`.
 *
 * Usage: boot-owner <tmux|interactive|docker> [hermit-root]
 *   hermit-root defaults to .hermit.
 *
 * Prints one JSON object and exits 0:
 *   {"status":"clear"}                                    boot may proceed
 *   {"status":"clear","reason":"forced"}                  HERMIT_FORCE_BOOT=1
 *   {"status":"owned","mode":"tmux","age_secs":42|null,"via":"tmux"|"liveness"}
 * The tmux probe sees only this namespace's tmux. The entrypoint asks before the
 * container starts its own tmux server, so there only the shared liveness files
 * count.
 */

import path from 'node:path';
import { readRuntimeJson } from './lib/runtime';
import { bootOwner, residentLiveness, REAL_LIVENESS_DEPS } from './lib/resident-liveness';

const TARGETS = ['tmux', 'interactive', 'docker'];

if (import.meta.main) {
  const target = process.argv[2] ?? '';
  const hermitRoot = process.argv[3] || '.hermit';
  if (!TARGETS.includes(target)) {
    console.log(JSON.stringify({ error: 'usage:boot-owner <tmux|interactive|docker> [hermit-root]' }));
    process.exit(1);
  }
  if (process.env.HERMIT_FORCE_BOOT === '1') {
    console.log(JSON.stringify({ status: 'clear', reason: 'forced' }));
    process.exit(0);
  }
  const rt = readRuntimeJson(path.join(hermitRoot, 'state'));
  const sessionName = typeof rt?.tmux_session === 'string' ? rt.tmux_session : '';
  const owner = bootOwner(residentLiveness(rt, sessionName, REAL_LIVENESS_DEPS(hermitRoot)), target);
  console.log(JSON.stringify(owner ? { status: 'owned', ...owner } : { status: 'clear' }));
  process.exit(0);
}
