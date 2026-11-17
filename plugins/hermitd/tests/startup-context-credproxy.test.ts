// SessionStart exports for the credential proxy (startup-context.ts → lib/credproxy-env.ts).
// The mount is a scratch folder named by HERMIT_CREDPROXY_DIR; the proxy is a local listener.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { runScript } from './helpers/run';
import { setupWorkdir, type Workdir } from './helpers/workdir';

let listener: Bun.TCPSocketListener<undefined>;
const dirs: Workdir[] = [];
beforeAll(() => { listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } }); });
afterAll(() => { listener.stop(true); for (const wd of dirs) wd.cleanup(); });

function fixture(opts: { mount?: boolean; address?: string } = {}) {
  const wd = setupWorkdir(); dirs.push(wd);
  const mount = path.join(wd.dir, 'mount');
  const address = opts.address ?? `http://127.0.0.1:${listener.port}`;
  if (opts.mount !== false) {
    fs.mkdirSync(mount);
    fs.writeFileSync(path.join(mount, 'ca.pem'), '-----BEGIN CERTIFICATE-----\nPROXYCA\n-----END CERTIFICATE-----\n');
    fs.writeFileSync(path.join(mount, 'proxy.json'), JSON.stringify({ address, hosts: [{ host: 'api.example.com', headers: ['X-Key'] }] }));
  }
  const roots = path.join(wd.dir, 'roots.pem');
  fs.writeFileSync(roots, 'OPERATOR-ROOTS\n');
  const envFile = path.join(wd.dir, 'env-file');
  const home = path.join(wd.dir, 'home');
  const base: Record<string, string> = {
    AGENT_DIR: path.join(wd.dir, '.hermit'), HERMIT_CREDPROXY_DIR: mount, CLAUDE_ENV_FILE: envFile, HOME: home,
    HTTPS_PROXY: '', https_proxy: '', SSL_CERT_FILE: '', HERMIT_RESIDENT: '', EVAL_HERMIT_RESIDENT: '',
  };
  const run = (source: string, env: Record<string, string> = {}) =>
    runScript('startup-context.ts', { stdin: JSON.stringify({ source, session_id: 's-1' }), env: { ...base, ...env }, cwd: wd.dir });
  const lines = () => fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').trimEnd().split('\n') : [];
  const bundle = path.join(home, '.cache/hermit-credproxy/ca-bundle.pem');
  return { dir: wd.dir, mount, envFile, roots, bundle, address, run, lines };
}

const EXPORT_KEYS = ['HTTPS_PROXY', 'https_proxy', 'NODE_USE_ENV_PROXY', 'SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO', 'REQUESTS_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS'];

describe('startup-context credential proxy exports', () => {
  for (const source of ['startup', 'clear', 'compact', 'resume']) {
    test(`writes the exports on ${source}, for the resident and a guest`, async () => {
      for (const resident of ['1', '']) {
        const f = fixture();
        const r = await f.run(source, { EVAL_HERMIT_RESIDENT: resident });
        expect(r.exitCode).toBe(0);
        expect(r.stdout).not.toContain('HTTPS_PROXY');
        expect(f.lines().map(line => line.split('=')[0].replace('export ', ''))).toEqual(EXPORT_KEYS);
        expect(f.lines()).toContain(`export HTTPS_PROXY='${f.address}'`);
        expect(f.lines()).toContain(`export SSL_CERT_FILE='${f.bundle}'`);
        expect(f.lines()).toContain(`export NODE_EXTRA_CA_CERTS='${path.join(f.mount, 'ca.pem')}'`);
        expect(fs.readFileSync(f.bundle, 'utf8')).toContain('PROXYCA');
      }
    });
  }

  test('two runs never duplicate a line and keep unrelated exports', async () => {
    const f = fixture();
    fs.writeFileSync(f.envFile, 'export OTHER=1\nexport HTTPS_PROXY_NOTE=x');
    await f.run('startup');
    await f.run('resume');
    const lines = f.lines();
    expect(lines.slice(0, 2)).toEqual(['export OTHER=1', 'export HTTPS_PROXY_NOTE=x']);
    expect(lines).toHaveLength(2 + EXPORT_KEYS.length);
    expect(new Set(lines).size).toBe(lines.length);
  });

  test('a pre-set SSL_CERT_FILE supplies the roots in the bundle', async () => {
    const f = fixture();
    await f.run('startup', { SSL_CERT_FILE: f.roots });
    const bundle = fs.readFileSync(f.bundle, 'utf8');
    expect(bundle).toStartWith('OPERATOR-ROOTS\n');
    expect(bundle).toContain('PROXYCA');
  });

  test('nothing is written without a mount, an env file, an answering proxy, or with an own HTTPS_PROXY', async () => {
    const cases: [ReturnType<typeof fixture>, Record<string, string>][] = [
      [fixture({ mount: false }), {}],
      [fixture(), { CLAUDE_ENV_FILE: '' }],
      [fixture({ address: 'http://127.0.0.1:1' }), {}],
      [fixture(), { HTTPS_PROXY: 'http://corp-proxy:3128' }],
    ];
    for (const [f, env] of cases) {
      const r = await f.run('startup', env);
      expect(r.exitCode).toBe(0);
      expect(f.lines()).toEqual([]);
      expect(fs.existsSync(f.bundle)).toBe(false);
    }
  });

  test('a failure prints nothing and keeps the exit code', async () => {
    const f = fixture();
    fs.mkdirSync(f.envFile);
    const failing = await f.run('startup', { EVAL_HERMIT_RESIDENT: '1' });
    const plain = await fixture({ mount: false }).run('startup', { EVAL_HERMIT_RESIDENT: '1' });
    expect(failing.exitCode).toBe(0);
    expect(failing.stderr).toBe(plain.stderr);
    expect(failing.stdout.length).toBeGreaterThan(0);
    expect(failing.stdout).not.toContain('credproxy');
  });
});
