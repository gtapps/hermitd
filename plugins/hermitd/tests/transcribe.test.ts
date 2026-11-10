import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { withDir } from './helpers/workdir';
import { debData, ensureModels, installedWhisper, installEngine, readiness, transcriptionDir, type TranscriptionPins } from '../scripts/lib/transcription';

const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
function tar(dir: string, target: string, flags: string): Uint8Array {
  const result = Bun.spawnSync(['tar', flags, target, '-C', dir, '.'], { stderr: 'pipe' });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return fs.readFileSync(target);
}
function deb(body: Uint8Array): Uint8Array {
  const header = 'data.tar.zst/'.padEnd(16) + '0'.padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6) + '100644'.padEnd(8) + String(body.length).padEnd(10) + '`\n';
  return Buffer.concat([Buffer.from('!<arch>\n' + header), body, ...(body.length % 2 ? [Buffer.from('\n')] : [])]);
}
function fixture(root: string) {
  const contents = new Map<string, Uint8Array>();
  const whisper = path.join(root, 'fixture-whisper');
  fs.mkdirSync(whisper);
  fs.writeFileSync(path.join(whisper, 'whisper-cli'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  contents.set('whisper', tar(whisper, path.join(root, 'whisper.tgz'), 'czf'));
  const lib = path.join(root, 'fixture-lib/usr/lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, 'libgomp.so.1'), 'fixture library');
  const libTar = tar(path.join(root, 'fixture-lib'), path.join(root, 'lib.tar'), 'cf');
  contents.set('libgomp', deb(Bun.zstdCompressSync(libTar)));
  const ffmpeg = path.join(root, 'fixture-ffmpeg/bin');
  fs.mkdirSync(ffmpeg, { recursive: true });
  fs.writeFileSync(path.join(ffmpeg, 'ffmpeg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  contents.set('ffmpeg', tar(path.join(root, 'fixture-ffmpeg'), path.join(root, 'ffmpeg.txz'), 'cJf'));
  const pin = (name: string) => ({ url: name, checksum: hash(contents.get(name)!) });
  const pins: TranscriptionPins = {
    version: '1.9.5', whisper: { x64: pin('whisper'), arm64: pin('whisper') },
    libgomp: { x64: pin('libgomp'), arm64: pin('libgomp') }, ffmpeg: { x64: pin('ffmpeg'), arm64: pin('ffmpeg') }, models: {},
  };
  const requests: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    requests.push(String(url));
    return new Response(contents.get(String(url))!);
  }) as unknown as typeof fetch;
  return { pins, requests, fetch: fetcher, projectRoot: root, deadline: Date.now() + 10_000, platform: 'linux' as const, arch: 'x64', musl: false };
}

describe('transcription engine', () => {
  test('checksum mismatch records private install error and never publishes', withDir(async root => {
    const options = fixture(root);
    options.pins.whisper.x64.checksum = 'bad';
    expect(await installEngine(options)).toHaveProperty('error');
    const error = path.join(transcriptionDir(root), 'install-error.json');
    expect(fs.readFileSync(error, 'utf8')).toContain('checksum_mismatch');
    expect(fs.statSync(error).mode & 0o777).toBe(0o600);
    expect(installedWhisper(root, 'linux', 'x64')).toBeNull();
  }));
  test('fixture deb supplies libgomp and PATH ffmpeg skips its download', withDir(async root => {
    const options = fixture(root);
    expect(await installEngine({ ...options, which: () => '/usr/bin/ffmpeg' })).toHaveProperty('status', 'ready');
    const installed = installedWhisper(root, 'linux', 'x64')!;
    expect(fs.readFileSync(path.join(installed.dir, 'libgomp.so.1'), 'utf8')).toBe('fixture library');
    expect(options.requests).toEqual(['whisper', 'libgomp']);
    expect(installed.ffmpeg).toBeNull();
    expect(fs.existsSync(path.join(transcriptionDir(root), 'models'))).toBe(false);
  }));
  test('bundled ffmpeg passes its executable check', withDir(async root => {
    const options = fixture(root);
    expect(await installEngine({ ...options, which: () => null })).toHaveProperty('status', 'ready');
    expect(installedWhisper(root, 'linux', 'x64')?.ffmpeg).toBeTruthy();
    expect(options.requests).toContain('ffmpeg');
  }));
  test('an install without ffmpeg is completed once PATH ffmpeg is gone', withDir(async root => {
    const options = fixture(root);
    expect(await installEngine({ ...options, which: () => '/usr/bin/ffmpeg' })).toHaveProperty('status', 'ready');
    expect(await installEngine({ ...options, which: () => null })).toHaveProperty('status', 'ready');
    expect(installedWhisper(root, 'linux', 'x64')?.ffmpeg).toBeTruthy();
  }));
  test('readiness never writes and reports default first use', withDir(root => {
    const before = fs.readdirSync(root, { recursive: true });
    expect(readiness({ projectRoot: root, platform: 'linux', arch: 'x64', musl: false, which: () => null }).status).toBe('first_use');
    expect(readiness({ projectRoot: root, enabled: false }).status).toBe('disabled');
    expect(readiness({ projectRoot: root, platform: 'darwin', which: () => null }).reason).toContain('brew install');
    expect(readiness({ projectRoot: root, platform: 'linux', musl: true, which: () => null }).status).toBe('unsupported');
    expect(fs.readdirSync(root, { recursive: true })).toEqual(before);
  }));
  test('rejects malformed deb archives', () => {
    expect(() => debData(new Uint8Array())).toThrow('invalid_deb');
  });
  test('models are published only after checksums match', withDir(async root => {
    const model = Buffer.from('model');
    const options = fixture(root);
    options.pins.models = { 'ggml-base.bin': { url: 'base', checksum: hash(model) }, 'ggml-silero-v6.2.0.bin': { url: 'silero', checksum: hash(model) } };
    let downloads = 0;
    options.fetch = (async () => { downloads++; return new Response(model); }) as unknown as typeof fetch;
    const models = await ensureModels(options);
    expect(fs.readFileSync(models.base, 'utf8')).toBe('model');
    await ensureModels(options);
    expect(downloads).toBe(2);
  }));
});

import { normalizeLanguage, transcribe } from '../scripts/transcribe';
import { logMessage, searchLog } from '../scripts/lib/channel-log';
function note(root: string, config: object = {}) {
  const dir = path.join(root, '.hermit');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ channels: { custom: { enabled: true } }, ...config }));
  const state = path.join(root, '.claude.local/channels/custom');
  fs.mkdirSync(state, { recursive: true });
  const file = path.join(state, 'note.ogg');
  fs.writeFileSync(file, 'audio');
  const argv = ['--file', file, '--channel', 'custom', '--chat', 'chat', '--message-id', 'message'];
  return { dir, file, argv };
}
const noEngine = { which: () => null, install: async () => ({ error: 'unavailable' }) };
const models = async () => ({ base: '/fixture/base', silero: '/fixture/silero' });
function localRun(text?: string) {
  return (argv: string[]) => {
    if (argv[0].includes('whisper') && text !== undefined) fs.writeFileSync(`${argv[argv.indexOf('-of') + 1]}.txt`, text);
    return { exitCode: 0, stderr: '' };
  };
}

