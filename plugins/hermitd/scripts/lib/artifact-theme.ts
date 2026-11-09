// Single source of visual truth for the script-rendered Artifact pages
// (dashboard, proposals). Everything a re-sync against Claude Code's
// `artifact-design` skill needs to touch lives in this file: the palette, the
// type scale, the layout, and the small markup helpers the renderers compose.
//
// Why a module and not a CSS const inside dashboard.ts: the previous sheet
// hand-wrote its token set four times (bare :root, the dark media query, and
// both [data-theme] blocks), and the two [data-theme] blocks silently drifted
// to 6 of 19 tokens — so a viewer with an explicit theme choice got base
// colours from one block and chip colours from another. Here PALETTE is
// declared once and every block is generated from it, which makes that class
// of drift unrepresentable rather than merely fixed. tests/artifact-theme.test.ts
// pins the invariants that a hand edit could still break.
//
// Helpers take **already-escaped** HTML, matching the convention the renderers
// already use (see dashboard.ts alertMessage/proposalLabel): callers escape
// file-derived values, chrome strings arrive pre-escaped from loadStrings().

/** Token set, declared once per theme. Both objects must carry identical keys —
 *  a missing key is what produced the chip-drift bug this module replaces. */
export const PALETTE = {
  light: {
    bg: '#fbfbfa',
    surface: '#f4f5f4',
    raised: '#ffffff',
    fg: '#171a1c',
    muted: '#5f6b6b',
    border: '#e0e4e3',
    accent: '#116b63',
    good: '#2f6f4a',
    warn: '#8a5a10',
    crit: '#a33a32',
    'chip-warn-bg': '#f7ead3',
    'chip-warn-fg': '#7a4f0c',
    'chip-good-bg': '#dcece2',
    'chip-good-fg': '#2a6042',
    'chip-acc-bg': '#d9ecea',
    'chip-acc-fg': '#0e5f58',
    'chip-mute-bg': '#e9ecec',
    'chip-mute-fg': '#55605f',
    'code-bg': '#eef0ef',
  },
  dark: {
    bg: '#14171a',
    surface: '#1c2024',
    raised: '#20262a',
    fg: '#e6e9e8',
    muted: '#93a0a0',
    border: '#2b3236',
    accent: '#63d9c9',
    good: '#6fca92',
    warn: '#e3ae53',
    crit: '#f08b80',
    'chip-warn-bg': '#3a2a10',
    'chip-warn-fg': '#e3ae53',
    'chip-good-bg': '#17301f',
    'chip-good-fg': '#6fca92',
    'chip-acc-bg': '#10302d',
    'chip-acc-fg': '#63d9c9',
    'chip-mute-bg': '#232a2c',
    'chip-mute-fg': '#93a0a0',
    'code-bg': '#232a2c',
  },
} as const;

export type Tone = 'warn' | 'good' | 'acc' | 'mute' | 'crit';

function vars(theme: Record<string, string>): string {
  return Object.entries(theme).map(([k, v]) => `--${k}:${v};`).join(' ');
}

// Four blocks, because the viewer has three states and an explicit choice must
// win in both directions: bare :root is the light default; the media query is
// guarded with :not([data-theme="light"]) so an explicit light choice beats a
// dark OS; and each [data-theme] block restates the *full* set so a toggle can
// never leave half the tokens resolved from the other theme.
const THEME_BLOCKS = [
  `:root { color-scheme: light dark; ${vars(PALETTE.light)} }`,
  `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${vars(PALETTE.dark)} } }`,
  `:root[data-theme="dark"] { ${vars(PALETTE.dark)} }`,
  `:root[data-theme="light"] { ${vars(PALETTE.light)} }`,
].join('\n');

