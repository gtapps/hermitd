---
name: hermit-dashboard-design
description: Designs this hermit's dashboard around what it tracks, writing a renderer that rebuilds it every refresh at no model cost. Use for "design/customize/change my dashboard", "put X on my dashboard", "remove my custom dashboard".
---
# Dashboard Design

Every hermit ships with the same dashboard: status, brief, proposals, weekly, compiled index. It's a reasonable default and it's wrong for almost every hermit that has been running a while. A hermit tracking training load should lead with training load. One watching a house should lead with what's broken. One reading feeds should lead with what's worth reading.

This skill replaces that default with a page designed around **this** hermit, and does it in a way that stays free to keep current: you design once, and what you leave behind is a small program that rebuilds the page from the hermit's own files every time the page refreshes.

## Commands
- `artifact-render`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/artifact.ts render <type> .hermit`

## The one rule that shapes everything

**You design the page. A script renders it — every time, forever, without you.**

The dashboard republishes on every morning brief, every evening brief, every weekly review, and every proposal event. If a model composed the page on each of those, an always-on hermit would pay a generation several times a day for a page nobody may open. So the artifact of this session is not a page — it's `dashboard-render.ts`, a deterministic script in the hermit's state dir. After today, refreshes cost a script run.

This means: anything that changes between refreshes must be **computed by the renderer from files on disk**, never written as a literal by you. Text that never changes (headings, an operator's chosen framing, section labels) is fine as a literal.

## 1. Learn what this hermit actually is

Don't ask the operator what they want yet — most of the answer is already on disk. Read enough to know what this hermit accumulates and what its work is about:

- `.hermit/knowledge-schema.md` — the per-hermit contract for what it produces and when. The single most useful file here.
- `.hermit/compiled/` — durable outputs (listing + frontmatter of the interesting ones). These are display-ready markdown and make excellent dashboard sections.
- `.hermit/state/` and fixed-name files in `.hermit/raw/` — machine state: baselines, snapshots, digests. Rich, but usually JSON that needs shaping.
- `.hermit/OPERATOR.md` — what the operator cares about, in their words.
- `.hermit/config.json` — identity, language, what routines run (so you know what will be fresh and what won't).
- Installed sibling hermit plugins (scan `${CLAUDE_PLUGIN_ROOT}/../*/.claude-plugin/`) — a domain hermit's own docs say what its data means.

Then form a view: **what is the one question this operator opens this page to answer?** That question is the page's lead. Everything else supports it or goes.

A hermit with little history yet is a real answer too: say so, and suggest the default page until there's something worth showing.

## 2. Design it

Load the `artifact-design` skill and design properly — it owns the visual craft, and a dashboard is exactly the kind of page it's for.

What's yours to decide here:

- **Lead with the domain, not the machinery.** Core's status/cost/proposals cards are supporting cast on a domain hermit's page, and belong lower or not at all. You can drop every one of them.
- **Summary before detail.** Tiles and counts at the top, expandable detail below.
- **State as form**, not just text: a rail, chip or color for good/warn/critical, so the page reads at a glance.
- **Computed beats raw.** "Training load 12% above baseline" is a dashboard; a pretty-printed JSON dump is not. If the data needs shaping, shape it in the renderer.
- Charts are welcome — inline SVG drawn from the data, no libraries (the page's CSP blocks external scripts).
- Interactivity (collapsibles, tabs, client-side filtering over embedded data) is allowed; inline `<script>` runs.

Write in the operator's `language` from `config.json` when it's set.

## 3. Write `dashboard-render.ts`

Write it to `.hermit/dashboard-render.ts`. Its presence is the switch — core detects it and hands the whole dashboard render over to it. There is no config flag to set.

**Contract the script must honor** (core relies on exactly these):

- Takes the hermit state dir as `argv[2]`.
- Writes the page to `<hermitDir>/state/dashboard.html`.
- Prints one line of JSON to stdout: `{"path":…,"bytes":…,"hash":…}` — **and nothing else**. Core fails an exit-0 run whose stdout doesn't parse as that receipt, so a stray debug `console.log` costs the refresh.
- Exits 0 on success, non-zero on failure (core turns that into a silent skip, so a broken renderer never publishes a broken page). Core also kills it at 60s.
- **Outputs a fragment, not a document** — no `<!DOCTYPE>`, `<html>`, `<head>` or `<body>`; the Artifact tool supplies the shell. A `<style>` block and inline `<script>` are fine.
- **No imports from the plugin.** The plugin lives at a version-stamped cache path that changes on every update — an import would break the next time the operator updates. Node/Bun built-ins only.

**The hash decides whether a publish happens**, so compute it right: hash the page with the timestamp still a placeholder, then swap the real timestamp in afterwards. Otherwise the page mints a new artifact version on every single refresh, twice a day, forever.

**Core hands you its own data** if you want it. Call this from inside `dashboard-render.ts`, not from this session: the payload carries the whole stylesheet and all five rendered cards, sized for a script to parse rather than for your context.

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/artifact.ts state dashboard .hermit
```

returns `{state, theme_css, core_sections, updated_token}` — the same state the default page renders from, the live stylesheet (so core's theme and dark-mode fixes keep reaching your page), the default cards as ready HTML you can embed verbatim, and the placeholder to use for the hash trick. Use what helps; ignore the rest.

**Escape everything that came from a file.** Compiled docs and raw snapshots can contain text a hermit fetched from the web, which means an attacker's text can reach your page. Escape it into element content; never interpolate it into an attribute, a `<script>`, or a `<style>`, and only allow `https:`/`#`/`mailto:` links. This is not optional — the page is published to the operator's account and can be shared.

Skeleton to adapt (not to copy verbatim — the interesting part is what you put in `sections`):

```ts
import fs from 'node:fs';
import path from 'node:path';

const hermitDir = process.argv[2];
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const readJson = (rel: string) => { try { return JSON.parse(fs.readFileSync(path.join(hermitDir, rel), 'utf8')); } catch { return null; } };

const STAMP = '__DASHBOARD_UPDATED__';           // excluded from the hash, swapped below
const sections = [ /* your cards, computed from the hermit's files */ ].join('\n');
const page = `<style>/* … */</style>
<main class="page"><h1>…</h1>${sections}
<footer><span class="updated">updated ${STAMP}</span></footer></main>`;

