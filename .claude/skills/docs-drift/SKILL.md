---
name: docs-drift
description: Documentation-drift audit for the plugin monorepo. Audits either each scoped plugin's unreleased changelog claims or its latest shipped release from the previous reachable plugin-name--v* tag, then checks whether the matching plugin README, docs/, CLAUDE.md or AGENTS.md files, and root documentation still tell the truth. Reports meaningful drift with concrete proposed edits and asks before applying anything. Use when preparing or verifying a release, when asked to check the latest version, or when the operator says "docs drift", "check the docs", "are the docs up to date", "docs audit", "did the docs keep up", "check documentation before release", or whether documentation matches released or unreleased changes. Complements /pre-release-review, which checks changelog claims against code; this skill checks changelog claims against docs.
---

# Docs Drift

The third leg of the release check. `/release-status` shows what is queued,
`/pre-release-review` verifies that the changelog tells the truth about the
code, and this skill verifies that the docs tell the truth after the change.

**Read-only until the operator approves.** The audit never edits, commits,
tags, pushes, publishes, or releases. Apply only the findings the operator
selects in Step 5.

## Usage

- `/docs-drift` or `/docs-drift unreleased` — audit every plugin with a
  non-empty `[Unreleased]` section.
- `/docs-drift <plugin-slug>` — audit that plugin's unreleased changes.
- `/docs-drift latest` — audit the latest reachable release of every tagged
  plugin.
- `/docs-drift latest <plugin-slug>` — audit only that plugin's latest release.

Default to unreleased mode. Treat "latest version", "latest release", or
equivalent wording as latest-release mode.

Natural ordering before a ship:

`/release-status` → `/pre-release-review` → `/docs-drift` → `/release <slug>`

## Step 1 — Scope plugins and snapshots

Never mix released and unreleased windows in one claim set.

### Unreleased mode

Identify plugins whose `[Unreleased]` section contains non-blank content:

```bash
for p in plugins/*/CHANGELOG.md; do
  slug=$(basename "$(dirname "$p")")
  awk '/^## \[Unreleased\]/{f=1; next} /^## \[/{f=0} f && NF' "$p" | rg -q '.' \
    && echo "$slug"
done
```

If the operator named a plugin, limit scope to that slug after verifying it
exists and has unreleased content. If nothing is in scope, stop with:

`No unreleased changes in any plugin — nothing to drift-check.`

Use the working tree as the documentation snapshot. Keep incidentally noticed
older drift separate as pre-existing debt.

### Latest-release mode

Start from all `plugins/*/CHANGELOG.md` slugs, or only the operator-named slug.
Resolve each plugin's refs independently:

```bash
EMPTY_TREE=$(git hash-object -t tree /dev/null)

for p in plugins/*/CHANGELOG.md; do
  slug=$(basename "$(dirname "$p")")
  latest=$(git describe --tags --abbrev=0 --match "${slug}--v*" HEAD 2>/dev/null || true)

  if [ -z "$latest" ]; then
    printf '%s\n' "$slug: skipped (no reachable release tag)"
    continue
  fi

  previous=$(git describe --tags --abbrev=0 --match "${slug}--v*" "${latest}^" 2>/dev/null || true)
  printf '%s\n' "$slug latest=$latest previous=${previous:-<empty-tree>}"
done
```

Use only reachable `<slug>--v*` tags. Do not select an unreachable tag merely
because its version sorts later. If a plugin has only one reachable tag, use
the empty tree as its previous snapshot. If every scoped plugin lacks a tag,
stop with:

`No reachable plugin release tags — nothing to latest-release drift-check.`

For each plugin, record:

- claim window: `<previous-tag>..<latest-tag>`, or empty tree to latest tag;
- changelog claims: the exact `## [<latest-version>]` section at the latest tag;
- documentation snapshot: the repository exactly at that plugin's latest tag.

Later commits and working-tree changes are not release claims in this mode.
Different plugins may have different latest-tag snapshots; preserve the
plugin-to-tag mapping throughout the audit.

## Step 2 — Extract doc-checkable claims

In unreleased mode, read only each scoped plugin's working-tree `[Unreleased]`
section.

In latest-release mode, derive the version from `<slug>--v<version>` and read
the matching changelog section from the tagged snapshot:

```bash
version=${latest##*--v}
git show "$latest:plugins/$slug/CHANGELOG.md" | sed -n "/^## \\[$version\\]/,/^## \\[/{/^## \\[/!p}"
```

Also inspect the plugin-scoped release diff to catch doc-checkable
operator-visible changes that a changelog bullet may group:

```bash
release_diff_base=${previous:-$EMPTY_TREE}
git diff "$release_diff_base" "$latest" -- "plugins/$slug/"
```

Use that diff only in latest-release mode and only for claim discovery. This
skill does not replace changelog-versus-code review.

Turn each bullet or diff-derived behavior into zero or more claims:

- **Removal or rename** — a skill, command, script, hook, config key, doc file,
  or CLI changed identity.
- **New operator-visible surface** — a new skill, slash command, config block,
  hook, CLI, or channel behavior should appear where siblings are enumerated.
- **Changed default or behavior** — docs may still state the previous default
  or behavior. Treat this as the highest-severity class.
- **Count or version claim** — a hand-written number or version marker may
  still contain the old value.
- **Promised documentation** — a cited file or anchor must exist and cover what
  the changelog promises.

Mark pure internal fixes, refactors, and test-only changes as `no doc surface`.
Do not manufacture a finding for every bullet.

## Step 3 — Sweep the matching documentation

For each scoped plugin, consider the files that exist in its selected snapshot:

- `plugins/<slug>/README.md`
- `plugins/<slug>/docs/*.md`
- `plugins/<slug>/CLAUDE.md`
- `plugins/<slug>/AGENTS.md`
- top-level plugin extras such as `SAFETY.md`, `DOCKER.md`, or
  `CONTRIBUTING.md`

Also check relevant root documentation:

- root `README.md`
- root `CLAUDE.md`
- root `AGENTS.md`
- root documentation extras relevant to a claim

Work claim-first, not file-first:

- **Unreleased:** use `rg -n` against the working tree. Sweep root files once
  against the union of all claims.
- **Latest release:** use `git grep -n <pattern> "$latest" -- <paths>` and
  `git show "$latest:<path>"`. Sweep root files at each plugin's own latest-tag
  snapshot. Deduplicate identical root findings without losing the plugin/tag
  evidence.

Never silently substitute current documentation for a released snapshot.

**Fan out when scope is wide.** With more than two plugins in scope, dispatch
one Explore/general-purpose subagent per plugin. Give it only that plugin's
claims, mode, and snapshot ref. Require findings as:

`snapshot:file:line — claim contradicted — current text — suggested fix`

Keep the root-file sweep in the main session because it needs cross-plugin
deduplication. In latest-release mode, require subagents to inspect tagged
files with `git grep` and `git show`; the working tree is only for the
actionability check below.

In latest-release mode, re-check each snapshot finding against the current
working tree:

- If it is still stale, propose an edit to the current file.
- If it is already corrected, report it under `Fixed after release` with no
  proposed edit.
- If the file no longer exists, explain its replacement or removal and do not
  propose recreating it without evidence.

## Step 4 — Judge meaningfulness

Propose an edit only when a reader would be factually misled:

- **Meaningful:** references a removed or renamed surface; states an old
  default or behavior; gives a wrong count or version; omits a new surface from
  a sibling enumeration; or promises documentation that does not exist or does
  not cover the claim.
- **Not meaningful:** tone, formatting, absent marketing coverage, missing
  documentation for internal fixes, or changelog accuracy that
  `/pre-release-review` owns.
- **Borderline:** reader impact is unclear. Report it separately with a
  one-line rationale and no proposed edit.

Never pad findings.

## Step 5 — Report, then ask before applying

Emit one report:

```text
# Docs Drift — <date>

## Scope
Mode: <unreleased | latest release>
In scope: <slugs with snapshot refs>
Skipped: <slugs and reasons>
Claim windows: <[Unreleased] | previous-tag..latest-tag per plugin>
Documentation snapshots: <working tree | latest tag per plugin>

## Findings
### <n>. <slug> — <misleading | stale-reference | missing-doc>
- Claim: <abbreviated claim and changelog/diff evidence>
- Drift: <snapshot>:<doc file:line> — currently says: "<excerpt>"
- Current tree: <still stale | changed | file removed>
- Proposed edit: <exact replacement text, or "add section X covering Y">

## Fixed after release (no edit proposed)
- <snapshot>:<file:line> — <what was stale and where it is now corrected>

## Borderline (no edit proposed)
- <snapshot>:<file:line> — <one-line rationale>

## No doc surface
- <briefly grouped internal or test-only claims>

## Pre-existing drift (not this window)
- <anything noticed outside the selected claim window>

## Verdict
<N> actionable findings across <M> current files | Docs are clean for this window.
```

Ask which actionable findings to apply: all, selected finding numbers, or none.
The audit itself is not approval to edit.

For approved findings, edit only the current working tree, surgically, matching
each document's style. Never edit a tag. Shortening a doc means condensing the
wording and keeping the content: removing a section or content block needs
per-item operator confirmation, and install, upgrade and recovery steps always
stay (compressed to a few lines plus a link if needed).

After applying:

- Re-read changed passages and run `git diff --check`.
- For edits under `plugins/<slug>/`, offer a terse sentence-case line for that
  plugin's `[Unreleased]` `### Fixed`, with no `**docs:**` prefix. Root
  README/CLAUDE.md edits skip the changelog per repository convention.
- Report that edits are uncommitted and `/commit` can capture them.
- Never commit, push, tag, publish, or release from this skill.
