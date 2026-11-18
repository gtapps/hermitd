// Host-only credential proxy store: the map of mapped hosts and headers, the secret
// values, the certificate authority and the rendered sidecar files. It lives under the
// host config dir, never under the project folder, so a Docker agent can neither read
// nor stage it. Values never appear in a return value a caller might print.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { sha256 } from './hash';
import { writeFileAtomic } from './md-write';

export type Binding = { host: string; header: string; secret: string; prefix?: string; basic_user?: string };
type StoreFile = { project: string; bindings: Binding[] };

const LISTEN_PORT = 18443;
const PROXY_ADDRESS = `http://127.0.0.1:${LISTEN_PORT}`;
const ROOTS = '/etc/ssl/certs/ca-certificates.crt'; // the pinned Envoy image's own bundle
const SIDECAR_MOUNT = '/etc/envoy';

const HOST_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const HEADER_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const SECRET_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const CONTROL_RE = /[\x00-\x1f\x7f]/;

export function normalizeHost(host: string): string | null {
  const h = String(host ?? '').trim().toLowerCase().replace(/\.$/, '');
  return HOST_RE.test(h) && !/^[0-9.]+$/.test(h) ? h : null;
}
export const validHeader = (name: string) => HEADER_RE.test(name ?? '');
export const validSecretName = (name: string) => SECRET_RE.test(name ?? '');
export const validText = (text: string) => !CONTROL_RE.test(text);

/** The store for a project: named from its real path plus a hash of that path, so punctuation never collides. */
// Fixed under the home folder, never CLAUDE_CONFIG_DIR: the wizard's session, the operator's shell and
// a project's runtime.config_dir can each carry a different value, and all of them must name one store.
export function storeDir(project: string, configRoot = path.join(os.homedir(), '.claude')): string {
  return path.join(path.resolve(configRoot), 'hermitd', 'credproxy', storeName(fs.realpathSync(project)));
}

/** The store folder's name for a project's real path; pure, so a deleted project still names its stores. */
export function storeName(real: string): string {
  return `${real.replace(/[^a-zA-Z0-9]/g, '-').slice(-100)}-${sha256(real).slice(0, 16)}`;
}

export const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith('/') ? parent : parent + '/');

/** Refuse before any write that would put the store, and so a secret, under the project folder. */
export function assertOutside(store: string, project: string): void {
  if (inside(store, project)) throw new Error('store_inside_project');
}

export function readBindings(store: string): Binding[] {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(store, 'map.json'), 'utf8')) as StoreFile;
    return Array.isArray(data?.bindings) ? data.bindings : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('map_unreadable');
  }
}

export function writeBindings(store: string, project: string, bindings: Binding[]): void {
  fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  writeFileAtomic(path.join(store, 'map.json'), JSON.stringify({ project, bindings }, null, 2) + '\n', 0o600);
}

const sameHeader = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Same host and header replaces; another header on the same host is kept. */
export function upsertBinding(bindings: Binding[], next: Binding): Binding[] {
  return [...bindings.filter(b => !(b.host === next.host && sameHeader(b.header, next.header))), next];
}

export function removeBindings(bindings: Binding[], host: string, header?: string): Binding[] {
  return bindings.filter(b => !(b.host === host && (header === undefined || sameHeader(b.header, header))));
}

const secretPath = (store: string, name: string) => path.join(store, 'secrets', name);
export const hasValue = (store: string, name: string) => fs.existsSync(secretPath(store, name));

export function writeSecret(store: string, name: string, value: string): void {
  const dir = path.join(store, 'secrets');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Created 0600 up front, so the value is never briefly world-readable.
  writeFileAtomic(secretPath(store, name), value, 0o600);
}

export function deleteSecret(store: string, name: string): void {
  fs.rmSync(secretPath(store, name), { force: true });
}

export function headerValue(binding: Binding, value: string): string {
  return binding.basic_user !== undefined
    ? 'Basic ' + Buffer.from(`${binding.basic_user}:${value}`).toString('base64')
    : (binding.prefix ?? '') + value;
}

// ---------------------------------------------------------------------------
// Envoy config (pure). JSON is valid YAML, so values need no YAML escaping.
// ---------------------------------------------------------------------------

type Mapped = { host: string; headers: { header: string; value: string }[] };

