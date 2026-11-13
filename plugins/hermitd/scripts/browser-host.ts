#!/usr/bin/env bun
import { composeFiles } from './lib/compose-files';
import fs from 'node:fs';
import path from 'node:path';
import { isContainer } from './lib/container';
import { readSettledConfig } from './lib/config-read';
import { APPARMOR_PROFILE_FILE, BROWSER_PACKAGE_COMMANDS, appArmorProfileMissing, browserAppArmorProfile, browserDataDir, browserDeployment, browserHostPlatform, browserImageProbe, browserRuntimeMode, installedBrowser } from './lib/browser-runtime';
import { installBrowser } from './browser-install';
import { maybeStartBrowserDisplay } from './browser-display';
import os from 'node:os';
import type { RenderInput } from './render-security-overlay';

interface HostOptions {
  container?: () => boolean;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  log?: (line: string) => void;
  verifyWaitMs?: number;
  platform?: NodeJS.Platform;
  data?: string;
  which?: (name: string) => string | null;
  install?: typeof installBrowser;
  capture?: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
  interactive?: (args: string[], options?: { env?: NodeJS.ProcessEnv; input?: string }) => Promise<number>;
  restriction?: () => string;
  profileFile?: string;
  startDisplay?: typeof maybeStartBrowserDisplay;
}

const onPath = (name: string) => Bun.which(name, { PATH: process.env.PATH });
export function tailscaleCLI(): string {
  const found = onPath('tailscale');
  if (found) return found;
  const app = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  try { fs.accessSync(app, fs.constants.X_OK); return app; } catch {}
  const windows = onPath('tailscale.exe');
  if (windows) return windows;
  throw new Error('Tailscale CLI missing. Install Tailscale and enable its CLI integration on the host.');
}

export function securityRenderInput(security: any): RenderInput {
  const network = security.network ?? {};
  const resources = security.resources ?? {};
  return {
    network: network.enabled ? { subnet: network.subnet, gateway: network.gateway, netguard_ip: network.netguard_ip } : undefined,
    toggles: {
      lan: { enabled: network.enabled, dnsMode: network.dns_mode },
      resources: { enabled: resources.enabled, memLimit: resources.mem_limit, memswapLimit: resources.memswap_limit,
        cpus: resources.cpus, sysctlsEnabled: resources.sysctls_enabled },
      audit: { enabled: security.audit?.plugin_installs },
    },
    publishPorts: network.publish_ports ?? [], lanAllowlist: network.lan_allowlist ?? [],
    additionalDomains: network.additional_domains ?? [], fleetDomains: [],
  };
}