// Type scale runs title > stat > body > meta > eyebrow-as-label. The previous
// sheet set h2 at 14px under 15px body, so section headings read as smaller
// than the text they introduced; eyebrows are small here on purpose (they are
// labels) and hierarchy comes from the content beneath them.
const RULES = `
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); }
.hermit-page {
  background: var(--bg); color: var(--fg);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-variant-numeric: tabular-nums;
  max-width: 1100px; margin: 0 auto; padding: 32px 24px 64px;
}
.hermit-page header { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; flex-wrap: wrap; }
.hermit-page header h1 { font-size: 26px; font-weight: 600; letter-spacing: -0.015em; margin: 0; text-wrap: balance; }
.hermit-page header .updated { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.summary { display: flex; flex-wrap: wrap; gap: 8px; margin: 20px 0; }
.pill { display: inline-flex; align-items: baseline; gap: 7px; border-radius: 999px; padding: 5px 13px; font-size: 13px; border: 1px solid transparent; }
.pill b { font-family: var(--mono); font-weight: 600; font-size: 13.5px; }
.pill-warn { background: var(--chip-warn-bg); color: var(--chip-warn-fg); }
.pill-good { background: var(--chip-good-bg); color: var(--chip-good-fg); }
.pill-acc { background: var(--chip-acc-bg); color: var(--chip-acc-fg); }
.pill-mute { background: transparent; color: var(--muted); border-color: var(--border); }
/* The card is the scroll container for wide content: proposal bodies and the
   weekly review are model-authored markdown, so a long unbroken token (a file
   path in inline code, a URL) has to scroll here rather than push the page into
   a horizontal scroll. */
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; margin-bottom: 14px; overflow-x: auto; }
.card h2 { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.09em; color: var(--muted); margin: 0 0 14px; }
.stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 18px; margin-bottom: 4px; }
.stat { display: flex; flex-direction: column; }
.stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); margin-bottom: 4px; }
.stat-value { font-family: var(--mono); font-size: 21px; font-weight: 600; letter-spacing: -0.02em; }
.stat-value.tone-acc { color: var(--accent); }
.stat-value.tone-warn { color: var(--warn); }
.stat-value.tone-crit { color: var(--crit); }
.stat-value.tone-good { color: var(--good); }
.muted { color: var(--muted); font-size: 13.5px; }
.chip { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
.chip-proposed { background: var(--chip-warn-bg); color: var(--chip-warn-fg); }
.chip-accepted { background: var(--chip-acc-bg); color: var(--chip-acc-fg); }
.chip-resolved { background: var(--chip-good-bg); color: var(--chip-good-fg); }
.chip-deferred { background: var(--chip-mute-bg); color: var(--chip-mute-fg); }
.chip-dismissed { background: var(--chip-mute-bg); color: var(--chip-mute-fg); }
.chip-unknown { background: var(--chip-mute-bg); color: var(--chip-mute-fg); }
.rail { border-left: 3px solid var(--border); padding: 9px 0 9px 13px; }
.rail + .rail { border-top: 1px solid var(--border); }
.rail-warn { border-left-color: var(--warn); }
.rail-good { border-left-color: var(--good); }
.rail-crit { border-left-color: var(--crit); }
.rail-acc { border-left-color: var(--accent); }
.rail-mute { border-left-color: var(--border); }
.rail-title { font-size: 15px; font-weight: 600; margin: 0; text-wrap: pretty; }
.rail-meta { font-family: var(--mono); font-size: 12.5px; color: var(--muted); margin: 3px 0 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 9px; }
.alerts { list-style: none; margin: 0; padding: 0; }
.proposal { border-left: 3px solid var(--warn); padding: 9px 0 9px 13px; }
.proposal + .proposal { border-top: 1px solid var(--border); }
.proposal summary { cursor: pointer; }
/* The row template is two block-level paragraphs, so the native disclosure
   marker would sit on its own line above the title. Hide it and draw the caret
   inline at the head of the title instead, which keeps the affordance on the
   thing you actually click. */
.proposal summary { list-style: none; }
.proposal summary::-webkit-details-marker { display: none; }
.proposal summary .rail-title::before { content: "\\25B8"; color: var(--muted); margin-right: 8px; font-size: 11px; vertical-align: 1px; }
.proposal[open] summary .rail-title::before { content: "\\25BE"; }
.proposal-body { margin-top: 10px; padding-left: 2px; }
.proposal-history { list-style: none; margin: 0; padding: 0; }
.proposal-history li { padding: 7px 0; border-top: 1px solid var(--border); font-size: 14px; }
.proposal-history li:first-child { border-top: none; }
.doc-tools { display: flex; flex-direction: column; gap: 8px; margin: 0 0 10px; }
.doc-tools[hidden], .doc-list li[hidden], .doc-empty[hidden] { display: none; }
.doc-search { width: 100%; min-height: 44px; padding: 8px 12px; font: inherit; font-size: 16px; color: var(--fg); background: var(--raised); border: 1px solid var(--border); border-radius: 8px; }
.doc-types { display: flex; flex-wrap: wrap; gap: 6px; }
.doc-type { min-height: 36px; padding: 4px 12px; font: inherit; font-size: 13px; color: var(--fg); background: transparent; border: 1px solid var(--border); border-radius: 999px; cursor: pointer; }
.doc-type[aria-pressed="true"] { background: var(--chip-acc-bg); color: var(--chip-acc-fg); border-color: transparent; }
.doc-list li { overflow-wrap: anywhere; }
.doc-summary { margin: 3px 0 0; font-size: 14px; }
.evolution { list-style: none; margin: 0 0 12px; padding: 0; }
.evolution li { padding: 3px 0; }
.weekly-body summary { cursor: pointer; color: var(--accent); font-size: 13px; width: fit-content; }
summary:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 3px; }
code { background: var(--code-bg); border-radius: 4px; padding: 1px 5px; font-family: var(--mono); font-size: 13px; }
pre { background: var(--code-bg); border-radius: 6px; padding: 10px 12px; overflow-x: auto; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; }
a { color: var(--accent); }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
`;

