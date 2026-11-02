import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setupBrowserHost, securityRenderInput, tailscaleCLI } from '../scripts/browser-host';
import { render } from '../scripts/render-docker-templates';
import { freshDirFactory } from './helpers/workdir';
const { freshDir, cleanup } = freshDirFactory('browser-host-');
afterAll(cleanup);

function fixture(lan = false) {
  const project = freshDir();
  const dir = path.join(project, '.hermit');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  const logFile = path.join(project, 'calls');
  const config: any = { channels: {}, docker: { packages: [], browser: true, browser_admins: [{ login: 'admin', mentions: {} }] } };
  if (lan) config.docker.security = {
    network: { enabled: true, subnet: '172.28.0.0/24', gateway: '172.28.0.1', netguard_ip: '172.28.0.2',
      publish_ports: [{ target: 3000, published: '3000' }], lan_allowlist: ['192.168.1.1'], additional_domains: ['example.com'], dns_mode: 'enforce' },
    resources: { enabled: true, mem_limit: '5g', memswap_limit: '6g', cpus: 3, sysctls_enabled: true }, audit: { plugin_installs: true },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  const rendered = render({ auth: 'oauth-token', networkMode: 'bridge', gitIdentityMount: false, browser: true });
  fs.writeFileSync(path.join(project, 'docker-compose.hermit.yml'), rendered.compose);
  fs.writeFileSync(path.join(project, 'Dockerfile.hermit'), rendered.dockerfile);
  const bin = path.join(project, 'fake-bin'); fs.mkdirSync(bin);
  const versionFile = path.join(project, 'version'); fs.writeFileSync(versionFile, '29.8.1');
  const routesFile = path.join(project, 'routes'); fs.writeFileSync(routesFile, '{}');
  const deniedFile = path.join(project, 'denied');
  const exe = (file: string, code: string) => fs.writeFileSync(file, `#!${process.execPath}\n${code}`, { mode: 0o755 });
  exe(path.join(bin, 'docker'), `console.log(await Bun.file(${JSON.stringify(versionFile)}).text());`);
  exe(path.join(bin, 'tailscale'), `
    import fs from 'node:fs';
    const args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + '\\n');
    if (args[0] === 'status') console.log(JSON.stringify({ Self: { DNSName: 'hermit.tail.test.' } }));
    else if (args[1] === 'status') console.log(await Bun.file(${JSON.stringify(routesFile)}).text());
    else if (fs.existsSync(${JSON.stringify(deniedFile)})) process.exit(1);
    else { const port = args[args.indexOf('--https') + 1]; const routes = JSON.parse(await Bun.file(${JSON.stringify(routesFile)}).text());
      routes.TCP ??= {}; routes.Web ??= {};
      routes.TCP[port] = { HTTPS: true }; routes.Web['hermit.tail.test:' + port] = { Handlers: { '/': { Proxy: args.at(-1) } } };
      fs.writeFileSync(${JSON.stringify(routesFile)}, JSON.stringify(routes)); }
  `);
  fs.writeFileSync(path.join(dir, 'bin/hermitd-docker'), `#!/bin/bash\nprintf '%s\\n' "$@" >> '${logFile}'\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = bin + ':' + oldPath;
  if (tailscaleCLI() !== path.join(bin, 'tailscale')) {
    process.env.PATH = oldPath;
    throw new Error('Fixture refused: Tailscale lookup escaped fake-bin');
  }
  const messages: string[] = [];
  const opts = { container: () => false, log: (message: string) => messages.push(message), fetch: (async () => Response.json({ error: 'browser_identity_refused' }, { status: 403 })) };
  return { project, dir, config, opts, messages, versionFile, routesFile, deniedFile, logFile, bin, stop() { process.env.PATH = oldPath; } };
}

test.serial('container refusal happens before any host command', async () => {
  await expect(setupBrowserHost('/missing', { container: () => true })).rejects.toThrow('outside the container');
});

test.serial('old Docker refuses before writing configuration', async () => {
  const f = fixture(); try {
    fs.writeFileSync(f.versionFile, '27.9.9');
    await expect(setupBrowserHost(f.project, f.opts)).rejects.toThrow('28.0.0');
    expect(JSON.parse(fs.readFileSync(path.join(f.dir, 'config.json'), 'utf8'))).toEqual(f.config);
  } finally { f.stop(); }
});

for (const lan of [false, true]) test.serial(`host setup recreates without build, preserves routes, idempotent (LAN ${lan})`, async () => {
  const f = fixture(lan); try {
    fs.writeFileSync(f.routesFile, JSON.stringify({ Web: { 'hermit.tail.test:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } } } }));
    const result = await setupBrowserHost(f.project, f.opts);
    const config = JSON.parse(fs.readFileSync(path.join(f.dir, 'config.json'), 'utf8'));
    expect(config.docker.browser_port).toBe(result.port);
    expect(result.port).toBeGreaterThanOrEqual(6080);
    const compose: any = Bun.YAML.parse(fs.readFileSync(path.join(f.project, 'docker-compose.hermit.yml'), 'utf8'));
    expect(!!compose.services.hermit.ports).toBe(!lan);
    if (lan) {
      expect(config.docker.security.network.publish_ports).toContainEqual({ target: 3000, published: '3000' });
      const overlay: any = Bun.YAML.parse(fs.readFileSync(path.join(f.project, 'docker-compose.security.yml'), 'utf8'));
      expect(overlay.services['hermit-netguard'].ports).toHaveLength(2);
      expect(overlay.services.hermit.mem_limit).toBe('5g');
      expect(fs.readFileSync(path.join(f.dir, 'docker/dnsmasq.allowlist'), 'utf8')).toContain('example.com');
    }
    expect(JSON.parse(fs.readFileSync(f.routesFile, 'utf8')).Web['hermit.tail.test:443'].Handlers['/'].Proxy).toBe('http://127.0.0.1:9999');
    const calls = fs.readFileSync(f.logFile, 'utf8');
    expect(calls).toContain('up\n--force-recreate\n--no-build');
    expect(calls).toContain(`"serve","--bg","--https","${result.port}"`);
    expect(f.messages[0]).toContain('Recreating');
    const before = fs.readFileSync(path.join(f.dir, 'config.json'), 'utf8');
    await setupBrowserHost(f.project, f.opts);
    expect(fs.readFileSync(path.join(f.dir, 'config.json'), 'utf8')).toBe(before);
    expect(fs.readFileSync(f.logFile, 'utf8').match(/--force-recreate/g)).toHaveLength(1);
  } finally { f.stop(); }
});

test.serial('Serve denial prints sudo, and an unreachable host-mode viewer is unverified', async () => {
  const f = fixture(); try {
    fs.writeFileSync(f.deniedFile, 'yes');
    await expect(setupBrowserHost(f.project, f.opts)).rejects.toThrow('Tailscale Serve failed');
    expect(f.messages.join('\n')).toContain('sudo');
    fs.unlinkSync(f.deniedFile);
    const config = JSON.parse(fs.readFileSync(path.join(f.dir, 'config.json'), 'utf8'));
    config.docker.network_mode = 'host';
    fs.writeFileSync(path.join(f.dir, 'config.json'), JSON.stringify(config));
    await expect(setupBrowserHost(f.project, { ...f.opts, fetch: (async () => { throw new Error('unreachable'); }) })).rejects.toThrow('unverified');
  } finally { f.stop(); }
});

test.serial('missing CLI reports clearly and Windows interop is the final PATH choice', () => {
  const f = fixture(); const oldPath = process.env.PATH; try {
    fs.renameSync(path.join(f.bin, 'tailscale'), path.join(f.bin, 'tailscale.exe'));
    process.env.PATH = f.bin;
    // The macOS app path is absent in this fixture environment.
    expect(tailscaleCLI()).toBe(path.join(f.bin, 'tailscale.exe'));
    fs.unlinkSync(path.join(f.bin, 'tailscale.exe'));
    expect(() => tailscaleCLI()).toThrow('Tailscale CLI missing');
  } finally { process.env.PATH = oldPath; f.stop(); }
});

test.serial('security inputs use the configured domains, network and toggles', () => {
  expect(securityRenderInput({ network: { enabled: true, subnet: 'subnet', gateway: 'gw', netguard_ip: 'ip', additional_domains: ['one'] }, resources: { sysctls_enabled: true } })).toMatchObject({ network: { subnet: 'subnet', gateway: 'gw', netguard_ip: 'ip' }, fleetDomains: [], additionalDomains: ['one'], toggles: { resources: { sysctlsEnabled: true } } });
});
