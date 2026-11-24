// Tests for render-security-overlay.ts.
//
// Subnet-overlap logic is exercised in-process (no docker). One subprocess test
// drives the pick-subnet CLI with docker unreachable to assert graceful
// degrade. The render subcommand renders the REAL security templates into a tmp
// dir and asserts the property contract (indentation is load-bearing for the
// compose overlay merge; no golden fixtures).
//
// Usage: bun test tests/render-security-overlay.test.ts   (from the plugin root)

import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { freshDirFactory } from './helpers/workdir';
import {
  cidrToRange, overlaps, pickSubnet, validateCandidate, ipv4SubnetsFromInspect, renderOverlay as renderOverlayText,
  securityInput, InvalidValue,
} from '../scripts/render-security-overlay';
import { storeDir } from '../scripts/lib/credproxy';
import { storeDir as connectorStoreDir, writeConfig as writeConnectorConfig } from '../scripts/lib/connector';

const { freshDir, cleanup } = freshDirFactory('hermit-rso-');
afterAll(cleanup);

const CANDIDATES = [
  '172.28.0.0/24', '172.29.0.0/24', '172.30.0.0/24', '172.31.0.0/24',
  '10.244.0.0/24', '10.245.0.0/24', '10.246.0.0/24', '10.247.0.0/24',
];

// -------------------------------------------------------
// Pure subnet-overlap logic (no docker)
// -------------------------------------------------------
describe('subnet overlap logic', () => {
  test('cidrToRange rejects malformed / out-of-range input', () => {
    expect(cidrToRange('not-a-cidr')).toBeNull();
    expect(cidrToRange('172.28.0.0')).toBeNull();      // no prefix
    expect(cidrToRange('999.0.0.0/24')).toBeNull();    // octet > 255
    expect(cidrToRange('10.0.0.0/33')).toBeNull();     // prefix > 32
  });

  test('overlaps detects a /24 inside a /16 and disjoint ranges', () => {
    const inner = cidrToRange('172.17.5.0/24')!;
    const outer = cidrToRange('172.17.0.0/16')!;
    expect(overlaps(inner, outer)).toBe(true);
    expect(overlaps(cidrToRange('10.0.0.0/24')!, cidrToRange('11.0.0.0/24')!)).toBe(false);
  });

  test('pickSubnet returns the first candidate when nothing is occupied', () => {
    const r = pickSubnet(CANDIDATES, []);
    expect(r.chosen).toEqual({ subnet: '172.28.0.0/24', gateway: '172.28.0.1', netguard_ip: '172.28.0.2' });
    expect(r.all_candidates_collide).toBe(false);
  });

  test('pickSubnet skips candidates that overlap an occupied subnet', () => {
    // Occupy the first three /24s via covering /16s.
    const occupied = ['172.28.0.0/16', '172.29.0.0/16', '172.30.0.0/16'];
    const r = pickSubnet(CANDIDATES, occupied);
    expect(r.chosen!.subnet).toBe('172.31.0.0/24');
  });

  test('pickSubnet reports all_candidates_collide when every candidate overlaps', () => {
    const occupied = CANDIDATES.map((c) => c.replace('/24', '/16'));
    const r = pickSubnet(CANDIDATES, occupied);
    expect(r.chosen).toBeNull();
    expect(r.all_candidates_collide).toBe(true);
  });

  test('validateCandidate accepts a non-colliding /24 and derives gateway/netguard', () => {
    const r = validateCandidate('192.168.50.0/24', ['172.17.0.0/16']);
    expect(r.chosen).toEqual({ subnet: '192.168.50.0/24', gateway: '192.168.50.1', netguard_ip: '192.168.50.2' });
  });

  test('validateCandidate rejects a non-/24 prefix', () => {
    const r = validateCandidate('192.168.0.0/16', []);
    expect(r.chosen).toBeNull();
    expect(r.all_candidates_collide).toBe(true);
  });

  test('validateCandidate rejects a colliding /24', () => {
    const r = validateCandidate('172.17.5.0/24', ['172.17.0.0/16']);
    expect(r.chosen).toBeNull();
  });

  test('validateCandidate normalizes an operator /24 with host bits to its network address', () => {
    // Docker rejects a subnet whose address has host bits set; the wizard must
    // persist/render the canonical network address, not the raw operator input.
    const r = validateCandidate('192.168.5.10/24', ['172.17.0.0/16']);
    expect(r.chosen).toEqual({ subnet: '192.168.5.0/24', gateway: '192.168.5.1', netguard_ip: '192.168.5.2' });
  });

  test('ipv4SubnetsFromInspect keeps the IPv4 range of a dual-stack network', () => {
    // `{{range .IPAM.Config}}{{.Subnet}} {{end}}` space-joins every subnet; a
    // dual-stack net emits IPv4 + IPv6. The IPv4 half must survive so pickSubnet
    // can't hand back a /24 that overlaps it.
    expect(ipv4SubnetsFromInspect('172.20.0.0/16 fc00::/64')).toEqual(['172.20.0.0/16']);
    expect(ipv4SubnetsFromInspect('172.20.0.0/16 172.21.0.0/16')).toEqual(['172.20.0.0/16', '172.21.0.0/16']);
    expect(ipv4SubnetsFromInspect('fc00::/64')).toEqual([]); // IPv6-only → nothing occupied
    expect(ipv4SubnetsFromInspect('')).toEqual([]);
  });
});

