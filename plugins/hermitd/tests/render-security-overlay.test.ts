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
  cidrToRange, overlaps, pickSubnet, validateCandidate, ipv4SubnetsFromInspect,
} from '../scripts/render-security-overlay';

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

  test('a failed render or unknown subcommand prints {"error"} on stdout', async () => {
    const dir = freshDir();
    const bad = await runScript('render-security-overlay.ts', {
      args: ['render', dir], stdin: JSON.stringify({ toggles: { lan: { enabled: true } } }),
    });
    expect(bad.exitCode).toBe(1);
    expect(JSON.parse(bad.stdout).error).toStartWith('render_failed:');
    expect(fs.existsSync(path.join(dir, 'docker-compose.security.yml'))).toBe(false);
    const usage = await runScript('render-security-overlay.ts', { args: ['nope', dir] });
    expect(usage.exitCode).toBe(1);
    expect(JSON.parse(usage.stdout)).toEqual({ error: 'usage' });
  });
});

// -------------------------------------------------------
// render subcommand — real templates, property assertions
// -------------------------------------------------------
async function renderOverlay(dir: string, input: Record<string, unknown>) {
  const r = await runScript('render-security-overlay.ts', {
    args: ['render', dir], stdin: JSON.stringify(input),
  });
  expect(r.exitCode).toBe(0);
  return r;
}

const overlayPath = (dir: string) => path.join(dir, 'docker-compose.security.yml');
const nftPath = (dir: string) => path.join(dir, '.hermit', 'docker', 'nftables.conf');
const allowPath = (dir: string) => path.join(dir, '.hermit', 'docker', 'dnsmasq.allowlist');

const ALL_ON = {
  network: { subnet: '172.28.0.0/24', gateway: '172.28.0.1', netguard_ip: '172.28.0.2' },
  toggles: {
    lan: { enabled: true, dnsMode: 'enforce' },
    resources: { enabled: true, memLimit: '4g', memswapLimit: '4g', cpus: 2.0, sysctlsEnabled: true },
    audit: { enabled: true },
  },
  publishPorts: [{ target: 3000, published: '3000', protocol: 'tcp', host_ip: '0.0.0.0', mode: 'ingress' }],
  lanAllowlist: ['192.168.1.50', '10.0.0.5'],
  fleetDomains: ['api.strava.com'],
  additionalDomains: ['example.org'],
};

describe('render subcommand — all toggles on', () => {
  test('writes all three files with no {{ }} left', async () => {
    const dir = freshDir();
    const r = await renderOverlay(dir, ALL_ON);
    expect(JSON.parse(r.stdout).written).toHaveLength(3);
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
    expect(nft).toMatch(/^ {8}ip daddr 10\.0\.0\.5 accept$/m);
    expect(nft).toContain('meta skuid != 100 ');
    // The doc-comment reference must not have been mangled into a rule line.
    expect(nft).not.toMatch(/accept is rendered at overlay/);
  });

  test('dnsmasq renders fleet + additional domains as server= lines', async () => {
    const dir = freshDir();
    await renderOverlay(dir, ALL_ON);
    const allow = fs.readFileSync(allowPath(dir), 'utf8');
    expect(allow).toContain('server=/api.strava.com/1.1.1.1');
    expect(allow).toContain('server=/example.org/1.1.1.1');
  });
});

describe('render subcommand — partial toggles', () => {
  test('resources-only (no LAN) writes only the overlay, sysctls on hermit', async () => {
    const dir = freshDir();
    const r = await renderOverlay(dir, {
      toggles: {
        lan: { enabled: false },
        resources: { enabled: true, sysctlsEnabled: true },
        audit: { enabled: false },
      },
    });
    expect(JSON.parse(r.stdout).written).toHaveLength(1);
    expect(fs.existsSync(nftPath(dir))).toBe(false);
    const overlay = fs.readFileSync(overlayPath(dir), 'utf8');
    expect(overlay).not.toContain('hermit-netguard:');
    expect(overlay).toContain('sysctls:');
    expect(overlay).toContain('mem_limit:');
  });

  test('log-only DNS mode sets DNS_LOG_ONLY=1', async () => {
    const dir = freshDir();
    await renderOverlay(dir, {
      network: { subnet: '172.28.0.0/24', gateway: '172.28.0.1', netguard_ip: '172.28.0.2' },
      toggles: { lan: { enabled: true, dnsMode: 'log-only' }, resources: { enabled: false }, audit: { enabled: false } },
      lanAllowlist: [], fleetDomains: [], additionalDomains: [],
    });
    expect(fs.readFileSync(overlayPath(dir), 'utf8')).toContain('- DNS_LOG_ONLY=1');
  });
});