export async function installHostPrerequisites(project: string, options: HostOptions = {}): Promise<void> {
  const platform = options.platform ?? browserHostPlatform();
  const log = options.log ?? console.log;
  const which = options.which ?? onPath;
  const interactive = options.interactive ?? (async (args, extra) => {
    const child = Bun.spawn(args, { cwd: project, env: extra?.env ?? process.env, stdin: extra?.input === undefined ? 'inherit' : new Blob([extra.input]), stdout: 'inherit', stderr: 'inherit' });
    return child.exited;
  });
  const capture = options.capture ?? (async args => {
    const child = Bun.spawn(args, { cwd: project, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  });
  const run = async (args: string[], extra?: { env?: NodeJS.ProcessEnv; input?: string }) => {
    if (await interactive(args, extra)) throw new Error(`browser_host_command_failed:${args.join(' ')}`);
  };
  const privileged = async (args: string[], input?: string) => {
    if (!which('sudo')) {
      log(`Run as an administrator: ${args.map(arg => "'" + arg.replaceAll("'", "'\\''") + "'").join(' ')}`);
      if (input) log(input);
      throw new Error('sudo_missing: install sudo or run the printed commands as an administrator, then rerun hermitd run browser-host');
    }
    await run(['sudo', ...args], { input });
  };
  if (platform === 'linux' && BROWSER_PACKAGE_COMMANDS.some(name => !which(name))) {
    if (which('apt-get')) {
      await privileged(['apt-get', 'update']);
      await privileged(['apt-get', 'install', '-y', 'tigervnc-standalone-server', 'openbox', 'unzip']);
    } else if (which('dnf')) await privileged(['dnf', 'install', '-y', 'tigervnc-server', 'openbox', 'unzip']);
    else if (which('pacman')) await privileged(['pacman', '-S', '--needed', '--noconfirm', 'tigervnc', 'openbox', 'unzip']);
    else throw new Error('package_manager_unsupported: install Xvnc, openbox and unzip, then rerun hermitd run browser-host');
  }
  const data = options.data ?? browserDataDir();
  const installed = await (options.install ?? installBrowser)({ data });
  if ('error' in installed) throw new Error(`browser_install_failed:${installed.error}`);
  const browser = installedBrowser(data);
  if (!browser) throw new Error('browser_installing: rerun hermitd run browser-host after installation finishes');
  if (platform !== 'linux') return;
  const missingLibraries = async () => {
    const result = await capture(['ldd', browser.chrome]);
    const output = result.stdout + result.stderr;
    if (result.code && !output.includes('not found')) throw new Error(`ldd_failed:${output.trim()}`);
    return output.split('\n').filter(line => line.includes('not found')).join('\n');
  };
  let missing = await missingLibraries();
  if (missing) {
    if (which('pacman')) { log(missing); throw new Error('chrome_libraries_missing: install the libraries reported by ldd, then rerun hermitd run browser-host'); }
    if (!which('sudo')) {
      log(`${browser.binary} install --with-deps (with a throwaway HOME)`);
      throw new Error('sudo_missing: install sudo before installing Chrome libraries');
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-browser-deps-'));
    try { await run([browser.binary, 'install', '--with-deps'], { env: { ...process.env, HOME: home } }); }
    finally { fs.rmSync(home, { recursive: true }); }
    missing = await missingLibraries();
    if (missing) throw new Error(`chrome_libraries_missing:${missing}`);
  }
  if (appArmorProfileMissing(data, options)) {
    await privileged(['tee', options.profileFile ?? APPARMOR_PROFILE_FILE], browserAppArmorProfile(data));
    await privileged(['systemctl', 'reload', 'apparmor']);
  }
}

export async function setupBrowserHost(project = process.cwd(), options: HostOptions = {}) {
  if ((options.container ?? isContainer)()) throw new Error('Run hermitd run browser-host on the host, outside the container.');
  const log = options.log ?? console.log;
  const run = async (args: string[], input?: unknown) => {
    const child = Bun.spawn(args, { cwd: project, env: process.env, stdin: input === undefined ? 'ignore' : new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  };
  const required = async (args: string[], input?: unknown) => {
    const result = await run(args, input);
    if (result.code) throw new Error(`${path.basename(args[0])} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    return result.stdout;
  };
  const dir = path.join(project, '.hermit');
  const config = readSettledConfig(dir);
  if (!config.browser.enabled) throw new Error('Managed browser is off. Enable browser.enabled through /hermitd:hermit-settings.');
  const deployment = browserDeployment(dir, false);
  const startDisplay = () => (options.startDisplay ?? maybeStartBrowserDisplay)(browserRuntimeMode(dir), dir);
  if (deployment === 'host' && (options.platform ?? browserHostPlatform()) === 'darwin' && config.browser.admins.length) throw new Error('takeover_unsupported: use Claude in Chrome on macOS');
  if (deployment === 'host') {
    await installHostPrerequisites(project, options);
    if (!config.browser.admins.length) { startDisplay(); return { status: 'ready' }; }
    if (browserRuntimeMode(dir) !== 'tmux') throw new Error('takeover_needs_tmux: phone takeover runs only for always-on tmux hermits. Start the hermit with hermitd start, then rerun hermitd run browser-host.');
  }
  if (deployment === 'docker_host') {
    const version = (await required(['docker', 'version', '--format', '{{.Server.Version}}'])).trim();
    if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version) || Number(version.split('.')[0]) < 28) throw new Error('Docker server 28.0.0 or newer is required for safe localhost publishing.');
    const marker = await run(browserImageProbe(path.join(project, 'docker-compose.hermit.yml')));
    if (marker.code) {
      throw new Error('Managed browser missing from the image: run hermitd update to rebuild');
    }
  }
  const containerDisplay = async (verb: 'ensure' | 'status') => {
    const args = ['docker', 'compose', ...composeFiles(project)];
    args.push('exec', '-T', 'hermit', '.hermit/bin/hermitd-run', 'browser-display', verb);
    return JSON.parse(await required(args));
  };
  const ensureDockerDisplay = async () => {
    const result = await containerDisplay('ensure');
    if (result.status === 'blocked') throw new Error(`Browser display unavailable: ${result.reason}; run hermitd update on the Docker host.`);
  };
  if (!config.browser.admins.length) {
    if (deployment === 'docker_host') await ensureDockerDisplay();
    return { status: 'ready' };
  }
  const tailscale = tailscaleCLI();
  const status = JSON.parse(await required([tailscale, 'status', '--json']));
  const host = status.Self?.DNSName?.replace(/\.$/, '');
  if (!host) throw new Error('Tailscale is not connected or has no DNS name.');
  const routes = JSON.parse(await required([tailscale, 'serve', 'status', '--json']));
  let port = config.browser.port ?? undefined;
  const usedRoute = (candidate: number) => routes.Web?.[`${host}:${candidate}`] || routes.TCP?.[String(candidate)];
  if (port === undefined) {
    for (let candidate = 6080; candidate <= 65535; candidate++) {
      if (usedRoute(candidate)) continue;
      try {
        const listener = Bun.listen({ hostname: '127.0.0.1', port: candidate, socket: { data() {} } });
        listener.stop(true); port = candidate; break;
      } catch (error: any) { if (error.code !== 'EADDRINUSE') throw error; }
    }
    if (port === undefined) throw new Error('No free loopback viewer port.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid browser.port.');
  const target = `http://127.0.0.1:${port}`;
  const route = routes.Web?.[`${host}:${port}`];
  const configured = routes.TCP?.[String(port)]?.HTTPS === true && route?.Handlers?.['/']?.Proxy === target;
  if (usedRoute(port) && !configured) throw new Error(`Tailscale port ${port} already has another route; it was left unchanged.`);
  const verifyRoute = async () => {
    // A recreated container answers only once its entrypoint reaches the viewer.
    const deadline = Date.now() + (options.verifyWaitMs ?? 180_000);
    while (true) {
      try {
        const response = await (options.fetch ?? fetch)(target, { signal: AbortSignal.timeout(5000), redirect: 'error' });
        const body = await response.json() as { error?: unknown };
        if (response.status === 403 && body?.error === 'browser_identity_refused'
          && (deployment !== 'docker_host' || (await containerDisplay('status')).display === 'up')) return;
      } catch {}
      if (Date.now() >= deadline) break;
      await Bun.sleep(2000);
    }
    throw new Error(config.docker.network_mode === 'host'
      ? 'Viewer loopback route failed. Docker Desktop host networking with loopback binding is unverified; setup is not verified.'
      : 'Viewer loopback route failed: expected browser_identity_refused without a Tailscale login header.');
  };
  const script = (name: string) => path.join(import.meta.dir, name + '.ts');
  const set = (key: string, value: unknown) => required([process.execPath, script('settings-edit'), path.join(dir, 'config.json'), 'set', key, JSON.stringify(value)]);
  if (config.browser.port !== port) await set('browser.port', port);
  if (config.browser.host !== host) await set('browser.host', host);
  if (configured && config.browser.port === port) {
    if (deployment === 'docker_host') await ensureDockerDisplay();
    else startDisplay();
    await verifyRoute();
    log(`Browser viewer ready: https://${host}:${port}/`);
    return { status: 'ready', host, port };
  }
  if (deployment === 'docker_host') {
    const security = config.docker.security;
    if (security?.network?.enabled === true) {
      const ports = security.network.publish_ports ?? [];
      const mapping = { target: 6080, published: String(port), host_ip: '127.0.0.1', protocol: 'tcp' };
      if (!ports.some((entry: any) => Number(entry.target) === 6080 && String(entry.published) === String(port) && entry.host_ip === '127.0.0.1' && (entry.protocol ?? 'tcp') === 'tcp')) ports.push(mapping);
      await set('docker.security.network.publish_ports', ports);
      security.network.publish_ports = ports;
      await required([process.execPath, script('render-security-overlay'), 'render', project], securityRenderInput(security));
    } else {
      const rendered = JSON.parse(await required([process.execPath, script('render-docker-templates'), project]));
      if (rendered.error) throw new Error(rendered.error);
      if (rendered.status === 'skipped') throw new Error(rendered.reason === 'not_converted'
        ? 'Docker files are not converted; run /hermitd:docker-customize "Convert".'
        : 'Docker files use a newer renderer; update the host plugin.');
    }
    log('Recreating the hermit container to enable the viewer; the image will not be rebuilt.');
    await required(['bash', path.join(dir, 'bin/hermitd-docker'), 'up', '--force-recreate', '--no-build']);
  } else startDisplay();
  if (!configured) {
    const serveArgs = ['serve', '--bg', '--https', String(port), target];
    const serve = await run([tailscale, ...serveArgs]);
    if (serve.code) {
      const quote = (arg: string) => "'" + arg.replaceAll("'", "'\\''") + "'";
      log(`Tailscale Serve denied. Run on the host: sudo ${[tailscale, ...serveArgs].map(quote).join(' ')}`);
      throw new Error('Tailscale Serve failed; existing routes were left in place.');
    }
  }
  if (deployment === 'docker_host') await ensureDockerDisplay();
  await verifyRoute();
  log(`Browser viewer ready: https://${host}:${port}/`);
  return { status: 'ready', host, port };
}

if (import.meta.main) {
  try {
    if (process.getuid?.() === 0) throw new Error('Run as the operator; only package and AppArmor commands use sudo.');
    await setupBrowserHost();
  }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
