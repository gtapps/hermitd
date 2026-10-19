# Plugin Hermit Storage Convention

Plugin hermits store session-facing domain artifacts in exactly two directories:

- `.hermit/raw/` — ephemeral inputs (fetched content, snapshots, logs, API dumps).
- `.hermit/compiled/` — durable outputs (briefings, digests, assessments, audit results).

Everything else is infra managed by the base hermit (`state/`, `sessions/`, `proposals/`, `templates/`, operator-curated docs). Domain plugins must not add top-level directories for knowledge artifacts unless the directory is an intentional plugin-owned archive with its own documented lifecycle. Plugin-owned archives and runtime directories must be declared in `config.storage_drift.ignore` (see below).

## Why these two and nothing else

The `compiled/` directory is scanned at session start to inject foundational context. `scripts/archive-raw.ts` and the weekly review run retention against `raw/`, covering both dated `.md` and `.json` artifacts. Fixed-name `-latest.*` aliases are never archived. Anything outside these two paths is invisible to both mechanisms — your audits won't surface at session start, and your snapshots will never be archived.

## Intentional plugin-owned dirs (`storage_drift.ignore`)

Some domain plugins install a hermit-owned runtime tree that is **not** a knowledge artifact — for example, `hermitd-laravel-forge` puts a Composer vendor tree at `.hermit/forge-runtime/`. The same applies to a downstream agent that overrides a core plugin script (e.g. keeping a project-specific `hermitd-start.ts` wrapper at `.hermit/scripts/`) — it's live code, not an artifact, and must not be moved into `raw/` or `compiled/`. These dirs are legitimate, so the storage-drift check must not flag them.

A domain plugin may also own an archive that is intentionally outside core's context injection and rotation. The declaring plugin owns the archive's readers, format, and retention policy, and exposes any session-facing projection through `compiled/`. Allowlisting the archive suppresses false remediation but does not make core inject or rotate it.

Declare such dirs in `config.json`:

```json
"storage_drift": {
  "ignore": ["forge-runtime"]
}
```

The entry must be the **bare directory name** (`"forge-runtime"`, `"scripts"`), not a path (`".hermit/scripts/"` or `"scripts/"`) — the check matches against `entry.name` from a directory listing, so a path-form entry silently fails to match and the drift warning keeps recurring.

When a domain plugin calls hatch, its config rewrite appends each intentional directory name to `storage_drift.ignore` idempotently. The drift check (`scripts/lib/drift.ts`) reads this list at runtime and skips declared dirs; in both the startup Storage Drift block and the reflect observations ledger.

Rules for a compliant plugin-owned dir:
- One per domain plugin (keep it scoped).
- Hermit-owned only — not the application's own `vendor/` or `node_modules/`.
- Runtime dirs never contain archivable knowledge content; use `raw/` or `compiled/` for that.
- Archive dirs document their consumers and lifecycle, and expose any session-facing projection through `compiled/`.
- Register it in `storage_drift.ignore` during hatch — never rely on it being silently ignored.

The session-facing layout still mirrors the Karpathy raw-vs-compiled split: raw is the immutable ground truth, compiled is the LLM-maintained derivative. The `type` field in frontmatter differentiates work products within each directory; allowlisted archives stay behind their declaring plugin's interface.

## File naming

Use flat filenames inside each directory. The pattern is:

```
raw/<type>-<slug>-<date>.md
compiled/<type>-<slug>-<date>.md
compiled/topic-<slug>.md          (living topic pages — undated, updated in place)
```

Examples:
```
raw/snapshot-home-2026-04-17.md
raw/source-ha-sensors-2026-04-17.md
compiled/audit-kitchen-2026-04-17.md
compiled/briefing-home-2026-04-17.md
```

**No subdirectories inside `raw/` or `compiled/`.** The `type` field in frontmatter is the discriminator — never a folder. The only exception is `raw/.archive/`, which is managed automatically by the weekly review.

## Required frontmatter

Every artifact must carry frontmatter:

```yaml
---
title: Home Sensors Snapshot
type: snapshot          # matches knowledge-schema.md entry
created: 2026-04-17T09:00:00-03:00
tags: [home, sensors]
---
```

Inside an open record's turn add `task: T-...` and cite the artifact through `task.ts note`; omit the task field otherwise. `startup-context.ts` surfaces eligible compiled artifacts at startup. For compiled artifacts, add a `source:` citation pointing to the raw artifact(s) they were derived from:

```yaml
source: raw/snapshot-home-2026-04-17.md
```

Tag compiled artifacts `foundational` to pin them to every session start regardless of age.

Artifacts should carry frontmatter for grep-ability and startup injection. See `docs/frontmatter-contract.md` for the field conventions.

## Handling large artifact volumes

If a hermit produces many artifacts of the same type (per-room audits, per-account snapshots):

- **Write a rollup digest** to `compiled/` and the per-entity raw data to `raw/`. One `compiled/audit-home-2026-04-17.md` covering all rooms beats 10 per-room files bloating session context.
- Let retention do the work: raw snapshots expire per `knowledge.raw_retention_days` and land in `raw/.archive/`. The compiled digest survives.
- If the rollup is too coarse, use tags (e.g. `tags: [kitchen, audit]`) to group related artifacts — not subdirectories.