describe('transcribe verb', () => {
  test('disabled and unreadable configs do no work', withDir(async root => {
    const n = note(root, { transcription: { enabled: false } });
    const unexpected = async () => { throw new Error('must not run'); };
    for (const unreadable of [false, true]) {
      if (unreadable) fs.writeFileSync(path.join(n.dir, 'config.json'), '{');
      expect(await transcribe(n.argv, { dir: n.dir, install: unexpected, models: unexpected, send: unexpected, fetch: unexpected as unknown as typeof fetch })).toEqual({ exitCode: 0, result: { status: 'disabled', path: n.file } });
    }
    expect(fs.existsSync(transcriptionDir(root))).toBe(false);
  }));
  test('refuses secrets, symlinks, nonregular files, disabled channels and foreign attachments', withDir(async root => {
    const n = note(root);
    const state = path.dirname(n.file);
    fs.writeFileSync(path.join(state, '.env.ogg'), 'secret');
    fs.writeFileSync(path.join(root, 'outside.ogg'), 'audio');
    fs.symlinkSync(n.file, path.join(state, 'link.ogg'));
    fs.mkdirSync(path.join(state, 'dir.ogg'));
    for (const file of [path.join(state, '.env.ogg'), path.join(state, 'link.ogg'), path.join(root, 'outside.ogg'), path.join(state, 'dir.ogg')]) {
      const out = await transcribe(['--file', file, ...n.argv.slice(2)], { dir: n.dir });
      expect(out.exitCode).toBe(1);
      expect(out.result).toHaveProperty('error');
    }
    fs.writeFileSync(path.join(n.dir, 'config.json'), JSON.stringify({ channels: { custom: { enabled: false } } }));
    expect((await transcribe(n.argv, { dir: n.dir })).exitCode).toBe(1);
  }));
  test('PATH engine wins, subprocess environment is restricted, transcript is recorded and echo off sends nothing', withDir(async root => {
    const n = note(root, { transcription: { echo: false } });
    logMessage(n.dir, { source: 'custom', chat_id: 'chat', message_id: 'message', direction: 'in', sender: 'Alice', text: '(attachment)' });
    const calls: string[][] = [];
    const out = await transcribe([...n.argv, '--language', 'pt-BR'], {
      dir: n.dir, which: name => `/path/${name}`, models,
      install: async () => { throw new Error('PATH engine should win'); },
      send: async () => { throw new Error('echo off'); },
      env: { PATH: '/path', HOME: '/home/test', LANG: 'C', GROQ_API_KEY: 'not inherited' },
      run: (argv, opts) => {
        calls.push(argv);
        expect(opts.env).toEqual({ PATH: '/path', HOME: '/home/test', LANG: 'C' });
        expect(opts.timeout).toBeLessThanOrEqual(300_000);
        return localRun('buy kumquats')(argv);
      },
    });
    expect(out.result).toEqual({ status: 'ok', transcript: 'buy kumquats', provider: 'whisper.cpp', recorded: true, echo: 'off' });
    expect(calls[0][0]).toBe('/path/ffmpeg');
    expect(calls[1][calls[1].indexOf('-l') + 1]).toBe('pt');
    expect(fs.existsSync(path.dirname(calls[0].at(-1)!))).toBe(false);
    expect(searchLog(n.dir, ['kumquats'])[0].sender).toBe('Alice');
  }));
  test('a missing output is local failure but whitespace is empty without cloud upload', withDir(async root => {
    const n = note(root);
    for (const [text, status] of [[undefined, 'unavailable'], [' \n ', 'empty']] as const) {
      const out = await transcribe(n.argv, { dir: n.dir, which: name => name, models, run: localRun(text), env: {} });
      expect(out.result).toHaveProperty('status', status);
      if (status === 'unavailable') expect(out.result).toHaveProperty('reason', 'local_transcript_missing');
    }
  }));
  test('a single expired deadline prevents local execution and cloud requests', withDir(async root => {
    const n = note(root);
    let calls = 0;
    const out = await transcribe(n.argv, { dir: n.dir, deadline: Date.now() - 1, env: { GROQ_API_KEY: 'test' }, which: name => name, models, run: () => { calls++; return { exitCode: 0, stderr: '' }; }, fetch: (async () => { calls++; return Response.json({ text: 'bad' }); }) as unknown as typeof fetch });
    expect(out.result).toHaveProperty('status', 'unavailable');
    expect(calls).toBe(0);
  }));
  test('cloud prefers Groq then OpenAI with multipart and bounded timeouts', withDir(async root => {
    const n = note(root, { transcription: { echo: false } });
    const requests: string[] = [];
    const out = await transcribe(n.argv, {
      ...noEngine, dir: n.dir, env: { GROQ_API_KEY: 'groq-test', OPENAI_API_KEY: 'openai-test' },
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push(String(url));
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(init?.body).toBeInstanceOf(FormData);
        expect((init!.body as FormData).get('model')).toBe(requests.length === 1 ? 'whisper-large-v3-turbo' : 'whisper-1');
        return requests.length === 1 ? new Response('', { status: 503 }) : Response.json({ text: 'cloud words' });
      }) as unknown as typeof fetch,
    });
    expect(requests).toEqual(['https://api.groq.com/openai/v1/audio/transcriptions', 'https://api.openai.com/v1/audio/transcriptions']);
    expect(out.result).toMatchObject({ status: 'ok', provider: 'openai', transcript: 'cloud words', echo: 'off' });
  }));
  test('audio over 25 MB is never uploaded', withDir(async root => {
    const n = note(root);
    fs.truncateSync(n.file, 25 * 1024 * 1024 + 1);
    let calls = 0;
    const out = await transcribe(n.argv, { ...noEngine, dir: n.dir, env: { GROQ_API_KEY: 'test' }, fetch: (async () => { calls++; return new Response(); }) as unknown as typeof fetch });
    expect(calls).toBe(0);
    expect(out.result).toHaveProperty('reason', 'audio_over_25mb');
  }));
  test('prepare never downloads models or sends', withDir(async root => {
    const n = note(root);
    let installs = 0;
    const out = await transcribe(['--prepare'], { dir: n.dir, which: () => null, install: async () => { installs++; return { error: 'fixture missing' }; }, models: async () => { throw new Error('models requested'); }, send: async () => { throw new Error('send requested'); } });
    expect(installs).toBe(1);
    expect(out.result).toHaveProperty('status', 'unavailable');
  }));
  for (const [error, expected] of [[undefined, 'sent'], ['no_send_path', 'unsupported'], ['missing_token', 'failed']] as const) {
    test(`echo outcome ${expected} preserves success and exact chat`, withDir(async root => {
      const n = note(root);
      const out = await transcribe(n.argv, { dir: n.dir, which: name => name, models, run: localRun('spoken text'), send: async (dir, text, options) => {
        expect(dir).toBe(n.dir);
        expect(text).toBe('🎙️ "spoken text"');
        expect(options?.target).toEqual({ id: 'custom', chat_id: 'chat' });
        expect(options?.sensitive).toBe(true);
        return error ? { ok: false, error } : { ok: true };
      } });
      expect(out.result).toMatchObject({ status: 'ok', echo: expected });
    }));
  }
  test('language normalization', () => {
    expect(normalizeLanguage('pt-BR')).toBe('pt');
    expect(normalizeLanguage('EN')).toBe('en');
    expect(normalizeLanguage('es_ES')).toBe('es');
    for (const input of [undefined, '', 'english', '--bad', 'p']) expect(normalizeLanguage(input)).toBe('en');
  });
});
