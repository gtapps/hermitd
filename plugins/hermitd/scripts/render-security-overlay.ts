#!/usr/bin/env bun
/**
 * Deterministic rendering for /docker-security. Two subcommands:
 *
 *   pick-subnet <project-root> [--candidate <cidr>]
 *     Enumerates occupied Docker subnets, excludes this project's own
 *     hermit-net, and walks the 8 fixed /24 candidates for the first that does
 *     not overlap. With --candidate, validates an operator-supplied /24 (prefix
 *     + collision) so the AskUserQuestion retry loop is one cheap call. Always
 *     exits 0 — the caller inspects fields, not the exit code (probe pattern).
 *     Output: { chosen: {subnet, gateway, netguard_ip} | null,
 *               all_candidates_collide: bool, occupied: [...] }
 *
 *   render <project-root>
 *     Renders docker-compose.security.yml + nftables.conf + dnsmasq.allowlist
 *     from operator selections on stdin. All three render in memory and pass the
 *     fail-loud placeholder check before anything is written; any failure →
 *     {"error":"render_failed:<detail>"}, exit 1, nothing written. Output: { written: [...] }.
 *     stdin JSON:
 *       {
 *         "network": { "subnet": "172.28.0.0/24", "gateway": "172.28.0.1", "netguard_ip": "172.28.0.2" },
 *         "toggles": {
 *           "lan":       { "enabled": true, "dnsMode": "log-only" | "enforce" },
 *           "resources": { "enabled": true, "memLimit": "4g", "memswapLimit": "4g", "cpus": 2.0, "sysctlsEnabled": true },
 *           "audit":     { "enabled": true }
 *         },
 *         "publishPorts": [ { "target": 3000, "published": "3000", "protocol": "tcp", "host_ip": "0.0.0.0", "mode": "ingress" } ],
 *         "lanAllowlist": ["192.168.1.50", ...],
 *         "fleetDomains": ["api.strava.com", ...],
 *         "additionalDomains": ["example.org", ...]
 *       }
 *     network is required only when toggles.lan.enabled; pick-subnet's `chosen` passes as-is.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderTemplate } from './lib/render-template';
import { exitError } from './lib/cli';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');
const SECURITY_DIR = path.join(PLUGIN_ROOT, 'state-templates', 'docker', 'security');

const DNSMASQ_UID = '100'; // Alpine dnsmasq's static UID — see docker-security SKILL step 6a.

const CANDIDATES = [
  '172.28.0.0/24', '172.29.0.0/24', '172.30.0.0/24', '172.31.0.0/24',
  '10.244.0.0/24', '10.245.0.0/24', '10.246.0.0/24', '10.247.0.0/24',
];

// ---------------------------------------------------------------------------
// Pure subnet-overlap logic (exported — tests exercise it without docker).
// ---------------------------------------------------------------------------

export type Range = [number, number];

export function cidrToRange(cidr: string): Range | null {
  const m = String(cidr).trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return null;
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  if (octets.some((o) => o > 255)) return null;
  const prefix = Number(m[5]);
  if (prefix > 32) return null;
  const ip = octets[0] * 2 ** 24 + octets[1] * 2 ** 16 + octets[2] * 2 ** 8 + octets[3];
  const size = 2 ** (32 - prefix);
  const network = Math.floor(ip / size) * size;
  return [network, network + size - 1];
}

export function overlaps(a: Range, b: Range): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

export interface Chosen {
  subnet: string;
  gateway: string;
  netguard_ip: string;
}

// derive is only ever called with a /24 (CANDIDATES are /24; validateCandidate
// enforces /24). Normalize to the network address so an operator-supplied CIDR
// with host bits set (e.g. 192.168.5.10/24) renders as 192.168.5.0/24: Docker
// rejects a subnet whose address has host bits ("it should be 192.168.5.0/24").
function derive(subnet: string): Chosen {
  const o = subnet.split('/')[0].split('.');
  const base = `${o[0]}.${o[1]}.${o[2]}`;
  return { subnet: `${base}.0/24`, gateway: `${base}.1`, netguard_ip: `${base}.2` };
}

export interface PickResult {
  chosen: Chosen | null;
  all_candidates_collide: boolean;
  occupied: string[];
}

/** Walk `candidates`, return the first that overlaps no occupied subnet. */
export function pickSubnet(candidates: string[], occupied: string[]): PickResult {
  const occRanges = occupied
    .map(cidrToRange)
    .filter((r): r is Range => r !== null);
  for (const cand of candidates) {
    const cr = cidrToRange(cand);
    if (!cr) continue;
    if (!occRanges.some((o) => overlaps(cr, o))) {
      return { chosen: derive(cand), all_candidates_collide: false, occupied };
    }
  }
  return { chosen: null, all_candidates_collide: true, occupied };
}

