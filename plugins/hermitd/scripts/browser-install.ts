#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BROWSER_PINS } from './lib/browser-pins';
import { browserDataDir, installedBrowser } from './lib/browser-runtime';
import { acquireLockWithWait, releaseLock } from './lib/lockfile';
import { writeFileAtomic } from './lib/md-write';
import { printJson } from './lib/cli';

export function browserPlatform(platform = process.platform, arch: string = process.arch, musl?: boolean) {
  if (!['linux', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error(`unsupported_platform:${platform}-${arch}`);
  if (platform === 'linux' && musl === undefined) {
    try {
      const ldd = Bun.spawnSync(['ldd', '--version']);
      musl = (ldd.stdout.toString() + ldd.stderr.toString()).toLowerCase().includes('musl');
    } catch { musl = fs.existsSync('/lib/ld-musl-x86_64.so.1') || fs.existsSync('/lib/ld-musl-aarch64.so.1'); }
  }
  return { binary: `agent-browser-${platform === 'linux' && musl ? 'linux-musl' : platform}-${arch}`,
    chrome: platform === 'darwin' ? `mac-${arch}` as 'mac-x64' | 'mac-arm64' : arch === 'arm64' ? 'linux-arm64' as const : 'linux64' as const,
    linux: platform === 'linux' };
}
interface InstallOptions {
  data?: string; fetch?: typeof fetch; platform?: NodeJS.Platform; arch?: string; musl?: boolean;
  pins?: typeof BROWSER_PINS;
}
const activeInstalls = new Set<string>();
export async function installBrowser(options: InstallOptions = {}) {
  const data = options.data ?? browserDataDir();
  fs.mkdirSync(data, { recursive: true, mode: 0o700 });
  const lock = path.join(data, 'install.lock');
  if (activeInstalls.has(data) || !acquireLockWithWait(lock, 50)) return { status: 'installing' };
  activeInstalls.add(data);
  let temp: string | undefined;
  try {
    const pins = options.pins ?? BROWSER_PINS;
    const platform = browserPlatform(options.platform, options.arch, options.musl);
    const target = path.join(data, `${pins.agent.version}-${pins.chrome.version}`);
    const current = installedBrowser(data);
    if (current?.dir === target) return { status: 'ready', dir: target };
    if (!Bun.which('unzip')) throw new Error('unzip_missing:run hermitd run browser-host');
    // The lock is ours, so any temp folder here belongs to a killed installer.
    for (const name of fs.readdirSync(data)) if (name.startsWith('.install-')) fs.rmSync(path.join(data, name), { recursive: true });
    temp = fs.mkdtempSync(path.join(data, '.install-'));
    const command = (argv: string[]) => {
      const result = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe' });
      if (result.exitCode !== 0) throw new Error(`${argv[0]}:${result.stderr.toString().trim()}`);
    };
    const download = async (url: string, name: string, algorithm: string, digest: string, encoding: 'hex' | 'base64' = 'hex') => {
      const response = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`download_failed:${name}:HTTP ${response.status}`);
      const file = path.join(temp!, name);
      await Bun.write(file, response);
      const hash = createHash(algorithm);
      for await (const chunk of Bun.file(file).stream()) hash.update(chunk);
      if (hash.digest(encoding) !== digest) throw new Error(`checksum_mismatch:${name}`);
      return file;
    };
    const agent = await download(pins.agent.url, 'agent.tgz', 'sha512', pins.agent.integrity.slice('sha512-'.length), 'base64');
    command(['tar', 'xzf', agent, '-C', temp]);
    const binary = path.join(temp, 'package/bin', platform.binary);
    fs.chmodSync(binary, 0o755);
    fs.renameSync(binary, path.join(temp, 'agent-browser'));
    const chromeZip = await download(`https://storage.googleapis.com/chrome-for-testing-public/${pins.chrome.version}/${platform.chrome}/chrome-${platform.chrome}.zip`, 'chrome.zip', 'sha256', pins.chrome.checksums[platform.chrome]);
    command(['unzip', '-q', chromeZip, '-d', temp]);
    fs.renameSync(path.join(temp, `chrome-${platform.chrome}`), path.join(temp, 'chrome'));
    const chrome = platform.linux ? 'chrome/chrome' : 'chrome/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
    fs.accessSync(path.join(temp, chrome), fs.constants.X_OK);
    if (platform.linux) {
      const novnc = await download(pins.novnc.url, 'novnc.tgz', 'sha256', pins.novnc.checksum);
      fs.mkdirSync(path.join(temp, 'novnc'));
      command(['tar', 'xzf', novnc, '-C', path.join(temp, 'novnc'), '--strip-components=1']);
      if (!fs.existsSync(path.join(temp, 'novnc/core/rfb.js'))) throw new Error('novnc_incomplete');
    }
    for (const name of ['agent.tgz', 'chrome.zip', 'novnc.tgz', 'package']) fs.rmSync(path.join(temp, name), { recursive: true, force: true });
    fs.writeFileSync(path.join(temp, 'config.json'), '{}\n');
    writeFileAtomic(path.join(temp, 'complete.json'), JSON.stringify({ binary: 'agent-browser', chrome }) + '\n');
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(temp, target); temp = undefined;
    fs.rmSync(path.join(data, 'install-error.json'), { force: true });
    const previous = current?.dir;
    for (const name of fs.readdirSync(data)) {
      const dir = path.join(data, name);
      if (/^\d/.test(name) && dir !== target && dir !== previous && fs.statSync(dir).isDirectory()) fs.rmSync(dir, { recursive: true });
    }
    return { status: 'ready', dir: target };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeFileAtomic(path.join(data, 'install-error.json'), JSON.stringify({ error: detail }) + '\n', 0o600);
    return { error: detail };
  } finally {
    if (temp) fs.rmSync(temp, { recursive: true });
    activeInstalls.delete(data);
    releaseLock(lock);
  }
}
if (import.meta.main) printJson(await installBrowser());
