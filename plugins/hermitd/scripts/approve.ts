#!/usr/bin/env bun
// Usage: bun approve.ts <project>
//        bun approve.ts note unannounced <project>             prints the pending candidate whose notice has not reached chat
//        bun approve.ts note notified <project> <candidate>    the notice for that candidate was delivered
//        bun approve.ts note deployed <project> <set-path>     that approved set is now running
import path from 'node:path';
import { approveProject, markApprovalNote, unannouncedCandidate } from './lib/approval';
import { isContainer } from './lib/container';
import { failJson, printJson } from './lib/cli';

if (import.meta.main) {
  try {
    if (isContainer()) {
      printJson({ error: 'host_only' });
      process.exitCode = 1;
    } else if (process.argv[2] === 'note') {
      const [mark, project, value, ...extra] = process.argv.slice(3);
      if (!project || extra.length) throw new Error('usage');
      if (mark === 'unannounced' && value === undefined) {
        const candidate = unannouncedCandidate(project);
        if (candidate) console.log(candidate);
      } else if ((mark === 'notified' || mark === 'deployed') && value) {
        markApprovalNote(project, mark, mark === 'deployed' ? path.basename(value) : value);
      } else throw new Error('usage');
    } else {
      const [project, ...extra] = process.argv.slice(2);
      if (!project || extra.length) throw new Error('usage');
      process.exitCode = (await approveProject(project)).code;
    }
  } catch (error) { failJson(error, 'approval_failed'); }
}
