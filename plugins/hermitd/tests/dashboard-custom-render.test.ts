// bun test for the custom-dashboard seam in scripts/artifact.ts — the `state dashboard`
// verb a hermit-local renderer reads, and the delegation that lets it own the page.
// Usage: bun test tests/dashboard-custom-render.test.ts   (from the plugin root)

import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScript } from './helpers/run';
import { CSS } from '../scripts/lib/artifact-theme';

function makeHermitDir(): { hermitDir: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermit-custom-dash-'));
  const hermitDir = path.join(root, '.hermit');
  for (const d of ['state', 'sessions', 'proposals', 'compiled']) {
    fs.mkdirSync(path.join(hermitDir, d), { recursive: true });
  }
  return { hermitDir, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} } };
}

function withHermitDir(fn: (hermitDir: string) => Promise<void>) {
  return async () => {
    const h = makeHermitDir();
    try { await fn(h.hermitDir); } finally { h.cleanup(); }
  };
}

/** Stands in for a renderer `/hermit-dashboard-design` would generate: writes the page
 *  itself and prints the same {path,bytes,hash} receipt the built-in renderer prints. */
function writeRenderer(hermitDir: string, body: string): void {
  fs.writeFileSync(path.join(hermitDir, 'dashboard-render.ts'), body);
}

const RECEIPT_RENDERER = `
import fs from 'node:fs';
import path from 'node:path';
const hermitDir = process.argv[2];
const out = path.join(hermitDir, 'state', 'dashboard.html');
const html = '<h1>custom</h1>';
fs.writeFileSync(out, html);
process.stdout.write(JSON.stringify({ path: out, bytes: html.length, hash: 'deadbeef' }) + '\\n');
`;

describe('artifact.ts state dashboard', () => {
  test('prints the render inputs a hermit-local renderer needs', withHermitDir(async (hermitDir) => {
    const r = await runScript('artifact.ts', { args: ['state', 'dashboard', hermitDir] });
    expect(r.exitCode).toBe(0);

    const payload = JSON.parse(r.stdout);
    expect(Object.keys(payload).sort()).toEqual(['core_sections', 'state', 'theme_css', 'updated_token']);
    // Theme comes from the live stylesheet, so core-side theme fixes reach custom pages.
    expect(payload.theme_css).toBe(CSS);
    expect(Object.keys(payload.core_sections).sort())
      .toEqual(['brief', 'by_person', 'compiled_index', 'proposals', 'status', 'weekly']);
    expect(payload.state.agent_name).toBe('Hermit');
    expect(typeof payload.updated_token).toBe('string');
    expect(payload.updated_token.length).toBeGreaterThan(0);
    // The whole payload is the renderer contract, so every nested key is snake_case too.
    const keys = (v: any): string[] => v && typeof v === 'object'
      ? Object.entries(v).flatMap(([k, c]) => (Array.isArray(v) ? [] : [k]).concat(keys(c))) : [];
    expect(keys(payload).filter(k => !/^[a-z0-9_]+$/.test(k))).toEqual([]);
  }));

  test('a bare state dir degrades instead of throwing', withHermitDir(async (hermitDir) => {
    fs.rmSync(path.join(hermitDir, 'state'), { recursive: true, force: true });
    const r = await runScript('artifact.ts', { args: ['state', 'dashboard', hermitDir] });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).state.today_cost_usd).toBe(0);
  }));

  test('rejects a page other than dashboard', withHermitDir(async (hermitDir) => {
    const r = await runScript('artifact.ts', { args: ['state', 'proposals', hermitDir] });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: 'usage' });
  }));
});

