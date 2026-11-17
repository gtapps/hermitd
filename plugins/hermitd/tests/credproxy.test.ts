import { afterAll, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { envoyConfig, headerValue, removeBindings, storeDir, upsertBinding } from '../scripts/lib/credproxy';

const SCRIPT = path.resolve(import.meta.dir, '../scripts/credproxy.ts');
const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(docker = true) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-credproxy-')));
  roots.push(root);
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, '.hermit'), { recursive: true });
  fs.writeFileSync(path.join(project, '.hermit/config.json'), '{}');
  if (docker) fs.writeFileSync(path.join(project, 'docker-compose.hermit.yml'), 'services: {}\n');
  const config = path.join(root, 'home', '.claude');
  const env = { ...process.env, HOME: path.join(root, 'home'), container: '' };
  const run = async (sub: string, args: string[] = [], options: { stdin?: string; env?: Record<string, string> } = {}) => {
    const proc = Bun.spawn([process.execPath, SCRIPT, sub, project, ...args], { cwd: '/', env: { ...env, ...options.env }, stdin: Buffer.from(options.stdin ?? ''), stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr, json: JSON.parse(stdout.trim().split('\n').pop() || 'null') };
  };
  const store = () => storeDir(project, config);
  return { root, project, config, run, store };
}

/** Every file under `dir` whose content holds `needle`. */
function holding(dir: string, needle: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.join(entry.parentPath, entry.name))
    .filter(file => fs.readFileSync(file).includes(needle));
}

describe('store and map', () => {
  test('stores are named from the real path plus a hash, so punctuation never collides', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-credproxy-')));
    roots.push(root);
    for (const name of ['a.b', 'a-b']) fs.mkdirSync(path.join(root, name));
    const a = storeDir(path.join(root, 'a.b'), '/cfg');
    const b = storeDir(path.join(root, 'a-b'), '/cfg');
    expect(a).not.toBe(b);
    expect(path.basename(a)).toContain('-a-b-');
    expect(a.startsWith('/cfg/')).toBe(true);
  });

  test('bindings are keyed by host and header, case-insensitively', () => {
    let list = upsertBinding([], { host: 'api.example.com', header: 'DD-API-KEY', secret: 'a' });
    list = upsertBinding(list, { host: 'api.example.com', header: 'DD-APPLICATION-KEY', secret: 'b' });
    list = upsertBinding(list, { host: 'api.example.com', header: 'dd-api-key', secret: 'c' });
    expect(list.map(b => b.secret).sort()).toEqual(['b', 'c']);
    expect(removeBindings(list, 'api.example.com', 'DD-application-key').map(b => b.secret)).toEqual(['c']);
    expect(removeBindings(list, 'api.example.com')).toEqual([]);
  });

  test('header values follow prefix and basic auth', () => {
    expect(headerValue({ host: 'h.io', header: 'Authorization', secret: 's', prefix: 'Bearer ' }, 'v')).toBe('Bearer v');
    expect(headerValue({ host: 'h.io', header: 'Authorization', secret: 's', basic_user: 'u' }, 'p')).toBe('Basic ' + btoa('u:p'));
  });

  test('map, status and unmap print one JSON object naming hermitd restart', async () => {
    const f = fixture();
    const mapped = await f.run('map', ['API.Example.com.', '--header', 'DD-API-KEY', '--secret', 'dd_api']);
    expect(mapped.code).toBe(0);
    expect(mapped.json).toMatchObject({ status: 'mapped', host: 'api.example.com', header: 'DD-API-KEY', has_value: false, apply: 'hermitd restart' });
    await f.run('map', ['api.example.com', '--header', 'DD-APPLICATION-KEY', '--secret', 'dd_app']);
    expect((await f.run('status')).json.bindings).toEqual([
      { host: 'api.example.com', header: 'DD-API-KEY', secret: 'dd_api', has_value: false },
      { host: 'api.example.com', header: 'DD-APPLICATION-KEY', secret: 'dd_app', has_value: false },
    ]);
    const map = JSON.parse(fs.readFileSync(path.join(f.store(), 'map.json'), 'utf8'));
    expect(map.project).toBe(f.project);
    expect(fs.statSync(path.join(f.store(), 'map.json')).mode & 0o777).toBe(0o600);
    const unmapped = await f.run('unmap', ['api.example.com', '--header', 'dd-api-key']);
    expect(unmapped.json).toMatchObject({ status: 'unmapped', removed: 1, apply: 'hermitd restart' });
    expect((await f.run('unmap', ['api.example.com'])).json.removed).toBe(1);
    expect((await f.run('status')).json.bindings).toEqual([]);
    expect(fs.readdirSync(f.store()).filter(name => name.includes('.tmp'))).toEqual([]);
    expect(f.store().startsWith(f.project)).toBe(false);
  });

  test('invalid input is refused', async () => {
    const f = fixture();
    expect((await f.run('map', ['not a host', '--header', 'X', '--secret', 's'])).json).toEqual({ error: 'invalid_host' });
    expect((await f.run('map', ['h.io', '--header', 'Bad Header', '--secret', 's'])).json).toEqual({ error: 'invalid_header' });
    expect((await f.run('map', ['h.io', '--header', 'X', '--secret', '../x'])).json).toEqual({ error: 'invalid_secret_name' });
    expect((await f.run('map', ['h.io', '--header', 'X', '--secret', 's', '--prefix', 'a', '--basic-user', 'u'])).json).toEqual({ error: 'prefix_and_basic_user' });
  });

  test('a tmux project is refused, and so is a container', async () => {
    expect((await fixture(false).run('status'))).toMatchObject({ code: 1, json: { error: 'docker_only' } });
    expect((await fixture().run('status', [], { env: { container: 'docker' } }))).toMatchObject({ code: 1, json: { error: 'host_only' } });
  });
});

