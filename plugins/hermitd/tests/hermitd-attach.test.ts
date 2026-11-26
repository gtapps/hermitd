import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, runBash } from './helpers/run';
import { setupWorkdir, hermit, write } from './helpers/workdir';

describe('hermitd-attach host tmux', () => {
  test('attaches with forced UTF-8 output', async () => {
    const wd = setupWorkdir();
    try {
      const proj = wd.dir;
      const dest = hermit(proj, 'bin', 'hermitd-attach');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(PLUGIN_ROOT, 'state-templates', 'bin', 'hermitd-attach'), dest);
      fs.chmodSync(dest, 0o755);
      write(hermit(proj, 'state', 'runtime.json'), JSON.stringify({ runtime_mode: 'tmux', tmux_session: 'hermit-demo' }));

      const stubDir = path.join(proj, '.stub');
      const callsFile = path.join(stubDir, 'tmux-calls.txt');
      fs.mkdirSync(stubDir, { recursive: true });
      write(path.join(stubDir, 'tmux'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${callsFile}"\nexit 0\n`);
      fs.chmodSync(path.join(stubDir, 'tmux'), 0o755);

      const r = await runBash(dest, { cwd: proj, env: { PATH: `${stubDir}:${process.env.PATH}` } });
      expect(r.exitCode).toBe(0);
      expect(fs.readFileSync(callsFile, 'utf8').split('\n')).toContain('-u attach -t hermit-demo');
    } finally {
      wd.cleanup();
    }
  });
});
