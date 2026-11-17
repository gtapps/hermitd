import { describe, test, expect, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { resolvePaths, checkDockerSecurity } from '../scripts/doctor-check';
import { freshDirFactory } from './helpers/workdir';

const PLUGIN_ROOT = path.resolve(import.meta.dir, '..');
const { freshDir, cleanup } = freshDirFactory('hermit-docker-sec-');
afterAll(cleanup);

// A project with LAN containment declared and the overlay present; no base compose,
// so the host path stops before any docker subprocess.
function scenario(dnsMode: string, nftables: string | null, allowlist = '', extra: object = { transcription: { enabled: false } }) {
  const dir = freshDir();
  fs.mkdirSync(path.join(dir, '.hermit', 'docker'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.hermit', 'config.json'),
    JSON.stringify({ ...extra, docker: { security: { network: { enabled: true, dns_mode: dnsMode } } } }));
  fs.writeFileSync(path.join(dir, 'docker-compose.security.yml'), 'services: {}\n');
  if (nftables !== null) fs.writeFileSync(path.join(dir, '.hermit', 'docker', 'nftables.conf'), nftables);
  if (allowlist) fs.writeFileSync(path.join(dir, '.hermit', 'docker', 'dnsmasq.allowlist'), allowlist);
  return checkDockerSecurity(resolvePaths(path.join(dir, '.hermit'), PLUGIN_ROOT));
}

const CURRENT_RULES = 'set allow4 { type ipv4_addr; }\nip daddr @allow4 accept\n';

describe('docker-security DNS mode', () => {
  test('enforce rules without the IP sets warn and name /docker-security', () => {
    const r = scenario('enforce', 'table inet firewall { chain output { policy accept; } }\n');
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('predate IP filtering');
    expect(r.detail).toContain('/docker-security');
  });

  test('current enforce rules report the mode', () => {
    const r = scenario('enforce', CURRENT_RULES);
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('DNS enforce');
  });

  test('an enabled channel missing from the enforce allowlist warns with its hosts', () => {
    const r = scenario('enforce', CURRENT_RULES, 'server=/telegram.org/1.1.1.1\naddress=/#/\n', {
      channels: { telegram: { enabled: true }, discord: { enabled: true } }, transcription: { enabled: false },
    });
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('discord.com');
    expect(r.detail).not.toContain('telegram.org');
    expect(r.detail).toContain('/docker-security');
  });

  test('an allowlist covering every enabled feature stays ok', () => {
    const r = scenario('enforce', CURRENT_RULES, 'server=/telegram.org/1.1.1.1\naddress=/#/\n', {
      channels: { telegram: { enabled: true }, discord: { enabled: false } }, transcription: { enabled: false },
    });
    expect(r.status).toBe('ok');
  });

  test('log-only mode never warns about old rules', () => {
    const r = scenario('log-only', 'table inet firewall { chain output { policy accept; } }\n');
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('DNS log-only');
  });
});