const type = (name: string) => `type.googleapis.com/${name}`;
const ROUTER = { name: 'envoy.filters.http.router', typed_config: { '@type': type('envoy.extensions.filters.http.router.v3.Router'), suppress_envoy_headers: true } };
const connectRoute = (cluster: string) => ({
  match: { connect_matcher: {} },
  route: { cluster, timeout: '0s', upgrade_configs: [{ upgrade_type: 'CONNECT', connect_config: {} }] },
});
const dnsCache = { name: 'dfp', dns_lookup_family: 'V4_ONLY' };

export function envoyConfig(mapped: Mapped[]): object {
  const secrets: object[] = [];
  const listeners: object[] = [];
  const clusters: object[] = [{
    name: 'passthrough',
    lb_policy: 'CLUSTER_PROVIDED',
    cluster_type: { name: 'envoy.clusters.dynamic_forward_proxy', typed_config: { '@type': type('envoy.extensions.clusters.dynamic_forward_proxy.v3.ClusterConfig'), dns_cache_config: dnsCache } },
  }];
  const vhosts = mapped.map((m, i) => ({ name: `h${i}`, domains: [`${m.host}:443`], routes: [connectRoute(`int_${i}`)] }));
  mapped.forEach((m, i) => {
    const injectors = m.headers.map((h, j) => {
      secrets.push({ name: `s_${i}_${j}`, generic_secret: { secret: { inline_string: h.value } } });
      return {
        name: `inject_${i}_${j}`,
        typed_config: {
          '@type': type('envoy.extensions.filters.http.credential_injector.v3.CredentialInjector'),
          overwrite: true,
          credential: {
            name: 'envoy.http.injected_credentials.generic',
            typed_config: { '@type': type('envoy.extensions.http.injected_credentials.generic.v3.Generic'), header: h.header, credential: { name: `s_${i}_${j}` } },
          },
        },
      };
    });
    listeners.push({
      name: `mitm_${i}`,
      internal_listener: {},
      filter_chains: [{
        transport_socket: {
          name: 'envoy.transport_sockets.tls',
          typed_config: {
            '@type': type('envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext'),
            common_tls_context: { tls_certificates: [{ certificate_chain: { filename: `${SIDECAR_MOUNT}/server.crt` }, private_key: { filename: `${SIDECAR_MOUNT}/server.key` } }] },
          },
        },
        filters: [{
          name: 'envoy.filters.network.http_connection_manager',
          typed_config: {
            '@type': type('envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager'),
            stat_prefix: `mitm_${i}`,
            // The mapped host receives the tool's headers plus the mapped ones, none of Envoy's.
            generate_request_id: false,
            route_config: {
              request_headers_to_remove: ['x-forwarded-proto', 'x-request-id'],
              // Only the mapped host: a tunnel opened to it must not carry a request for another host.
              virtual_hosts: [{ name: 'up', domains: [m.host, `${m.host}:443`], routes: [{ match: { prefix: '/' }, route: { cluster: `up_${i}`, timeout: '0s' } }] }],
            },
            http_filters: [...injectors, ROUTER],
          },
        }],
      }],
    });
    clusters.push({
      name: `int_${i}`,
      load_assignment: { cluster_name: `int_${i}`, endpoints: [{ lb_endpoints: [{ endpoint: { address: { envoy_internal_address: { server_listener_name: `mitm_${i}` } } } }] }] },
    }, {
      name: `up_${i}`,
      type: 'LOGICAL_DNS',
      dns_lookup_family: 'V4_ONLY',
      load_assignment: { cluster_name: `up_${i}`, endpoints: [{ lb_endpoints: [{ endpoint: { address: { socket_address: { address: m.host, port_value: 443 } } } }] }] },
      transport_socket: {
        name: 'envoy.transport_sockets.tls',
        typed_config: {
          '@type': type('envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext'),
          // Fixed name, verified chain, and the certificate must name this host.
          sni: m.host,
          auto_sni_san_validation: true,
          common_tls_context: { validation_context: { trusted_ca: { filename: ROOTS } } },
        },
      },
    });
  });
  return {
    bootstrap_extensions: [{ name: 'envoy.bootstrap.internal_listener', typed_config: { '@type': type('envoy.extensions.bootstrap.internal_listener.v3.InternalListener') } }],
    static_resources: {
      secrets,
      listeners: [{
        name: 'forward',
        address: { socket_address: { address: '127.0.0.1', port_value: LISTEN_PORT } },
        filter_chains: [{
          filters: [{
            name: 'envoy.filters.network.http_connection_manager',
            typed_config: {
              '@type': type('envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager'),
              stat_prefix: 'forward',
              upgrade_configs: [{ upgrade_type: 'CONNECT' }],
              route_config: { name: 'forward', virtual_hosts: [...vhosts, { name: 'passthrough', domains: ['*'], routes: [connectRoute('passthrough')] }] },
              http_filters: [
                { name: 'envoy.filters.http.dynamic_forward_proxy', typed_config: { '@type': type('envoy.extensions.filters.http.dynamic_forward_proxy.v3.FilterConfig'), dns_cache_config: dnsCache } },
                ROUTER,
              ],
            },
          }],
        }],
      }, ...listeners],
      clusters,
    },
  };
}

