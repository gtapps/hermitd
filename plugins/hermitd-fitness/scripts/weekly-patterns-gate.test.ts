import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeReporter } from '../../../tests/lib/skill-lint';

const { ok, summary } = makeReporter();
const gate = path.resolve(import.meta.dir, '../state-templates/bin/fitness-weekly-patterns-gate');
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'fitness-gate-'));
const hermitDir = path.join(project, '.hermit');
fs.mkdirSync(path.join(hermitDir, 'bin'), { recursive: true });
const shim = path.join(hermitDir, 'bin/hermitd-run');

try {
  for (const [output, code, expected] of [
    ['{"trend":"upward"}', 0, 'WAKE'],
    ['{"trend":"none"}', 0, 'SKIP'],
    ['{"trend":"insufficient-data"}', 0, 'SKIP'],
    ['garbage', 0, null],
    ['{"trend":"unknown"}', 0, null],
    ['{"trend":"none"}', 2, null],
  ] as const) {
    fs.writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "$HERMIT_DIR/args.txt"\nprintf '%s\\n' '${output}'\nexit ${code}\n`, { mode: 0o755 });
    const child = Bun.spawn([gate], {
      cwd: project,
      env: { ...process.env, HERMIT_DIR: hermitDir },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, , exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    ok(`${output} exit ${code}`, expected === null ? exitCode !== 0 && stdout === '' : exitCode === 0 && stdout === `${expected}\n`);
  }
  ok('sibling command receives the consumer root', fs.readFileSync(path.join(hermitDir, 'args.txt'), 'utf-8') === [
    'sibling-run', 'hermitd-fitness', 'scripts/fitness-lab.ts', 'weekly-patterns', '--project-root', project, '',
  ].join('\n'));
} finally {
  fs.rmSync(project, { recursive: true, force: true });
}
process.exit(summary() === 0 ? 0 : 1);
