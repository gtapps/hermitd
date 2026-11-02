#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { isContainer } from './lib/container';
import { readConfigRaw } from './lib/config-read';
import { deriveRenderInputs } from './lib/derive-render-inputs';
import type { RenderInput } from './render-security-overlay';

interface HostOptions {
  container?: () => boolean;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  log?: (line: string) => void;
}

export function tailscaleCLI(): string {
  const lookup = (name: string) => {
    for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
      const candidate = path.resolve(entry, name);
      try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch {}
    }
    return null;
  };
  const found = lookup('tailscale');
  if (found) return found;
  const app = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  try { fs.accessSync(app, fs.constants.X_OK); return app; } catch {}
  const windows = lookup('tailscale.exe');
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

export async function setupBrowserHost(project = process.cwd(), options: HostOptions = {}) {
  if ((options.container ?? isContainer)()) throw new Error('Run hermitd run browser-host on the host, outside the container.');
  const log = options.log ?? console.log;
  const tailscale = tailscaleCLI();
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
  const version = (await required(['docker', 'version', '--format', '{{.Server.Version}}'])).trim();
  if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version) || Number(version.split('.')[0]) < 28) throw new Error('Docker server 28.0.0 or newer is required for safe localhost publishing.');
  const dir = path.join(project, '.hermit');
  const config = readConfigRaw(dir);
  if (config?.docker?.browser !== true) throw new Error('Managed browser is off. Run /hermitd:docker-setup explicitly first.');
  if (!Array.isArray(config.docker.browser_admins) || !config.docker.browser_admins.length) throw new Error('Set docker.browser_admins through browser setup in chat first.');
  const status = JSON.parse(await required([tailscale, 'status', '--json']));
  const host = status.Self?.DNSName?.replace(/\.$/, '');
  if (!host) throw new Error('Tailscale is not connected or has no DNS name.');
  const routes = JSON.parse(await required([tailscale, 'serve', 'status', '--json']));
  let port = config.docker.browser_port as number | undefined;
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
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid docker.browser_port.');
  const target = `http://127.0.0.1:${port}`;
  const route = routes.Web?.[`${host}:${port}`];
  const configured = routes.TCP?.[String(port)]?.HTTPS === true && route?.Handlers?.['/']?.Proxy === target;
  if (usedRoute(port) && !configured) throw new Error(`Tailscale port ${port} already has another route; it was left unchanged.`);
  const verifyRoute = async () => {
    try {
      const response = await (options.fetch ?? fetch)(target, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      const body = await response.json() as { error?: unknown };
      if (response.status === 403 && body?.error === 'browser_identity_refused') return;
    } catch {}
    throw new Error(config.docker.network_mode === 'host'
      ? 'Viewer loopback route failed. Docker Desktop host networking with loopback binding is unverified; setup is not verified.'
      : 'Viewer loopback route failed: expected browser_identity_refused without a Tailscale login header.');
  };
  if (configured && config.docker.browser_port === port) {
    await verifyRoute();
    log(`Browser viewer ready: https://${host}:${port}/`);
    return { status: 'ready', host, port };
  }
  const script = (name: string) => path.join(import.meta.dir, name + '.ts');
  const set = (key: string, value: unknown) => required([process.execPath, script('settings-edit'), path.join(dir, 'config.json'), 'set', key, JSON.stringify(value)]);
  await set('docker.browser_port', port);
  const security = config.docker.security;
  if (security?.network?.enabled === true) {
    const ports = security.network.publish_ports ?? [];
    const mapping = { target: 6080, published: String(port), host_ip: '127.0.0.1', protocol: 'tcp' };
    if (!ports.some((entry: any) => Number(entry.target) === 6080 && String(entry.published) === String(port) && entry.host_ip === '127.0.0.1' && (entry.protocol ?? 'tcp') === 'tcp')) ports.push(mapping);
    await set('docker.security.network.publish_ports', ports);
    security.network.publish_ports = ports;
  }
  const inputs = deriveRenderInputs(path.join(dir, 'config.json'), path.join(project, 'docker-compose.hermit.yml'));
  if (!inputs) throw new Error('Cannot derive Docker template inputs from this project.');
  await required([process.execPath, script('render-docker-templates'), project], inputs);
  if (security) await required([process.execPath, script('render-security-overlay'), 'render', project], securityRenderInput(security));
  log('Recreating the hermit container to enable the viewer; the image will not be rebuilt.');
  await required(['bash', path.join(dir, 'bin/hermitd-docker'), 'up', '--force-recreate', '--no-build']);
  if (!configured) {
    const serveArgs = ['serve', '--bg', '--https', String(port), target];
    const serve = await run([tailscale, ...serveArgs]);
    if (serve.code) {
      const quote = (arg: string) => "'" + arg.replaceAll("'", "'\\''") + "'";
      log(`Tailscale Serve denied. Run on the host: sudo ${[tailscale, ...serveArgs].map(quote).join(' ')}`);
      throw new Error('Tailscale Serve failed; existing routes were left in place.');
    }
  }
  await verifyRoute();
  log(`Browser viewer ready: https://${host}:${port}/`);
  return { status: 'ready', host, port };
}

if (import.meta.main) {
  try { await setupBrowserHost(); }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
}
