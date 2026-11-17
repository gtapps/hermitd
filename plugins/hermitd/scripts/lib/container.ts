// Container detection, shared by the booter and doctor so neither has to import
// the other.

import fs from 'node:fs';

/** Root-owned managed-settings drop-in the generated Docker image bakes. */
export const MANAGED_SECURITY_SETTINGS = '/etc/claude-code/managed-settings.d/hermitd-security.json';

/** Detect if running inside a container (Docker, Podman, LXC). */
export function isContainer(): boolean {
  return (
    fs.existsSync('/.dockerenv') ||
    fs.existsSync('/run/.containerenv') ||
    process.env.container === 'docker'
  );
}
