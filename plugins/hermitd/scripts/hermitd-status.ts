import path from 'node:path';
import { projectStatus, renderStatus } from './lib/hermit-status';
import { resolveProjection } from './lib/cc-compat';
try {
  // A projected .hermit/ reports on the real root above it.
  const project = path.dirname(resolveProjection(path.resolve('.hermit')));
  console.log(renderStatus([projectStatus(project)], process.argv.includes('--json')));
} catch (error) {
  console.error(`[hermit] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