/** Validate an operator-supplied /24 against the occupied set. */
export function validateCandidate(candidate: string, occupied: string[]): PickResult {
  const cr = cidrToRange(candidate);
  const isSlash24 = /\/24$/.test(String(candidate).trim());
  if (!cr || !isSlash24) {
    return { chosen: null, all_candidates_collide: true, occupied };
  }
  const occRanges = occupied.map(cidrToRange).filter((r): r is Range => r !== null);
  if (occRanges.some((o) => overlaps(cr, o))) {
    return { chosen: null, all_candidates_collide: true, occupied };
  }
  return { chosen: derive(candidate.trim()), all_candidates_collide: false, occupied };
}

/**
 * Extract the parseable IPv4 subnets from a `docker network inspect` subnet
 * field (space-separated when a network is dual-stack). Drops IPv6 / unparseable
 * entries but keeps the IPv4 range (dropping the whole net on an unparseable
 * IPv6 half would hide its real IPv4 range from the overlap check).
 */
export function ipv4SubnetsFromInspect(subnetField: string): string[] {
  return (subnetField ?? '').trim().split(/\s+/).filter((s) => cidrToRange(s) !== null);
}

// ---------------------------------------------------------------------------
// Impure docker enumeration (mirrors docker-preflight's spawnSync + timeouts).
// ---------------------------------------------------------------------------

function ownProjectName(projectRoot: string): string {
  try {
    const r = spawnSync('docker', ['compose', '-f', 'docker-compose.hermit.yml', 'config', '--format', 'json'],
      { cwd: projectRoot, timeout: 10000, encoding: 'utf8' });
    if (r.status === 0 && r.stdout) {
      const j = JSON.parse(r.stdout);
      if (j && typeof j.name === 'string' && j.name) return j.name;
    }
  } catch {}
  return path.basename(projectRoot);
}

/** Enumerate occupied IPv4 subnets, excluding this project's own hermit-net. */
export function gatherOccupied(projectRoot: string): string[] {
  const occupied: string[] = [];
  let nets: string[];
  try {
    const ls = spawnSync('docker', ['network', 'ls', '--format', '{{.Name}}'],
      { timeout: 10000, encoding: 'utf8' });
    if (ls.status !== 0 || !ls.stdout) return occupied;
    nets = ls.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return occupied;
  }
  const projectName = ownProjectName(projectRoot);
  for (const net of nets) {
    try {
      const insp = spawnSync('docker', ['network', 'inspect', net,
        '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}|||{{json .Labels}}'],
        { timeout: 5000, encoding: 'utf8' });
      if (insp.status !== 0 || !insp.stdout) continue;
      const [subnetPart, labelsPart] = insp.stdout.trim().split('|||');
      const subnets = ipv4SubnetsFromInspect(subnetPart);
      if (subnets.length === 0) continue; // no IPv4 subnet on this net
      let labels: any = {};
      try { labels = JSON.parse(labelsPart || '{}') || {}; } catch {}
      if (labels['com.docker.compose.project'] === projectName
        && labels['com.docker.compose.network'] === 'hermit-net') continue;
      occupied.push(...subnets);
    } catch { /* skip this network */ }
  }
  return occupied;
}

// ---------------------------------------------------------------------------
// Overlay / nftables / dnsmasq rendering (pure — exported for tests).
// ---------------------------------------------------------------------------

interface Port {
  target: number | string;
  published: number | string;
  host_ip?: string;
  protocol?: string;
  mode?: string;
}
interface Toggles {
  lan?: { enabled?: boolean; dnsMode?: 'log-only' | 'enforce' };
  resources?: { enabled?: boolean; memLimit?: string; memswapLimit?: string; cpus?: number | string; sysctlsEnabled?: boolean };
  audit?: { enabled?: boolean };
}
export interface RenderInput {
  network?: Chosen;
  toggles: Toggles;
  publishPorts?: Port[];
  lanAllowlist?: string[];
  fleetDomains?: string[];
  additionalDomains?: string[];
}

