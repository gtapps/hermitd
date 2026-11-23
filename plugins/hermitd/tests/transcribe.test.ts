import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixturesDir, withDir } from './helpers/workdir';
import { ensureModels, installedEngine, installEngine, readiness, transcriptionDir, type TranscriptionPins } from '../scripts/lib/transcription';

const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
function tar(dir: string, target: string, flags: string): Uint8Array {
  const result = Bun.spawnSync(['tar', flags, target, '-C', dir, '.'], { stderr: 'pipe' });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return fs.readFileSync(target);
}
function fixture(root: string) {
  const contents = new Map<string, Uint8Array>();
  const engine = path.join(root, 'fixture-engine');
  fs.mkdirSync(path.join(engine, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(engine, 'lib'));
  fs.writeFileSync(path.join(engine, 'bin/nemo-speech'), '#!/bin/sh\n[ "$1" = "--version" ] && test -f "$(dirname "$0")/../lib/fixture"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(engine, 'lib/fixture'), 'fixture library');
  contents.set('engine', tar(engine, path.join(root, 'engine.tgz'), 'czf'));
  const ffmpeg = path.join(root, 'fixture-ffmpeg/bin');
  fs.mkdirSync(ffmpeg, { recursive: true });
  fs.writeFileSync(path.join(ffmpeg, 'ffmpeg'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  contents.set('ffmpeg', tar(path.join(root, 'fixture-ffmpeg'), path.join(root, 'ffmpeg.txz'), 'cJf'));
  const pin = (name: string) => ({ url: name, checksum: hash(contents.get(name)!) });
  const pins: TranscriptionPins = {
    version: '0.3.0',
    engine: { 'linux-x64': pin('engine'), 'linux-arm64': pin('engine'), 'darwin-arm64': pin('engine') },
    ffmpeg: { x64: pin('ffmpeg'), arm64: pin('ffmpeg') },
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
    options.pins.engine['linux-x64'].checksum = 'bad';
    expect(await installEngine(options)).toHaveProperty('error');
    const error = path.join(transcriptionDir(root), 'install-error.json');
    expect(fs.readFileSync(error, 'utf8')).toContain('checksum_mismatch');
    expect(fs.statSync(error).mode & 0o777).toBe(0o600);
    expect(installedEngine(root, 'linux', 'x64')).toBeNull();
  }));
  test('engine keeps its bundled libraries and PATH ffmpeg skips its download', withDir(async root => {
    const options = fixture(root);
    expect(await installEngine({ ...options, which: () => '/usr/bin/ffmpeg' })).toHaveProperty('status', 'ready');
    const installed = installedEngine(root, 'linux', 'x64')!;
    expect(fs.readFileSync(path.join(installed.dir, 'lib/fixture'), 'utf8')).toBe('fixture library');
    expect(options.requests).toEqual(['engine']);
    expect(installed.ffmpeg).toBeNull();
    expect(fs.existsSync(path.join(transcriptionDir(root), 'models'))).toBe(false);
  }));
  test('bundled ffmpeg passes its executable check', withDir(async root => {
    const options = fixture(root);
    expect(await installEngine({ ...options, which: () => null })).toHaveProperty('status', 'ready');
    expect(installedEngine(root, 'linux', 'x64')?.ffmpeg).toBeTruthy();
    expect(options.requests).toContain('ffmpeg');
  }));
  test('an install without ffmpeg is completed once PATH ffmpeg is gone', withDir(async root => {
    const options = fixture(root);
    expect(await installEngine({ ...options, which: () => '/usr/bin/ffmpeg' })).toHaveProperty('status', 'ready');
    expect(await installEngine({ ...options, which: () => null })).toHaveProperty('status', 'ready');
    expect(installedEngine(root, 'linux', 'x64')?.ffmpeg).toBeTruthy();
  }));
  test('readiness never writes and reports default first use', withDir(root => {
    const before = fs.readdirSync(root, { recursive: true });
    expect(readiness({ projectRoot: root, platform: 'linux', arch: 'x64', musl: false, which: () => null }).status).toBe('first_use');
    expect(readiness({ projectRoot: root, enabled: false }).status).toBe('disabled');
    expect(readiness({ projectRoot: root, platform: 'darwin', arch: 'arm64', which: () => null }).reason).toContain('brew install ffmpeg');
    expect(readiness({ projectRoot: root, platform: 'linux', musl: true, which: () => null }).status).toBe('unsupported');
    expect(fs.readdirSync(root, { recursive: true })).toEqual(before);
  }));
  test('container readiness follows the image and ignores an old install error', withDir(async root => {
    fs.mkdirSync(transcriptionDir(root), { recursive: true });
    fs.writeFileSync(path.join(transcriptionDir(root), 'install-error.json'), JSON.stringify({ error: 'tar: xz: Cannot exec' }));
    const docker = { projectRoot: root, enabled: true, platform: 'linux' as const, arch: 'x64', musl: false, docker: true };
    expect(readiness({ ...docker, which: () => null })).toEqual({ status: 'unavailable', reason: 'Voice notes unavailable: image has no ffmpeg' });
    expect(readiness({ ...docker, which: name => name === 'ffmpeg' ? '/usr/bin/ffmpeg' : null }).status).toBe('first_use');
    expect(readiness({ ...docker, which: name => `/usr/bin/${name}` }).status).toBe('ready');
    expect(readiness({ ...docker, docker: false, which: () => null }).status).toBe('failed');
    expect(await installEngine({ ...fixture(root), which: () => null })).toHaveProperty('status', 'ready');
    expect(readiness({ ...docker, which: () => null }).status).toBe('ready');
  }));
  test('Apple Silicon installs without downloading ffmpeg, including when reported as musl', withDir(async root => {
    const options = { ...fixture(root), platform: 'darwin' as const, musl: true, which: () => null };
    expect(await installEngine({ ...options, arch: 'x64' })).toHaveProperty('error', expect.stringContaining('unsupported_platform'));
    expect(await installEngine({ ...options, arch: 'arm64' })).toHaveProperty('status', 'ready');
    expect(installedEngine(root, 'darwin', 'arm64')?.ffmpeg).toBeNull();
    expect(options.requests).toEqual(['engine']);
  }));
  test('model pull invokes the engine and reports its failure', () => {
    expect(() => ensureModels('/path/nemo-speech', argv => {
      expect(argv).toEqual(['/path/nemo-speech', 'pull', 'nemotron-3.5']);
      return { exitCode: 1, stderr: 'download failed' };
    })).toThrow('model_pull_failed:download failed');
  });
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
const noEngine = { which: () => null, container: false, install: async () => ({ error: 'unavailable' }) };
const models = () => {};
function localRun(text: string) {
  return (argv: string[]) => ({ exitCode: 0, stdout: argv[1] === '--quiet' ? text : '', stderr: '' });
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
        expect(opts.env).toEqual({ PATH: '/path', HOME: '/home/test', LANG: 'C', NEMO_SPEECH_MODEL_DIR: path.join(transcriptionDir(root), 'models') });
        expect(opts.timeout).toBeLessThanOrEqual(300_000);
        return localRun('buy kumquats')(argv);
      },
    });
    expect(out.result).toEqual({ status: 'ok', transcript: 'buy kumquats', provider: 'nemo-speech', recorded: true, echo: 'off' });
    expect(calls[0][0]).toBe('/path/ffmpeg');
    expect(calls[1]).toEqual([
      '/path/nemo-speech', '--quiet', 'transcribe', calls[0].at(-1)!, '--model', 'nemotron-3.5',
      '--language', 'auto', '--device', 'cpu', '--asr.backend.threads', String(os.availableParallelism()), '--no-warmup',
    ]);
    expect(fs.existsSync(path.dirname(calls[0].at(-1)!))).toBe(false);
    expect(searchLog(n.dir, ['kumquats'])[0].sender).toBe('Alice');
  }));
  test('whitespace is empty without cloud upload', withDir(async root => {
    const n = note(root);
    const fetcher = new Proxy(fetch, { apply: () => { throw new Error('cloud upload requested'); } });
    const out = await transcribe(n.argv, {
      dir: n.dir, which: name => name, models, run: localRun(' \n '), env: { GROQ_API_KEY: 'test' }, fetch: fetcher,
    });
    expect(out.result).toHaveProperty('status', 'empty');
  }));
  test('a single expired deadline prevents local execution and cloud requests', withDir(async root => {
    const n = note(root);
    let calls = 0;
    const out = await transcribe(n.argv, { dir: n.dir, deadline: Date.now() - 1, env: { GROQ_API_KEY: 'test' }, which: name => name, models, run: () => { calls++; return { exitCode: 0, stdout: '', stderr: '' }; }, fetch: (async () => { calls++; return Response.json({ text: 'bad' }); }) as unknown as typeof fetch });
    expect(out.result).toHaveProperty('status', 'unavailable');
    expect(calls).toBe(0);
  }));
  for (const [language, code] of [[undefined, null], ['pt-PT', 'pt']] as const) {
    test(`cloud prefers Groq then OpenAI with language ${language ?? 'unset'}`, withDir(async root => {
      const n = note(root, { language, transcription: { echo: false } });
      const requests: string[] = [];
      const out = await transcribe(n.argv, {
        ...noEngine, dir: n.dir, env: { GROQ_API_KEY: 'groq-test', OPENAI_API_KEY: 'openai-test' },
        fetch: (async (url: string | URL | Request, init?: RequestInit) => {
          requests.push(String(url));
          expect(init?.signal).toBeInstanceOf(AbortSignal);
          expect(init?.body).toBeInstanceOf(FormData);
          const body = init!.body as FormData;
          expect(body.get('model')).toBe(requests.length === 1 ? 'whisper-large-v3-turbo' : 'gpt-transcribe');
          expect(body.get('language')).toBe(requests.length === 1 ? code : null);
          expect(body.get('languages[]')).toBe(requests.length === 1 ? null : code);
          return requests.length === 1 ? new Response('', { status: 503 }) : Response.json({ text: 'cloud words' });
        }) as unknown as typeof fetch,
      });
      expect(requests).toEqual(['https://api.groq.com/openai/v1/audio/transcriptions', 'https://api.openai.com/v1/audio/transcriptions']);
      expect(out.result).toMatchObject({ status: 'ok', provider: 'openai', transcript: 'cloud words', echo: 'off' });
    }));
  }
  for (const [extension, ffmpeg, upload] of [
    ['caf', true, 'note.wav'], ['caf', false, 'note.caf'], ['oga', true, 'note.oga'],
  ] as const) {
    test(`cloud uploads ${upload} for ${extension} with ffmpeg ${ffmpeg}`, withDir(async root => {
      const n = note(root, { transcription: { echo: false } });
      const file = n.file.replace(/\.ogg$/, `.${extension}`);
      fs.renameSync(n.file, file);
      let wav: string | undefined;
      const out = await transcribe(['--file', file, ...n.argv.slice(2)], {
        ...noEngine, dir: n.dir, env: { GROQ_API_KEY: 'test' },
        which: name => name === 'ffmpeg' && ffmpeg ? name : null,
        run: argv => {
          expect(argv[0]).toBe('ffmpeg');
          wav = argv.at(-1)!;
          fs.writeFileSync(wav, 'converted audio');
          return { exitCode: 0, stdout: '', stderr: '' };
        },
        fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
          const multipart = await new Response(init!.body).formData();
          const attachment = multipart.get('file') as File;
          expect(attachment.name).toBe(upload);
          expect(await attachment.text()).toBe(upload.endsWith('.wav') ? 'converted audio' : 'audio');
          return Response.json({ text: 'cloud words' });
        }) as unknown as typeof fetch,
      });
      expect(out.result).toMatchObject({ status: 'ok', provider: 'groq' });
      if (upload.endsWith('.wav')) {
        expect(wav).toBeDefined();
        expect(fs.existsSync(wav!)).toBe(false);
      } else expect(wav).toBeUndefined();
    }));
  }
  test('audio over 25 MB is never uploaded', withDir(async root => {
    const n = note(root);
    fs.truncateSync(n.file, 25 * 1024 * 1024 + 1);
    let calls = 0;
    const out = await transcribe(n.argv, { ...noEngine, dir: n.dir, env: { GROQ_API_KEY: 'test' }, fetch: (async () => { calls++; return new Response(); }) as unknown as typeof fetch });
    expect(calls).toBe(0);
    expect(out.result).toHaveProperty('reason', 'audio_over_25mb');
  }));
  test('prepare installs a missing engine, pulls the model and never sends', withDir(async root => {
    const n = note(root);
    const dir = path.join(transcriptionDir(root), `${process.platform}-${process.arch}`, '0.3.0');
    const binary = path.join(dir, 'bin', 'nemo-speech');
    const calls: string[] = [];
    let pullExit = 0;
    const out = (argv: string[]) => transcribe(argv, {
      dir: n.dir, container: false, which: name => name === 'ffmpeg' ? name : null,
      install: async () => {
        calls.push('install');
        fs.mkdirSync(path.dirname(binary), { recursive: true });
        fs.writeFileSync(binary, '', { mode: 0o700 });
        fs.writeFileSync(path.join(dir, 'complete.json'), JSON.stringify({ version: '0.3.0', binary: 'nemo-speech', ffmpeg: null }));
        return { status: 'ready', dir };
      },
      run: (argv, options) => {
        calls.push('pull');
        expect(argv).toEqual([binary, 'pull', 'nemotron-3.5']);
        expect(options.env.NEMO_SPEECH_MODEL_DIR).toBe(path.join(transcriptionDir(root), 'models'));
        return { exitCode: pullExit, stdout: '', stderr: 'fixture pull failed' };
      },
      send: async () => { calls.push('send'); return { ok: true }; },
    });
    expect((await out(['--prepare'])).result).toEqual({ status: 'ready' });
    expect(calls).toEqual(['install', 'pull']);
    pullExit = 1;
    expect((await out(['--prepare'])).result).toMatchObject({ status: 'unavailable', reason: 'model_pull_failed:fixture pull failed' });
    expect(calls).toEqual(['install', 'pull', 'pull']);
  }));
  test('a failed model pull falls back to cloud', withDir(async root => {
    const n = note(root, { transcription: { echo: false } });
    const out = await transcribe(n.argv, {
      dir: n.dir, which: name => name, env: { GROQ_API_KEY: 'test' },
      run: argv => {
        expect(argv).toEqual(['nemo-speech', 'pull', 'nemotron-3.5']);
        return { exitCode: 1, stdout: '', stderr: 'fixture pull failed' };
      },
      fetch: (async () => Response.json({ text: 'cloud words' })) as unknown as typeof fetch,
    });
    expect(out.result).toMatchObject({ status: 'ok', provider: 'groq', transcript: 'cloud words' });
  }));
  test('a container without ffmpeg never installs and reports the image', withDir(async root => {
    const n = note(root, { transcription: { echo: false } });
    const unexpected = async () => { throw new Error('install requested'); };
    for (const argv of [['--prepare'], n.argv]) {
      const out = await transcribe(argv, { dir: n.dir, container: true, env: {}, which: () => null, install: unexpected, models: unexpected });
      expect(out.result).toMatchObject({ status: 'unavailable', reason: 'image_has_no_ffmpeg' });
    }
    let installs = 0;
    await transcribe(['--prepare'], { dir: n.dir, container: true, which: name => name === 'ffmpeg' ? '/usr/bin/ffmpeg' : null, install: async () => { installs++; return { error: 'fixture missing' }; } });
    expect(installs).toBe(1);
    if (process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch)) {
      expect(await installEngine({ ...fixture(root), arch: process.arch, which: () => null })).toHaveProperty('status', 'ready');
      const out = await transcribe(['--prepare'], { dir: n.dir, container: true, which: () => null, install: unexpected, models });
      expect(out.result).toEqual({ status: 'ready' });
    }
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
    for (const input of [undefined, '', 'english', '--bad', 'p']) expect(normalizeLanguage(input)).toBeUndefined();
  });
});

