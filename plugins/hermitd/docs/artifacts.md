# Artifacts

Home for the hermit's use of Claude Code's [Artifacts](https://code.claude.com/docs/en/artifacts)
feature — private `claude.ai/code/artifact/<uuid>` pages published from the main
session. That is the default and everything below describes it; `config.artifacts.backend`
can instead point publishing at a connected MCP artifact server the operator runs, in which
case this file's claude.ai-specific mechanics (tool-call shape, `force`, entitlement,
TUI-only reachability) are replaced by that server's own protocol — see § Non-claude
backend deviations. Gated per artifact type under `config.artifacts.*` (default **on** — the
plugin's research-preview feature-defaults rule, except the weekly-review page, which is off; toggle a single page via
`/hermit-settings artifact-dashboard|artifact-proposals|artifact-weekly-review`, or
disable Artifacts entirely via Claude Code's own `disableArtifact`,
`CLAUDE_CODE_DISABLE_ARTIFACT`, or `permissions.deny`). Only reachable from the
interactive TUI session (`hermitd-start`'s surface); absent under `claude -p`.
Runs in **main only, never a subagent** — publishing is a main-session-owned
notification action, same as `CLAUDE-APPEND.md` § Operator Notification, and subagent
`Artifact` tool availability is unverified.

Unattended (non-interactive/channel) sessions cannot answer the first-publish
permission ask — a headless "ask" is an effective deny — and on a `permission_mode:
auto` hermit, a session can't even self-grant that permission, since the auto-mode
classifier blocks a self-widened `permissions.allow` unless the operator's own live
message asked for it (`docs/security.md` § Auto-mode Classifier). The
`config.artifacts.publish_authorized` flag (`/hermit-settings artifact-authorization`,
tri-state: `null`/`true`/`false`) records the decision — attended, `hatch`/
`hermit-evolve` set it directly; unattended, `hermit-evolve` defers to the channel
and the reply sets only the flag, nothing else. Two paths follow from it: **authorize**
(`true`) — `permissions.allow: ["Artifact"]` plus a matching `autoMode.allow` exception
are applied by `hermitd-start`'s boot-time grant (a plain OS process, outside any
session and outside the classifier), re-ensured every boot so a hand-wiped entry
heals itself; or **decline** (`false` / `setup-time banking`) — the attended hatch/
evolve session publishes the first version of each enabled stable page inline,
recording its URL in `state/artifacts.json` so every later refresh is a prompt-free
same-URL republish, and the same boot-time executor removes `Artifact` from the
`permissions.allow` of every settings file this install wrote it to at the next boot
(a `null` flag leaves an existing entry alone). With the flag `null`/`false` and no banked URL, unattended
publishes silently no-op (step 5 below) — a deliberate choice, not a bug.

## Shared refresh procedure

**Resolve the backend first.** `config.artifacts.backend` is `"claude"` by default — the
native `Artifact` tool, and the five steps below apply unchanged. Any other value names a
**connected MCP artifact server** the operator registered and permissioned themselves —
take the § Non-claude backend deviations after step 2, which defers entirely to that
server's own MCP `instructions`.

Every script-rendered artifact type (dashboard, proposals page, weekly review) follows
the same five steps; only the render script, `<title>`, and `state/artifacts.json` key
differ per type (called out in each subsection below):

1. Run `artifact-render` (Commands) with the artifact type (e.g. `dashboard`) as `<type>`
   and parse stdout JSON (`path`, `bytes`, `hash`).
2. Read `.hermit/state/artifacts.json` (if present). **Compare `<key>.backend`
   against the active backend before anything else** — an entry with **no** `backend` field
   is a pre-existing native record and counts as `"claude"`. A mismatch means the recorded
   URL was minted on a different host, so the entry is **treated as unpublished**: ignore
   both its `hash` and its `url`, take step 3 as a **first publish** (no `url`, no `force`),
   and overwrite the entry in step 4. This ordering matters — a backend switch typically
   leaves the content hash unchanged, so checking the hash first would silently stop at the
   gate below and leave the recorded URL pointing at the old host. Only on a backend match,
   compare `hash` to `<key>.hash`: **unchanged → stop here**, no publish (avoids minting a
   no-op artifact version).
3. Changed, no prior record, or a backend mismatch from step 2 → publish. When a
   **backend-matching** entry has a `url`, first call `Artifact` with `action: "read"` and
   that `url`. Claude Code 2.1.x refuses a publish to an artifact this session has neither
   read nor published (it fires after any restart, since the session only read the URL from
   state), and `force: true` does **not** bypass that guard: it only overrides a version
   conflict, and the refused publish is re-refused as identical content on retry. The read
   result is discarded (the rendered file is authoritative; a large page lands in a local
   file, not in context). Then call `Artifact` with `file_path` set to the rendered path, a
   stable `<title>` for that type, a stable favicon (pick once, keep it across republishes),
   and `url` set to `<key>.url` (redeploys to the same address instead of minting a new one).
   Never pass `force`. A first publish omits `url` and skips the read, and per step 2, a
   backend mismatch **is** a first publish, however stale-but-present the recorded `url` looks.