// -------------------------------------------------------
// pick-subnet CLI — graceful degrade when docker is unreachable
// -------------------------------------------------------
describe('pick-subnet CLI (docker absent)', () => {
  test('degrades to first candidate, exits 0, occupied empty', async () => {
    const dir = freshDir();
    const r = await runScript('render-security-overlay.ts', {
      args: ['pick-subnet', dir],
      // PATH at a nonexistent dir → spawnSync('docker') ENOENTs deterministically
      // (an empty PATH still hits execvp's built-in /bin:/usr/bin fallback).
      env: { PATH: '/nonexistent-hermit-test' },
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.occupied).toEqual([]);
    expect(out.chosen.subnet).toBe('172.28.0.0/24');
  });

  test('an invalid config value or unknown subcommand prints {"error"} on stdout and writes nothing', async () => {
    const dir = freshDir();
    writeConfig(dir, { ...ALL_ON, network: { ...ALL_ON.network, lan_allowlist: ['192.168.1.50', '10.0.0.5; drop'] } });
    const bad = await runScript('render-security-overlay.ts', { args: ['render', dir] });
    expect(bad.exitCode).toBe(1);
    expect(JSON.parse(bad.stdout)).toEqual({ error: 'invalid_value:docker.security.network.lan_allowlist.1' });
    expect(fs.existsSync(path.join(dir, 'docker-compose.security.yml'))).toBe(false);
    const usage = await runScript('render-security-overlay.ts', { args: ['nope', dir] });
    expect(usage.exitCode).toBe(1);
    expect(JSON.parse(usage.stdout)).toEqual({ error: 'usage' });
  });
});

// -------------------------------------------------------
// render subcommand — real templates, property assertions
// -------------------------------------------------------
function writeConfig(dir: string, security: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  fs.mkdirSync(path.join(dir, '.hermit'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.hermit', 'config.json'), JSON.stringify({ ...extra, docker: { security } }));
}

async function renderOverlay(dir: string, security: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  writeConfig(dir, security, extra);
  const r = await runScript('render-security-overlay.ts', { args: ['render', dir] });
  expect(r.exitCode).toBe(0);
  return r;
}

const overlayPath = (dir: string) => path.join(dir, 'docker-compose.security.yml');
const nftPath = (dir: string) => path.join(dir, '.hermit', 'docker', 'nftables.conf');
const allowPath = (dir: string) => path.join(dir, '.hermit', 'docker', 'dnsmasq.allowlist');
const includePath = (dir: string) => path.join(dir, '.hermit', 'docker', 'dnsmasq.hermit-local.conf');

const NETWORK = { subnet: '172.28.0.0/24', gateway: '172.28.0.1', netguard_ip: '172.28.0.2' };
const ALL_ON = {
  network: {
    enabled: true, dns_mode: 'enforce', ...NETWORK,
    publish_ports: [{ target: 3000, published: '3000', protocol: 'tcp', host_ip: '0.0.0.0', mode: 'ingress' }],
    lan_allowlist: ['192.168.1.50', '10.0.0.0/24'],
    additional_domains: ['api.strava.com', 'example.org'],
  },
  resources: { enabled: true, mem_limit: '4g', memswap_limit: '4g', cpus: 2.0, sysctls_enabled: true },
  audit: { plugin_installs: true },
};

describe('render subcommand — all toggles on', () => {
  test('writes all five files with no {{ }} left', async () => {
    const dir = freshDir();
    const r = await renderOverlay(dir, ALL_ON);
    expect(JSON.parse(r.stdout)).toEqual({ status: 'rendered', written: [
      'docker-compose.security.yml', '.hermit/docker/Dockerfile.hermit-netguard', '.hermit/docker/netguard-entrypoint.sh',
      '.hermit/docker/nftables.conf', '.hermit/docker/dnsmasq.allowlist',
    ] });
    expect(fs.statSync(path.join(dir, '.hermit/docker/netguard-entrypoint.sh')).mode & 0o777).toBe(0o755);
    for (const p of [overlayPath(dir), nftPath(dir), allowPath(dir)]) {
      expect(fs.readFileSync(p, 'utf8')).not.toMatch(/\{\{[A-Z][A-Z0-9_]*\}\}/);
    }
  });

  test('hermit and hermit-netguard services align at 2-space indent (merge-critical)', async () => {
    const dir = freshDir();
    await renderOverlay(dir, ALL_ON);
    const overlay = fs.readFileSync(overlayPath(dir), 'utf8');
    expect(overlay).toMatch(/^ {2}hermit:$/m);
    expect(overlay).toMatch(/^ {2}hermit-netguard:$/m);
    // A 4-space service key would silently corrupt the compose merge.
    expect(overlay).not.toMatch(/^ {4}hermit(-netguard)?:$/m);
  });

  test('netguard cap_add list and healthcheck start_period render (retargeted from SKILL)', async () => {
    const dir = freshDir();
    await renderOverlay(dir, ALL_ON);
    const overlay = fs.readFileSync(overlayPath(dir), 'utf8');
    expect(overlay).toContain('cap_add: [NET_ADMIN, NET_BIND_SERVICE, SETUID, SETGID]');
    expect(overlay).toContain('start_period: 5s');
  });

  test('DNS enforce mode sets DNS_LOG_ONLY=0', async () => {
    const dir = freshDir();
    await renderOverlay(dir, ALL_ON);
    expect(fs.readFileSync(overlayPath(dir), 'utf8')).toContain('- DNS_LOG_ONLY=0');
  });

  test('nftables LAN carve-outs render at 8-space chain-body indent, uid=100', async () => {
    const dir = freshDir();
    await renderOverlay(dir, ALL_ON);
    const nft = fs.readFileSync(nftPath(dir), 'utf8');
    expect(nft).toMatch(/^ {8}ip daddr 192\.168\.1\.50 accept$/m);
    expect(nft).toMatch(/^ {8}ip daddr 10\.0\.0\.0\/24 accept$/m);
    expect(nft).toContain('meta skuid != 100 ');
    // The doc-comment reference must not have been mangled into a rule line.
    expect(nft).not.toMatch(/accept is rendered at overlay/);
  });

  test('dnsmasq renders additional domains as server= lines', async () => {
    const dir = freshDir();
    await renderOverlay(dir, ALL_ON);
    const allow = fs.readFileSync(allowPath(dir), 'utf8');
    expect(allow).toContain('server=/api.strava.com/1.1.1.1');
    expect(allow).toContain('server=/example.org/1.1.1.1');
  });
});

describe('render subcommand: egress enforcement', () => {
  const LOG_ONLY = { network: { enabled: true, dns_mode: 'log-only', ...NETWORK } };

  test('enforce mode drops by default and accepts only resolved sets and dnsmasq upstream', async () => {
    const dir = freshDir();
    await renderOverlay(dir, ALL_ON);
    const nft = fs.readFileSync(nftPath(dir), 'utf8');
    expect(nft).toContain('policy drop;');
    expect(nft).toMatch(/^ {4}set allow4 \{ type ipv4_addr; \}$/m);
    expect(nft).toMatch(/^ {8}ip daddr @allow4 accept$/m);
    expect(nft).toMatch(/^ {8}ip6 daddr @allow6 accept$/m);
    expect(nft).toMatch(/^ {8}meta skuid 100 meta l4proto \{ tcp, udp \} th dport 53 accept$/m);
    expect(nft).toMatch(/^ {8}icmpv6 type \{ nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit \} accept$/m);
    // Carve-outs accept before the default drop.
    expect(nft.indexOf('ip daddr 192.168.1.50 accept')).toBeLessThan(nft.indexOf('@allow4 accept'));
  });

  test('log-only mode keeps the accept policy and adds no egress rules', async () => {
    const dir = freshDir();
    await renderOverlay(dir, LOG_ONLY);
    const nft = fs.readFileSync(nftPath(dir), 'utf8');
    expect(nft).toContain('policy accept;');
    expect(nft).not.toContain('@allow4 accept');
  });

  test('channel and voice-note hosts follow config.json', async () => {
    const dir = freshDir();
    await renderOverlay(dir, LOG_ONLY, {
      channels: { telegram: { enabled: true }, discord: { enabled: false } },
      transcription: { enabled: false },
    });
    const allow = fs.readFileSync(allowPath(dir), 'utf8');
    expect(allow).toContain('server=/telegram.org/1.1.1.1');
    expect(allow).not.toContain('discord.com');
    expect(allow).not.toContain('huggingface.co');
  });

  test('transcription hosts render when the block is absent (enabled by default)', async () => {
    const dir = freshDir();
    await renderOverlay(dir, LOG_ONLY);
    const allow = fs.readFileSync(allowPath(dir), 'utf8');
    expect(allow).toContain('server=/huggingface.co/1.1.1.1');
    expect(allow).not.toContain('telegram.org');
  });

  test('rule files are image build inputs, never mounted from the project folder', async () => {
    const dir = freshDir();
    await renderOverlay(dir, LOG_ONLY);
    const overlay = Bun.YAML.parse(fs.readFileSync(overlayPath(dir), 'utf8')) as any;
    expect(overlay.services['hermit-netguard'].volumes).toBeUndefined();
    expect(overlay.services.hermit.volumes).toBeUndefined();
    const dockerfile = fs.readFileSync(path.join(import.meta.dir, '..', 'state-templates', 'docker', 'security',
      'Dockerfile.hermit-netguard.template'), 'utf8');
    expect(dockerfile).toContain('COPY nftables.conf /etc/nftables.conf');
    expect(dockerfile).toContain('COPY dnsmasq.allowlist /etc/dnsmasq.allowlist');
  });

  test('netguard logs are capped on a pinned json-file driver', async () => {
    const dir = freshDir();
    await renderOverlay(dir, LOG_ONLY);
    const overlay = Bun.YAML.parse(fs.readFileSync(overlayPath(dir), 'utf8')) as any;
    expect(overlay.services['hermit-netguard'].logging).toEqual({
      driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' },
    });
  });
});

describe('credential proxy sidecar', () => {
  const host = { store: '/cfg/hermitd/credproxy/p-0123', uid: 1000, gid: 1000 };
  const LAN = { network: NETWORK, toggles: { lan: { enabled: true, dnsMode: 'enforce' as const } } };

  test('joins the agent and mounts only the store folders read-only', () => {
    const overlay = Bun.YAML.parse(renderOverlayText({ toggles: { credproxy: { enabled: true } } }, host)) as any;
    const proxy = overlay.services['hermit-credproxy'];
    expect(proxy).toMatchObject({
      image: 'envoyproxy/envoy:distroless-v1.40.2', user: '1000:1000', network_mode: 'service:hermit',
      cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'], pids_limit: 256, restart: 'unless-stopped',
      volumes: [`${host.store}/sidecar:/etc/envoy:ro`],
    });
    expect(proxy.ports).toBeUndefined();
    expect(proxy.networks).toBeUndefined();
    expect(overlay.services.hermit.volumes).toEqual([`${host.store}/agent:/run/hermit-credproxy:ro`]);
    expect(overlay.services.hermit.depends_on).toBeUndefined();
  });

  test('joins netguard with LAN containment on', () => {
    const overlay = Bun.YAML.parse(renderOverlayText({ ...LAN, toggles: { ...LAN.toggles, credproxy: { enabled: true } } }, host)) as any;
    expect(overlay.services['hermit-credproxy'].network_mode).toBe('service:hermit-netguard');
    expect(overlay.services.hermit.network_mode).toBe('service:hermit-netguard');
    expect(overlay.services.hermit.volumes).toEqual([`${host.store}/agent:/run/hermit-credproxy:ro`]);
  });

  test('off or absent leaves the overlay byte-identical', () => {
    const allOn = { network: NETWORK, toggles: { lan: { enabled: true, dnsMode: 'enforce' as const }, resources: { enabled: true, sysctlsEnabled: true }, audit: { enabled: true } } };
    for (const input of [allOn, LAN, { toggles: {} }]) {
      const off = renderOverlayText({ ...input, toggles: { ...input.toggles, credproxy: { enabled: false } } } as any, host);
      expect(off).toBe(renderOverlayText(input as any));
      expect(off).not.toContain('credproxy');
    }
  });

  test('uid 100 with LAN containment is refused', () => {
    expect(() => renderOverlayText({ ...LAN, toggles: { ...LAN.toggles, credproxy: { enabled: true } } }, { ...host, uid: 100 })).toThrow(/uid 100/);
  });

  test('the render subcommand mounts this project\'s store and prepares its folders', async () => {
    const dir = freshDir();
    const home = freshDir();
    const config = path.join(home, '.claude');
    const real = freshDir();
    writeConfig(dir, { credential_proxy: { enabled: true } });
    const r = await runScript('render-security-overlay.ts', {
      args: ['render', dir, '--store-project', real], env: { HOME: home },
    });
    expect(r.exitCode).toBe(0);
    // A render in the approved copy names the real project's store, never the copy's.
    const store = storeDir(real, config);
    const overlay = Bun.YAML.parse(fs.readFileSync(overlayPath(dir), 'utf8')) as any;
    expect(overlay.services['hermit-credproxy'].user).toBe(`${process.getuid!()}:${process.getgid!()}`);
    expect(overlay.services['hermit-credproxy'].volumes).toEqual([`${store}/sidecar:/etc/envoy:ro`]);
    expect(fs.statSync(path.join(store, 'sidecar')).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(path.join(store, 'agent'))).toBe(true);
  });
});

describe('connector service', () => {
  const connector = { store: '/cfg/hermitd/connector/p-0123', port: 8790, uid: 1000, gid: 1000 };
  const proxy = { store: '/cfg/hermitd/credproxy/p-0123', uid: 1000, gid: 1000 };

  test('runs in its own namespace, publishes only on host loopback, and gives the agent the socket folder read-only', () => {
    const overlay = Bun.YAML.parse(renderOverlayText({ toggles: {} }, undefined, connector)) as any;
    expect(overlay.services['hermit-connector']).toMatchObject({
      image: 'oven/bun:1.4.5-distroless', command: ['/connector/sidecar/gateway.ts', '/connector'], user: '1000:1000',
      environment: ['CONNECTOR_HOSTNAME=0.0.0.0'], cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
      restart: 'unless-stopped', ports: ['127.0.0.1:8790:8790'],
      volumes: [`${connector.store}/sidecar:/connector/sidecar:ro`, `${connector.store}/data:/connector/data`, `${connector.store}/bridge:/connector/bridge`],
    });
    expect(overlay.services['hermit-connector'].network_mode).toBeUndefined();
    expect(overlay.services.hermit.volumes).toEqual([`${connector.store}/bridge:/run/hermit-connector:ro`]);
    expect(overlay.services.hermit.ports).toBeUndefined();
  });

  test('shares one agent volumes block with the credential proxy and leaves netguard without ports', () => {
    const LAN = { network: NETWORK, toggles: { lan: { enabled: true, dnsMode: 'enforce' as const }, credproxy: { enabled: true } } };
    const overlay = Bun.YAML.parse(renderOverlayText(LAN, proxy, connector)) as any;
    expect(overlay.services.hermit.volumes).toEqual([`${proxy.store}/agent:/run/hermit-credproxy:ro`, `${connector.store}/bridge:/run/hermit-connector:ro`]);
    expect(overlay.services['hermit-netguard'].ports).toBeUndefined();
    expect(overlay.services['hermit-connector'].network_mode).toBeUndefined();
  });

  test('absent leaves the overlay byte-identical', () => {
    for (const input of [{ toggles: {} }, { network: NETWORK, toggles: { lan: { enabled: true, dnsMode: 'enforce' as const } } }]) {
      expect(renderOverlayText(input as any, undefined, undefined)).toBe(renderOverlayText(input as any));
      expect(renderOverlayText(input as any)).not.toContain('connector');
    }
  });

  test('host networking or a corrupt settings file leaves the connector out instead of failing the render', async () => {
    for (const [extra, settings] of [[{ docker: { network_mode: 'host' } }, null], [{}, '{"port":']] as const) {
      const dir = freshDir();
      const home = freshDir();
      const real = freshDir();
      fs.mkdirSync(path.join(dir, '.hermit'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.hermit', 'config.json'), JSON.stringify({ docker: { ...(extra as any).docker, security: { audit: { plugin_installs: true } } } }));
      const store = connectorStoreDir(real, path.join(home, '.claude'));
      writeConnectorConfig(store, { port: 8790, public_url: 'https://agent.example.com', wait_seconds: 25, rate_per_hour: 60 });
      if (settings) fs.writeFileSync(path.join(store, 'sidecar', 'connector.json'), settings);
      const r = await runScript('render-security-overlay.ts', { args: ['render', dir, '--store-project', real], env: { HOME: home } });
      expect(r.exitCode).toBe(0);
      expect(fs.readFileSync(overlayPath(dir), 'utf8')).not.toContain('hermit-connector');
    }
  });

  test('the render subcommand renders the overlay when the connector is the only thing on', async () => {
    const dir = freshDir();
    const home = freshDir();
    const real = freshDir();
    writeConfig(dir, {});
    const store = connectorStoreDir(real, path.join(home, '.claude'));
    writeConnectorConfig(store, { port: 8790, public_url: 'https://agent.example.com', wait_seconds: 25, rate_per_hour: 60 });
    const r = await runScript('render-security-overlay.ts', { args: ['render', dir, '--store-project', real], env: { HOME: home } });
    expect(r.exitCode).toBe(0);
    const overlay = Bun.YAML.parse(fs.readFileSync(overlayPath(dir), 'utf8')) as any;
    expect(overlay.services['hermit-connector'].user).toBe(`${process.getuid!()}:${process.getgid!()}`);
    expect(overlay.services.hermit.volumes).toEqual([`${store}/bridge:/run/hermit-connector:ro`]);
  });
});

describe('mcp-hosts subcommand', () => {
  test('lists remote server hostnames once, skipping stdio, IPs and localhost', async () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: {
      linear: { type: 'http', url: 'https://mcp.linear.app/mcp' },
      linear2: { type: 'sse', url: 'https://MCP.linear.app./sse' },
      templated: { type: 'http', url: 'https://mcp.example.com:${PORT}/mcp' },
      local: { command: 'node', args: ['server.js'] },
      lan: { type: 'http', url: 'http://192.168.1.9:8080/mcp' },
      dev: { type: 'http', url: 'http://localhost:3000/mcp' },
    } }));
    const r = await runScript('render-security-overlay.ts', { args: ['mcp-hosts', dir] });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ hosts: [{ host: 'mcp.linear.app', server: 'linear' }] });
  });

  test('a missing .mcp.json yields no hosts', async () => {
    const r = await runScript('render-security-overlay.ts', { args: ['mcp-hosts', freshDir()] });
    expect(JSON.parse(r.stdout)).toEqual({ hosts: [] });
  });
});

