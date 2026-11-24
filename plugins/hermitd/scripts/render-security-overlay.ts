#!/usr/bin/env bun
import { composeFiles } from './lib/compose-files';
/**
 * Deterministic rendering for /docker-security. Three subcommands:
 *
 *   mcp-hosts <project-root>
 *     Hostnames of remote (url-based) servers in the project's .mcp.json, for
 *     the wizard to offer as allowlist entries. Always exits 0.
 *     Output: { hosts: [{ host, server }] }
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
 *   render <project-root> [--store-project <project>]
 *     Renders the five netguard files from <project-root>/.hermit/config.json
 *     (`docker.security`) plus the operator's own dnsmasq lines in
 *     .hermit/docker/dnsmasq.hermit-local.conf: docker-compose.security.yml and
 *     .hermit/docker/{Dockerfile.hermit-netguard, netguard-entrypoint.sh,
 *     nftables.conf, dnsmasq.allowlist}. Every config value is validated before it
 *     is spliced, every file renders in memory first, and each is replaced
 *     atomically, so a link at a generated path is replaced, never followed.
 *     The host lifecycle runs it on the approved copy; --store-project names the real
 *     project, whose credential store the overlay mounts. Output, one of:
 *       { status: "rendered", written: [...] }
 *       { status: "disabled", removed: [...] }    no security toggle on: the five files are removed
 *       { status: "skipped", reason: "incomplete_config" }   LAN containment on without a subnet
 *       { error: "invalid_value:<config path>" | "render_failed:<detail>" }, exit 1
 *     The credential proxy sidecar runs as the caller's uid and gid.
 *
 *   migrate-allowlist <project-root>
 *     Once per install: moves the operator's own lines out of a wizard-rendered
 *     .hermit/docker/dnsmasq.allowlist into dnsmasq.hermit-local.conf (exclusive
 *     create; nothing when that file exists). Output:
 *       { moved, carve_outs_missing: [...], pins_needing_carve_out: [...] }
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderTemplate } from './lib/render-template';
import { exitError } from './lib/cli';
import { readSettledConfig } from './lib/config-read';
import { BUILTIN_FEATURE_HOSTS, featureDomains } from './lib/netguard-hosts';
import { storeDir } from './lib/credproxy';
import { CONTAINER_SOCKET, readConfig as readConnector, storeDir as connectorStore } from './lib/connector';
import { CREDPROXY_MOUNT } from './lib/credproxy-env';
import { NETGUARD_FILES, OVERLAY_FILE, SECURITY_FILES, isLink, writeExclusive } from './lib/security-files';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');
const SECURITY_DIR = path.join(PLUGIN_ROOT, 'state-templates', 'docker', 'security');

const DNSMASQ_UID = '100'; // Alpine dnsmasq's static UID — see docker-security SKILL step 6a.

// Project-relative files `render` writes. The two rule files are netguard
// image build inputs (Dockerfile.hermit-netguard COPYs them).
const NFTABLES_FILE = NETGUARD_FILES.nftables;
const DNSMASQ_FILE = NETGUARD_FILES.dnsmasq;
/** The operator's own dnsmasq lines; the plugin writes it only when the migration creates it. */
export const OPERATOR_DNSMASQ_FILE = '.hermit/docker/dnsmasq.hermit-local.conf';

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
    const r = spawnSync('docker', ['compose', ...composeFiles(projectRoot), 'config', '--format', 'json'],
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
  credproxy?: { enabled?: boolean };
}
export interface RenderInput {
  network?: Chosen;
  toggles: Toggles;
  publishPorts?: Port[];
  lanAllowlist?: string[];
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
    // Enforce mode logs every query; json-file is pinned so the size options
    // are valid whatever the daemon's default driver is.
    '    logging:',
    '      driver: json-file',
    '      options:',
    '        max-size: "10m"',
    '        max-file: "3"',
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

/** The credential proxy's host side: its store and the uid and gid the sidecar runs as. */
export interface CredproxyHost { store: string; uid: number; gid: number }

function credproxyService(host: CredproxyHost, lanOn: boolean): string {
  return [
    '  hermit-credproxy:',
    '    image: envoyproxy/envoy:distroless-v1.40.2',
    '    command: ["-c", "/etc/envoy/envoy.yaml", "--concurrency", "1", "-l", "warn"]',
    `    user: "${host.uid}:${host.gid}"`,
    // Loopback inside the agent's network namespace: only the agent reaches it.
    `    network_mode: "service:${lanOn ? 'hermit-netguard' : 'hermit'}"`,
    '    cap_drop: [ALL]',
    '    security_opt:',
    '      - no-new-privileges:true',
    '    pids_limit: 256',
    '    restart: unless-stopped',
    '    volumes:',
    `      - ${JSON.stringify(`${path.join(host.store, 'sidecar')}:/etc/envoy:ro`)}`,
  ].join('\n');
}

/** The connector's host side: its store, the public port it listens on, and the uid and gid it runs as. */
export interface ConnectorHost { store: string; port: number; uid: number; gid: number }

// Its own network namespace: the agent reaches it only through the read-only socket mount, and
// cannot bind or take over its port. The port is published on host loopback for the tunnel.
function connectorService(host: ConnectorHost): string {
  const mount = (sub: string, ro = false) => `      - ${JSON.stringify(`${path.join(host.store, sub)}:/connector/${sub}${ro ? ':ro' : ''}`)}`;
  return [
    '  hermit-connector:',
    '    image: oven/bun:1.4.5-distroless',
    '    command: ["/connector/sidecar/gateway.ts", "/connector"]',
    `    user: "${host.uid}:${host.gid}"`,
    '    environment:',
    '      - CONNECTOR_HOSTNAME=0.0.0.0',
    '    cap_drop: [ALL]',
    '    security_opt:',
    '      - no-new-privileges:true',
    '    pids_limit: 256',
    '    restart: unless-stopped',
    '    ports:',
    `      - "127.0.0.1:${host.port}:${host.port}"`,
    '    volumes:',
    mount('sidecar', true),
    mount('data'),
    mount('bridge'),
  ].join('\n');
}

export function renderOverlay(input: RenderInput, credproxy?: CredproxyHost, connector?: ConnectorHost): string {
  const template = fs.readFileSync(path.join(SECURITY_DIR, 'docker-compose.security.yml.template'), 'utf8');
  const lanOn = input.toggles.lan?.enabled === true;
  const resOn = input.toggles.resources?.enabled === true;
  const auditOn = input.toggles.audit?.enabled === true;
  const sysctlsOn = resOn && input.toggles.resources?.sysctlsEnabled === true;
  const ports = input.publishPorts ?? [];

  if (lanOn && !input.network) throw new Error('toggles.lan.enabled requires network {subnet,gateway,netguard_ip}');
  const proxyOn = input.toggles.credproxy?.enabled === true;
  if (proxyOn && !credproxy) throw new Error('toggles.credproxy.enabled requires the credential store');
  // netguard exempts uid 100 (dnsmasq) from its DNS redirect; a sidecar in its namespace must not share it.
  if (proxyOn && lanOn && String(credproxy!.uid) === DNSMASQ_UID) {
    throw new Error(`credential proxy cannot run as uid ${DNSMASQ_UID} with LAN containment: netguard exempts that uid from its DNS rules; run as another user`);
  }

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
  const agentMounts = [
    ...(proxyOn ? [`${path.join(credproxy!.store, 'agent')}:${CREDPROXY_MOUNT}:ro`] : []),
    ...(connector ? [`${path.join(connector.store, 'bridge')}:${path.dirname(CONTAINER_SOCKET)}:ro`] : []),
  ];
  const agentMount = agentMounts.length ? ['    volumes:', ...agentMounts.map(m => `      - ${JSON.stringify(m)}`)].join('\n') : '';

  return renderTemplate(template, {
    NETWORKS_BLOCK: networksBlock,
    HERMIT_NETGUARD_SERVICE: [netguardBlock, proxyOn ? credproxyService(credproxy!, lanOn) : '', connector ? connectorService(connector) : ''].filter(Boolean).join('\n\n'),
    HERMIT_NETWORK_MODE: hermitNetworkMode,
    HERMIT_RESOURCE_BOUNDS: resourceBounds,
    HERMIT_SYSCTLS_ON_HERMIT: hermitSysctls,
    HERMIT_AUDIT_ENV: [auditEnv, agentMount].filter(Boolean).join('\n'),
  });
}

// Template lines for rule placeholders sit at the 8-space chain-body indent.
// The first rule takes the template's indent; the rest are prefixed to align.
const chainBody = (rules: string[]) => rules.map((r, i) => (i === 0 ? '' : '        ') + r).join('\n');

export function renderNftables(lanAllowlist: string[], dnsMode: string): string {
  const template = fs.readFileSync(path.join(SECURITY_DIR, 'nftables.conf.template'), 'utf8');
  const enforce = dnsMode === 'enforce';
  return renderTemplate(template, {
    LAN_ALLOWLIST_RULES: chainBody(lanAllowlist.map((e) => `ip daddr ${e} accept`)),
    OUTPUT_POLICY: enforce ? 'drop' : 'accept',
    EGRESS_ALLOW_RULES: enforce ? chainBody([
      `meta skuid ${DNSMASQ_UID} meta l4proto { tcp, udp } th dport 53 accept`,
      // IPv6 neighbor and router discovery, without which IPv6 connects hang.
      'icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit } accept',
      'ip daddr @allow4 accept',
      'ip6 daddr @allow6 accept',
    ]) : '',
    DNSMASQ_UID,
  });
}

export function renderDnsmasq(
  additionalDomains: string[], features: ReturnType<typeof featureDomains>, operatorLines: string[] = [],
): string {
  const template = fs.readFileSync(path.join(SECURITY_DIR, 'dnsmasq.allowlist.template'), 'utf8');
  const toServers = (domains: string[]) => domains.map((d) => `server=/${d}/1.1.1.1`).join('\n');
  return renderTemplate(template, {
    CHANNEL_DOMAINS: toServers(features.channels),
    TRANSCRIPTION_DOMAINS: toServers(features.transcription),
    ADDITIONAL_DOMAINS: toServers(additionalDomains),
    OPERATOR_LINES: operatorLines.join('\n'),
  });
}

// ---------------------------------------------------------------------------
// Config mapping: the one place docker.security becomes render input.
// ---------------------------------------------------------------------------

export class InvalidValue extends Error {}

const DOMAIN_RE = /^[a-z0-9][a-z0-9.-]+$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const SIZE_RE = /^[0-9]+(g|m)?$/;
const CPUS_RE = /^[0-9.]+$/;
const PORT_RE = /^[0-9]{1,5}(-[0-9]{1,5})?$/;

const isIpv4 = (v: unknown) => typeof v === 'string' && IPV4_RE.test(v) && v.split('.').every((o) => Number(o) <= 255);
/** A carve-out as the wizard stores it: a bare IPv4 address or an IPv4 CIDR. */
const carveOutRange = (v: string): Range | null => (isIpv4(v) ? cidrToRange(`${v}/32`) : cidrToRange(v));

function stringList(value: unknown, where: string, ok: (v: string) => boolean): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new InvalidValue(where);
  value.forEach((v, i) => { if (typeof v !== 'string' || !ok(v)) throw new InvalidValue(`${where}.${i}`); });
  return value as string[];
}

