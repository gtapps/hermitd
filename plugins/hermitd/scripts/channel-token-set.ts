import fs from 'node:fs';
import path from 'node:path';
import { hermitDir } from './lib/cc-compat';
import { readConfigRaw } from './lib/config-read';
import { channelStateDir } from './lib/channel-token';
import { writeFileAtomic } from './lib/md-write';

async function main() {
  if (!process.stdin.isTTY) return { status: 'skip', reason: 'no_tty' };
  const channel = process.argv[2];
  if (!channel || !/^[a-z][a-z0-9_]*$/.test(channel)) return { status: 'refused', reason: 'invalid_channel' };
  const dir = hermitDir();
  const state = channelStateDir(dir, channel, readConfigRaw(dir)?.channels?.[channel]);
  const wasRaw = process.stdin.isRaw;
  let token: string | null;
  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    token = await new Promise<string | null>((resolve) => {
      let input = '';
      const finish = (value: string | null) => {
        process.stdin.off('data', onData);
        process.stdin.off('end', onEnd);
        resolve(value);
      };
      const onEnd = () => finish(null);
      const onData = (chunk: Buffer) => {
        for (const char of chunk.toString()) {
          if (char === '\x03' || char === '\x04') { finish(null); return; }
          if (char === '\r' || char === '\n') { finish(input.trim()); return; }
          if (char === '\x7f' || char === '\b') input = input.slice(0, -1);
          else if (char >= ' ') input += char;
        }
      };
      process.stdin.on('data', onData);
      process.stdin.once('end', onEnd);
      process.stderr.write('Token (hidden; Ctrl-C cancels): ');
    });
  } finally {
    process.stdin.setRawMode(wasRaw);
    process.stdin.pause();
    process.stderr.write('\n');
  }
  if (!token) return { status: 'skip', reason: 'cancelled' };
  if (!/^[A-Za-z0-9_.:\-]+$/.test(token)) return { status: 'refused', reason: 'invalid_token' };
  fs.mkdirSync(state, { recursive: true });
  const file = path.join(state, '.env');
  let content = '';
  try { content = fs.readFileSync(file, 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  const key = `${channel.toUpperCase()}_BOT_TOKEN`;
  const tokenLine = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  const lines: string[] = [];
  let replaced = false;
  for (const line of content.split('\n')) {
    if (!tokenLine.test(line)) lines.push(line);
    else if (!replaced) {
      lines.push(`${key}=${token}`);
      replaced = true;
    }
  }
  const next = lines.join('\n');
  writeFileAtomic(file, replaced ? next : `${next}${next && !next.endsWith('\n') ? '\n' : ''}${key}=${token}\n`, 0o600);
  return { status: 'saved', channel };
}
if (import.meta.main) main().then(value => console.log(JSON.stringify(value))).catch(() => {
  console.log(JSON.stringify({ error: 'token_write_failed' })); process.exitCode = 1;
});