// --mono is a plain constant rather than a themed token — it does not vary by
// theme, but routing it through a custom property keeps every font-family
// declaration below to one name.
export const CSS = `${THEME_BLOCKS}
:root { --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
${RULES}`;

// ---------- markup helpers (inputs must be pre-escaped) ----------

const CHIP_STATUSES = ['proposed', 'accepted', 'resolved', 'dismissed', 'deferred'];

/** Status chip. `status` is escaped by the caller-facing wrapper in dashboard.ts. */
export function chipHtml(status: string, escapedLabel: string): string {
  const cls = CHIP_STATUSES.includes(status) ? status : 'unknown';
  return `<span class="chip chip-${cls}">${escapedLabel}</span>`;
}

/** Section card with an uppercase eyebrow heading. */
export function card(heading: string, body: string): string {
  return `
    <section class="card">
      <h2>${heading}</h2>
      ${body}
    </section>`;
}

/** One stat tile inside a `.stat-row` grid. */
export function statTile(label: string, value: string, tone?: 'acc' | 'warn' | 'crit' | 'good'): string {
  const cls = tone ? ` tone-${tone}` : '';
  return `<div class="stat"><span class="stat-label">${label}</span><span class="stat-value${cls}">${value}</span></div>`;
}

/** Separator between meta parts. Shared with dashboard.ts's proposal rows so the
 *  markup — including the `aria-hidden` that keeps it out of the accessible name —
 *  has one definition rather than a copy per call site. */
export const META_SEP = '<span aria-hidden="true">·</span>';

/** A row whose left rail encodes state as form, not just as text. `meta` parts
 *  are joined with a separator so callers never hand-build the dot list. */
export function railRow(opts: { tone: Tone; title: string; meta?: string[]; extra?: string }): string {
  const meta = opts.meta && opts.meta.length
    ? `<p class="rail-meta">${opts.meta.join(META_SEP)}</p>`
    : '';
  return `<div class="rail rail-${opts.tone}"><p class="rail-title">${opts.title}</p>${meta}${opts.extra ?? ''}</div>`;
}

/** Pill strip: the summary-before-detail layer at the top of a page. There is no
 *  `.pill-crit` on purpose — a rail has room for a distinct critical colour, a
 *  compact pill does not, so `crit` borrows `warn`'s here. */
export function pills(entries: { tone: Tone; value: string; label: string }[]): string {
  if (!entries.length) return '';
  const items = entries
    .map(e => `<span class="pill pill-${e.tone === 'crit' ? 'warn' : e.tone}"><b>${e.value}</b> ${e.label}</span>`)
    .join('');
  return `<div class="summary">${items}</div>`;
}

/** Page shell shared by both renderers. `updated` is the placeholder token the
 *  callers swap post-hash, so the "last updated" stamp stays out of the hash. */
export function pageShell(opts: {
  title: string;
  heading: string;
  updatedLabel: string;
  updatedToken: string;
  body: string;
}): string {
  return `<title>${opts.title}</title>
<style>${CSS}</style>
<div class="hermit-page">
  <header>
    <h1>${opts.heading}</h1>
    <span class="updated">${opts.updatedLabel} ${opts.updatedToken}</span>
  </header>
  ${opts.body}
</div>
`;
}