describe('secret values', () => {
  test('set stores the value 0600 and never prints it; unset removes it', async () => {
    const f = fixture();
    const value = 'sv-' + crypto.randomUUID();
    await f.run('map', ['api.example.com', '--header', 'X-Key', '--secret', 'k']);
    const set = await f.run('set', ['k'], { stdin: value + '\n' });
    expect(set.code).toBe(0);
    expect(set.json).toEqual({ status: 'set', secret: 'k', apply: 'hermitd restart' });
    expect(set.stdout + set.stderr).not.toContain(value);
    const file = path.join(f.store(), 'secrets/k');
    expect(fs.readFileSync(file, 'utf8')).toBe(value);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const status = await f.run('status');
    expect(status.json.bindings[0].has_value).toBe(true);
    expect(status.stdout).not.toContain(value);
    expect(holding(f.project, value)).toEqual([]);
    expect((await f.run('unset', ['k'])).json).toEqual({ status: 'unset', secret: 'k', apply: 'hermitd restart' });
    expect(fs.existsSync(file)).toBe(false);
    expect((await f.run('status')).json.bindings[0].has_value).toBe(false);
    expect((await f.run('unset', ['k'])).code).toBe(0);
  });

  test('an empty value is refused', async () => {
    const f = fixture();
    expect(await f.run('set', ['k'], { stdin: '\n' })).toMatchObject({ code: 1, json: { error: 'empty_value' } });
  });
});

