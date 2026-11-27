import fs from 'node:fs';
import os from 'node:os';
import { ancestorGit } from './workdir';

// Keep operator channel state out of fixtures and their subprocesses. Tests
// can set explicit overrides after preload when exercising env precedence.
delete process.env.DISCORD_STATE_DIR;
delete process.env.TELEGRAM_STATE_DIR;

// Spawned scripts inherit process.env, so one default covers every mock Discord
// server: the 2s production lookup bound aborts under parallel test load.
process.env.HERMIT_DISCORD_LOOKUP_TIMEOUT_MS ??= '30000';

// Production waits that negative-path tests sit out in full. No test registers a
// Claude Code Monitor or worker, so short bounds change only how long they wait.
process.env.HEARTBEAT_MONITOR_SLICE_SECONDS ??= '1';
process.env.HERMIT_FIRST_TICK_WAIT_MS ??= '1000';
process.env.HERMIT_TRUST_SETTLE_MS ??= '100';

// A `.git` above the temp root (a stray `git init`, a sandbox placeholder) puts
// every fixture inside a repository for code that walks up for `.git`, so
// fixtures move to a clean temp root. os.tmpdir() reads TMPDIR per call.
const stray = ancestorGit(os.tmpdir());
if (stray) {
  const fallback = '/var/tmp';
  if (!fs.existsSync(fallback) || ancestorGit(fallback)) {
    throw new Error(`${stray} sits above the temp directory and ${fallback} is not a clean fallback; remove it or set TMPDIR outside any repository`);
  }
  process.env.TMPDIR = fallback;
}