describe('artifact.ts render dashboard — custom renderer', () => {
  test('hands off to the hermit renderer and relays its receipt', withHermitDir(async (hermitDir) => {
    writeRenderer(hermitDir, RECEIPT_RENDERER);
    const r = await runScript('artifact.ts', { args: ['render', 'dashboard', hermitDir] });

    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).hash).toBe('deadbeef');
    expect(fs.readFileSync(path.join(hermitDir, 'state', 'dashboard.html'), 'utf8')).toBe('<h1>custom</h1>');
  }));

  test('the renderer can compose from the state verb', withHermitDir(async (hermitDir) => {
    writeRenderer(hermitDir, `
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const hermitDir = process.argv[2];
const artifactTs = ${JSON.stringify(path.resolve(import.meta.dir, '..', 'scripts', 'artifact.ts'))};
const res = spawnSync(process.execPath, [artifactTs, 'state', 'dashboard', hermitDir], { encoding: 'utf8' });
const { core_sections, theme_css } = JSON.parse(res.stdout);
const html = '<style>' + theme_css + '</style>' + core_sections.status;
const out = path.join(hermitDir, 'state', 'dashboard.html');
fs.writeFileSync(out, html);
process.stdout.write(JSON.stringify({ path: out, bytes: html.length, hash: 'x' }) + '\\n');
`);
    const r = await runScript('artifact.ts', { args: ['render', 'dashboard', hermitDir] });

    expect(r.exitCode).toBe(0);
    const html = fs.readFileSync(path.join(hermitDir, 'state', 'dashboard.html'), 'utf8');
    expect(html).toContain('<style>');
    expect(html).toContain('stat-row'); // the status card came through verbatim
  }));

  test('a failing renderer exits 1 so the publish protocol skips silently', withHermitDir(async (hermitDir) => {
    writeRenderer(hermitDir, 'process.exit(3);');
    const r = await runScript('artifact.ts', { args: ['render', 'dashboard', hermitDir] });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: 'render_failed:dashboard' });
  }));

  // The receipt is core's protocol, not the child's: step 1 of the refresh procedure
  // JSON.parses this stdout, so an exit-0 renderer that printed something else has to
  // land on the same silent skip rather than throwing inside the calling skill.
  test('an exit-0 renderer without a receipt still exits 1', withHermitDir(async (hermitDir) => {
    writeRenderer(hermitDir, 'console.log("rendered ok");');
    const r = await runScript('artifact.ts', { args: ['render', 'dashboard', hermitDir] });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: 'render_failed:dashboard:no_receipt' });
  }));

  test('an explicit outPath is rejected, not silently ignored', withHermitDir(async (hermitDir) => {
    writeRenderer(hermitDir, RECEIPT_RENDERER);
    const out = path.join(hermitDir, 'state', 'elsewhere.html');
    const r = await runScript('artifact.ts', { args: ['render', 'dashboard', hermitDir, out] });
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ error: 'custom_renderer_owns_out_path' });
    expect(fs.existsSync(out)).toBe(false);
    // and the live page was not overwritten behind the caller's back
    expect(fs.existsSync(path.join(hermitDir, 'state', 'dashboard.html'))).toBe(false);
  }));

  // A generated renderer that calls back into `render dashboard` would otherwise
  // re-enter the hand-off forever; the guard env var bottoms it out at the built-in.
  test('a renderer that re-enters render dashboard does not recurse', withHermitDir(async (hermitDir) => {
    writeRenderer(hermitDir, `
import { spawnSync } from 'node:child_process';
const artifactTs = ${JSON.stringify(path.resolve(import.meta.dir, '..', 'scripts', 'artifact.ts'))};
const res = spawnSync(process.execPath, [artifactTs, 'render', 'dashboard', process.argv[2]], { encoding: 'utf8' });
process.stdout.write(res.stdout);
process.exit(res.status ?? 1);
`);
    const r = await runScript('artifact.ts', { args: ['render', 'dashboard', hermitDir] });
    expect(r.exitCode).toBe(0);
    expect(typeof JSON.parse(r.stdout).hash).toBe('string');
  }));

  test('without a renderer the built-in dashboard is unchanged', withHermitDir(async (hermitDir) => {
    const before = await runScript('artifact.ts', { args: ['render', 'dashboard', hermitDir] });
    const builtIn = fs.readFileSync(path.join(hermitDir, 'state', 'dashboard.html'), 'utf8');
    expect(before.exitCode).toBe(0);
    expect(builtIn).toContain('Hermit');

    // Adding then removing a renderer must leave the default path byte-identical.
    writeRenderer(hermitDir, RECEIPT_RENDERER);
    await runScript('artifact.ts', { args: ['render', 'dashboard', hermitDir] });
    fs.rmSync(path.join(hermitDir, 'dashboard-render.ts'));

    const after = await runScript('artifact.ts', { args: ['render', 'dashboard', hermitDir] });
    expect(after.exitCode).toBe(0);
    expect(JSON.parse(after.stdout).hash).toBe(JSON.parse(before.stdout).hash);
    // Only the "last updated" stamp may differ between two renders of identical state —
    // it is swapped in after hashing, which is why the hashes above match.
    const stampless = (html: string) => html.replace(/(<span class="updated">)[^<]*/, '$1STAMP');
    expect(stampless(fs.readFileSync(path.join(hermitDir, 'state', 'dashboard.html'), 'utf8')))
      .toBe(stampless(builtIn));
  }));

  test('the other pages ignore the dashboard renderer', withHermitDir(async (hermitDir) => {
    writeRenderer(hermitDir, RECEIPT_RENDERER);
    const r = await runScript('artifact.ts', { args: ['render', 'proposals', hermitDir] });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).hash).not.toBe('deadbeef');
  }));
});