4. On success, write `.hermit/state/artifacts.json`:
   `{"<key>": {"url": "<returned url>", "hash": "<hash from step 1>", "updated": "<now, ISO>", "backend": "<active backend>"}}`
   (merge — never drop sibling keys belonging to other artifact types).
5. On any failure (tool absent, no entitlement, publish error) — skip silently, append
   one `task.ts note <id>` inside an open record's turn (not one per attempt), otherwise skip the note, and continue.
   Never block or degrade the calling skill's normal channel/markdown output.

### Non-claude backend deviations

When `config.artifacts.backend` is anything other than `"claude"`, steps 1 and 2 are
unchanged (render, then the hash and backend gate). Steps 3 and 5 change:

- **Step 3 — publish via the named MCP server's own artifact tools.** Follow that server's
  `instructions` for tool selection, argument names, content shape, create-vs-update, and
  version-conflict handling; this doc deliberately specifies none of it, so a compatible
  backend needs no core change. The only requirement core places on a backend is that its
  create/update tools accept a title plus the page content and return a stable `url`.
  A recurring page is **updated in place** so its URL stays stable across refreshes — never
  re-created, with one exception: after a backend switch, step 2 treats the page as
  unpublished, so the first publish on the new host is a create, not an update against a
  URL another host minted. `file_path`, `force`, and favicon are `Artifact`-tool concepts
  and do not apply here.
- **Step 5 — same skip-and-log as the default path above, plus no fallback.** Server not
  connected, its tools unavailable, or any call fails → skip and log as above.
  **Never fall back to the native `Artifact` tool.** An operator who configured a
  self-hosted backend must not have hermit content quietly published to Anthropic's host
  instead.

Registering the server, minting its token, and granting its tool permissions are the
operator's own manual setup; core neither performs nor verifies them. A native
`Artifact` publish on this backend is denied by the plugin's `PreToolUse` hook
(`scripts/artifact-backend-guard.ts`), which names the backend in its reason so the
model publishes with the server's own MCP tools instead. The tool and its design
skills stay available. `hermitd-start`'s boot-time grant still covers only the native
`Artifact` tool and is skipped on a non-`claude` backend, so that tool is never newly
pre-approved; a hermit that ran on the default backend before the switch keeps the
`Artifact` entry its earlier boots wrote. Drop it by hand from
`.claude/settings.local.json` (`permissions.allow`) if you want that pre-approval gone.

## Dashboard

