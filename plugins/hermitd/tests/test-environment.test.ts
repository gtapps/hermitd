import { expect, test } from 'bun:test';
import path from 'node:path';

for (const channel of ['discord', 'telegram']) {
  test(`test preload isolates inherited ${channel} state while allowing fixture overrides`, async () => {
    const preload = path.resolve(import.meta.dir, 'helpers/preload.ts');
    const token = path.resolve(import.meta.dir, '../scripts/lib/channel-token.ts');
    const key = `${channel.toUpperCase()}_STATE_DIR`;
    const proc = Bun.spawn([process.execPath, '-e', `
      await import(${JSON.stringify(preload)});
      const { channelStateDir } = await import(${JSON.stringify(token)});
      const configured = channelStateDir('/fixture/.hermit', '${channel}', { state_dir: '/fixture/configured' });
      process.env['${key}'] = '/fixture/explicit';
      const explicit = channelStateDir('/fixture/.hermit', '${channel}', { state_dir: '/fixture/configured' });
      console.log(JSON.stringify({ configured, explicit }));
    `], {
      cwd: '/tmp',
      env: { ...process.env, [key]: '/ambient/operator-state' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({ configured: '/fixture/configured', explicit: '/fixture/explicit' });
  });
}