function scalar(value: unknown, where: string, re: RegExp): string | undefined {
  if (value === undefined || value === null) return undefined;
  if ((typeof value !== 'string' && typeof value !== 'number') || !re.test(String(value))) throw new InvalidValue(where);
  return String(value);
}

function publishPorts(value: unknown): Port[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new InvalidValue('docker.security.network.publish_ports');
  return value.map((p: any, i) => {
    const at = `docker.security.network.publish_ports.${i}`;
    if (!p || typeof p !== 'object') throw new InvalidValue(at);
    const target = scalar(p.target, `${at}.target`, PORT_RE);
    const published = scalar(p.published, `${at}.published`, PORT_RE);
    if (target === undefined) throw new InvalidValue(`${at}.target`);
    if (published === undefined) throw new InvalidValue(`${at}.published`);
    if (p.host_ip !== undefined && !isIpv4(p.host_ip)) throw new InvalidValue(`${at}.host_ip`);
    if (p.protocol !== undefined && !['tcp', 'udp'].includes(p.protocol)) throw new InvalidValue(`${at}.protocol`);
    if (p.mode !== undefined && !['ingress', 'host'].includes(p.mode)) throw new InvalidValue(`${at}.mode`);
    return { target, published, host_ip: p.host_ip, protocol: p.protocol, mode: p.mode };
  });
}