test.skipIf(process.env.HERMIT_LIVE_TRANSCRIBE !== '1')('live voice engine prepares, transcribes speech and leaves silence empty', withDir(async root => {
  const n = note(root, { transcription: { echo: false } });
  const cli = path.join(import.meta.dir, '../scripts/transcribe.ts');
  const invoke = async (argv: string[]) => {
    const child = Bun.spawn([process.execPath, cli, ...argv], {
      cwd: root,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG, AGENT_DIR: n.dir },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);
    if (exitCode !== 0) throw new Error(`transcribe exited ${exitCode}: ${stdout}${stderr}`);
    return JSON.parse(stdout);
  };

  expect(await invoke(['--prepare'])).toEqual({ status: 'ready' });
  expect(installedEngine(root)?.binary).toBeDefined();
  fs.copyFileSync(path.join(fixturesDir, 'voice/fleurs-en_us-10010138729160973689.ogg'), n.file);
  const speech = await invoke(n.argv);
  expect(speech).toMatchObject({ status: 'ok', provider: 'nemo-speech' });
  expect(speech.transcript.toLowerCase()).toContain('thousands of miles');
  expect(speech.transcript.toLowerCase()).toContain('satellite');

  const silent = path.join(path.dirname(n.file), 'silence.wav');
  const sampleRate = 16_000;
  const dataSize = 2 * sampleRate * 2; // Two seconds of mono PCM16.
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // Mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(silent, wav);
  expect(await invoke(['--file', silent, ...n.argv.slice(2)])).toEqual({ status: 'empty', path: silent });
}), 720_000);
