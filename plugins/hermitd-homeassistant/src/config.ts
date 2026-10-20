// WP7 tier 1 port of src/ha_agent_lab/config.py.
//
// The .env load is EXPLICIT (python-dotenv `dotenv_values(env_path)` at
// config.py:47): the file is parsed manually below — we never rely on Bun's
// automatic cwd .env autoload, so precedence stays identical to Python:
//   process env var > .env file > operator context file > fallback.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { dumpFrontmatter, loadFrontmatter } from './markdown';

// ---------------------------------------------------------------------------
// Project-root resolution (robust to drifted hook/CLI cwd — fix for #384)
// ---------------------------------------------------------------------------

/**
 * Fleet resolver — one of three; same walk-up logic, different return and fallback:
 *   core hermitDir    (core/scripts/lib/cc-compat.ts)              → the .cch dir
 *   HA   projectRoot  (homeassistant-hermit/src/config.ts)         → project root (this file)
 *   dev  findHermitDir(dev-hermit/scripts/git-push-guard.ts)       → the .cch dir or null
 * INVARIANT: hermitDir() === join(projectRoot(), '.hermit').
 * Fix one (env-var precedence, iteration cap, worktree-projection skip) → check
 * the other two.
 *
 * Returns the project ROOT (the dir containing .hermit), NOT the
 * .cch dir itself — callers append paths themselves. Does NOT honor AGENT_DIR
 * (core-only signal pointing AT the .cch dir; honoring it here would break the
 * return-value contract).
 */
