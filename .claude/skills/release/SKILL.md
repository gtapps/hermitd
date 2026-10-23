---
name: release
description: Bump a plugin's version, write a detailed changelog entry for the upgrade skill to consume, and commit+push. Takes a plugin slug argument identifying which plugin under `plugins/` to release. Use this skill whenever the user says "release", "version bump", "cut a release", "changelog and push", or finishes a set of changes and wants to ship them. Also trigger when the user says "do the release thing" or asks to prepare changes for hermits to pick up.
---
# Release

Bump version, write changelog, commit, and push for a single plugin in the monorepo. The changelog entry is critical because the upgrade skill (`skills/hermit-evolve/SKILL.md`) reads it to know what to tell hermits during `/hermitd:hermit-evolve`.

## Usage

`/release <plugin-slug>` — release the plugin at `plugins/<plugin-slug>/`.

Examples:
- `/release hermitd` — release the core plugin
- `/release hermitd-dev` — release the dev hermit
- `/release hermitd-homeassistant` — release the HA hermit
- `/release hermitd-laravel-forge` — release the Laravel Forge hermit

If invoked without a slug, list all `plugins/<name>/` directories that contain `.claude-plugin/plugin.json` and ask the operator which one via AskUserQuestion before proceeding.

## Steps

### 0. Identify target plugin

Resolve the plugin slug:
- If the user passed `<slug>` as argument, use that.
- Otherwise, glob `plugins/*/.claude-plugin/plugin.json`, collect the directory names, and ask via AskUserQuestion: "Which plugin to release?" with one option per slug.

Validate `plugins/<slug>/.claude-plugin/plugin.json` exists. If it does not, abort: `Plugin 'plugins/<slug>/' not found.` Suggest the available slugs.

Throughout the rest of this skill, `$PLUGIN_DIR` refers to `plugins/<slug>/`.

### 1. Pre-release validation

Run before anything else. Abort the release if any step fails.

1. **Run the native plugin validator (CLI form):**
   ```bash
   claude plugin validate plugins/<slug> 2>&1
   ```
   Abort on any error.

2. **Run test suites for the target plugin.** Detect the convention and dispatch:
   - If `plugins/<slug>/tests/run-all.sh` exists (bash entrypoint, used by dev/fitness/scribe/forge):
     ```bash
     bash plugins/<slug>/tests/run-all.sh 2>&1
     ```
   - Else if any `plugins/<slug>/tests/*.test.ts` exists (bun entrypoint, used by core/HA):
     ```bash
     cd plugins/<slug> && bun test 2>&1
     ```
   - Else if a `plugins/<slug>/tests/` dir exists but neither marker matched: abort the release with `Plugin '<slug>' has a tests/ dir but no recognized convention (run-all.sh or *.test.ts) — fix the dispatch before releasing.` Do not silently skip.
   - Else (no `tests/` dir at all): skip this step and note it in the release report.

   If any test fails, stop and fix before releasing.

3. **Run the plugin-validator agent in `release` mode** (`plugin-validator <slug> release`) to cross-reference plugin integrity. Pass it the plugin slug explicitly so it knows which plugin to audit:
   - Skills in `plugins/<slug>/CLAUDE.md` match actual `plugins/<slug>/skills/` directories
   - Agents in `plugins/<slug>/CLAUDE.md` match actual `plugins/<slug>/agents/` files
   - Hook scripts referenced in `plugins/<slug>/hooks/hooks.json` exist in `plugins/<slug>/scripts/`
   - State-template JSON files parse correctly
   - `config.json.template` keys are in sync with `DEFAULT_CONFIG` in `plugins/<slug>/scripts/hermitd-start.ts` (core only)

If the auditor reports any FAIL, fix before proceeding. WARNs are acceptable if justified. Stale-reference detection-and-fix is consolidated into Step 4 below.

### 1.5. Refresh the knowledge graph

The repo carries graphify knowledge graphs (all gitignored): a root monorepo graph at `graphify-out/` and one per-plugin graph at `plugins/<slug>/graphify-out/`. Refresh both so they reflect the code that's shipping: the root graph (covers the whole monorepo, including this plugin's code) and this plugin's own graph. `/release` is single-plugin, so only the target plugin's per-plugin graph is refreshed here, not the other siblings'. This runs before the fast-path branch in Step 2, so it fires on both the normal and already-bumped paths, always before either push.

