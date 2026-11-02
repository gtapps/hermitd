import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hermitDir } from './cc-compat';
import { isContainer } from './container';
import { readSettledConfig } from './config-read';
import { marketplace, registryDir } from './host-registry';
import { readJson } from './cli';

export type BrowserDeployment = 'container' | 'docker_host' | 'host';
export function browserRuntimeMode(dir = hermitDir()): string {
  return readJson(path.join(dir, 'state/runtime.json'))?.runtime_mode ?? '';
}
export function browserDeployment(dir = hermitDir(), container = isContainer()): BrowserDeployment {
  if (container) return 'container';
  return browserRuntimeMode(dir) !== 'tmux' && fs.existsSync(path.join(dir, '../docker-compose.hermit.yml')) ? 'docker_host' : 'host';
}
export function browserDataDir(root = path.resolve(import.meta.dir, '../..')): string {
  const mp = marketplace(root);
  return path.join(mp ? registryDir(mp) : path.join(path.dirname(registryDir('inline')), 'hermitd-inline'), 'browser');
}
export function browserProfile(dir = hermitDir(), deployment = browserDeployment(dir)): string {
  return deployment === 'host' ? path.join(fs.realpathSync(path.dirname(dir)), '.claude.local/browser/profile') : '/home/claude/.claude/browser/profile';
}
// Runtime sockets must not be shared with other hermits on the fleet mesh.
export function browserSocketDir(dir: string): string {
  return `/tmp/hermit-browser-${createHash('sha256').update(dir).digest('hex').slice(0, 16)}`;
}
export function browserEnabled(dir = hermitDir()): boolean {
  return readSettledConfig(dir).browser.enabled === true;
}
export function dockerfileHasOwnBrowser(file: string): boolean {
  try {
    let managed = false;
    return fs.readFileSync(file, 'utf8').split('\n').some(line => {
      if (line.startsWith('# Managed browser')) { managed = true; return false; }
      if (managed) {
        if (line.trim() && !line.endsWith('\\')) managed = false;
        return false;
      }
      return line.includes('agent-browser');
    });
  } catch (error: any) { if (error.code === 'ENOENT') return false; throw error; }
}

export function browserHostPlatform(): NodeJS.Platform { return process.platform; }

export function installedBrowser(data = browserDataDir()) {
  if (!fs.existsSync(data)) return null;
  const dirs = fs.readdirSync(data).filter(name => /^\d[^/]*$/.test(name)).map(name => path.join(data, name))
    .filter(dir => fs.existsSync(path.join(dir, 'complete.json')))
    .map(dir => ({ dir, mtime: fs.statSync(dir).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
  for (const { dir } of dirs) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, 'complete.json'), 'utf8'));
      if (![record.binary, record.chrome].every(value => typeof value === 'string' && !value.includes('..') && !path.isAbsolute(value))) continue;
      const binary = path.join(dir, record.binary), chrome = path.join(dir, record.chrome);
      fs.accessSync(binary, fs.constants.X_OK); fs.accessSync(chrome, fs.constants.X_OK);
      if (fs.readFileSync(path.join(dir, 'config.json'), 'utf8').trim() !== '{}') continue;
      return { dir, binary, chrome, config: path.join(dir, 'config.json'), novnc: path.join(dir, 'novnc') };
    } catch {}
  }
  return null;
}

export function browserViewerPaths(dir = hermitDir()) {
  if (browserDeployment(dir) === 'container') return { novncRoot: '/opt/novnc', vncSocket: '/tmp/hermit-browser/vnc.sock' };
  const browser = installedBrowser();
  if (!browser) throw new Error('browser_install_missing: run hermitd run browser-host');
  return { novncRoot: browser.novnc, vncSocket: path.join(browserSocketDir(dir), 'vnc.sock') };
}

export function browserAppArmorProfile(data: string): string {
  return `abi <abi/4.0>,
include <tunables/global>
profile hermit-browser "${data}/*/chrome/chrome" flags=(unconfined) {
  userns,
  include if exists <local/hermit-browser>
}
`;
}

export const BROWSER_PACKAGE_COMMANDS = ['Xvnc', 'openbox', 'unzip'];
export const APPARMOR_PROFILE_FILE = '/etc/apparmor.d/hermit-browser';
export function browserImageProbe(compose: string): string[] {
  return ['docker', 'compose', '-f', compose, 'exec', '-T', 'hermit', 'test', '-f', '/etc/hermit/managed-browser'];
}
interface AppArmorOptions { restriction?: () => string; profileFile?: string }
export function appArmorProfileMissing(data: string, options: AppArmorOptions = {}): boolean {
  let restricted = '';
  try { restricted = (options.restriction ?? (() => fs.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8')))().trim(); } catch {}
  if (restricted !== '1') return false;
  let profile = '';
  try { profile = fs.readFileSync(options.profileFile ?? APPARMOR_PROFILE_FILE, 'utf8'); } catch {}
  return profile !== browserAppArmorProfile(data);
}
export interface BrowserPrerequisiteOptions extends AppArmorOptions {
  data?: string; platform?: NodeJS.Platform; which?: (name: string) => string | null;
  libraries?: (chrome: string) => string | null;
}
export function browserHostPrerequisite(options: BrowserPrerequisiteOptions = {}): string | null {
  const data = options.data ?? browserDataDir();
  const browser = installedBrowser(data);
  if (!browser) return 'browser binary missing';
  if ((options.platform ?? browserHostPlatform()) !== 'linux') return null;
  const which = options.which ?? (name => Bun.which(name));
  if (BROWSER_PACKAGE_COMMANDS.some(name => !which(name))) return 'display packages missing';
  const libraries = options.libraries ?? (chrome => {
    const result = Bun.spawnSync(['ldd', chrome], { timeout: 5000, stdout: 'pipe', stderr: 'pipe' });
    return result.exitCode || (result.stdout.toString() + result.stderr.toString()).includes('not found') ? 'Chrome libraries missing' : null;
  });
  const missing = libraries(browser.chrome);
  if (missing) return missing;
  return appArmorProfileMissing(data, options) ? 'Chrome sandbox prerequisite missing' : null;
}
