#!/usr/bin/env bun
import { readFileSync, rmSync } from 'node:fs';
import { isAbsolute } from 'node:path';

function rejected(reason: string): Record<string, unknown> {
  return { status: 'rejected', reason };
}

// Returns an exit-0 outcome; a throw is the exit-1 path (usage, or new-run's rmSync).
function run(args: string[]): Record<string, unknown> {
  if (args.length === 2 && args[0] === 'new-run' && isAbsolute(args[1])) {
    // A prior payload too large to Read cannot be overwritten by the fetcher's Write.
    rmSync(args[1], { force: true });
    return { run_id: crypto.randomUUID() };
  }

  const [command, path, runId] = args;
  if (args.length !== 3 || command !== 'verify' || !path || !isAbsolute(path) || !runId?.trim()) {
    throw new Error('usage');
  }

  let result: unknown;
  try {
    result = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return rejected((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing_output' : 'invalid_payload');
  }
  if (typeof result !== 'object' || result === null || Array.isArray(result)
    || !('run_id' in result) || typeof result.run_id !== 'string'
    || !('sources' in result) || !Array.isArray(result.sources)) {
    return rejected('invalid_payload');
  }
  if (result.run_id !== runId) return rejected('run_id_mismatch');
  return result as Record<string, unknown>;
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(run(process.argv.slice(2))));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(JSON.stringify({ error: message === 'usage' ? 'usage' : `new_run_failed:${message}` }));
    process.exitCode = 1;
  }
}