## Compliant vs non-compliant paths

| Path | Status | Reason |
|------|--------|--------|
| `.hermit/raw/snapshot-home-2026-04-17.md` | ✅ | correct location, flat |
| `.hermit/compiled/audit-kitchen-2026-04-17.md` | ✅ | correct location |
| `.hermit/compiled/briefing-ha-2026-04-17.md` | ✅ | use `type: briefing` in frontmatter |
| `.hermit/raw/audits/latest.md` | ❌ | subfolder inside `raw/` — invisible to archive-raw.ts |
| `.hermit/audits/` | ❌ | new top-level folder — not scanned at session start |
| `audits/` (repo root) | ❌ | completely outside hermit state |
| `reports/` (repo root) | ❌ | same — outside hermit state |
| `memory/` (inside `.hermit/`) | ❌ | base hermit infra — plugins don't add top-level dirs |
| `.hermit/forge-runtime/` (with `storage_drift.ignore: ["forge-runtime"]`) | ✅ | hermit-owned runtime dir, registered in config, not a knowledge artifact |
| `.hermit/scripts/` (with `storage_drift.ignore: ["scripts"]`) | ✅ | downstream override of a core script (e.g. project-specific `hermitd-start.ts`), not a knowledge artifact |
| `.hermit/scripts/` (with `storage_drift.ignore: [".hermit/scripts/"]`) | ❌ | path-form entry doesn't match `entry.name` — still flagged as drift |

## Declare your types in knowledge-schema.md

Every artifact type a plugin produces must appear in `knowledge-schema.md`:

```markdown
## Work Products
- audit: room-by-room issue list produced by the weekly home scan.
  Triggered by `ha-audit` routine. Format: bullet list per room.
  Location: compiled/audit-<slug>-<date>.md

## Raw Captures
- snapshot: Home Assistant sensor dump. Feeds the audit work product.
  Location: raw/snapshot-<slug>-<date>.md. Retained 3 days.
```

This is the behavioral contract operators read to understand what the hermit does automatically.

## Reviewer checklist

When reviewing a plugin hermit for storage compliance, run these checks:

1. **Grep for non-compliant write paths** in skills and agents:
   ```
   grep -r "audits/\|reports/\|reviews/\|statements/\|relatorios/\|tmp/\|memory/" skills/ agents/
   grep -r "raw/[a-zA-Z].*/" skills/ agents/   # catches raw/<subdir>/
   ```
2. **Check for repo-root folders** that shouldn't exist (anything that isn't hermit infra):
   ```
   ls -d */ | grep -vE '^(skills|agents|hooks|scripts|docs|state-templates|tests|\.claude-plugin|\.git)/'
   ```
3. **Verify every write path in skills/agents ends in `raw/` or `compiled/`** — not a subdir.
4. **Check `knowledge-schema.md`** in the target project has entries for every type the plugin writes.
5. **Check frontmatter** on a sample of produced artifacts — all required fields present.

## Migrating a non-compliant plugin

1. Identify all ad-hoc folders and their contents (one grep pass with the checklist above).
2. For each artifact:
   - If it's a domain input → move to `raw/<type>-<slug>-<date>.md`, add frontmatter.
   - If it's a domain output → move to `compiled/<type>-<slug>-<date>.md`, add frontmatter, cite source.
3. Update every skill and agent that referenced the old path.
4. Update `knowledge-schema.md` to declare the types.
5. Delete the empty old folders.
6. Run a final checklist pass to confirm nothing points at the old paths.

## Hook cwd and project-root resolution

Claude Code hooks fire with the session's shell cwd, which can drift away from the project root (a persisted `cd` into a subdirectory, for example). Hook scripts must **never** resolve `.hermit/...` paths relative to cwd.

All core hook scripts use `hermitDir()` from `scripts/lib/cc-compat.ts` instead. Resolution order:

1. `AGENT_DIR` if **absolute** — operator override via `config.env`, points directly at the `.cch` dir.
2. `CLAUDE_PROJECT_DIR`/`.hermit` if that directory exists — CC-authoritative root.
3. cwd walk-up looking for `.hermit/config.json` — drift recovery.
4. `path.resolve('.hermit')` — fail-open, preserves today's behavior.

Hooks that receive an absolute `file_path` in their payload (`validate-config`, `generate-summary`) anchor directly on that path instead of using the resolver — they have a guaranteed absolute source.

When adding a new hook script, import `hermitDir` from `./lib/cc-compat` and compute all `.hermit/...` paths against its return value.


## Resident launch files

| File under .hermit/ | Ownership |
|---|---|
| `state/resident-system-prompt.md` | Generated atomically at every start from `prompts/resident.md` and `prompts/rules.md`; passed only to the resident as its appended system prompt; gated. |
| `claude-settings.json` | Optional operator-owned native settings for the resident; never written by the plugin. Hooks merge per event after generated launch overlay entries. |
| `state/claude-settings.overlay.json` | Generated at each start from config and the operator override; passed only to the resident and read at launch only. This launch overlay carries `pause-gate`, `ask-gate`, `component-privacy`, and `permission-denied-notify` with absolute paths instead of plugin-manifest entries. |
| `state/helper-system-prompt.md` | Generated at each start; passed to spawn-session helpers as their appended system prompt; gated. |
