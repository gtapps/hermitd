import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { siblingPluginDirs, readHermitMeta, readCoreName } from './plugin-siblings';
import { pyTruthy } from './channel-config';
import {
  resolveAuthMode, readTokenValue, tokenFilePath, defaultConfigDir,
  TOKEN_FILENAME, envAuthPresent,
} from './setup-token';

// Probe timeout: 5s default; env override exists solely so tests can exercise
// the timeout path without waiting 5 real seconds.
const CRED_PROBE_TIMEOUT_MS_ENV = Number(process.env.HERMIT_CRED_PROBE_TIMEOUT_MS);
const CRED_PROBE_TIMEOUT_MS = CRED_PROBE_TIMEOUT_MS_ENV > 0 ? CRED_PROBE_TIMEOUT_MS_ENV : 5000;
const CRED_WARN_WINDOW_MS = 7 * 24 * 3600000; // < 7d → warn
const CRED_PROBE_CEILING = 8; // defensive cap on total probes run per doctor pass

type ProbeResult =
  | { kind: 'ok' }
  | { kind: 'expired' }
  | { kind: 'expires'; at: number }
  | { kind: 'probe-failed'; reason: string };

// Runs one hermit-meta.json expiry_probe. Protocol: bash -c <cmd>, one line of
// stdout, exactly OK | EXPIRED | EXPIRES:<iso8601>. Anything else (multi-word
// first line, unparseable date, timeout, nonzero exit) degrades to a warn-level
// "probe failed" — never crashes the doctor check. CLAUDE_PLUGIN_ROOT is set to
// the declaring plugin's dir (not core's) so a probe like
// `bun ${CLAUDE_PLUGIN_ROOT}/scripts/check-token.ts` resolves against its own scripts.
export function runExpiryProbe(cmd: string, pluginDir: string): ProbeResult {
  let out: string;
  try {
    out = execFileSync('bash', ['-c', cmd], {
      encoding: 'utf8',
      timeout: CRED_PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginDir },
    });
  } catch (e: any) {
    return { kind: 'probe-failed', reason: e?.code === 'ETIMEDOUT' || e?.signal === 'SIGTERM' ? 'timeout' : 'exit error' };
  }
  const line = (out.split('\n')[0] || '').trim();
  if (line === 'OK') return { kind: 'ok' };
  if (line === 'EXPIRED') return { kind: 'expired' };
  if (line.startsWith('EXPIRES:')) {
    const at = Date.parse(line.slice('EXPIRES:'.length));
    if (Number.isNaN(at)) return { kind: 'probe-failed', reason: 'malformed date' };
    return { kind: 'expires', at };
  }
  return { kind: 'probe-failed', reason: 'malformed output' };
}

// Walks core's own and sibling plugins' hermit-meta.json credentials[] and runs
// each declared expiry_probe, capped at CRED_PROBE_CEILING total probes (defensive
// ceiling on wall-clock: worst case CRED_PROBE_CEILING × CRED_PROBE_TIMEOUT_MS).
// Entries missing expiry_probe are skipped silently — declaring a credential
// without a probe is allowed, there's just nothing to check.
//
// Core is probed first and deliberately: siblingPluginDirs() excludes core's own
// dir in both cache layouts, so core's setup-token credential would otherwise be
// invisible to the very check that exists to catch expiring credentials.
export function probeDeclaredCredentials(pluginRoot: string): { okCount: number; badNotes: string[] } {
  const coreName = readCoreName(pluginRoot);

  let okCount = 0;
  const badNotes: string[] = [];
  let probesRun = 0;
  let skipped = 0;

  for (const dir of [pluginRoot, ...siblingPluginDirs(pluginRoot, coreName)]) {
    const meta = readHermitMeta(dir);
    const credentials = Array.isArray(meta.credentials) ? meta.credentials : [];
    const pluginLabel = (dir === pluginRoot ? coreName : readCoreName(dir)) || path.basename(dir);

    for (const cred of credentials) {
      if (!cred || typeof cred.expiry_probe !== 'string' || !cred.expiry_probe) continue;
      // Past the ceiling, count remaining credentials as skipped rather than
      // silently dropping them — an unchecked credential must not read as ok.
      if (probesRun >= CRED_PROBE_CEILING) { skipped++; continue; }
      probesRun++;
      const who = `${pluginLabel}/${cred.name || 'credential'}`;
      const fix = cred.reauth_skill ? ` — run ${cred.reauth_skill}` : '';
      // Per-credential lead time: a credential whose renewal needs the operator
      // to find a browser deserves its own window rather than the 7d default.
      // Core's `claude-subscription` asks for 3, matching what Claude Code itself
      // warns on.
      const warnDays = Number(cred.warn_days);
      const warnWindowMs = warnDays > 0 ? warnDays * 24 * 3600000 : CRED_WARN_WINDOW_MS;
      const result = runExpiryProbe(cred.expiry_probe, dir);
      if (result.kind === 'ok') {
        okCount++;
      } else if (result.kind === 'expired') {
        badNotes.push(`${who} EXPIRED${fix}`);
      } else if (result.kind === 'expires') {
        const msLeft = result.at - Date.now();
        if (msLeft <= 0) {
          badNotes.push(`${who} EXPIRED${fix}`);
        } else if (msLeft < warnWindowMs) {
          badNotes.push(`${who} expires in ${(msLeft / (24 * 3600000)).toFixed(1)}d${fix}`);
        } else {
          okCount++;
        }
      } else {
        badNotes.push(`${who} probe failed (${result.reason})`);
      }
    }
  }
  if (skipped > 0) badNotes.push(`${skipped} credential(s) not checked (probe ceiling ${CRED_PROBE_CEILING} reached)`);
  return { okCount, badNotes };
}

// Two credentials on one volume. In login mode the leftover token file is the
// confusing artifact: nothing reads it, but its presence is why an operator thinks a
// renewal "did nothing". In token mode a stored /login next to the token is inert,
// because Claude Code keeps a user-supplied CLAUDE_CODE_OAUTH_TOKEN ahead of it.
// External mode has no file this hermit owns, so it says nothing.
//
// No expiry_probe reports this — it is a property of the volume, not of any one
// credential — so both the doctor check and the heartbeat precheck fold it in
// alongside probeDeclaredCredentials.
export function strayTokenNote(config: any = {}): string | null {
  const configDir = defaultConfigDir();
  if (resolveAuthMode(config, configDir) !== 'login') return null;
  if (readTokenValue(configDir) === null) return null;
  return `stray ${TOKEN_FILENAME} is ignored in login mode — remove it (rm ${tokenFilePath(configDir)}) or set auth_mode: token`;
}

// Chrome requires a claude.ai login; setup-tokens and environment credentials
// leave it disabled in Claude Code even when --chrome is requested.
export function chromeAuthNote(config: any = {}): string | null {
  if (!pyTruthy(config.chrome)) return null;
  if (envAuthPresent()) {
    return 'Chrome stays off with an env credential; remove it from the hermit environment, then use auth_mode: login via /hermitd:relogin';
  }
  if (resolveAuthMode(config, defaultConfigDir()) !== 'token') return null;
  return 'Chrome stays off with a setup-token; use auth_mode: login via /hermitd:relogin';
}
