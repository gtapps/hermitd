// Contract tests for the docker-security templates.
// (bun test port of test-docker-security-templates.sh)
//
// These bugs (1.0.27 → 1.0.28) escaped because template content has no
// automated assertions: tee-vs-dnsmasq PID capture, missing capabilities,
// host bind mount under rootless Docker, slow healthcheck. This suite
// pattern-matches the templates and SKILL.md to lock those regressions
// down. No Docker daemon required — pure file inspection.
//
// Usage: bun test tests/docker-security-templates.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { PLUGIN_ROOT } from './helpers/run';

const read = (...p: string[]) => fs.readFileSync(path.join(PLUGIN_ROOT, ...p), 'utf-8');

const entrypoint = read('state-templates', 'docker', 'security', 'netguard-entrypoint.sh.template');
const skill = read('skills', 'docker-security', 'SKILL.md');
const allowlist = read('state-templates', 'docker', 'security', 'dnsmasq.allowlist.template');
const docs = read('docs', 'docker-security.md');
// Step 8's verification heredoc was extracted verbatim into a static file the
// skill streams via `exec -T hermit sh -s < verify-security.sh`. The runtime
// probe assertions moved here with it.
const verify = read('state-templates', 'docker', 'security', 'verify-security.sh');

// -------------------------------------------------------
// Entrypoint: no tee-piping, no DNSMASQ_PID=$! capture
// -------------------------------------------------------
describe('netguard-entrypoint.sh.template', () => {
  test("entrypoint: no 'tee -a' (regression: bug #1 + #2 cascade)", () => {
    expect(entrypoint).not.toContain('tee -a');
  });

  test("entrypoint: no 'DNSMASQ_PID=' assignment (regression: $! captures tee)", () => {
    expect(entrypoint).not.toContain('DNSMASQ_PID=');
  });

  test("entrypoint: no '/var/log/netguard' references (regression: rootless bind mount)", () => {
    expect(entrypoint).not.toContain('/var/log/netguard');
  });

  // -------------------------------------------------------
  // Entrypoint: positive assertions
  // -------------------------------------------------------
  test('entrypoint: --log-facility=- on log-only dnsmasq line', () => {
    expect(entrypoint).toContain('dnsmasq -k --log-queries --log-facility=-');
  });

  test('entrypoint: --log-facility=- on enforce dnsmasq line', () => {
    expect(entrypoint).toContain('dnsmasq -k --log-facility=- --conf-file');
  });

  test('entrypoint: pgrep dnsmasq used for liveness check', () => {
    expect(entrypoint).toContain('pgrep dnsmasq');
  });

  // -------------------------------------------------------
  // Entrypoint: log-only mode honors static address= records (issue #602)
  // -------------------------------------------------------
  test('entrypoint: log-only branch extracts address= lines from the allowlist', () => {
    expect(entrypoint).toContain('while IFS= read -r line || [ -n "$line" ]; do');
    expect(entrypoint).toContain('done < /etc/dnsmasq.allowlist');
  });

  test('entrypoint: log-only extraction excludes the address=/#/ catchall', () => {
    expect(entrypoint).toContain('address=/#/*) ;;');
  });

  test('entrypoint: log-only extraction forwards matched lines as --address= flags', () => {
    expect(entrypoint).toContain('set -- "$@" "--$line"');
    expect(entrypoint).toContain('--server=1.1.1.1 "$@" \\');
  });

  test('entrypoint: log-only dnsmasq launch is still followed by the pgrep hold-open guard', () => {
    const logOnlyIdx = entrypoint.indexOf('--server=1.1.1.1 "$@"');
    const pgrepIdx = entrypoint.indexOf('pgrep dnsmasq');
    expect(logOnlyIdx).toBeGreaterThan(-1);
    expect(pgrepIdx).toBeGreaterThan(logOnlyIdx);
  });
});

