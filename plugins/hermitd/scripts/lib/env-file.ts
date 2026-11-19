import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './md-write';

export function parseEnvLine(line: string): { key: string; value: string } | null {
  line = line.trim();
  if (!line || line.startsWith('#')) return null;
  if (line.startsWith('export ')) line = line.slice('export '.length).trim();
  const eq = line.indexOf('=');
  if (eq === -1) return null;
  const key = line.slice(0, eq).trim();
  let value = line.slice(eq + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

function lstatIfPresent(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Canonicalize through the closest existing ancestor, including symlinks. */
function realParent(dir: string): string {
  if (lstatIfPresent(dir)) return fs.realpathSync(dir);
  return path.join(realParent(path.dirname(dir)), path.basename(dir));
}

export function privateEnvPath(projectRoot: string, file: string): string | null {
  try {
    const root = fs.realpathSync(projectRoot);
    const destination = path.resolve(projectRoot, file);
    if (path.basename(destination) !== '.env') return null;
    const parent = realParent(path.dirname(destination));
    const relative = path.relative(path.join(root, '.claude.local'), parent);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
    const resolved = path.join(parent, '.env');
    const stat = lstatIfPresent(resolved);
    return !stat || stat.isFile() ? resolved : null;
  } catch {
    return null;
  }
}

export function upsertEnvVar(file: string, name: string, value: string): void {
  const parent = path.dirname(file);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const lines = lstatIfPresent(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
  const entry = `${name}="${value}"`;
  let replaced = false;
  const updated: string[] = [];
  for (const line of lines) {
    if (parseEnvLine(line)?.key !== name) {
      updated.push(line);
    } else if (!replaced) {
      updated.push(entry + (line.endsWith('\r') ? '\r' : ''));
      replaced = true;
    }
  }
  if (!replaced) {
    if (updated.at(-1) === '') updated.pop();
    updated.push(entry, '');
  }
  const staging = fs.mkdtempSync(path.join(parent, '.env-write-'));
  try {
    const staged = path.join(staging, '.env');
    writeFileAtomic(staged, updated.join('\n'), 0o600);
    fs.renameSync(staged, file);
  } finally {
    fs.rmSync(staging, { recursive: true });
  }
}
