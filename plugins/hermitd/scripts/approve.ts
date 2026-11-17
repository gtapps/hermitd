#!/usr/bin/env bun
import { approveProject } from './lib/approval';
import { isContainer } from './lib/container';
import { failJson, printJson } from './lib/cli';

if (import.meta.main) {
  try {
    if (isContainer()) {
      printJson({ error: 'host_only' });
      process.exitCode = 1;
    } else {
      const [project, ...extra] = process.argv.slice(2);
      if (!project || extra.length) throw new Error('usage');
      process.exitCode = (await approveProject(project)).code;
    }
  } catch (error) { failJson(error, 'approval_failed'); }
}