```bash
ROOT="$(git rev-parse --show-toplevel)"
if command -v graphify >/dev/null; then
  # Root monorepo graph
  [ -f "$ROOT/graphify-out/graph.json" ] && (cd "$ROOT" && graphify update .)
  # This plugin's own graph (single-plugin scope; "if exists")
  [ -f "$ROOT/plugins/<slug>/graphify-out/graph.json" ] && (cd "$ROOT" && graphify update plugins/<slug>)
fi
```

AST-only, no API cost. Each update is guarded by its graph.json existing, so it skips silently on checkouts where graphify isn't set up. Both graph dirs are gitignored, so this never affects release staging or the Step 6 `git status` check. If an update errors, warn and continue: a stale graph must not block a release.

### 1.6. Reconcile the proposal queue

Skip this step entirely if `.claude/skills/stale-proposals/` doesn't exist (monorepo-internal; not present in every checkout).

Run `/stale-proposals` before deciding what's shipping in this release — closing anything this release already delivers keeps the release notes and the proposal queue honest at the same time. Dispatch a `general-purpose` subagent at **`model: "sonnet"`** to run `stale-proposals/SKILL.md`'s Steps 1–2b (collect the evidence bundle and match), then apply `SHIPPED-STRONG` verdicts per that skill's Step 3. This is an interactive release flow, so — unlike the unattended routine — `SHIPPED-WEAK` and `AGED` verdicts go through `AskUserQuestion` exactly as `stale-proposals/SKILL.md` Step 4 describes, not a queued channel ask.

### 2. Determine version bump

**Already-bumped fast-path (two-phase release flow):** Find the most recent tag for this plugin:

```bash
git tag --list "<slug>--v*" | sort -V | tail -1
```

Compare its version to `plugin.json`. If `plugin.json` is already ahead (e.g. tag is `dev-hermit--v0.2.0`, plugin.json says `0.3.0`), the version was bumped on a plugin branch that has since merged to main. Skip steps 2–7 entirely — the CHANGELOG, version files, and commit are already done. Jump directly to step 8.

**Normal path:** Read `plugins/<slug>/.claude-plugin/plugin.json` for the current version and `plugins/<slug>/CHANGELOG.md` for recent entries.

Review the uncommitted or recently committed changes (`git diff` and/or `git log` since the last `<slug>--v<version>` tag).

Decide the bump level:
- **Patch** (0.0.X) — bug fixes, behavioral changes via updated instructions, small additions
- **Minor** (0.X.0) — new features, new skills, structural changes, breaking config migrations
- **Major** (X.0.0) — only if the user explicitly asks

Present the suggested version and rationale. Wait for confirmation before proceeding.

### 3. Write the changelog entry

Prepend a new entry to `plugins/<slug>/CHANGELOG.md` immediately after the `# Changelog` header, before the previous version entry. If a `[Unreleased]` section already exists, rename it to `[X.Y.Z] - YYYY-MM-DD` instead of prepending a new one — the entry has been accumulating during development.

**Docs-only double-check (do this before promoting/writing the entry).** Read every narrative bullet about to ship in this version and confirm each describes a real code/behavior change an operator experiences. Drop any bullet whose only change is documentation — README, `docs/`, `CLAUDE.md`, or code comments — including bullets that pair a docs correction onto an otherwise-code entry (keep the code half, cut the docs half). Docs corrections belong in the commit message and PR description, never the CHANGELOG. Cross-check against the actual diff: `git diff <last-tag>..HEAD -- plugins/<slug>` — if a bullet's only backing changes are `.md` or comment edits, it should not be in the changelog. This mirrors the root `CLAUDE.md` §Commits rule.

**Format**:

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added / Changed / Fixed
(use whichever sections apply — skip empty ones)

- Plain sentence-case line describing the change; the header carries the category. Backticks for `commands`, `paths`, `--flags`.

### Upgrade Instructions

Run `/hermitd:hermit-evolve`. The evolve skill handles:

1. **Imperative step title** — what to do, in one sentence.

**Operator action required:** `.hermit/bin/hermitd-docker restart` (or `hermitd-stop && hermitd-start`).

