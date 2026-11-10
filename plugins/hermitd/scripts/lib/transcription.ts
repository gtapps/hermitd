import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TRANSCRIPTION_PINS } from './transcription-pins';
import { acquireLockWithWait, releaseLock } from './lockfile';
import { writeFileAtomic } from './md-write';
import { readSettledConfig } from './config-read';

export interface Pin { url: string; checksum: string }
export interface TranscriptionPins {
  version: string;
  whisper: Record<'x64' | 'arm64', Pin>;
  libgomp: Record<'x64' | 'arm64', Pin>;
  ffmpeg: Record<'x64' | 'arm64', Pin>;
  models: Record<string, Pin>;
}
export interface EngineOptions {
  projectRoot: string;
  deadline: number;
  fetch?: typeof fetch;
  which?: (name: string) => string | null;
  platform?: NodeJS.Platform;
  arch?: string;
  musl?: boolean;
  pins?: TranscriptionPins;
}
export function transcriptionDir(projectRoot: string): string {
  return path.join(projectRoot, '.claude.local/whisper.cpp');
}
export function remaining(deadline: number, limit = 300_000): number {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new Error('transcription_deadline_exceeded');
  return Math.min(ms, limit);
}
export function isMusl(): boolean {
  const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
  return !report.header.glibcVersionRuntime;
}
function platformDir(options: Pick<EngineOptions, 'projectRoot' | 'platform' | 'arch'>): string {
  return path.join(transcriptionDir(options.projectRoot), `${options.platform ?? process.platform}-${options.arch ?? process.arch}`);
}
export function installedWhisper(projectRoot: string, platform = process.platform, arch: string = process.arch) {
  const data = platformDir({ projectRoot, platform, arch });
  try {
    const versions = fs.readdirSync(data).filter(name => /^\d/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const dir = path.join(data, version);
      try {
        const record = JSON.parse(fs.readFileSync(path.join(dir, 'complete.json'), 'utf8'));
        if (record.version !== version || record.binary !== 'whisper-cli' || ![null, 'ffmpeg'].includes(record.ffmpeg)) continue;
        const binary = path.join(dir, 'whisper-cli');
        if (!fs.statSync(binary).isFile()) continue;
        fs.accessSync(binary, fs.constants.X_OK);
        const ffmpeg = record.ffmpeg ? path.join(dir, 'ffmpeg') : null;
        if (ffmpeg) fs.accessSync(ffmpeg, fs.constants.X_OK);
        return { dir, binary, ffmpeg };
      } catch {}
    }
  } catch {}
  return null;
}
export interface ReadinessOptions {
  projectRoot: string;
  hermitDir?: string;
  enabled?: boolean;
  platform?: NodeJS.Platform;
  arch?: string;
  musl?: boolean;
  which?: (name: string) => string | null;
  docker?: boolean;
}
export function readiness(options: ReadinessOptions): { status: 'disabled' | 'ready' | 'first_use' | 'unsupported' | 'failed'; reason: string } {
  const enabled = options.enabled ?? readSettledConfig(options.hermitDir ?? path.join(options.projectRoot, '.hermit')).transcription.enabled !== false;
  if (!enabled) return { status: 'disabled', reason: 'Voice-note transcription disabled' };
  const which = options.which ?? (name => Bun.which(name));
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (options.docker && !which('ffmpeg')) return { status: 'failed', reason: 'Docker image has no ffmpeg; run hermitd update' };
  if (which('whisper-cli') && which('ffmpeg')) return { status: 'ready', reason: 'PATH engine ready; models download on first use' };
  if (platform !== 'linux') return { status: 'unsupported', reason: platform === 'darwin' ? 'brew install whisper-cpp ffmpeg' : `Unsupported platform: ${platform}` };
  if ((options.musl ?? isMusl()) || !['x64', 'arm64'].includes(arch)) return { status: 'unsupported', reason: 'Automatic transcription install requires Linux glibc x64 or arm64' };
  const installed = installedWhisper(options.projectRoot, platform, arch);
  if (installed && (which('ffmpeg') || installed.ffmpeg)) return { status: 'ready', reason: 'Installed engine ready; models download on first use' };
  try {
    const error = JSON.parse(fs.readFileSync(path.join(transcriptionDir(options.projectRoot), 'install-error.json'), 'utf8'));
    return { status: 'failed', reason: String(error.error) };
  } catch {}
  return { status: 'first_use', reason: 'Engine and models install on first voice note' };
}

