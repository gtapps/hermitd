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
function scenario(dnsMode: string, nftables: string | null) {
  const dir = freshDir();
  fs.mkdirSync(path.join(dir, '.hermit', 'docker'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.hermit', 'config.json'),
    JSON.stringify({ docker: { security: { network: { enabled: true, dns_mode: dnsMode } } } }));
  fs.writeFileSync(path.join(dir, 'docker-compose.security.yml'), 'services: {}\n');
  if (nftables !== null) fs.writeFileSync(path.join(dir, '.hermit', 'docker', 'nftables.conf'), nftables);
  return checkDockerSecurity(resolvePaths(path.join(dir, '.hermit'), PLUGIN_ROOT));
}

describe('docker-security DNS mode', () => {
  test('enforce rules without the IP sets warn and name /docker-security', () => {
    const r = scenario('enforce', 'table inet firewall { chain output { policy accept; } }\n');
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('predate IP filtering');
    expect(r.detail).toContain('/docker-security');
  });

  test('current enforce rules report the mode', () => {
    const r = scenario('enforce', 'set allow4 { type ipv4_addr; }\nip daddr @allow4 accept\n');
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('DNS enforce');
  });

  test('log-only mode never warns about old rules', () => {
    const r = scenario('log-only', 'table inet firewall { chain output { policy accept; } }\n');
    expect(r.status).toBe('ok');
    expect(r.detail).toContain('DNS log-only');
  });
});
