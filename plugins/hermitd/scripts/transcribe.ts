#!/usr/bin/env bun
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hermitDir } from './lib/cc-compat';
import { readConfigRaw, readSettledConfig } from './lib/config-read';
import { getEnabledChannels } from './lib/channel-config';
import { channelStateDir } from './lib/channel-token';
import { enrichInbound } from './lib/channel-log';
import { sendToChannel } from './lib/channel-send';
import { loadMessages } from './lib/messages';
import { ensureModels, installedWhisper, installEngine, remaining, type EngineOptions } from './lib/transcription';

export function normalizeLanguage(value?: string): string {
  return value?.match(/^([a-z]{2})(?:[-_][a-z]{2})?$/i)?.[1].toLowerCase() ?? 'en';
}
interface Options {
  dir?: string;
  deadline?: number;
  which?: (name: string) => string | null;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  run?: (argv: string[], options: { env: Record<string, string>; timeout: number }) => { exitCode: number; stderr: string };
  install?: typeof installEngine;
  models?: typeof ensureModels;
  send?: typeof sendToChannel;
}
type Result = { status: 'disabled' | 'empty'; path: string }
  | { status: 'unavailable'; reason: string; path: string }
  | { status: 'ok'; transcript: string; provider: string; recorded: boolean; echo: 'sent' | 'off' | 'failed' | 'unsupported' }
  | { status: 'ready' | 'disabled' }
  | { error: string };