export function projectRoot(): string {
  const proj = process.env.CLAUDE_PROJECT_DIR;
  if (proj) {
    const cch = join(proj, '.hermit');
    if (existsSync(cch) && !isWorktreeProjection(cch)) return proj;
  }
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const cch = join(dir, '.hermit');
    if (existsSync(join(cch, 'config.json')) && !isWorktreeProjection(cch)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd(); // fail-open: preserves today's behavior
}

// A worktree's projected `.hermit/` — never a resolution target.
// `.worktreeinclude`'s managed block copies config.json into a `claude --worktree`
// worktree so skills can Read it at the relative path they expect, but never
// `state/`: hermit state is main-rooted and shared across worktrees. So the
// sentinel without `state/` means a projection of a real root further up, and
// the walk continues to it. Mirrored in core's cc-compat.ts and dev's
// find-hermit-dir.ts — fix one, fix all three.
function isWorktreeProjection(cchDir: string): boolean {
  return existsSync(join(cchDir, 'config.json')) && !existsSync(join(cchDir, 'state'));
}

export class AppConfig {
  constructor(
    readonly root: string,
    readonly haUrl: string | null,
    readonly haLocalUrl: string | null,
    readonly haRemoteUrl: string | null,
    readonly haToken: string | null,
    readonly timeoutSeconds: number,
    readonly retryCount: number,
  ) {}

  get hasHaEndpoint(): boolean {
    return Boolean(this.primaryUrl());
  }

  get hasHaCredentials(): boolean {
    return Boolean(this.haToken && this.hasHaEndpoint);
  }

  /** Single resolved URL. Uses haUrl unless dual-URL mode is active. */
  primaryUrl(): string | null {
    return this.haUrl || this.haLocalUrl || this.haRemoteUrl;
  }

  missingHaConfigurationFields(): string[] {
    const missing: string[] = [];
    if (!this.hasHaEndpoint) missing.push('HOMEASSISTANT_URL');
    if (!this.haToken) missing.push('HOMEASSISTANT_TOKEN');
    return missing;
  }
}

// ---------------------------------------------------------------------------
// .env parsing — manual port of python-dotenv's dotenv_values semantics:
//   - optional `export ` prefix; whitespace around key and value trimmed
//   - double-quoted values decode escapes (\n, \t, ...) and may span lines
//   - single-quoted values are literal and may span lines
//   - unquoted values: a ` #` (whitespace + hash) starts a comment; a hash
//     glued to the value (`value#kept`) is part of the value
//   - `KEY=` -> '' ; bare `KEY` (no '=') -> null (dropped by loadEnvFile)
// ---------------------------------------------------------------------------

export function parseEnvText(text: string): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trimStart();

    const eq = line.indexOf('=');
    if (eq === -1) {
      if (/^[^\s#]+$/.test(line)) values[line] = null;
      continue;
    }
    const key = line.slice(0, eq).trim();
    if (key === '' || /[\s#]/.test(key)) continue;

    let raw = line.slice(eq + 1).trim();
    const quote = raw[0];
    if (quote === '"' || quote === "'") {
      // Consume continuation lines until the closing quote.
      while (!closesQuote(raw, quote) && i + 1 < lines.length) {
        raw += `\n${lines[++i]!}`;
      }
      const close = closingQuoteIndex(raw, quote);
      const inner = close === -1 ? raw.slice(1) : raw.slice(1, close);
      values[key] = quote === '"' ? decodeEscapes(inner) : inner;
    } else {
      const comment = raw.search(/\s#/);
      values[key] = (comment === -1 ? raw : raw.slice(0, comment)).trim();
    }
  }
  return values;
}

function closingQuoteIndex(raw: string, quote: string): number {
  for (let i = 1; i < raw.length; i++) {
    if (raw[i] === '\\' && quote === '"') i++;
    else if (raw[i] === quote) return i;
  }
  return -1;
}

const closesQuote = (raw: string, quote: string): boolean => closingQuoteIndex(raw, quote) !== -1;

function decodeEscapes(value: string): string {
  const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', f: '\f', b: '\b', v: '\v' };
  return value.replace(/\\(.)/g, (_, ch: string) => map[ch] ?? ch);
}

export function loadEnvFile(root: string): Record<string, string> {
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) return {};
  const entries = Object.entries(parseEnvText(readFileSync(envPath, 'utf8'))).filter(
    (entry): entry is [string, string] => entry[1] !== null,
  );
  return Object.fromEntries(entries);
}

export function saveEnvFile(root: string, updates: Record<string, string | null>): string {
  const envPath = join(root, '.env');
  const existing = loadEnvFile(root);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) delete existing[key];
    else existing[key] = value;
  }
  const lines = Object.entries(existing).map(([key, value]) => `${key}=${value}`);
  writeFileSync(envPath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
  return envPath;
}

// ---------------------------------------------------------------------------
// Operator context (.local/operator/context.md)
// ---------------------------------------------------------------------------

export function operatorContextPath(root: string): string {
  return join(root, '.local', 'operator', 'context.md');
}

export function loadOperatorContext(root: string): Record<string, string> {
  const path = operatorContextPath(root);
  if (!existsSync(path)) return {};
  const [metadata] = loadFrontmatter(path);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (isPyTruthy(value)) out[key] = String(value);
  }
  return out;
}

// Python `if value` truthiness (the values written here are always strings,
// but keep the filter faithful for hand-edited frontmatter).
function isPyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') {
    return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

export function saveOperatorContext(
  root: string,
  options: { url?: string | null; localUrl?: string | null; remoteUrl?: string | null } = {},
): string {
  const metadata = {
    home_assistant_url: options.url || '',
    home_assistant_local_url: options.localUrl || '',
    home_assistant_remote_url: options.remoteUrl || '',
  };
  const body = [
    '# Local Operator Context',
    '',
    '- This file is ignored and local-only.',
    '- Keep operator-specific endpoints here if they are not stored in `.env`.',
  ].join('\n');
  const path = operatorContextPath(root);
  dumpFrontmatter(path, metadata, body);
  return path;
}

export const HERMIT_RAW = join('.hermit', 'raw');

export function normalizedContextPath(root: string): string {
  return join(root, HERMIT_RAW, 'snapshot-ha-normalized-latest.json');
}

// ---------------------------------------------------------------------------
// load_config
// ---------------------------------------------------------------------------

// Python int(): digits only (no float strings), raise on garbage.
function pyInt(value: string): number {
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) {
    throw new Error(`invalid literal for int(): '${value}'`);
  }
  return parseInt(trimmed, 10);
}

export function loadConfig(root?: string | null): AppConfig {
  const repoRoot = resolve(root ?? process.cwd());
  const envFile = loadEnvFile(repoRoot);
  const operatorContext = loadOperatorContext(repoRoot);

  const pick = (name: string, fallback: string | null = null): string | null =>
    process.env[name] || envFile[name] || operatorContext[name.toLowerCase()] || fallback;

  return new AppConfig(
    repoRoot,
    pick('HOMEASSISTANT_URL'),
    pick('HOMEASSISTANT_LOCAL_URL'),
    pick('HOMEASSISTANT_REMOTE_URL'),
    pick('HOMEASSISTANT_TOKEN'),
    pyInt(pick('HOMEASSISTANT_TIMEOUT_SECONDS', '15') || '15'),
    pyInt(pick('HOMEASSISTANT_RETRY_COUNT', '2') || '2'),
  );
}
