import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { freshDirFactory } from './helpers/workdir';
import { runScript, SCRIPTS_DIR } from './helpers/run';
const { freshDir, cleanup } = freshDirFactory('token-set-');
afterAll(cleanup);
test('non-TTY writes nothing', async () => {
  const dir = freshDir();
  const r = await runScript('channel-token-set.ts', { args: ['telegram'], env: { AGENT_DIR: dir } });
  expect(r.exitCode).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ status: 'skip', reason: 'no_tty' });
  expect(fs.readdirSync(dir)).toEqual([]);
});
for (const cancel of [false, true]) test(`PTY hidden entry, cancellation=${cancel}`, async () => {
  const dir = freshDir();
  const state = path.join(dir, 'channel'); fs.mkdirSync(state);
  const file = path.join(state, '.env');
  const original = '# keep\nOTHER=keep\nexport TELEGRAM_BOT_TOKEN=old\nTAIL=yes\n';
  fs.writeFileSync(file, original);
  const code = `import os, pty, select, subprocess, sys, termios\nmaster, slave = pty.openpty()\nbefore = termios.tcgetattr(slave)\np = subprocess.Popen([sys.argv[1], sys.argv[2], 'telegram'], stdin=slave, stdout=slave, stderr=slave)\nout = b''\nwhile b'cancels): ' not in out:\n if not select.select([master], [], [], 5)[0]: raise RuntimeError('prompt timeout')\n out += os.read(master, 4096)\nos.write(master, ${cancel ? "b'\\x03'" : "b'private-token\\r'"})\np.wait(timeout=5)\nwhile select.select([master], [], [], 0.1)[0]:\n out += os.read(master, 4096)\nassert termios.tcgetattr(slave) == before, 'terminal not restored'\nprint(out.decode())\nos.close(master)\nos.close(slave)\nsys.exit(p.returncode)\n`;
  const p = Bun.spawn(['python3', '-c', code, process.execPath, path.join(SCRIPTS_DIR, 'channel-token-set.ts')], { env: { ...process.env, AGENT_DIR: dir, TELEGRAM_STATE_DIR: state }, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect(err).toBe(''); expect(exit).toBe(0);
  expect(out).not.toContain('private-token');
  expect(fs.readFileSync(file, 'utf8')).toBe(cancel ? original : original.replace('export TELEGRAM_BOT_TOKEN=old', 'TELEGRAM_BOT_TOKEN=private-token'));
  if (!cancel) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});
