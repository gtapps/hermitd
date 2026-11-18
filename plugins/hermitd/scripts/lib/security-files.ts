// The files `render-security-overlay.ts render` owns, project-relative, and the write
// primitives host code uses inside agent-writable folders. A leaf module: the approval core
// cannot import the renderer (it imports compose-files, which imports the approval core).
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';

export const OVERLAY_FILE = 'docker-compose.security.yml';
export const NETGUARD_FILES = {
  dockerfile: '.hermit/docker/Dockerfile.hermit-netguard',
  entrypoint: '.hermit/docker/netguard-entrypoint.sh',
  nftables: '.hermit/docker/nftables.conf',
  dnsmasq: '.hermit/docker/dnsmasq.allowlist',
} as const;
export const SECURITY_FILES: readonly string[] = [OVERLAY_FILE, ...Object.values(NETGUARD_FILES)];

export function isLink(file: string): boolean {
  try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; }
}

/** Replace `file` through an exclusive, unpredictable temp file, so a planted link is replaced, never followed. */
export function writeExclusive(file: string, content: string, mode: number): void {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, content, { flag: 'wx', mode });
  try {
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}