export type SecurityPlan =
  | { status: 'disabled' }
  | { status: 'skipped'; reason: 'incomplete_config' }
  | { status: 'rendered'; input: RenderInput };

/** Decide and validate from docker.security: no toggle on is disabled; LAN on without a subnet is skipped. */
export function securityInput(security: any): SecurityPlan {
  const s = security && typeof security === 'object' ? security : {};
  const network = s.network ?? {};
  const resources = s.resources ?? {};
  const lanOn = network.enabled === true;
  const resOn = resources.enabled === true;
  const auditOn = s.audit?.plugin_installs === true;
  const proxyOn = s.credential_proxy?.enabled === true;
  if (!lanOn && !resOn && !auditOn && !proxyOn) return { status: 'disabled' };
  if (lanOn && !network.subnet) return { status: 'skipped', reason: 'incomplete_config' };
  const at = (key: string) => `docker.security.${key}`;
  if (lanOn) {
    if (typeof network.subnet !== 'string' || !cidrToRange(network.subnet)) throw new InvalidValue(at('network.subnet'));
    for (const key of ['gateway', 'netguard_ip']) if (!isIpv4(network[key])) throw new InvalidValue(at(`network.${key}`));
  }
  if (network.dns_mode !== undefined && !['log-only', 'enforce'].includes(network.dns_mode)) throw new InvalidValue(at('network.dns_mode'));
  return {
    status: 'rendered',
    input: {
      network: lanOn ? { subnet: network.subnet, gateway: network.gateway, netguard_ip: network.netguard_ip } : undefined,
      toggles: {
        lan: { enabled: lanOn, dnsMode: network.dns_mode },
        resources: {
          enabled: resOn,
          memLimit: scalar(resources.mem_limit, at('resources.mem_limit'), SIZE_RE),
          memswapLimit: scalar(resources.memswap_limit, at('resources.memswap_limit'), SIZE_RE),
          cpus: scalar(resources.cpus, at('resources.cpus'), CPUS_RE),
          sysctlsEnabled: resources.sysctls_enabled === true,
        },
        audit: { enabled: auditOn },
        credproxy: { enabled: proxyOn },
      },
      publishPorts: publishPorts(network.publish_ports),
      lanAllowlist: stringList(network.lan_allowlist, at('network.lan_allowlist'), (v) => carveOutRange(v) !== null),
      additionalDomains: stringList(network.additional_domains, at('network.additional_domains'), (v) => DOMAIN_RE.test(v)),
    },
  };
}