const SYSCTLS_ITEMS = [
  'net.ipv4.conf.all.accept_redirects=0',
  'net.ipv4.conf.all.send_redirects=0',
  'net.ipv4.conf.all.accept_source_route=0',
  'net.ipv4.conf.default.accept_redirects=0',
];

function sysctlsBlock(keyIndent: string): string {
  const item = keyIndent + '  ';
  return `${keyIndent}sysctls:\n` + SYSCTLS_ITEMS.map((s) => `${item}- ${s}`).join('\n');
}

function portsBlock(ports: Port[], keyIndent: string): string {
  const item = keyIndent + '  ';
  const field = item + '  ';
  const lines = [`${keyIndent}ports:`];
  for (const p of ports) {
    lines.push(`${item}- target: ${p.target}`);
    lines.push(`${field}published: "${p.published}"`);
    if (p.host_ip && p.host_ip !== '0.0.0.0') lines.push(`${field}host_ip: ${p.host_ip}`);
    lines.push(`${field}protocol: ${p.protocol ?? 'tcp'}`);
    if (p.mode && p.mode !== 'ingress') lines.push(`${field}mode: ${p.mode}`);
  }
  return lines.join('\n');
}

function netguardService(net: Chosen, dnsMode: string, sysctls: string, ports: string): string {
  const dnsLogOnly = dnsMode === 'log-only' ? '1' : '0';
  const lines = [
    '  hermit-netguard:',
    '    build:',
    '      context: ./.hermit/docker',
    '      dockerfile: Dockerfile.hermit-netguard',
    "    # NET_BIND_SERVICE: dnsmasq retains it post-bind-drop. SETUID+SETGID:",
    "    # drops to UID/GID 100 (Alpine's `dnsmasq` user).",
    '    cap_add: [NET_ADMIN, NET_BIND_SERVICE, SETUID, SETGID]',
    '    cap_drop: [ALL]',
    '    security_opt:',
    '      - no-new-privileges:true',
    '    pids_limit: 256',
    '    networks:',
    '      hermit-net:',
    `        ipv4_address: ${net.netguard_ip}`,
    '    volumes:',
    '      - ./.hermit/docker/nftables.conf:/etc/nftables.conf:ro',
    '      - ./.hermit/docker/dnsmasq.allowlist:/etc/dnsmasq.allowlist:ro',
    '    environment:',
    `      - DNS_LOG_ONLY=${dnsLogOnly}`,
    '    restart: unless-stopped',
  ];
  if (sysctls) lines.push(sysctls);
  if (ports) lines.push(ports);
  lines.push(
    '    healthcheck:',
    `      test: ["CMD-SHELL", "nft list ruleset | grep -q 'table inet firewall' && (! [ -f /etc/dnsmasq.allowlist ] || pgrep dnsmasq)"]`,
    '      interval: 10s',
    '      timeout: 5s',
    '      retries: 3',
    '      start_period: 5s',
  );
  return lines.join('\n');
}

export function renderOverlay(input: RenderInput): string {
  const template = fs.readFileSync(path.join(SECURITY_DIR, 'docker-compose.security.yml.template'), 'utf8');
  const lanOn = input.toggles.lan?.enabled === true;
  const resOn = input.toggles.resources?.enabled === true;
  const auditOn = input.toggles.audit?.enabled === true;
  const sysctlsOn = resOn && input.toggles.resources?.sysctlsEnabled === true;
  const ports = input.publishPorts ?? [];

  if (lanOn && !input.network) throw new Error('toggles.lan.enabled requires network {subnet,gateway,netguard_ip}');

  const networksBlock = lanOn
    ? [
        'networks:',
        '  hermit-net:',
        '    driver: bridge',
        '    ipam:',
        '      config:',
        `        - subnet: ${input.network!.subnet}`,
        `          gateway: ${input.network!.gateway}`,
      ].join('\n')
    : '';

  const netguardSysctls = lanOn && sysctlsOn ? sysctlsBlock('    ') : '';
  const netguardPorts = lanOn && ports.length > 0 ? portsBlock(ports, '    ') : '';
  const netguardBlock = lanOn
    ? netguardService(input.network!, input.toggles.lan?.dnsMode ?? 'log-only', netguardSysctls, netguardPorts)
    : '';

  const hermitNetworkMode = lanOn
    ? [
        '    network_mode: "service:hermit-netguard"',
        '    depends_on:',
        '      hermit-netguard:',
        '        condition: service_healthy',
      ].join('\n')
    : '';

  const resourceBounds = resOn
    ? [
        `    mem_limit: ${input.toggles.resources?.memLimit ?? '4g'}`,
        `    memswap_limit: ${input.toggles.resources?.memswapLimit ?? '4g'}`,
        `    cpus: ${input.toggles.resources?.cpus ?? 2.0}`,
      ].join('\n')
    : '';

  const hermitSysctls = sysctlsOn && !lanOn ? sysctlsBlock('    ') : '';
  const auditEnv = auditOn
    ? ['    environment:', '      - HERMIT_PLUGIN_INSTALL_AUDIT=1'].join('\n')
    : '';

  return renderTemplate(template, {
    NETWORKS_BLOCK: networksBlock,
    HERMIT_NETGUARD_SERVICE: netguardBlock,
    HERMIT_NETWORK_MODE: hermitNetworkMode,
    HERMIT_RESOURCE_BOUNDS: resourceBounds,
    HERMIT_SYSCTLS_ON_HERMIT: hermitSysctls,
    HERMIT_AUDIT_ENV: auditEnv,
  });
}