// ---------------------------------------------------------------------------
// Certificates (host openssl, config files only: no -addext, so LibreSSL works).
// ---------------------------------------------------------------------------

function openssl(args: string[], cwd: string): void {
  const result = spawnSync('openssl', args, { cwd, encoding: 'utf8' });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') throw new Error('openssl_missing');
  if (result.error || result.status !== 0) throw new Error(`openssl_failed:${(result.stderr || String(result.error)).trim().split('\n')[0]}`);
}

const CA_CONFIG = `[req]
distinguished_name = dn
prompt = no
[dn]
CN = hermitd credential proxy CA
[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
`;
// A fixed CN: X.509 caps it at 64 characters, and clients match the SAN list anyway.
const leafConfig = (hosts: string[]) => `[req]
distinguished_name = dn
prompt = no
[dn]
CN = hermitd credential proxy
[v3_leaf]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = ${hosts.map(h => `DNS:${h}`).join(',')}
`;

function issueCa(dir: string): void {
  fs.writeFileSync(path.join(dir, 'ca.cnf'), CA_CONFIG);
  openssl(['genrsa', '-out', 'ca.key', '2048'], dir);
  openssl(['req', '-x509', '-new', '-key', 'ca.key', '-config', 'ca.cnf', '-extensions', 'v3_ca', '-days', '3650', '-sha256', '-out', 'ca.pem'], dir);
}

function issueServer(dir: string, caDir: string, hosts: string[]): void {
  fs.writeFileSync(path.join(dir, 'leaf.cnf'), leafConfig(hosts));
  openssl(['genrsa', '-out', 'server.key', '2048'], dir);
  openssl(['req', '-new', '-key', 'server.key', '-config', 'leaf.cnf', '-out', 'server.csr'], dir);
  // 825 days: the longest server certificate lifetime Apple platforms accept.
  openssl(['x509', '-req', '-in', 'server.csr', '-CA', path.join(caDir, 'ca.pem'), '-CAkey', path.join(caDir, 'ca.key'),
    '-set_serial', '0x' + randomBytes(12).toString('hex'),
    '-days', '825', '-sha256', '-extfile', 'leaf.cnf', '-extensions', 'v3_leaf', '-out', 'server.crt'], dir);
}

function serverCurrent(store: string, hosts: string[]): boolean {
  try {
    if (JSON.stringify(JSON.parse(fs.readFileSync(path.join(store, 'server-hosts.json'), 'utf8'))) !== JSON.stringify(hosts)) return false;
    if (!fs.existsSync(path.join(store, 'server.key'))) return false;
  } catch { return false; }
  // Reissue within 30 days of expiry.
  return spawnSync('openssl', ['x509', '-checkend', '2592000', '-noout', '-in', path.join(store, 'server.crt')]).status === 0;
}

// ---------------------------------------------------------------------------
// Render: build a complete set in a staging folder, then replace the old one.
// ---------------------------------------------------------------------------

export type RenderResult = { status: 'skipped'; reason: 'no_bindings' } | { status: 'rendered'; hosts: string[]; missing_values: Binding[] };

/** Replace `dest`'s files with `src`'s, keeping the folder itself so a running bind mount sees the new files. */
function replaceFolder(src: string, dest: string, mode: number): void {
  fs.mkdirSync(dest, { recursive: true, mode });
  fs.chmodSync(dest, mode);
  const fresh = new Set(fs.readdirSync(src));
  for (const name of fresh) fs.renameSync(path.join(src, name), path.join(dest, name));
  for (const name of fs.readdirSync(dest)) if (!fresh.has(name)) fs.rmSync(path.join(dest, name), { recursive: true, force: true });
}