describe('render subcommand — partial toggles', () => {
  test('resources-only (no LAN) writes only the overlay, sysctls on hermit', async () => {
    const dir = freshDir();
    const r = await renderOverlay(dir, { network: { enabled: false }, resources: { enabled: true, sysctls_enabled: true } });
    expect(JSON.parse(r.stdout).written).toEqual(['docker-compose.security.yml']);
    expect(fs.existsSync(nftPath(dir))).toBe(false);
    const overlay = fs.readFileSync(overlayPath(dir), 'utf8');
    expect(overlay).not.toContain('hermit-netguard:');
    expect(overlay).toContain('sysctls:');
    expect(overlay).toContain('mem_limit:');
  });

  test('log-only DNS mode sets DNS_LOG_ONLY=1', async () => {
    const dir = freshDir();
    await renderOverlay(dir, { network: { enabled: true, dns_mode: 'log-only', ...NETWORK }, resources: { enabled: false } });
    expect(fs.readFileSync(overlayPath(dir), 'utf8')).toContain('- DNS_LOG_ONLY=1');
  });
});

describe('render outcomes and validation', () => {
  test('no toggle on is disabled and removes the five files, a link only unlinked', async () => {
    const dir = freshDir();
    await renderOverlay(dir, ALL_ON);
    const outside = path.join(freshDir(), 'target');
    fs.writeFileSync(outside, 'keep');
    fs.rmSync(nftPath(dir));
    fs.symlinkSync(outside, nftPath(dir));
    const r = await renderOverlay(dir, { network: { enabled: false }, managed_ceiling: true });
    expect(JSON.parse(r.stdout).status).toBe('disabled');
    expect(JSON.parse(r.stdout).removed).toHaveLength(5);
    expect(fs.existsSync(overlayPath(dir))).toBe(false);
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
  });

  test('LAN containment without a subnet is skipped and writes nothing', async () => {
    const dir = freshDir();
    const r = await renderOverlay(dir, { network: { enabled: true, dns_mode: 'enforce' } });
    expect(JSON.parse(r.stdout)).toEqual({ status: 'skipped', reason: 'incomplete_config' });
    expect(fs.existsSync(overlayPath(dir))).toBe(false);
  });

  test('the mapper accepts the wizard\'s bare IPv4 carve-out and rejects each bad value by its path', () => {
    expect(securityInput(ALL_ON)).toMatchObject({ status: 'rendered', input: { lanAllowlist: ['192.168.1.50', '10.0.0.0/24'] } });
    const bad: [Record<string, unknown>, string][] = [
      [{ network: { ...ALL_ON.network, additional_domains: ['Bad Domain'] } }, 'docker.security.network.additional_domains.0'],
      [{ network: { ...ALL_ON.network, subnet: '172.28.0.0' } }, 'docker.security.network.subnet'],
      [{ network: { ...ALL_ON.network, gateway: '172.28.0.1\n' } }, 'docker.security.network.gateway'],
      [{ network: { ...ALL_ON.network, dns_mode: 'strict' } }, 'docker.security.network.dns_mode'],
      [{ network: { ...ALL_ON.network, publish_ports: [{ target: 3000, published: '3000', host_ip: '0.0.0.0\n  privileged: true' }] } }, 'docker.security.network.publish_ports.0.host_ip'],
      [{ network: { ...ALL_ON.network, publish_ports: [{ target: 3000, published: '3000', protocol: 'sctp' }] } }, 'docker.security.network.publish_ports.0.protocol'],
      [{ network: { ...ALL_ON.network, publish_ports: [{ target: 3000, published: '3000', mode: 'x' }] } }, 'docker.security.network.publish_ports.0.mode'],
      [{ network: { ...ALL_ON.network, publish_ports: [{ target: 'x', published: '3000' }] } }, 'docker.security.network.publish_ports.0.target'],
      [{ resources: { enabled: true, mem_limit: '4g\nprivileged: true' } }, 'docker.security.resources.mem_limit'],
      [{ resources: { enabled: true, cpus: '2; x' } }, 'docker.security.resources.cpus'],
    ];
    for (const [patch, where] of bad) expect(() => securityInput({ ...ALL_ON, ...patch })).toThrow(new InvalidValue(where));
  });

  test('a link at a generated path is replaced, not followed', async () => {
    const dir = freshDir();
    const outside = path.join(freshDir(), 'target');
    fs.writeFileSync(outside, 'keep');
    fs.mkdirSync(path.join(dir, '.hermit', 'docker'), { recursive: true });
    fs.symlinkSync(outside, allowPath(dir));
    await renderOverlay(dir, ALL_ON);
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
    expect(fs.lstatSync(allowPath(dir)).isSymbolicLink()).toBe(false);
  });

  test('a linked include file is refused', async () => {
    const dir = freshDir();
    writeConfig(dir, ALL_ON);
    fs.mkdirSync(path.join(dir, '.hermit', 'docker'), { recursive: true });
    fs.symlinkSync('/etc/hostname', includePath(dir));
    const r = await runScript('render-security-overlay.ts', { args: ['render', dir] });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).error).toStartWith('render_failed:');
  });

  test('include lines land above the catchall', async () => {
    const dir = freshDir();
    fs.mkdirSync(path.join(dir, '.hermit', 'docker'), { recursive: true });
    fs.writeFileSync(includePath(dir), '# mine\naddress=/nas.lan/192.168.1.9\n\nserver=/corp.example/10.0.0.53\n');
    await renderOverlay(dir, ALL_ON);
    const allow = fs.readFileSync(allowPath(dir), 'utf8');
    for (const line of ['# mine', 'address=/nas.lan/192.168.1.9', 'server=/corp.example/10.0.0.53']) {
      expect(allow).toContain(line);
      expect(allow.indexOf(line)).toBeLessThan(allow.lastIndexOf('address=/#/'));
    }
  });
});