// ---------------------------------------------------------------------------
// Operator lines: the include file, and the one-time move out of a wizard-rendered allowlist.
// ---------------------------------------------------------------------------

const FIXED_DIRECTIVES = new Set(['listen-address=127.0.0.1', 'no-hosts', 'no-resolv', 'address=/#/']);
// Comment lines of the allowlist as earlier releases rendered it, beyond the current template's own.
const LEGACY_COMMENTS = [
  '# To add a domain at runtime, edit this file in',
  '# .hermit/docker/dnsmasq.allowlist and run',
  '# `hermitd-docker down && hermitd-docker up`',
  '# (restart hermit-netguard alone leaves hermit with stale resolver state).',
  '# In enforce mode the firewall also drops connections to any address that no',
  '# server= name in this file returned, so a new server= line is the whole',
  '# change. A literal IP, or the IP behind an address= pin, needs a carve-out.',
  '# This file is built into the netguard image. To add a domain, edit',
  '# .hermit/docker/dnsmasq.allowlist on the host and run `hermitd restart --build`.',
  '# --- Fleet-plugin contributions (rendered from each plugin\'s',
  '#     `## Docker network requirements` section, gated by per-entry',
  '#     operator confirmation during /docker-security) ---',
  '# --- Operator additions (from /docker-security Prompt 1c) ---',
  '# Channel APIs',
  '# Voice-note engine and model downloads and credential-enabled cloud fallback',
  '# Voice-note model downloads and credential-enabled cloud fallback',
];
const DEFAULT_SERVER_RE = /^server=\/([^/]+)\/1\.1\.1\.1$/;

