// artifact.ts — single CLI for the Artifact-page renderers and the
// artifact-strings scaffold. One script per page was three copies of the same
// twelve lines: resolve an out path, render, mkdir -p, write, print the
// {path,bytes,hash} receipt, exit 1 on anything thrown.
//
// Usage:
//   bun artifact.ts render <dashboard|proposals|weekly> <hermit-state-dir> [outPath]
//     Renders the page to disk. Prints {"path":…,"bytes":…,"hash":…} on success,
//     or {"error":"render_failed:<page>"} (unknown_page, custom_renderer_owns_out_path)
//     at exit 1. The refresh protocols in docs/artifacts.md treat any failure as
//     "skip silently".
//
//   bun artifact.ts scaffold-strings <language> [generatedISO]
//     Prints the artifact-strings.json scaffold with every chrome key at its
//     English default, for a language-set skill (hatch / hermit-settings) to
//     translate the *values* in place and write to state/artifact-strings.json.
//     Keeps DEFAULT_STRINGS the single source of keys — the model never
//     hand-transcribes the key set.
//
//   bun artifact.ts state dashboard <hermit-state-dir>
//     Prints the dashboard's render inputs as JSON, for a hermit-local renderer
//     (see docs/artifacts.md § Custom renderer) to compose its own page from:
//     {state, theme_css, core_sections, updated_token}. Read-only; writes nothing.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadDashboardState, renderDashboard, renderCoreSections, UPDATED_TOKEN } from './lib/dashboard';
import { loadProposalsPageState, renderProposalsPage } from './lib/proposals-page';
import { renderWeeklyArtifact } from './lib/weekly-artifact';
import { DEFAULT_STRINGS } from './lib/artifact-strings';
import { CSS } from './lib/artifact-theme';
import { exitError, printJson } from './lib/cli';

interface Rendered { content: string; hash: string }

/** A hermit that has run `/hermit-dashboard-design` owns its dashboard render: this
 *  script hands off to that script and passes its receipt through untouched. Presence
 *  of the file is the switch — no config gate. */
const CUSTOM_RENDERER = 'dashboard-render.ts';

/** Set on the child's env so a renderer that calls back into `render dashboard` (instead
 *  of the `state dashboard` verb it is meant to use) gets the built-in render once rather
 *  than re-entering the hand-off forever — a routine-path fork bomb otherwise. */
const RENDER_GUARD = 'HERMIT_DASHBOARD_RENDER';

// Each page contributes only what actually differs between them: where it lands
// by default, and how its bytes are produced.
const PAGES: Record<string, { defaultOut: (dir: string) => string; render: (dir: string) => Rendered }> = {
  dashboard: {
    defaultOut: dir => path.join(dir, 'state', 'dashboard.html'),
    render: dir => {
      const { html, hash } = renderDashboard(loadDashboardState(dir));
      return { content: html, hash };
    },
  },
  proposals: {
    defaultOut: dir => path.join(dir, 'state', 'proposals-page.html'),
    render: dir => {
      const { html, hash } = renderProposalsPage(loadProposalsPageState(dir));
      return { content: html, hash };
    },
  },
  weekly: {
    defaultOut: dir => path.join(dir, 'state', 'weekly-review-artifact.md'),
    render: renderWeeklyArtifact,
  },
};

/** Runs the hermit's own dashboard renderer and relays its receipt verbatim. The
 *  child owns the whole render — layout, data, hash — so nothing here inspects or
 *  rewrites its *page*; a non-zero exit becomes this script's render_failed, which the
 *  refresh protocol already treats as "skip silently". The `{path,bytes,hash}` receipt
 *  is core's protocol rather than the child's, though, and step 1 of that protocol
 *  JSON.parses this stdout — so a renderer that exits 0 without one is failed here,
 *  landing on the same silent skip instead of throwing inside the calling skill. The
 *  child's stderr passes through as its own diagnostics. */
function renderCustomDashboard(rendererPath: string, hermitDir: string): never {
  const r = spawnSync(process.execPath, [rendererPath, hermitDir], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, [RENDER_GUARD]: '1' },
  });
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error) exitError(`render_failed:dashboard:${(r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? 'timeout' : 'spawn'}`);
  if (r.status !== 0) exitError('render_failed:dashboard');
  if (!parsesAsReceipt(r.stdout)) exitError('render_failed:dashboard:no_receipt');
  process.stdout.write(r.stdout);
  process.exit(0);
}

function parsesAsReceipt(stdout: string): boolean {
  try {
    const receipt = JSON.parse(stdout);
    return !!receipt && typeof receipt.path === 'string' && typeof receipt.hash === 'string';
  } catch {
    return false;
  }
}

function verbRender(page: string | undefined, hermitDir: string | undefined, outArg: string | undefined): void {
  if (!page || !hermitDir) exitError();
  const spec = PAGES[page];
  if (!spec) exitError(`unknown_page:${page}`);
  if (page === 'dashboard' && !process.env[RENDER_GUARD]) {
    const custom = path.join(hermitDir, CUSTOM_RENDERER);
    if (fs.existsSync(custom)) {
      // The renderer's contract fixes its own out path (<hermitDir>/state/dashboard.html),
      // so honoring an explicit one is impossible — fail loudly instead of writing over
      // the live page while the caller believes it asked for a copy elsewhere.
      if (outArg) exitError('custom_renderer_owns_out_path');
      renderCustomDashboard(custom, hermitDir);
    }
  }
  const outPath = outArg || spec.defaultOut(hermitDir);
  try {
    const { content, hash } = spec.render(hermitDir);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, content, 'utf8');
    process.stdout.write(JSON.stringify({ path: outPath, bytes: Buffer.byteLength(content), hash }) + '\n');
  } catch {
    exitError(`render_failed:${page}`);
  }
}

/** Render inputs for a hermit-local dashboard renderer. `core_sections` lets a custom
 *  page keep any default card verbatim, and `theme_css` comes from the live stylesheet
 *  so core-side theme fixes reach custom pages without them being rebuilt. */
function verbState(page: string | undefined, hermitDir: string | undefined): void {
  if (page !== 'dashboard' || !hermitDir) exitError();
  try {
    const state = loadDashboardState(hermitDir);
    printJson({
      state,
      theme_css: CSS,
      core_sections: renderCoreSections(state),
      updated_token: UPDATED_TOKEN,
    });
  } catch {
    exitError('state_failed:dashboard');
  }
}

function verbScaffoldStrings(language: string | undefined, generated: string | undefined): void {
  process.stdout.write(
    JSON.stringify({ language: language || 'en', generated: generated || '', strings: DEFAULT_STRINGS }, null, 2) + '\n',
  );
}

const verb = process.argv[2];
const rest = process.argv.slice(3);
switch (verb) {
  case 'render': verbRender(rest[0], rest[1], rest[2]); break;
  case 'state': verbState(rest[0], rest[1]); break;
  case 'scaffold-strings': verbScaffoldStrings(rest[0], rest[1]); break;
  default: exitError();
}