describe('migrate-allowlist', () => {
  // The allowlist as the hermitd--v1.4.34 wizard rendered it, plus hand-added lines.
  const LEGACY = `# dnsmasq allowlist for the hermit-netguard sidecar.
# To add a domain at runtime, edit this file in
# .hermit/docker/dnsmasq.allowlist and run
# \`hermitd-docker down && hermitd-docker up\`
# (restart hermit-netguard alone leaves hermit with stale resolver state).

listen-address=127.0.0.1
no-hosts
no-resolv

# --- Core hermit operation ---
server=/anthropic.com/1.1.1.1
server=/github.com/1.1.1.1
# Channel APIs
server=/discord.com/1.1.1.1
server=/telegram.org/1.1.1.1
# Voice-note engine and model downloads and credential-enabled cloud fallback
server=/api.openai.com/1.1.1.1
address=/api.openai.com/10.0.0.20

# --- Operator additions (from /docker-security Prompt 1c) ---
server=/example.org/1.1.1.1
server=/example.org/192.168.1.53
server=/cdn.discordapp.com/9.9.9.9
server=/db/127.0.0.11

# Catchall: NXDOMAIN for everything else (requires no-resolv above to work correctly).
address=/#/
`;
  const NFT = 'table inet firewall {\n  chain output {\n        ip daddr 192.168.1.50 accept\n        ip daddr 10.9.9.9 accept\n  }\n}\n';

  function legacyProject() {
    const dir = freshDir();
    writeConfig(dir, { network: { enabled: true, dns_mode: 'enforce', ...NETWORK, lan_allowlist: ['192.168.1.50'], additional_domains: ['example.org'] } });
    fs.mkdirSync(path.join(dir, '.hermit', 'docker'), { recursive: true });
    fs.writeFileSync(allowPath(dir), LEGACY);
    fs.writeFileSync(nftPath(dir), NFT);
    return dir;
  }
  const kept = ['address=/api.openai.com/10.0.0.20', 'server=/example.org/192.168.1.53', 'server=/cdn.discordapp.com/9.9.9.9', 'server=/db/127.0.0.11'];

  test('keeps every operator line, drops exact defaults, reports pins and carve-outs, and runs once', async () => {
    const dir = legacyProject();
    const r = await runScript('render-security-overlay.ts', { args: ['migrate-allowlist', dir] });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ moved: 4, carve_outs_missing: ['10.9.9.9'], pins_needing_carve_out: ['10.0.0.20'] });
    const include = fs.readFileSync(includePath(dir), 'utf8');
    for (const line of kept) expect(include).toContain(line);
    for (const line of ['server=/anthropic.com/1.1.1.1', 'server=/example.org/1.1.1.1', 'server=/discord.com/1.1.1.1', 'no-resolv', 'address=/#/', '# Channel APIs']) {
      expect(include.split('\n')).not.toContain(line);
    }
    expect(fs.readFileSync(allowPath(dir), 'utf8')).toBe(LEGACY);
    const again = await runScript('render-security-overlay.ts', { args: ['migrate-allowlist', dir] });
    expect(JSON.parse(again.stdout)).toEqual({ moved: 0, carve_outs_missing: [], pins_needing_carve_out: [] });
    expect(fs.readFileSync(includePath(dir), 'utf8')).toBe(include);
  });

  test('after the migration a render carries the moved lines', async () => {
    const dir = legacyProject();
    await runScript('render-security-overlay.ts', { args: ['migrate-allowlist', dir] });
    const r = await runScript('render-security-overlay.ts', { args: ['render', dir] });
    expect(r.exitCode).toBe(0);
    const allow = fs.readFileSync(allowPath(dir), 'utf8');
    for (const line of kept) expect(allow).toContain(line);
  });
});

test('viewer publishes on netguard loopback only', async () => {
  const { renderOverlay } = await import('../scripts/render-security-overlay');
  const overlay = Bun.YAML.parse(renderOverlay({
    network: { subnet: '172.28.0.0/24', gateway: '172.28.0.1', netguard_ip: '172.28.0.2' },
    toggles: { lan: { enabled: true } },
    publishPorts: [{ target: 6080, published: '6090', host_ip: '127.0.0.1', protocol: 'tcp' }],
  })) as any;
  expect(overlay.services['hermit-netguard'].ports).toEqual([{ target: 6080, published: '6090', host_ip: '127.0.0.1', protocol: 'tcp' }]);
  expect(overlay.services.hermit.ports).toBeUndefined();
});
