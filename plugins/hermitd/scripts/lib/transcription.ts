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
  engine: Record<'linux-x64' | 'linux-arm64' | 'darwin-arm64', Pin>;
  ffmpeg: Record<'x64' | 'arm64', Pin>;
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
  return path.join(projectRoot, '.claude.local/nemo-speech');
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
export function installedEngine(projectRoot: string, platform = process.platform, arch: string = process.arch) {
  const data = platformDir({ projectRoot, platform, arch });
  try {
    const versions = fs.readdirSync(data).filter(name => /^\d/.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const dir = path.join(data, version);
      try {
        const record = JSON.parse(fs.readFileSync(path.join(dir, 'complete.json'), 'utf8'));
        if (record.version !== version || record.binary !== 'nemo-speech' || ![null, 'ffmpeg'].includes(record.ffmpeg)) continue;
        const binary = path.join(dir, 'bin', 'nemo-speech');
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
export function readiness(options: ReadinessOptions): { status: 'disabled' | 'ready' | 'first_use' | 'unavailable' | 'unsupported' | 'failed'; reason: string } {
  const enabled = options.enabled ?? readSettledConfig(options.hermitDir ?? path.join(options.projectRoot, '.hermit')).transcription.enabled !== false;
  if (!enabled) return { status: 'disabled', reason: 'Voice-note transcription disabled' };
  const which = options.which ?? (name => Bun.which(name));
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const ffmpeg = which('ffmpeg');
  const binary = which('nemo-speech');
  if (binary && ffmpeg) return { status: 'ready', reason: 'PATH engine and ffmpeg ready' };
  if (platform === 'darwin') {
    if (arch === 'x64' && !binary) return { status: 'unsupported', reason: 'Install nemo-speech on PATH for Intel macOS' };
    if (['x64', 'arm64'].includes(arch) && !ffmpeg) return { status: 'unsupported', reason: 'Install ffmpeg with brew install ffmpeg' };
    if (arch !== 'arm64') return { status: 'unsupported', reason: `Unsupported macOS architecture: ${arch}` };
  } else if (platform !== 'linux') {
    return { status: 'unsupported', reason: `Unsupported platform: ${platform}` };
  } else if ((options.musl ?? isMusl()) || !['x64', 'arm64'].includes(arch)) {
    return { status: 'unsupported', reason: 'Automatic transcription install requires Linux glibc x64 or arm64' };
  }
  const installed = installedEngine(options.projectRoot, platform, arch);
  if (installed && (ffmpeg || installed.ffmpeg)) return { status: 'ready', reason: 'Installed engine and ffmpeg ready' };
  // A container gets ffmpeg from its image and never downloads one, so an old install error is moot there.
  if (options.docker && !ffmpeg) return { status: 'unavailable', reason: 'Voice notes unavailable: image has no ffmpeg' };
  if (!options.docker) {
    try {
      const error = JSON.parse(fs.readFileSync(path.join(transcriptionDir(options.projectRoot), 'install-error.json'), 'utf8'));
      return { status: 'failed', reason: String(error.error) };
    } catch {}
  }
  return { status: 'first_use', reason: 'Engine and model prepare at boot or on first voice note' };
}

function command(argv: string[], deadline: number): void {
  // Install children never see the boot environment's credentials.
  const env = Object.fromEntries(['PATH', 'HOME', 'LANG'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  const result = Bun.spawnSync(argv, { env, timeout: remaining(deadline), stdout: 'pipe', stderr: 'pipe' });
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
    const pins = options.pins ?? TRANSCRIPTION_PINS;
    const targetKey = `${platform}-${arch}`;
    if (!Object.hasOwn(pins.engine, targetKey) || (platform === 'linux' && (options.musl ?? isMusl()))) {
      throw new Error('unsupported_platform:Linux glibc x64/arm64 or Apple Silicon macOS required');
    }
    const enginePin = pins.engine[targetKey as keyof TranscriptionPins['engine']];
    if (activeInstalls.has(data)) throw new Error('install_in_progress');
    locked = acquireLockWithWait(lock, remaining(options.deadline, Infinity));
    if (!locked) throw new Error('install_lock_deadline');
    activeInstalls.add(data);
    const parent = platformDir(options);
    fs.mkdirSync(parent, { recursive: true });
    for (const name of fs.readdirSync(parent)) if (name.startsWith('.install-')) fs.rmSync(path.join(parent, name), { recursive: true });
    const target = path.join(parent, pins.version);
    const bundled = platform === 'linux' && !(options.which ?? (name => Bun.which(name)))('ffmpeg');
    const current = installedEngine(options.projectRoot, platform, arch);
    if (current?.dir === target && (current.ffmpeg || !bundled)) return { status: 'ready', dir: target };
    temp = fs.mkdtempSync(path.join(parent, '.install-'));
    const archive = path.join(temp, 'engine.tar.gz');
    await download(enginePin, archive, options);
    const unpack = path.join(temp, 'engine');
    fs.mkdirSync(unpack);
    command(['tar', 'xzf', archive, '-C', unpack], options.deadline);
    const binary = findFile(unpack, 'nemo-speech');
    if (!binary || path.basename(path.dirname(binary)) !== 'bin') throw new Error('engine_binary_missing');
    const stage = path.dirname(path.dirname(binary));
    command([binary, '--version'], options.deadline);
    if (bundled) {
      const ffmpegArchive = path.join(temp, 'ffmpeg.tar.xz');
      await download(pins.ffmpeg[arch as keyof TranscriptionPins['ffmpeg']], ffmpegArchive, options);
      const ffmpegDir = path.join(temp, 'ffmpeg');
      fs.mkdirSync(ffmpegDir);
      command(['tar', 'xJf', ffmpegArchive, '-C', ffmpegDir], options.deadline);
      const ffmpeg = findFile(ffmpegDir, 'ffmpeg');
      if (!ffmpeg || path.basename(path.dirname(ffmpeg)) !== 'bin') throw new Error('ffmpeg_binary_missing');
      fs.copyFileSync(ffmpeg, path.join(stage, 'ffmpeg'));
      fs.chmodSync(path.join(stage, 'ffmpeg'), 0o755);
      command([path.join(stage, 'ffmpeg'), '-version'], options.deadline);
    }
    writeFileAtomic(path.join(stage, 'complete.json'), JSON.stringify({ version: pins.version, binary: 'nemo-speech', ffmpeg: bundled ? 'ffmpeg' : null }) + '\n');
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
export const TRANSCRIPTION_MODEL = 'nemotron-3.5';

export function ensureModels(binary: string, run: (argv: string[], limit?: number) => { exitCode: number; stderr: string }): void {
  const pull = run([binary, 'pull', TRANSCRIPTION_MODEL], Infinity);
  if (pull.exitCode !== 0) throw new Error(`model_pull_failed:${pull.stderr}`);
}