function parse(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === '--prepare') { args.prepare = true; continue; }
    if (!['--file', '--channel', '--chat', '--message-id', '--language'].includes(name) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('invalid_arguments');
    if (name in args) throw new Error('duplicate_argument');
    args[name] = argv[++i];
  }
  return args;
}
function trustedFile(dir: string, config: any, file: string, channel: string, unreadable: boolean): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(channel) || (!unreadable && !getEnabledChannels(config).includes(channel))) throw new Error('channel_not_enabled');
  const name = path.basename(file).toLowerCase();
  if (name.startsWith('.env') || /\.(pem|key)$/.test(name)) throw new Error('forbidden_attachment_name');
  if (!/\.(ogg|oga|opus|mp3|m4a|mp4|mpeg|mpga|wav|webm|aac|flac|caf)$/i.test(name)) throw new Error('unsupported_audio_extension');
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('attachment_not_regular_file');
  const root = fs.realpathSync(channelStateDir(dir, channel, config.channels[channel]));
  const real = fs.realpathSync(file);
  const rel = path.relative(root, real);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('attachment_outside_channel_state');
  return real;
}
export async function transcribe(argv: string[], options: Options = {}): Promise<{ result: Result; exitCode: number }> {
  const dir = options.dir ?? hermitDir();
  const deadline = options.deadline ?? Date.now() + 540_000;
  const raw = readConfigRaw(dir);
  const config = readSettledConfig(dir);
  let args: Record<string, string | boolean>;
  let file = '';
  let channel = '';
  let chat = '';
  let messageId = '';
  try {
    args = parse(argv);
    if (!args.prepare) {
      if (!['--file', '--channel', '--chat', '--message-id'].every(key => typeof args[key] === 'string')) throw new Error('missing_arguments');
      channel = args['--channel'] as string;
      chat = args['--chat'] as string;
      messageId = args['--message-id'] as string;
      file = trustedFile(dir, config, args['--file'] as string, channel, raw === null);
    }
  } catch (error) { return { result: { error: error instanceof Error ? error.message : String(error) }, exitCode: 1 }; }
  const finish = (result: Result) => ({ result, exitCode: 0 });
  if (raw === null || config.transcription.enabled === false) return finish(args.prepare ? { status: 'disabled' } : { status: 'disabled', path: file });
  const which = options.which ?? (name => Bun.which(name));
  const engineOptions: EngineOptions = { projectRoot: path.dirname(dir), deadline, which, fetch: options.fetch };
  const env = options.env ?? process.env;
  const childEnv = Object.fromEntries(['PATH', 'HOME', 'LANG'].flatMap(key => env[key] === undefined ? [] : [[key, env[key]!]]));
  const run = (command: string[]) => {
    const timeout = remaining(deadline);
    if (options.run) return options.run(command, { env: childEnv, timeout });
    const child = Bun.spawnSync(command, { env: childEnv, timeout, killSignal: 'SIGKILL', stdout: 'pipe', stderr: 'pipe' });
    return { exitCode: child.exitCode, stderr: child.stderr.toString() };
  };
  let localReason = 'local_engine_unavailable';
  let transcript: string | undefined;
  let provider = 'whisper.cpp';
  let temp: string | undefined;
  try {
    remaining(deadline);
    let binary = which('whisper-cli');
    let ffmpeg = which('ffmpeg');
    if (!binary || !ffmpeg) {
      let installed = installedWhisper(path.dirname(dir));
      if (!installed || (!ffmpeg && !installed.ffmpeg)) {
        const result = await (options.install ?? installEngine)(engineOptions);
        if ('error' in result) localReason = result.error;
        installed = installedWhisper(path.dirname(dir));
      }
      binary = installed?.binary ?? null;
      ffmpeg = ffmpeg ?? installed?.ffmpeg ?? null;
    }
    if (args.prepare) return finish(binary && ffmpeg ? { status: 'ready' } : { status: 'unavailable', reason: localReason, path: '' });
    if (binary && ffmpeg) {
      const models = await (options.models ?? ensureModels)(engineOptions);
      temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-transcribe-'));
      const wav = path.join(temp, 'note.wav');
      const output = path.join(temp, 'transcript');
      const converted = run([ffmpeg, '-nostdin', '-loglevel', 'error', '-y', '-i', file, '-ar', '16000', '-ac', '1', wav]);
      if (converted.exitCode !== 0) throw new Error(`ffmpeg_failed:${converted.stderr}`);
      const recognized = run([binary, '-m', models.base, '-f', wav, '-l', normalizeLanguage(args['--language'] as string | undefined), '-t', '4', '-bs', '5', '-bo', '5', '-ng', '-nt', '-otxt', '-of', output, '--vad', '-vm', models.silero, '-vsd', '500']);
      remaining(deadline);
      if (recognized.exitCode !== 0) throw new Error(`whisper_failed:${recognized.stderr}`);
      if (!fs.existsSync(`${output}.txt`)) throw new Error('local_transcript_missing');
      transcript = fs.readFileSync(`${output}.txt`, 'utf8').trim();
    }
  } catch (error) {
    localReason = error instanceof Error ? error.message : String(error);
    if (args.prepare) return finish({ status: 'unavailable', reason: localReason, path: '' });
  } finally { if (temp) fs.rmSync(temp, { recursive: true }); }
  if (transcript === undefined) {
    try {
      if (fs.statSync(file).size > 25 * 1024 * 1024) throw new Error('audio_over_25mb');
      for (const [key, name, base, model] of [
        ['GROQ_API_KEY', 'groq', 'https://api.groq.com/openai/v1', 'whisper-large-v3-turbo'],
        ['OPENAI_API_KEY', 'openai', 'https://api.openai.com/v1', 'whisper-1'],
      ]) {
        if (!env[key]) continue;
        try {
          const body = new FormData();
          body.set('file', Bun.file(file), path.basename(file));
          body.set('model', model);
          body.set('language', normalizeLanguage(args['--language'] as string | undefined));
          const response = await (options.fetch ?? fetch)(`${base}/audio/transcriptions`, {
            method: 'POST', headers: { Authorization: `Bearer ${env[key]}` }, body,
            signal: AbortSignal.timeout(remaining(deadline, 60_000)),
          });
          if (!response.ok) throw new Error(`${name}_http_${response.status}`);
          const data = await response.json() as { text?: unknown };
          remaining(deadline);
          if (typeof data.text !== 'string') throw new Error(`${name}_transcript_missing`);
          transcript = data.text.trim(); provider = name; break;
        } catch (error) { localReason = error instanceof Error ? error.message : String(error); }
      }
    } catch (error) { localReason = error instanceof Error ? error.message : String(error); }
  }
  if (transcript === undefined) return finish({ status: 'unavailable', reason: localReason, path: file });
  if (!transcript) return finish({ status: 'empty', path: file });
  const recorded = enrichInbound(dir, { source: channel, chat_id: chat, message_id: messageId, transcript }).ok;
  let echo: 'sent' | 'off' | 'failed' | 'unsupported' = 'off';
  if (config.transcription.echo !== false) {
    try {
      const result = await (options.send ?? sendToChannel)(dir, loadMessages(dir, config.language).t('transcript_echo', { text: transcript }), {
        target: { id: channel, chat_id: chat }, sensitive: true, timeoutMs: remaining(deadline, 10_000),
      });
      if (result.ok) echo = 'sent';
      else if (['unsupported_platform', 'no_send_path'].includes(result.error ?? '')) echo = 'unsupported';
      else echo = 'failed';
    } catch { echo = 'failed'; }
  }
  return finish({ status: 'ok', transcript, provider, recorded, echo });
}
if (import.meta.main) {
  try {
    const { result, exitCode } = await transcribe(process.argv.slice(2));
    console.log(JSON.stringify(result));
    process.exitCode = exitCode;
  } catch (error) {
    console.log(JSON.stringify({ status: 'unavailable', reason: error instanceof Error ? error.message : String(error), path: '' }));
  }
}
