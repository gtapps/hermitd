import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appliedSet, approveProject, composeNames, contextsName } from './approval';
import { failJson, printJson } from './cli';
import { isContainer } from './container';

/** Select the stack in precedence order; operator overrides win. */
export function composeFiles(projectRoot: string, set = isContainer() ? undefined : appliedSet(projectRoot)): string[] {
  const source = set ?? projectRoot;
  const [base, ...overlays] = composeNames;
  const optional = overlays.map(file => path.join(source, file)).filter(full => fs.existsSync(full));
  const files = [path.join(source, base), ...optional];
  if (set) files.push(path.join(set, contextsName));
  const args = files.flatMap(full => ['-f', full]);
  return set ? ['--project-directory', projectRoot, '--env-file', path.join(set, '.env'), ...args] : args;
}

if (import.meta.main) {
  const [project, pinned, ...args] = process.argv.slice(2);
  const container = isContainer();
  if (args[0] === '--approve') {
    if (container) {
      printJson({ error: 'host_only' });
      process.exitCode = 1;
    } else {
      try {
        const result = await approveProject(project);
        if (result.applied) fs.writeSync(3, result.applied);
        process.exitCode = result.code;
      } catch (error) { failJson(error, 'approval_failed'); }
    }
  } else {
    const set = container ? undefined : pinned || appliedSet(project);
    if (args[0] === '--find-set') {
      if (set) console.log(set);
      process.exit(0);
    }
    const config = JSON.parse(fs.readFileSync(path.join(set ?? project, '.hermit/config.json'), 'utf8'));
    const result = spawnSync('docker', ['compose', ...composeFiles(project, set), ...args], {
      cwd: project,
      stdio: 'inherit',
      env: {
        ...process.env,
        HERMIT_BROWSER: config.browser?.enabled === false ? '0' : '1',
        HERMIT_TRANSCRIPTION: config.transcription?.enabled === false ? '0' : '1',
      },
    });
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status ?? 1;
  }
}