`config.artifacts.dashboard`, state key `dashboard`. A single persistent page — status,
latest brief, proposal queue, weekly evolution, and a compiled-docs index — rendered by
`scripts/lib/dashboard.ts` (deterministic; no model authorship, except the embedded
"latest brief" text, which is itself model-composed by the `brief` skill and written to
`state/last-brief.json` — see the file's header comment). `<title>` and the `<h1>` are
both `<agent_name> — Dashboard` (`agent_name` falls back to `Hermit`), so a fleet
operator can tell two hermits' tabs apart. The weekly and alert sections are omitted
rather than rendered empty; pending-proposal alerts are left to the proposals card,
which owns that surface, and still count in the "Needs you" tile.

Refresh triggers: `brief` (`--morning`/`--evening`), `weekly-review`, `proposal-create`,
`proposal-act`. `brief` and `weekly-review` append a `📎 <url>` line to their channel
message when a URL is returned; `proposal-create`/`proposal-act` refresh silently — no
URL re-post.

See `docs/config-reference.md#artifacts` for the config flag and privacy/entitlement
notes.

### Custom renderer

A hermit that has run `/hermit-dashboard-design` owns its dashboard render outright.
The skill writes `.hermit/dashboard-render.ts`; **the file's presence is the
switch** (no config flag), and `artifact.ts render dashboard` then hands the whole render
to it — `spawnSync`, 60s timeout, the child's stdout receipt relayed verbatim, a non-zero
child exit surfaced as `{"error":"render_failed:dashboard"}` at exit 1 so step 5's skip-silently rule applies unchanged. An exit-0
run whose stdout doesn't parse as a `{path,hash}` receipt is failed the same way, since
step 1 parses that stdout — the *page* is unvalidated, the *receipt* is core's protocol.
An explicit `outPath` is rejected rather than ignored (the renderer's contract fixes its
own out path), and the child runs with `HERMIT_DASHBOARD_RENDER=1` so a renderer that
mistakenly calls `render dashboard` gets the built-in render instead of recursing. Delete
the file and the built-in render returns, byte-identically, at the same URL. Everything
downstream (state key, hash gate, five-step procedure, refresh triggers) is untouched, so
no calling skill knows the difference.

Core deliberately validates nothing about the generated page: no structural check, no
theme injection, no escaping pass over the child's output. The renderer is operator
property — hand-editable, and left alone by `hermit-evolve`. The discipline that keeps a
generated renderer correct (fragment-only output, hash-then-swap so the updated stamp
stays out of the hash, escaping everything file-derived, no imports from the plugin's
version-stamped cache path) lives in the skill that writes it, not in a core gate.

`bun scripts/artifact.ts state dashboard <hermit-dir>` is the read-only companion verb a
renderer composes from: `{state, theme_css, core_sections, updated_token}` — the same
`DashboardState` the built-in page renders from, the live `artifact-theme.ts` stylesheet
(so core theme fixes reach custom pages without regenerating them), the default cards
as ready-to-embed HTML keyed `status`, `by_person`, `brief`, `proposals`, `weekly` and
`compiled_index`, and the hash placeholder. Every key in the payload, nested state
included, is snake_case (`state.today_cost_usd`, `state.proposals.oldest_open_accepted`,
`state.weekly.body_html`). A custom page may use all of it, some of it, or none.

## Proposals page

`config.artifacts.proposals`, state key `proposals`. Every open (`proposed`/`accepted`)
proposal renders as a collapsed-by-default `<details class="proposal" id="prop-nnn">`
(lowercased `PROP-NNN` prefix as the `id`) — a one-line summary (status
chip, id, title, created-date) that expands to the full body on click, the same pattern
the dashboard already uses for its proposals card. A heading above the list shows the open
count (e.g. "3 Open"); deferred/resolved/dismissed proposals stay one-line history entries
— the same "other" bucket the dashboard already computes. Rendered by
`scripts/lib/proposals-page.ts` (reuses the dashboard's proposal loader, markdown
converter, and CSS — no CSS changes were needed since `.proposal`/`.proposal-body` already
existed for the dashboard's own `<details>`). `<title>` is `<agent_name> — Proposals`,
matching the dashboard's tab convention. Deliberately
omits proposal age-in-days (unlike the dashboard) — age is `Date.now()`-derived and would
otherwise mint a new artifact version once a day even with zero activity; created-date
is shown instead, keeping the hash purely activity-driven (the open count is likewise
activity-driven, not date-driven, so it doesn't reintroduce that churn).

The `id` is inert as a deep link, though: the claude.ai artifact viewer renders the page
inside a sandboxed cross-origin iframe whose `src` carries no fragment — confirmed by
navigating a published proposals page with `#prop-nnn` appended, where the top-level
document held zero `prop-*` anchors and the iframe never received the fragment. The `id`
stays in the markup anyway, since it's free and still resolves for a locally opened or
remixed copy of the page.

Refresh triggers: `proposal-create` (step 6), `proposal-act` (every accept/defer/
dismiss/resolve flow, after its Respond step). `proposal-act` skips its refresh
under `--no-artifacts`, as `proposal-create` does. Both refresh silently by default,
matching the dashboard's existing no-URL-re-post convention — with one exception:
when the refresh returns a URL, the flow that just created one or more proposals
appends a single bare `📎 <url>` line to its own announcement, whether it created
one proposal or several. No fragment, and no proposal id or title in the link text
(`PROP-NNN` in an operator-facing message violates CLAUDE-APPEND.md § Channel voice).
When no URL is returned — the page is disabled, publish is unauthorized, or the
publish failed — the line is omitted entirely and the rest of the message is unaffected.

## Localization

The dashboard and proposals renderers read their fixed UI chrome (page titles, section
headers, stat labels, empty states, age labels, the synthesized budget-alert line) from
`scripts/lib/artifact-strings.ts` (`DEFAULT_STRINGS`, English). When
`.hermit/state/artifact-strings.json` is present, `loadStrings()` overlays it
**per key** over those defaults — a missing key or an absent file falls back to English,
so a hermit with no translation renders byte-identically to an untranslated one. That file
is an ordinary render input: it's model-composed once at language-set time (`hatch` /
`hermit-settings language`) and then rendered deterministically forever, exactly like
`state/last-brief.json`. Translating it therefore trips the hash gate once (one republish)
and steady state stays no-op-gated. Weekly-review has no chrome (pure frontmatter-stripped
model markdown), so it needs no string table. Number/date formatting (`$`, ISO timestamps)
is not localized — format, not language.

## Design contract

The two core-rendered HTML pages share one stylesheet and one set of markup helpers, both
in `scripts/lib/artifact-theme.ts`. That file is the **only** place a re-sync against
Claude Code's `artifact-design` skill needs to touch — `dashboard.ts` and
`proposals-page.ts` contribute content, not styling. A hermit-local custom renderer
(§ Custom renderer) is outside that guarantee by design: it owns its own layout and may
style the page however its operator wants. It is not cut off from core's design work,
though — the `state dashboard` verb hands it the current stylesheet on every render, so a
renderer that uses `theme_css` picks up theme fixes without being regenerated.
`artifact-design` is prose guidance with nothing importable, so the sync mechanism is
deliberate: keep every decision in one module, and encode the checkable rules as
`tests/artifact-theme.test.ts`. When that skill gains a mechanically-checkable
rule, add an assertion there rather than trusting a re-read.

Implemented from `artifact-design`:

- **One palette, four theme blocks.** `PALETTE` declares light and dark once, and
  `:root`, the `prefers-color-scheme` media query (guarded with
  `:not([data-theme="light"])`), `:root[data-theme="dark"]`, and
  `:root[data-theme="light"]` are all generated from it. Partial-override drift is
  unrepresentable, not merely fixed.
- **`body` paints its own background** from a token, so the page never composites
  over the viewer's ground.
- **Two type roles.** System sans for prose; `ui-monospace` for every
  machine-emitted value (ids, dates, costs, token counts, state enums). Scale runs
  title > stat > body > meta, with eyebrows small because they are labels.
- **State encoded as form**, not only as text: severity rails on alert and
  proposal rows, status chips derived from the semantic trio.
- **Summary before detail**: stat tiles and count pills precede the lists.
- Chosen neutrals (a cool cast, deliberately off stock greys), `tabular-nums`,
  `overflow-x: auto` on wide children, visible focus rings, reduced-motion honored.

Deliberately declined:

- **No inlined webfont.** `artifact-design` suggests a `@font-face` data URI, but
  the plugin bans build steps and runtime dependencies, subsetting needs tooling
  the repo does not have, and it would vendor a font plus its license into a
  public plugin. Two system faces used as distinct roles carry the hierarchy.
- **No per-publish model authorship.** These pages are script-rendered on purpose
  (a publish costs a render, not a generation, and publishes fire several times a
  day) — so the design work is done once, by hand, into the renderer. Never call
  `artifact-design` on the publish path.

## Weekly review

`config.artifacts.weekly_review`, state key `weekly_review`. The latest compiled
`review-weekly-YYYY-Www.md`, published as markdown directly (the Artifact tool renders
`.md` natively — confirmed empirically) with its YAML frontmatter stripped (raw
frontmatter renders as an ugly literal block; every field is already legible in the
report body's evolution block and the dashboard's weekly section). Rendered by
`artifact.ts render weekly` — no HTML step, so no CSS/fragment/`<title>`
wrapping to build; the same five-step hash-gate/publish/state-write procedure still
applies (hash is `sha256` of the frontmatter-stripped body). `<title>` for the
`Artifact` call is the report's own top heading (e.g. `Weekly Review — 2026-W27`).

Refresh trigger: `weekly-review` (step 6), which appends the page's URL to its channel
message alongside the dashboard's. Same page across the week — each mid-week revision
of the compiled report republishes to the same URL, so the artifact's own version
history *is* the week's revision history.

Off by default: the dashboard already embeds the full weekly body in its own section.
This standalone page's distinct value is a stable per-surface URL and its own version
history, not new content. Opt in via `/hermit-settings artifact-weekly-review yes`.

## On-demand document publish

Any compiled doc or proposal can be published as a one-off page on operator request
("open <compiled doc | PROP-NNN> as a page") — **no config gate; operator-initiated by
definition.** The missing gate is on *whether* to publish, not on *where*:
`config.artifacts.backend` still applies here exactly as in § Shared refresh procedure —
resolve it first, and take § Non-claude backend deviations when it is anything other than
`"claude"`. Publishes that `.md` file directly, no HTML render step (on the default
backend, the same `Artifact` call shape as the weekly-review page). The URL is recorded
under `documents.<basename>` in `state/artifacts.json`, same entry shape as the other
types including its `backend` field, so a repeated request for the same document
redeploys to the same URL instead of minting a new one — under the same gate discipline
as step 2: a backend mismatch is a first publish on the new host (no `url`);
otherwise skip the publish call when the file's content hash is unchanged from the last
recorded one, and on redeploy read the recorded `url` first, then publish without `force`
(step 3; the local file is authoritative). No automatic per-document publishing; the
dashboard's compiled-docs index is the discovery surface for what's available to ask
for.