export function renderNftables(lanAllowlist: string[]): string {
  const template = fs.readFileSync(path.join(SECURITY_DIR, 'nftables.conf.template'), 'utf8');
  // The template line is `        {{LAN_ALLOWLIST_RULES}}` (8 leading spaces).
  // Leave the first entry unindented (the template supplies its indent); prefix
  // every subsequent entry with the same 8 spaces so they align.
  const rules = lanAllowlist
    .map((e, i) => (i === 0 ? '' : '        ') + `ip daddr ${e} accept`)
    .join('\n');
  return renderTemplate(template, {
    LAN_ALLOWLIST_RULES: rules,
    DNSMASQ_UID,
  });
}

export function renderDnsmasq(fleetDomains: string[], additionalDomains: string[]): string {
  const template = fs.readFileSync(path.join(SECURITY_DIR, 'dnsmasq.allowlist.template'), 'utf8');
  const toServers = (domains: string[]) => domains.map((d) => `server=/${d}/1.1.1.1`).join('\n');
  return renderTemplate(template, {
    FLEET_DOMAINS: toServers(fleetDomains),
    ADDITIONAL_DOMAINS: toServers(additionalDomains),
  });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function runPickSubnet(projectRoot: string, candidate: string | null): void {
  const occupied = gatherOccupied(projectRoot);
  const result = candidate ? validateCandidate(candidate, occupied) : pickSubnet(CANDIDATES, occupied);
  console.log(JSON.stringify(result));
  process.exit(0);
}

function runRender(projectRoot: string, raw: string): void {
  const input = JSON.parse(raw) as RenderInput;
  // Render + validate all three in memory before any write.
  const overlay = renderOverlay(input);
  const nftables = renderNftables(input.lanAllowlist ?? []);
  const dnsmasq = renderDnsmasq(input.fleetDomains ?? [], input.additionalDomains ?? []);

  const lanOn = input.toggles.lan?.enabled === true;
  const overlayPath = path.join(projectRoot, 'docker-compose.security.yml');
  const written: string[] = [overlayPath];
  fs.writeFileSync(overlayPath, overlay);

  if (lanOn) {
    const dockerDir = path.join(projectRoot, '.hermit', 'docker');
    fs.mkdirSync(dockerDir, { recursive: true });
    const nftPath = path.join(dockerDir, 'nftables.conf');
    const allowPath = path.join(dockerDir, 'dnsmasq.allowlist');
    fs.writeFileSync(nftPath, nftables);
    fs.writeFileSync(allowPath, dnsmasq);
    written.push(nftPath, allowPath);
  }

  console.log(JSON.stringify({ written }));
  process.exit(0);
}

if (import.meta.main) {
  const sub = process.argv[2];
  const projectRoot = path.resolve(process.argv[3] || process.cwd());

  if (sub === 'pick-subnet') {
    const ci = process.argv.indexOf('--candidate');
    const candidate = ci >= 0 ? process.argv[ci + 1] ?? null : null;
    runPickSubnet(projectRoot, candidate);
  } else if (sub === 'render') {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('error', () => {});
    process.stdin.on('end', () => {
      try {
        runRender(projectRoot, raw.trim());
      } catch (e: any) {
        exitError(`render_failed:${e.message}`);
      }
    });
  } else {
    exitError();
  }
}
