#!/usr/bin/env bun
import { readFileSync, rmSync } from 'node:fs';
import { isAbsolute } from 'node:path';

function main(args: string[]): void {
  if (args.length === 2 && args[0] === 'new-run' && isAbsolute(args[1])) {
    // A prior payload too large to Read cannot be overwritten by the fetcher's Write.
    rmSync(args[1], { force: true });
    console.log(crypto.randomUUID());
    return;
  }

  const [command, path, runId] = args;
  if (args.length !== 3 || command !== 'verify' || !path || !isAbsolute(path) || !runId?.trim()) {
    throw new Error('Usage: source-fetch-result.ts new-run <absolute-output-path> | verify <absolute-output-path> <expected-run-id>');
  }

  const result: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof result !== 'object' || result === null || Array.isArray(result)
    || !('run_id' in result) || result.run_id !== runId
    || !('sources' in result) || !Array.isArray(result.sources)) {
    throw new Error('Expected current-run source output with matching run_id and a sources array.');
  }
  console.log(JSON.stringify(result));
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`Source fetch verification failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