/** The lines of a rendered allowlist that no template or config produced: the operator's own. */
export function operatorLinesFrom(allowlist: string, additionalDomains: string[]): string[] {
  const template = fs.readFileSync(path.join(SECURITY_DIR, 'dnsmasq.allowlist.template'), 'utf8').split('\n');
  const comments = new Set([...template.filter((l) => l.startsWith('#')), ...LEGACY_COMMENTS].map((l) => l.trimEnd()));
  const hosts = new Set([
    ...template.map((l) => l.match(DEFAULT_SERVER_RE)?.[1]).filter((h): h is string => !!h),
    ...BUILTIN_FEATURE_HOSTS,
    ...additionalDomains,
  ]);
  return allowlist.split('\n').map((l) => l.trimEnd()).filter((line) => {
    if (!line.trim() || FIXED_DIRECTIVES.has(line) || comments.has(line)) return false;
    const host = line.match(DEFAULT_SERVER_RE)?.[1];
    return !(host && hosts.has(host));
  });
}

/** A file's text, or null when it is absent. */
function readIfPresent(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** The include file's lines. */
function operatorLines(root: string): string[] {
  const include = path.join(root, OPERATOR_DNSMASQ_FILE);
  if (isLink(include)) throw new Error(`${OPERATOR_DNSMASQ_FILE} is a link`);
  return (readIfPresent(include) ?? '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
}

/** The allowlist a render would build for this config and include file, for checks that must not read the rendered copy. */
export function expectedAllowlist(root: string, config: any): string {
  const additional = Array.isArray(config?.docker?.security?.network?.additional_domains) ? config.docker.security.network.additional_domains : [];
  return renderDnsmasq(additional, featureDomains(config), operatorLines(root));
}

const INCLUDE_HEADER =`# Your own dnsmasq lines for the netguard allowlist, placed above its catchall.
# The plugin never rewrites this file. After an edit, run \`hermitd restart\` on the host.
# In enforce mode a literal IP, or the IP behind an address= pin, also needs a
# carve-out in docker.security.network.lan_allowlist.
`;

export type MigrateResult = { moved: number; carve_outs_missing: string[]; pins_needing_carve_out: string[] };

export function migrateAllowlist(root: string): MigrateResult {
  const result: MigrateResult = { moved: 0, carve_outs_missing: [], pins_needing_carve_out: [] };
  const include = path.join(root, OPERATOR_DNSMASQ_FILE);
  if (fs.existsSync(include) || isLink(include)) return result;
  const legacy = (isLink(path.join(root, DNSMASQ_FILE)) ? null : readIfPresent(path.join(root, DNSMASQ_FILE)));
  if (legacy === null) return result;
  const network = readSettledConfig(path.join(root, '.hermit')).docker?.security?.network ?? {};
  const carveOuts: string[] = Array.isArray(network.lan_allowlist) ? network.lan_allowlist.filter((v: unknown) => typeof v === 'string') : [];
  const lines = operatorLinesFrom(legacy, Array.isArray(network.additional_domains) ? network.additional_domains : []);
  ensureInside(root, include);
  fs.writeFileSync(include, INCLUDE_HEADER + (lines.length ? '\n' + lines.join('\n') + '\n' : ''), { flag: 'wx', mode: 0o644 });
  result.moved = lines.length;
  const ranges = carveOuts.map(carveOutRange).filter((r): r is Range => r !== null);
  const covered = (ip: string) => { const r = carveOutRange(ip); return !!r && ranges.some((c) => c[0] <= r[0] && r[1] <= c[1]); };
  for (const m of ((isLink(path.join(root, NFTABLES_FILE)) ? null : readIfPresent(path.join(root, NFTABLES_FILE))) ?? '').matchAll(/^\s*ip daddr (\S+) accept\s*$/gm)) {
    if (carveOutRange(m[1]) && !carveOuts.includes(m[1]) && !result.carve_outs_missing.includes(m[1])) result.carve_outs_missing.push(m[1]);
  }
  for (const line of lines) {
    const ip = line.match(/^address=\/[^/#]+\/(\S+)$/)?.[1];
    if (ip && isIpv4(ip) && !ip.startsWith('127.') && !covered(ip) && !result.pins_needing_carve_out.includes(ip)) result.pins_needing_carve_out.push(ip);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Writes: physical-path checked, exclusive temp file plus rename.
// ---------------------------------------------------------------------------

/** Refuse a write whose folder resolves outside the root (a linked folder the agent planted). */
function ensureInside(root: string, file: string): void {
  const realRoot = fs.realpathSync(root);
  const dir = fs.realpathSync(path.dirname(file));
  if (dir !== realRoot && !dir.startsWith(realRoot + '/')) throw new Error(`${path.relative(root, file)} resolves outside the project`);
}

function replaceFile(root: string, rel: string, content: string, mode: number): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  ensureInside(root, file);
  writeExclusive(file, content, mode);
}

function removeFile(root: string, rel: string): boolean {
  const file = path.join(root, rel);
  if (!fs.existsSync(file) && !isLink(file)) return false;
  ensureInside(root, file);
  fs.unlinkSync(file);
  return true;
}

export type RenderOutcome =
  | { status: 'rendered'; written: string[] }
  | { status: 'disabled'; removed: string[] }
  | { status: 'skipped'; reason: 'incomplete_config' };

export function renderSecurity(root: string, storeProject = root): RenderOutcome {
  const config = readSettledConfig(path.join(root, '.hermit'));
  const plan = securityInput(config.docker?.security);
  if (plan.status === 'skipped') return plan;
  const user = { uid: process.getuid!(), gid: process.getgid!() };
  const connectorDir = connectorStore(storeProject);
  // Never on host networking, where the agent could bind the server's port first; and a corrupt
  // settings file must not stop the agent starting, so doctor reports the connector missing instead.
  let connectorSettings = null;
  try { if (config.docker?.network_mode !== 'host') connectorSettings = readConnector(connectorDir); } catch {}
  const connector = connectorSettings ? { store: connectorDir, port: connectorSettings.port, ...user } : undefined;
  if (plan.status === 'disabled' && !connector) return { status: 'disabled', removed: SECURITY_FILES.filter((rel) => removeFile(root, rel)) };
  // The connector alone still needs the overlay for its service and the agent's socket mount.
  const input: RenderInput = plan.status === 'rendered' ? plan.input : { toggles: {} };
  const lanOn = input.toggles.lan?.enabled === true;
  const proxyOn = input.toggles.credproxy?.enabled === true;
  const credproxy = proxyOn ? { store: storeDir(storeProject), ...user } : undefined;
  // Every file in memory first, so a render failure writes nothing.
  const files: [string, string, number][] = [[OVERLAY_FILE, renderOverlay(input, credproxy, connector), 0o644]];
  if (lanOn) {
    const additional = input.additionalDomains ?? [];
    files.push(
      [NETGUARD_FILES.dockerfile, fs.readFileSync(path.join(SECURITY_DIR, 'Dockerfile.hermit-netguard.template'), 'utf8'), 0o644],
      [NETGUARD_FILES.entrypoint, fs.readFileSync(path.join(SECURITY_DIR, 'netguard-entrypoint.sh.template'), 'utf8'), 0o755],
      [NFTABLES_FILE, renderNftables(input.lanAllowlist ?? [], input.toggles.lan?.dnsMode ?? 'log-only'), 0o644],
      [DNSMASQ_FILE, renderDnsmasq(additional, featureDomains(config), operatorLines(root)), 0o644],
    );
  }
  for (const [rel, content, mode] of files) replaceFile(root, rel, content, mode);
  // Without LAN containment the netguard files would only be stale build inputs.
  const wanted = new Set(files.map(([rel]) => rel));
  for (const rel of SECURITY_FILES) if (!wanted.has(rel)) removeFile(root, rel);
  // Made here so Docker never creates the bind-mount sources as root; the host lifecycle fills them.
  if (credproxy) {
    fs.mkdirSync(path.join(credproxy.store, 'sidecar'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(credproxy.store, 'agent'), { recursive: true, mode: 0o755 });
  }
  return { status: 'rendered', written: files.map(([rel]) => rel) };
}

/** Hostnames of remote (url-based) servers in the project's .mcp.json, for the wizard to offer. */
export function mcpHosts(projectRoot: string): { host: string; server: string }[] {
  let servers: Record<string, any> = {};
  try {
    servers = JSON.parse(fs.readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8')).mcpServers ?? {};
  } catch { return []; }
  const seen = new Set<string>();
  const out: { host: string; server: string }[] = [];
  for (const [server, cfg] of Object.entries(servers)) {
    let host: string;
    // A ${VAR} placeholder fails to parse; Claude Code expands it only at runtime.
    try { host = new URL(cfg?.url).hostname.toLowerCase().replace(/\.$/, ''); } catch { continue; }
    // IP literals and localhost belong in carve-outs, not the DNS allowlist.
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) || /^[0-9.]+$/.test(host) || seen.has(host)) continue;
    seen.add(host);
    out.push({ host, server });
  }
  return out;
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

if (import.meta.main) {
  const sub = process.argv[2];
  const projectRoot = path.resolve(process.argv[3] || process.cwd());

  if (sub === 'mcp-hosts') {
    console.log(JSON.stringify({ hosts: mcpHosts(projectRoot) }));
    process.exit(0);
  } else if (sub === 'pick-subnet') {
    const ci = process.argv.indexOf('--candidate');
    const candidate = ci >= 0 ? process.argv[ci + 1] ?? null : null;
    runPickSubnet(projectRoot, candidate);
  } else if (sub === 'render') {
    const si = process.argv.indexOf('--store-project');
    const storeProject = si >= 0 && process.argv[si + 1] ? path.resolve(process.argv[si + 1]) : projectRoot;
    try {
      console.log(JSON.stringify(renderSecurity(projectRoot, storeProject)));
      process.exit(0);
    } catch (e: any) {
      exitError(e instanceof InvalidValue ? `invalid_value:${e.message}` : `render_failed:${e.message}`);
    }
  } else if (sub === 'migrate-allowlist') {
    try {
      console.log(JSON.stringify(migrateAllowlist(projectRoot)));
      process.exit(0);
    } catch (e: any) {
      exitError(`migrate_failed:${e.message}`);
    }
  } else {
    exitError();
  }
}
