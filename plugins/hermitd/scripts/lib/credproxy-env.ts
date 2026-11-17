// Points the agent's shell commands at the credential proxy sidecar. Runs inside the agent
// container from the SessionStart hook: when the read-only mount holds the proxy's
// authority and the proxy answers, it appends the proxy and trust exports to
// CLAUDE_ENV_FILE, which Claude Code sources before each Bash and Monitor command.
// Silent and fail-open: any failure writes nothing.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeFileAtomic } from './md-write';

export const CREDPROXY_MOUNT = '/run/hermit-credproxy';
const SYSTEM_ROOTS = ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/cert.pem'];

export type ProxyInfo = { address: string; hosts: { host: string; headers: string[] }[] };

/** The mount the agent reads; HERMIT_CREDPROXY_DIR points tests at a scratch folder. */
export const credproxyDir = () => process.env.HERMIT_CREDPROXY_DIR || CREDPROXY_MOUNT;

export function readProxyInfo(dir = credproxyDir()): ProxyInfo | null {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(dir, 'proxy.json'), 'utf8'));
    return typeof info?.address === 'string' && Array.isArray(info.hosts) ? info : null;
  } catch { return null; }
}

/** True when the proxy address accepts a TCP connection within `timeoutMs`. */
export function proxyAnswers(address: string, timeoutMs = 250): boolean {
  let url: URL;
  try { url = new URL(address); } catch { return false; }
  const code = `const s = require('net').connect(Number(process.argv[2]), process.argv[1]);
s.setTimeout(Number(process.argv[3]), () => process.exit(1));
s.on('connect', () => process.exit(0)); s.on('error', () => process.exit(1));`;
  const result = spawnSync(process.execPath, ['-e', code, url.hostname, url.port || '80', String(timeoutMs)], { timeout: timeoutMs + 2000, stdio: 'ignore' });
  return result.status === 0;
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Append the proxy exports to CLAUDE_ENV_FILE when every condition holds; otherwise write nothing. */
export function exportCredproxyEnv(env: NodeJS.ProcessEnv = process.env, dir = credproxyDir()): void {
  const envFile = env.CLAUDE_ENV_FILE;
  const ca = path.join(dir, 'ca.pem');
  if (!envFile || !fs.existsSync(ca)) return;
  const info = readProxyInfo(dir);
  if (!info) return;
  // An operator's own HTTPS proxy is not chained; a session started from a proxied shell is ours.
  const own = env.HTTPS_PROXY || env.https_proxy;
  if (own && own !== info.address) return;
  if (!proxyAnswers(info.address)) return;

  const bundle = path.join(os.homedir(), '.cache', 'hermit-credproxy', 'ca-bundle.pem');
  const preset = env.SSL_CERT_FILE && env.SSL_CERT_FILE !== bundle ? [env.SSL_CERT_FILE] : [];
  const roots = [...preset, ...SYSTEM_ROOTS].find(file => fs.existsSync(file));
  const content = (roots ? fs.readFileSync(roots, 'utf8').replace(/\n?$/, '\n') : '') + fs.readFileSync(ca, 'utf8');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  let current = '';
  try { current = fs.readFileSync(bundle, 'utf8'); } catch {}
  if (current !== content) writeFileAtomic(bundle, content, 0o644);

  const lines = [
    ['HTTPS_PROXY', info.address], ['https_proxy', info.address], ['NODE_USE_ENV_PROXY', '1'],
    ['SSL_CERT_FILE', bundle], ['CURL_CA_BUNDLE', bundle], ['GIT_SSL_CAINFO', bundle], ['REQUESTS_CA_BUNDLE', bundle],
    ['NODE_EXTRA_CA_CERTS', ca],
  ].map(([key, value]) => `export ${key}=${quote(value)}`);
  let existing = '';
  try { existing = fs.readFileSync(envFile, 'utf8'); } catch {}
  const present = new Set(existing.split('\n'));
  const missing = lines.filter(line => !present.has(line));
  if (!missing.length) return;
  fs.appendFileSync(envFile, (existing && !existing.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
}