No `config.json` changes required.
```

**Template constraints (enforce these):**

1. **Narrative bullets (Added / Changed / Fixed)** — canonical format lives in root `CLAUDE.md` §Commits; enforce it here: a plain sentence-case line under the category header, no `**component:**` prefix and no leading Fixed/Added verb (the header carries the category). Backticks for commands/paths/flags. Target 1–2 lines. If a bullet wants to grow longer, the surplus belongs in the PR description, not here.
   - Do NOT list internal refactors, helper extractions, test scaffolding, or renamed variables — those are visible in `git diff`.
   - **Recovery procedures, migration shell snippets, and breaking-change steps belong in `### Upgrade Instructions`, never in the narrative bullet.** Write a tight summary ("changed default X to Y") and let that section carry the imperative steps — `hermit-evolve` reads them step-by-step.

2. **Upgrade Instructions**: executable outcomes and declarations, following [Upgrade steps that change or remove what operators call](../../../plugins/hermitd/docs/creating-your-own-hermit.md#upgrade-steps-that-change-or-remove-what-operators-call):
   - Executable steps state the outcome plus constraints the model cannot infer; name migration verbs and required arguments exactly. Operator-dependent file or intent decisions belong to the evolve model. Each entry is self-contained and never references another entry.
   - Each executable step is a single action. Split independent outcomes into separate numbered steps.
   - No passive voice, no rationale clauses. If an operator needs to understand *why*, that belongs in the Changed bullet above, not here.
   - Include what `hermit-evolve` does NOT need to touch only if omission would cause it to act destructively. Otherwise silence.
   - Close with `No config.json changes required.` if true — it's the most common case and operators scan for it.

3. **What belongs where:**
   - Why it changed → Changed/Fixed bullet.
   - What evolve executes → Upgrade Instructions (imperative, numbered).
   - An action only the operator's environment can perform (restart, rebuild, host-side command) → one line after the numbered list, prefixed `**Operator action required:**` (canonical example: `.hermit/bin/hermitd-docker restart`). Never a numbered step and never a `**Note:**`.
   - Renamed or removed names and changed output → a `**Leftover check:**` line. Core may be terse; every other plugin writes a self-contained sentence saying what changed, the replacement, and to ask once before changing anything. Evolve owns check mechanics.
   - Minimum core floors belong in plugin metadata and dependencies, never in a changelog floor bullet.
   - Behavior deltas that need no action but operators should know → one final line after the numbered list, prefixed `**Note:**`. Not a step.

**The Upgrade Instructions section is the most important part.** The evolve skill reads this to know what actions to take for each hermit. Distinguish executable steps from `**Leftover check:**`, `**Operator action required:**` and `**Note:**` lines so evolve can handle each correctly.

### 4. Refresh references

For each new skill, agent, or hook added since the last release of this plugin, detect missing entries and add them in one pass:

- `plugins/<slug>/CLAUDE.md` quick reference list (skills) and subagent table (agents)
- `plugins/<slug>/docs/skills.md` (if the doc exists)
- Hook descriptions in `plugins/<slug>/CLAUDE.md` if the hook surface area changed

Skip the step entirely if nothing was added. The plugin-validator (Step 1.3) covers structural integrity; this step is about narrative references.

### 5. Bump version in all locations

Update the version string in:
- `plugins/<slug>/.claude-plugin/plugin.json` → `"version"` field
- `.claude-plugin/marketplace.json` → find the entry in `plugins[]` where `"name" == "<slug>"` and update its `"version"` field. Other plugin entries are untouched.
- `plugins/<slug>/README.md` → version badge if present: both the `img.shields.io` URL slug (`version-X.Y.Z-green.svg`) and the `alt` text (`Version X.Y.Z`). Confirm with `grep "version-" plugins/<slug>/README.md` that the new version appears and the old one does not. Skip silently if the README has no version badge. (For `hermitd`, skip this direct edit — the sync block below re-derives the whole file from root, picking up the updated badge automatically.)
- If `<slug>` is `hermitd`: also update the root `README.md` badge — `version-OLD-green.svg` → `version-NEW-green.svg` and `Version OLD` → `Version NEW`. This is the only plugin whose version the root README tracks.

**Sync plugin README from root (hermitd only):** `plugins/hermitd/README.md` is a path-adjusted derivative of the root `README.md`. After updating version badges, re-derive it by applying these substitutions to the root README content:

| In root `README.md`                              | In plugin `README.md`                          |
|--------------------------------------------------|------------------------------------------------|
| `href="LICENSE"`                                 | `href="../../LICENSE"`                         |
| `[MIT](LICENSE)`                                 | `[MIT](../../LICENSE)`                         |
| `href="plugins/hermitd/CHANGELOG.md"` | `href="CHANGELOG.md"`                          |
| `src="plugins/hermitd/assets/`        | `src="assets/`                                 |
| `](plugins/hermitd/docs/`             | `](docs/`                                      |
| `](plugins/hermitd-dev/`              | `](../hermitd-dev/`                 |
| `](plugins/hermitd-homeassistant/`    | `](../hermitd-homeassistant/`       |
| `](plugins/hermitd-fitness/`          | `](../hermitd-fitness/`             |
| `](plugins/hermitd-laravel-forge/`                | `](../hermitd-laravel-forge/`                   |

Write the result to `plugins/hermitd/README.md`.

After editing, verify the manifest and marketplace are in sync — the plugin manifest wins silently if they differ:
```bash
jq -r '.version' plugins/<slug>/.claude-plugin/plugin.json
jq -r --arg slug "<slug>" '.plugins[] | select(.name == $slug) | .version' .claude-plugin/marketplace.json
```
Both must print the same string. If they differ, fix `.claude-plugin/marketplace.json` before continuing.

### 6. Final validation

Steps 3–5 only edit Markdown and JSON, so re-running the test suite is unnecessary. Confirm:

```bash
jq -e . plugins/<slug>/.claude-plugin/plugin.json > /dev/null
jq -e . .claude-plugin/marketplace.json > /dev/null
git status --short
```

Both `jq` checks must succeed and `git status` must show only the files this release touched (CHANGELOG, plugin.json, marketplace.json, optional CLAUDE.md / README badge / state-templates updates). Any unexpected entry → investigate before committing.

### 7. Commit and push

Stage only the changed files (not `git add -A`). Commit with:

```
<slug> v<X.Y.Z>: One-line summary of the release
```

Push to origin.

### 8. Branch check before tagging

Run `git branch --show-current` and compare to `main` (or the repo's default branch from `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`).

- **On `main`/default branch** → tag immediately (step 9).
- **On any other branch** (e.g. `dev-hermit/v0.3.0`) → **stop**. Do not tag yet. Tagging the branch tip creates a commit SHA that `main` never carries after a regular merge (and is outright wrong after squash/rebase), leaving the tag stranded on an orphan commit.

  **Recommended path** (default): open a PR, merge into `main`, then re-run `/release <slug>` from `main`. Step 2's already-bumped detection will skip straight to tagging.

  If the user explicitly wants to tag now despite the risk, offer that as a secondary option. Wait for their explicit choice before proceeding.

### 9. Tag and publish

The tag format is **plugin-prefixed with double-dash separator**: `<slug>--v<X.Y.Z>`. This is the format Claude Code's native dependency resolver requires to find matching versions for `dependencies` entries.

Run `claude plugin tag --push` from the plugin directory — it validates plugin contents, confirms `plugin.json` and `marketplace.json` versions agree, requires a clean working tree, and refuses if the tag already exists:

```bash
(cd plugins/<slug> && claude plugin tag --push)
```

Then create the GitHub release pointing to the new double-dash tag. Source the release notes from the CHANGELOG section we just wrote — `--generate-notes` would otherwise interleave commits from sibling-plugin releases that landed since the last core tag.

```bash
VERSION=$(jq -r '.version' plugins/<slug>/.claude-plugin/plugin.json)
TAG="<slug>--v$VERSION"
NOTES_FILE=$(mktemp)
awk -v ver="$VERSION" '
  $0 ~ "^## \\[" ver "\\]" {flag=1; next}
  /^## \[/ && flag {exit}
  flag {print}
' plugins/<slug>/CHANGELOG.md > "$NOTES_FILE"
[ ! -s "$NOTES_FILE" ] && { echo "CHANGELOG section for $VERSION not found in plugins/<slug>/CHANGELOG.md — fix and retry"; rm "$NOTES_FILE"; exit 1; }
gh release create "$TAG" --title "$TAG" --notes-file "$NOTES_FILE"
rm "$NOTES_FILE"
```

### 10. Report

Print the slug, the new version, the commit hash, the tag name, and a one-liner confirming it's pushed.