function withValues(store: string, bindings: Binding[]): { mapped: Mapped[]; missing: Binding[] } {
  const missing: Binding[] = [];
  const byHost = new Map<string, Mapped>();
  for (const b of bindings) {
    // A hand-edited store renders the canonical name everywhere: domains, SNI and SAN.
    const host = normalizeHost(b.host);
    if (!host) throw new Error('invalid_host');
    if (!hasValue(store, b.secret)) { missing.push(b); continue; }
    const value = fs.readFileSync(secretPath(store, b.secret), 'utf8');
    const entry = byHost.get(host) ?? { host, headers: [] };
    entry.headers.push({ header: b.header, value: headerValue(b, value) });
    byHost.set(host, entry);
  }
  return { mapped: [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host)), missing };
}

/**
 * Rewrite only the rendered sidecar config, without values the store no longer maps. Other rendered
 * files stay as they are, and it keeps only host and header pairs already rendered, so the
 * certificate still covers every host and no pending change is applied before `hermitd restart`.
 */
export function scrubConfig(store: string): void {
  const config = path.join(store, 'sidecar', 'envoy.yaml');
  if (!fs.existsSync(config)) return;
  let rendered: { host: string; headers: string[] }[] = [];
  try { rendered = JSON.parse(fs.readFileSync(path.join(store, 'agent', 'proxy.json'), 'utf8')).hosts ?? []; } catch {}
  const keep = (b: Binding) => rendered.some(r => r.host === normalizeHost(b.host) && r.headers.some(h => sameHeader(h, b.header)));
  const { mapped } = withValues(store, readBindings(store).filter(keep));
  writeFileAtomic(config, JSON.stringify(envoyConfig(mapped), null, 2) + '\n', 0o600);
}

export function render(store: string, project: string): RenderResult {
  const bindings = readBindings(store);
  // A sidecar folder (made by the overlay render, or an earlier render) still needs a config,
  // so unmapping the last host clears it and an enabled sidecar has something to start on.
  if (!bindings.length && !fs.existsSync(path.join(store, 'sidecar'))) return { status: 'skipped', reason: 'no_bindings' };
  assertOutside(store, project);
  const { mapped, missing } = withValues(store, bindings);
  const hosts = mapped.map(m => m.host);

  const umask = process.umask(0o077);
  const stage = fs.mkdtempSync(path.join(store, '.render-'));
  try {
    const sidecar = path.join(stage, 'sidecar');
    const agent = path.join(stage, 'agent');
    const keys = path.join(stage, 'keys');
    for (const dir of [sidecar, agent, keys]) fs.mkdirSync(dir);
    // Freshly issued files live in `keys` until every file is built, then move into the store.
    const commits: string[] = [];
    let caDir = store;
    let serverDir = store;
    if (hosts.length) {
      if (!fs.existsSync(path.join(store, 'ca.key')) || !fs.existsSync(path.join(store, 'ca.pem'))) {
        issueCa(keys);
        caDir = keys;
        commits.push('ca.key', 'ca.pem');
      }
      if (caDir !== store || !serverCurrent(store, hosts)) {
        issueServer(keys, caDir, hosts);
        fs.writeFileSync(path.join(keys, 'server-hosts.json'), JSON.stringify(hosts) + '\n');
        serverDir = keys;
        commits.push('server.key', 'server.crt', 'server-hosts.json');
      }
      fs.copyFileSync(path.join(serverDir, 'server.crt'), path.join(sidecar, 'server.crt'));
      fs.copyFileSync(path.join(serverDir, 'server.key'), path.join(sidecar, 'server.key'));
      fs.copyFileSync(path.join(caDir, 'ca.pem'), path.join(agent, 'ca.pem'));
      fs.chmodSync(path.join(agent, 'ca.pem'), 0o644);
    }
    fs.writeFileSync(path.join(sidecar, 'envoy.yaml'), JSON.stringify(envoyConfig(mapped), null, 2) + '\n', { mode: 0o600 });
    const list = mapped.map(m => ({ host: m.host, headers: m.headers.map(h => h.header) }));
    fs.writeFileSync(path.join(agent, 'proxy.json'), JSON.stringify({ address: PROXY_ADDRESS, hosts: list }, null, 2) + '\n');
    fs.chmodSync(path.join(agent, 'proxy.json'), 0o644); // the 077 umask above would leave it 0600
    for (const name of commits) fs.renameSync(path.join(keys, name), path.join(store, name));
    replaceFolder(sidecar, path.join(store, 'sidecar'), 0o700);
    replaceFolder(agent, path.join(store, 'agent'), 0o755);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    process.umask(umask);
  }
  return { status: 'rendered', hosts, missing_values: missing };
}