// -------------------------------------------------------
// SKILL.md contract assertions
// -------------------------------------------------------
describe('docker-security SKILL.md', () => {
  // cap_add / start_period moved out of the SKILL into the rendered overlay when
  // template rendering was extracted to render-security-overlay.ts — those two
  // assertions now live in tests/render-security-overlay.test.ts.

  test("SKILL.md: no 'state:/var/log/netguard' bind mount (regression: rootless)", () => {
    expect(skill).not.toContain('state:/var/log/netguard');
  });

  // Python retired from the Docker layer (bun migration WP9) — the base image
  // no longer ships python3, so no verification snippet may invoke it.
  test('SKILL.md: no python3 invocations (only the "image has no python3" note)', () => {
    const invocations = skill.split('\n').filter((l) => l.includes('python3') && !l.includes('no `python3`'));
    expect(invocations).toEqual([]);
  });

  // --no-cache netguard rebuild (operational step 6c — stays in the skill)
  test('SKILL.md: step 6c forces --no-cache netguard build (prevents stale image on upgrade)', () => {
    expect(skill).toContain('build --no-cache hermit-netguard');
  });
});

// -------------------------------------------------------
// verify-security.sh: the extracted Step 8 verification heredoc.
// Assertions retargeted here from the in-SKILL block.
// -------------------------------------------------------
describe('verify-security.sh', () => {
  test('verify: placeholder-free (streamed verbatim, never rendered)', () => {
    expect(verify).not.toMatch(/\{\{[A-Z][A-Z0-9_]*\}\}/);
  });

  // Hardened DNS-block verifier
  test("verify: DNS-block check uses 'timeout 2s' (catches timeout vs NXDOMAIN)", () => {
    expect(verify).toContain('timeout 2s bun -e');
  });

  test('verify: DNS-block check classifies timeout explicitly (not just grep-on-stderr)', () => {
    expect(verify).toContain('query timed out');
  });

  test('verify: uses bun for LAN/DNS checks (no nc / nslookup invocations)', () => {
    expect(verify).toContain('require("net").connect');
    expect(verify).toContain('require("dns").lookup');
    expect(verify).toContain('require("dgram").createSocket');
    // python3 appears only in the header note; assert no invocation of it.
    const py = verify.split('\n').filter((l) => l.includes('python3') && !l.includes('no python3'));
    expect(py).toEqual([]);
  });
});

// -------------------------------------------------------
// dnsmasq.allowlist.template: no-resolv + core domains
// -------------------------------------------------------
describe('dnsmasq.allowlist.template', () => {
  test('allowlist: no-resolv directive present (prevents DNS leak to resolv.conf)', () => {
    expect(allowlist).toMatch(/^no-resolv$/m);
  });

  test('allowlist: server=/claude.ai/ present (OAuth login flow)', () => {
    expect(allowlist).toContain('server=/claude.ai/');
  });

  test('allowlist: server=/claude.com/ present (OAuth login flow)', () => {
    expect(allowlist).toContain('server=/claude.com/');
  });

  test('allowlist: server=/claudeusercontent.com/ present (Claude in Chrome bridge)', () => {
    const core = allowlist.split('# --- Core hermit operation ---')[1].split('# --- Fleet-plugin contributions')[0];
    expect(core).toContain("# Claude in Chrome's bridge\nserver=/claudeusercontent.com/1.1.1.1");
    expect(allowlist.match(/^server=\/claudeusercontent\.com\//gm)).toHaveLength(1);
    expect(allowlist.trimEnd().endsWith('address=/#/')).toBe(true);
  });

  test('allowlist: documents address=/<host>/<ip> as a static pin (issue #602)', () => {
    expect(allowlist).toContain('address=/<host>/<ip>');
  });
});

// -------------------------------------------------------
// SKILL.md + docs: tune instruction says down && up, not restart hermit-netguard
// -------------------------------------------------------
describe('tune instruction (SKILL.md + docs)', () => {
  test("SKILL.md: tune instruction uses 'hermitd-docker down && hermitd-docker up' not restart", () => {
    expect(skill).toContain('hermitd-docker down && hermitd-docker up');
  });

  test('docs/docker-security.md: tune instruction uses down && up', () => {
    expect(docs).toContain('hermitd-docker down && hermitd-docker up');
  });

  test("docs/docker-security.md: no stale 'restart hermit-netguard' instruction in tune section", () => {
    expect(docs).not.toContain('restart hermit-netguard');
  });

  test("docs/docker-security.md: no longer recommends extra_hosts as a workaround (issue #602 — Docker rejects it under network_mode: service:)", () => {
    expect(docs).not.toContain('Use `extra_hosts` on the `hermit` service in your compose file instead');
  });

  test('docs/docker-security.md: no python3 in the verify block (Python retired from image)', () => {
    expect(docs).not.toContain('python3');
  });
});