const hash = new Bun.CryptoHasher('sha256').update(page).digest('hex');
const html = page.replaceAll(STAMP, esc(new Date().toISOString()));
const out = path.join(hermitDir, 'state', 'dashboard.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
process.stdout.write(JSON.stringify({ path: out, bytes: Buffer.byteLength(html), hash }) + '\n');
```

Before installing it: back up any existing `dashboard-render.ts` (the operator may have hand-edited it), run the new one, and confirm it exits 0 and writes the file.

## 4. Publish and hand it over

Publish the rendered page following `${CLAUDE_PLUGIN_ROOT}/docs/artifacts.md` § Shared refresh procedure — same `dashboard` state key, same URL as the default page had, so nothing else changes and the operator's existing link keeps working.

Then give the operator the URL and invite reactions in plain language. Don't present a checklist; show them the page and let them tell you what's wrong with it. "Move X up", "drop the cost card", "add last week's total" are all just edits to the renderer.

If the hermit runs `permission_mode: auto`, note that unattended refreshes may hit the permission classifier on the renderer call; since the operator asked for this in their own message, you may add a `permissions.allow` entry for it in this session.

## Living with it

- **"Change my dashboard"** → same skill: read the current renderer, edit it, re-run, republish. Don't start over unless they want a redesign.
- **"Refresh it now"** → run the renderer and republish per `${CLAUDE_PLUGIN_ROOT}/docs/artifacts.md`; no redesign needed.
- **"Remove my custom dashboard"** → delete `dashboard-render.ts`; the default page comes back on the next refresh, same URL.
- **The page shows what's on disk.** It's refreshed by the hermit's rhythm (briefs, weekly review, proposal events), not live. If a section needs to be fresher than that, the fix is a routine that updates the underlying file — or one that runs the render and publish step — not a change to this page.
- **Data first, page second.** If the operator wants something the hermit doesn't currently record, the dashboard is the wrong place to solve it: the hermit needs to start writing that file (a routine, a heartbeat item, a brief step). Say so rather than faking it with a literal.