/** Debian ar members have 60-byte headers and two-byte alignment. */
export function debData(deb: Uint8Array): Uint8Array {
  const dec = (data: Uint8Array, off: number, size: number) => new TextDecoder().decode(data.subarray(off, off + size));
  if (dec(deb, 0, 8) !== '!<arch>\n') throw new Error('invalid_deb');
  let off = 8;
  while (off < deb.length) {
    const name = dec(deb, off, 16).trim().replace(/\/$/, '');
    const size = parseInt(dec(deb, off + 48, 10));
    if (!Number.isFinite(size) || size < 0 || off + 60 + size > deb.length) throw new Error('invalid_deb_member');
    const body = deb.subarray(off + 60, off + 60 + size);
    if (name === 'data.tar.zst') return Bun.zstdDecompressSync(body);
    off += 60 + size + (size % 2);
  }
  throw new Error('deb_data_missing');
}
function command(argv: string[], deadline: number): void {
  const result = Bun.spawnSync(argv, { timeout: remaining(deadline), stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`${argv[0]}:${result.stderr.toString().trim()}`);
}
async function download(pin: Pin, file: string, options: EngineOptions): Promise<void> {
  const response = await (options.fetch ?? fetch)(pin.url, { signal: AbortSignal.timeout(remaining(options.deadline)) });
  if (!response.ok) throw new Error(`download_failed:${pin.url}:HTTP ${response.status}`);
  await Bun.write(file, response);
  remaining(options.deadline);
  const hash = createHash('sha256');
  for await (const chunk of Bun.file(file).stream()) hash.update(chunk);
  if (hash.digest('hex') !== pin.checksum) throw new Error(`checksum_mismatch:${pin.url}`);
}
function findFile(dir: string, name: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.name === name && (entry.isFile() || entry.isSymbolicLink())) return file;
    if (entry.isDirectory()) {
      const found = findFile(file, name);
      if (found) return found;
    }
  }
  return null;
}
const activeInstalls = new Set<string>();
export async function installEngine(options: EngineOptions): Promise<{ status: 'ready'; dir: string } | { error: string }> {
  const data = transcriptionDir(options.projectRoot);
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  const lock = path.join(data, 'install.lock');
  let locked = false;
  let temp: string | undefined;
  try {
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    if (platform !== 'linux' || !['x64', 'arm64'].includes(arch) || (options.musl ?? isMusl())) throw new Error('unsupported_platform:Linux glibc x64/arm64 required');
    if (activeInstalls.has(data)) throw new Error('install_in_progress');
    locked = acquireLockWithWait(lock, remaining(options.deadline, Infinity));
    if (!locked) throw new Error('install_lock_deadline');
    activeInstalls.add(data);
    const pins = options.pins ?? TRANSCRIPTION_PINS;
    const parent = platformDir(options);
    fs.mkdirSync(parent, { recursive: true });
    for (const name of fs.readdirSync(parent)) if (name.startsWith('.install-')) fs.rmSync(path.join(parent, name), { recursive: true });
    const target = path.join(parent, pins.version);
    const bundled = !(options.which ?? (name => Bun.which(name)))('ffmpeg');
    const current = installedWhisper(options.projectRoot, platform, arch);
    if (current?.dir === target && (current.ffmpeg || !bundled)) return { status: 'ready', dir: target };
    temp = fs.mkdtempSync(path.join(parent, '.install-'));
    const stage = path.join(temp, 'release');
    fs.mkdirSync(stage);
    const architecture = arch as 'x64' | 'arm64';
    const archive = path.join(temp, 'whisper.tar.gz');
    await download(pins.whisper[architecture], archive, options);
    const unpack = path.join(temp, 'whisper');
    fs.mkdirSync(unpack);
    command(['tar', 'xzf', archive, '-C', unpack], options.deadline);
    const binary = findFile(unpack, 'whisper-cli');
    if (!binary) throw new Error('whisper_binary_missing');
    // Keep the upstream shared libraries beside the executable.
    fs.cpSync(path.dirname(binary), stage, { recursive: true, dereference: true });
    const deb = path.join(temp, 'libgomp.deb');
    await download(pins.libgomp[architecture], deb, options);
    const dataTar = path.join(temp, 'data.tar');
    fs.writeFileSync(dataTar, debData(fs.readFileSync(deb)));
    const libraries = path.join(temp, 'libraries');
    fs.mkdirSync(libraries);
    command(['tar', 'xf', dataTar, '-C', libraries], options.deadline);
    const libgomp = findFile(libraries, 'libgomp.so.1');
    if (!libgomp) throw new Error('libgomp_missing');
    fs.copyFileSync(libgomp, path.join(stage, 'libgomp.so.1'));
    if (bundled) {
      const ffmpegArchive = path.join(temp, 'ffmpeg.tar.xz');
      await download(pins.ffmpeg[architecture], ffmpegArchive, options);
      const ffmpegDir = path.join(temp, 'ffmpeg');
      fs.mkdirSync(ffmpegDir);
      command(['tar', 'xJf', ffmpegArchive, '-C', ffmpegDir], options.deadline);
      const ffmpeg = findFile(ffmpegDir, 'ffmpeg');
      if (!ffmpeg || path.basename(path.dirname(ffmpeg)) !== 'bin') throw new Error('ffmpeg_binary_missing');
      fs.copyFileSync(ffmpeg, path.join(stage, 'ffmpeg'));
      fs.chmodSync(path.join(stage, 'ffmpeg'), 0o755);
      command([path.join(stage, 'ffmpeg'), '-version'], options.deadline);
    }
    fs.chmodSync(path.join(stage, 'whisper-cli'), 0o755);
    command([path.join(stage, 'whisper-cli'), '--help'], options.deadline);
    writeFileAtomic(path.join(stage, 'complete.json'), JSON.stringify({ version: pins.version, binary: 'whisper-cli', ffmpeg: bundled ? 'ffmpeg' : null }) + '\n');
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true });
    fs.renameSync(stage, target);
    for (const name of fs.readdirSync(parent)) if (/^\d/.test(name) && path.join(parent, name) !== target) fs.rmSync(path.join(parent, name), { recursive: true });
    fs.rmSync(path.join(data, 'install-error.json'), { force: true });
    return { status: 'ready', dir: target };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeFileAtomic(path.join(data, 'install-error.json'), JSON.stringify({ error: detail }) + '\n', 0o600);
    return { error: detail };
  } finally {
    if (temp) fs.rmSync(temp, { recursive: true });
    if (locked) { activeInstalls.delete(data); releaseLock(lock); }
  }
}
export async function ensureModels(options: EngineOptions): Promise<{ base: string; silero: string }> {
  const dir = path.join(transcriptionDir(options.projectRoot), 'models');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, pin] of Object.entries((options.pins ?? TRANSCRIPTION_PINS).models)) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) continue;
    const temp = path.join(dir, `.${name}-${crypto.randomUUID()}.tmp`);
    try {
      await download(pin, temp, options);
      fs.renameSync(temp, file);
    } finally { fs.rmSync(temp, { force: true }); }
  }
  return { base: path.join(dir, 'ggml-base.bin'), silero: path.join(dir, 'ggml-silero-v6.2.0.bin') };
}
