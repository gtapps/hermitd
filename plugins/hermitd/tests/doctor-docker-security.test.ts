import { describe, test, expect, afterAll, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { resolvePaths, checkDockerApproval, checkDockerSecurity } from '../scripts/doctor-check';
import { freshDirFactory } from './helpers/workdir';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');
const { freshDir, cleanup } = freshDirFactory('hermit-docker-sec-');
afterAll(cleanup);

// A project with LAN containment declared; no base compose, so the host path stops
// before any docker subprocess. `note` is what the host recorded in docker-approval.json.
function scenario(dnsMode: string, note: object | null, files: Record<string, string> = {}) {
  const dir = freshDir();
  fs.mkdirSync(path.join(dir, '.hermit', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.hermit', 'config.json'),
    JSON.stringify({ transcription: { enabled: false }, docker: { security: { network: { enabled: true, dns_mode: dnsMode } } } }));
  if (note) fs.writeFileSync(path.join(dir, '.hermit', 'state', 'docker-approval.json'), JSON.stringify(note));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return checkDockerSecurity(resolvePaths(path.join(dir, '.hermit'), PLUGIN_ROOT));
}

const RUNNING = { status: 'approved', at: '2026-11-18T00:00:00Z', approved: 'set-a', security: 'rendered', deployed: 'set-a' };

describe('docker-security from the host note', () => {
  test('rendered and running reports the mode, whatever the project rule files hold', () => {
    for (const mode of ['enforce', 'log-only']) {
      const r = scenario(mode, RUNNING, { '.hermit/docker/nftables.conf': 'table inet firewall { chain output { policy accept; } }\n' });
      expect(r.status).toBe('ok');
      expect(r.detail).toContain(`DNS ${mode}`);
    }
  });

  test('approved rules that are not running yet warn and name hermitd restart, in any mode', () => {
    for (const mode of ['enforce', 'log-only']) {
      const r = scenario(mode, { ...RUNNING, approved: 'set-b' });
      expect(r.status).toBe('warn');
      expect(r.detail).toContain('not running yet');
      expect(r.detail).toContain('hermitd restart');
    }
  });

  test('containment turned on after the last approval says it is not applied yet, not to re-run the wizard', () => {
    const r = scenario('enforce', { ...RUNNING, security: 'disabled' });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('not applied yet');
    expect(r.detail).toContain('hermitd restart');
    expect(r.detail).not.toContain('docker-security');
  });

  test('rules the host did not render warn with the reason', () => {
    const r = scenario('enforce', { ...RUNNING, security: 'skipped:incomplete_config' });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('skipped:incomplete_config');
  });

  test('no note yet, or a pending change, leaves the verdict to other checks', () => {
    expect(scenario('enforce', null).status).toBe('ok');
    expect(scenario('enforce', { status: 'pending', at: 'x', changed: ['a'], candidate: 'c', notified: false }).status).toBe('ok');
  });

  test('a stray project overlay without a declared posture is not configured', () => {
    const dir = freshDir();
    fs.mkdirSync(path.join(dir, '.hermit'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.hermit', 'config.json'), '{}');
    fs.writeFileSync(path.join(dir, 'docker-compose.security.yml'), 'services: {}\n');
    expect(checkDockerSecurity(resolvePaths(path.join(dir, '.hermit'), PLUGIN_ROOT)).detail).toContain('not configured');
  });
});

describe('docker-approval', () => {
  test('a pending change warns and names hermitd approve; anything else is ok', () => {
    const dir = freshDir();
    fs.mkdirSync(path.join(dir, '.hermit', 'state'), { recursive: true });
    const paths = resolvePaths(path.join(dir, '.hermit'), PLUGIN_ROOT);
    expect(checkDockerApproval(paths).status).toBe('ok');
    fs.writeFileSync(path.join(dir, '.hermit', 'state', 'docker-approval.json'), JSON.stringify({ status: 'pending', at: 'x', changed: ['a'], candidate: 'c', notified: true }));
    expect(checkDockerApproval(paths)).toMatchObject({ status: 'warn', detail: expect.stringContaining('`hermitd approve`') });
  });
});

describe('docker-security credential proxy', () => {
  let server: Bun.TCPSocketListener<undefined>;
  beforeAll(() => { server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }); });
  afterAll(() => server.stop(true));

  // Coverage is judged against what a render would build: config domains plus the include file.
  function proxied(dnsMode: string, domains: string[], opts: { enabled?: boolean; answers?: boolean; include?: string } = {}) {
    const dir = freshDir();
    fs.mkdirSync(path.join(dir, '.hermit', 'docker'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.hermit', 'config.json'), JSON.stringify({ transcription: { enabled: false },
      docker: { security: { network: { enabled: true, dns_mode: dnsMode, additional_domains: domains }, credential_proxy: { enabled: opts.enabled ?? true } } } }));
    if (opts.include) fs.writeFileSync(path.join(dir, '.hermit', 'docker', 'dnsmasq.hermit-local.conf'), opts.include);
    const mount = path.join(dir, 'mount');
    fs.mkdirSync(mount);
    const address = `http://127.0.0.1:${opts.answers === false ? 1 : server.port}`;
    fs.writeFileSync(path.join(mount, 'proxy.json'), JSON.stringify({ address, hosts: [
      { host: 'api.datadoghq.com', headers: ['DD-API-KEY'] }, { host: 'api.example.net', headers: ['Authorization'] },
    ] }));
    return checkDockerSecurity(resolvePaths(path.join(dir, '.hermit'), PLUGIN_ROOT), mount);
  }

  test('enforce mode warns for mapped hosts the expected allowlist does not cover, naming /docker-security', () => {
    const r = proxied('enforce', ['datadoghq.com']);
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('api.example.net');
    expect(r.detail).not.toContain('api.datadoghq.com');
    expect(r.detail).toContain('/docker-security');
  });

  test('a parent domain, the host itself or an include line covers it', () => {
    expect(proxied('enforce', ['datadoghq.com', 'api.example.net']).status).toBe('ok');
    expect(proxied('enforce', ['datadoghq.com'], { include: 'server=/example.net/1.1.1.1\n' }).status).toBe('ok');
  });

  test('a proxy that does not answer warns and names hermitd restart, in any mode', () => {
    for (const mode of ['enforce', 'log-only']) {
      const r = proxied(mode, ['datadoghq.com', 'example.net'], { answers: false });
      expect(r.status).toBe('warn');
      expect(r.detail).toContain('does not answer');
      expect(r.detail).toContain('hermitd restart');
    }
  });

  test('with the proxy off the verdict is unchanged', () => {
    const r = proxied('enforce', [], { enabled: false, answers: false });
    expect(r.status).toBe('ok');
  });
});