describe('render', () => {
  const openssl = (args: string[]) => spawnSync('openssl', args, { encoding: 'utf8' });

  async function mapped() {
    const f = fixture();
    const values = { dd_api: 'v-api-' + crypto.randomUUID(), dd_app: 'v-app-' + crypto.randomUUID(), gh: 'v-gh-' + crypto.randomUUID() };
    await f.run('map', ['api.example.com', '--header', 'DD-API-KEY', '--secret', 'dd_api']);
    await f.run('map', ['api.example.com', '--header', 'DD-APPLICATION-KEY', '--secret', 'dd_app']);
    await f.run('map', ['api.github.com', '--header', 'Authorization', '--secret', 'gh', '--prefix', 'Bearer ']);
    for (const [name, value] of Object.entries(values)) await f.run('set', [name], { stdin: value });
    return { ...f, values };
  }

  test('with no bindings nothing is written', async () => {
    const f = fixture();
    expect((await f.run('render')).json).toEqual({ status: 'skipped', reason: 'no_bindings' });
    expect(fs.existsSync(f.store())).toBe(false);
  });

  test('writes sidecar and agent folders with a certificate valid for every mapped host', async () => {
    const f = await mapped();
    const r = await f.run('render');
    expect(r.code).toBe(0);
    expect(r.json).toEqual({ status: 'rendered', hosts: ['api.example.com', 'api.github.com'], missing_values: [] });
    const store = f.store();
    expect(fs.readdirSync(path.join(store, 'sidecar')).sort()).toEqual(['envoy.yaml', 'server.crt', 'server.key']);
    expect(fs.readdirSync(path.join(store, 'agent')).sort()).toEqual(['ca.pem', 'proxy.json']);
    expect(openssl(['verify', '-CAfile', path.join(store, 'agent/ca.pem'), path.join(store, 'sidecar/server.crt')]).status).toBe(0);
    const text = openssl(['x509', '-in', path.join(store, 'sidecar/server.crt'), '-noout', '-ext', 'subjectAltName']).stdout;
    expect(text).toContain('DNS:api.example.com');
    expect(text).toContain('DNS:api.github.com');
    expect(JSON.parse(fs.readFileSync(path.join(store, 'agent/proxy.json'), 'utf8'))).toEqual({
      address: 'http://127.0.0.1:18443',
      hosts: [{ host: 'api.example.com', headers: ['DD-API-KEY', 'DD-APPLICATION-KEY'] }, { host: 'api.github.com', headers: ['Authorization'] }],
    });
    const config = fs.readFileSync(path.join(store, 'sidecar/envoy.yaml'), 'utf8');
    expect(config).toContain('"DD-API-KEY"');
    expect(config).toContain('"DD-APPLICATION-KEY"');
    expect(config).toContain(`"Bearer ${f.values.gh}"`);
    expect(config).not.toContain('admin');
    expect(fs.statSync(path.join(store, 'sidecar/envoy.yaml')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(store, 'ca.key')).mode & 0o777).toBe(0o600);
    // The agent's container user may not be the host user.
    expect(fs.statSync(path.join(store, 'agent/proxy.json')).mode & 0o777).toBe(0o644);
    expect(fs.statSync(path.join(store, 'agent/ca.pem')).mode & 0o777).toBe(0o644);
    // Secret values and the authority's key stay in their own files.
    for (const value of Object.values(f.values)) {
      expect(holding(f.root, value).map(file => path.relative(store, file)).sort()).toEqual(['secrets/' + Object.entries(f.values).find(([, v]) => v === value)![0], 'sidecar/envoy.yaml'].sort());
    }
    const caKey = fs.readFileSync(path.join(store, 'ca.key'), 'utf8').split('\n').slice(1, 3).join('\n');
    expect(holding(f.root, caKey).map(file => path.relative(store, file))).toEqual(['ca.key']);
    expect(holding(f.project, 'BEGIN')).toEqual([]);
  });

  test('re-rendering the same hosts keeps the authority and certificate; a removed host is gone', async () => {
    const f = await mapped();
    await f.run('render');
    const read = (name: string) => fs.readFileSync(path.join(f.store(), name), 'utf8');
    const ca = read('agent/ca.pem'); const crt = read('sidecar/server.crt');
    await f.run('render');
    expect(read('agent/ca.pem')).toBe(ca);
    expect(read('sidecar/server.crt')).toBe(crt);
    await f.run('unmap', ['api.github.com']);
    expect((await f.run('render')).json.hosts).toEqual(['api.example.com']);
    expect(read('agent/ca.pem')).toBe(ca);
    expect(read('sidecar/server.crt')).not.toBe(crt);
    expect(read('sidecar/envoy.yaml')).not.toContain('api.github.com');
    expect(read('sidecar/envoy.yaml')).not.toContain(f.values.gh);
  });

  test('a binding without a value is reported and left out', async () => {
    const f = await mapped();
    await f.run('unset', ['dd_app']);
    const r = await f.run('render');
    expect(r.code).toBe(0);
    expect(r.json.missing_values).toEqual([{ host: 'api.example.com', header: 'DD-APPLICATION-KEY', secret: 'dd_app' }]);
    expect(fs.readFileSync(path.join(f.store(), 'sidecar/envoy.yaml'), 'utf8')).not.toContain('DD-APPLICATION-KEY');
  });

  test('unset and unmap remove the value from an already rendered config', async () => {
    const f = await mapped();
    await f.run('render');
    const config = path.join(f.store(), 'sidecar/envoy.yaml');
    expect((await f.run('unset', ['gh'])).json).toEqual({ status: 'unset', secret: 'gh', apply: 'hermitd restart' });
    expect(holding(f.root, f.values.gh)).toEqual([]);
    await f.run('unmap', ['api.example.com']);
    expect(fs.readFileSync(config, 'utf8')).not.toContain(f.values.dd_api);
    expect(holding(f.root, f.values.dd_api).map(file => path.relative(f.store(), file))).toEqual(['secrets/dd_api']);
  });

  test('when the re-render fails, unset drops the config rather than keep the value', async () => {
    const f = await mapped();
    await f.run('render');
    await f.run('map', ['new.example.com', '--header', 'X-Key', '--secret', 'dd_api']);
    const r = await f.run('unset', ['gh'], { env: { PATH: path.join(f.root, 'empty-bin') } });
    expect(r.json).toEqual({ status: 'unset', secret: 'gh', apply: 'hermitd restart' });
    expect(fs.existsSync(path.join(f.store(), 'sidecar/envoy.yaml'))).toBe(false);
    expect(holding(f.root, f.values.gh)).toEqual([]);
  });

  test('a host name longer than 64 characters still renders', async () => {
    const f = fixture();
    const host = 'my-very-long-function-name-abcdef1234567.lambda-url.eu-central-1.on.aws';
    await f.run('map', [host, '--header', 'X-Key', '--secret', 'k']);
    await f.run('set', ['k'], { stdin: 'v' });
    const r = await f.run('render');
    expect(r.code).toBe(0);
    expect(r.json.hosts).toEqual([host]);
  });

  test('a missing openssl fails and leaves the previous set untouched', async () => {
    const f = await mapped();
    await f.run('render');
    const before = fs.readFileSync(path.join(f.store(), 'sidecar/envoy.yaml'), 'utf8');
    await f.run('map', ['new.example.com', '--header', 'X-Key', '--secret', 'dd_api']);
    const r = await f.run('render', [], { env: { PATH: path.join(f.root, 'empty-bin') } });
    expect(r).toMatchObject({ code: 1, json: { error: 'openssl_missing' } });
    expect(fs.readFileSync(path.join(f.store(), 'sidecar/envoy.yaml'), 'utf8')).toBe(before);
    expect(fs.readdirSync(f.store()).filter(name => name.startsWith('.render-'))).toEqual([]);
  });

  test('the config verifies each upstream by name, drops Envoy headers and only listens on loopback', () => {
    const config: any = envoyConfig([
      { host: 'a.example.com', headers: [{ header: 'X-A', value: 'va' }, { header: 'X-B', value: 'vb' }] },
      { host: 'b.example.com', headers: [{ header: 'Authorization', value: 'Bearer vc' }] },
    ]);
    expect(config.admin).toBeUndefined();
    const [forward, ...internal] = config.static_resources.listeners;
    expect(forward.address.socket_address.address).toBe('127.0.0.1');
    expect(internal.every((l: any) => 'internal_listener' in l)).toBe(true);
    const vhosts = forward.filter_chains[0].filters[0].typed_config.route_config.virtual_hosts;
    expect(vhosts.map((v: any) => v.domains)).toEqual([['a.example.com:443'], ['b.example.com:443'], ['*']]);
    const upstreams = config.static_resources.clusters.filter((c: any) => c.name.startsWith('up_'));
    expect(upstreams.map((c: any) => [c.transport_socket.typed_config.sni, c.transport_socket.typed_config.auto_sni_san_validation])).toEqual([['a.example.com', true], ['b.example.com', true]]);
    const hcm = internal[0].filter_chains[0].filters[0].typed_config;
    expect(hcm.http_filters.filter((f: any) => f.name.startsWith('inject_')).map((f: any) => [f.typed_config.overwrite, f.typed_config.credential.typed_config.header])).toEqual([[true, 'X-A'], [true, 'X-B']]);
    expect(hcm.generate_request_id).toBe(false);
    expect(hcm.route_config.request_headers_to_remove).toEqual(['x-forwarded-proto', 'x-request-id']);
    expect(hcm.http_filters.at(-1).typed_config.suppress_envoy_headers).toBe(true);
    const b = internal[1].filter_chains[0].filters[0].typed_config.http_filters;
    expect(b.filter((f: any) => f.name.startsWith('inject_')).map((f: any) => f.typed_config.credential.typed_config.header)).toEqual(['Authorization']);
  });
});
