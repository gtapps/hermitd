---
name: hatch
description: One-time setup for hermit-scribe — appends the Issue Filing block to CLAUDE.md/CLAUDE.local.md. Run once per project; re-run to refresh after an upgrade.
disable-model-invocation: true
---

# Activate hermit-scribe

Hatch installs publication approval rules and refreshes the Issue Filing instruction block. There are no routines or channels.

## Plan

### 1. Check prerequisites

Check if `.hermit/` exists in the current project.

- Missing: ask the operator (`AskUserQuestion`) "Core hermit isn't set up yet. Run `/hermitd:hatch` now?" with options `Yes — run now` / `No — I'll do it later`. If yes, invoke `/hermitd:hatch` via the Skill tool and stop. If no, stop.
- Present: proceed.

### 1.5. Install publication approval rules

Run `.hermit/bin/hermitd-run domain-hatch preflight hermitd-scribe`. If it prints `error`, tell the operator in plain words what its token means, then stop. If `action` is `bootstrap_core`, `upgrade_core_package` or `upgrade_core_applied`, tell the operator to run the `next_steps` commands in order, then stop. An older core prints the dashed form of these with a `remedy` instead: relay `remedy` and stop. Map `target` (or `target_default` when absent): `local` to `.claude/settings.local.json`, `committed` to `.claude/settings.json`.

Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/native-permissions.ts <resolved-settings-file>` on every hatch, including when the version is current. It prints `OK`, or `{"status":"installed","deny_conflicts":[...]}` naming operator denies that still override these asks: name them in the final report. If it fails, stop before updating the instruction block.

### 2. Update CLAUDE.md / CLAUDE.local.md

**Resolve target file:** use `target_file` from step 1.5's preflight. When absent, map the same `target_default`: `local` to `CLAUDE.local.md`, `committed` to `CLAUDE.md`.

Read the plugin version from `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` and the stamped version from `.hermit/config.json` at `_hermit_versions["hermitd-scribe"]` (treat absent as `null`). Step 3 of this skill stamps that field at the end of every run, so on re-runs it reflects the version that last wrote the block. Read `target_file` (a missing file is marker-absent — the append below will create it). Look for the marker `<!-- hermitd-scribe: Issue Filing -->`.

- **Marker present AND stamped version equals plugin version:** skip — block is current. Do not re-read the template.
- **All other cases** (marker absent, stamped version null, OR stamped version stale): read `${CLAUDE_PLUGIN_ROOT}/state-templates/CLAUDE-APPEND.md`. The template is the source of truth; no operator prompt is needed.
  - **Marker absent** — append the **full** template, including its leading `---` separator, to `target_file` (the Edit tool creates `target_file` if missing).
  - **Marker present** — replace only the marked block with the template's **marker-onward portion** (from `<!-- hermitd-scribe: Issue Filing -->` to the end of the file, i.e. *excluding* the leading `---`, which already sits above the marker in the target — appending the whole file here would duplicate the separator). The block to replace runs from the opening `<!-- hermitd-scribe: Issue Filing -->` through the matching closing `<!-- /hermitd-scribe: Issue Filing -->`, inclusive; **if the target's block predates the closing marker** (every install hatched before the marker shipped), fall back to the first standalone `---` line after the opening marker, or end of file.

### 3. Stamp version

Write `_hermit_versions["hermitd-scribe"]` into `.hermit/config.json` with the current plugin version. Registering here also makes `hermit-scribe` a resolvable Conventional-Commits scope for `file-issue.ts classify` (which reads `_hermit_versions`) and puts the block within reach of `hermit-evolve`'s automatic refresh on future upgrades.

### 4. Final report

Print: "hermit-scribe active. Issue filing goes through `/hermitd-scribe:hermit-scribe`, always with an in-session preview before posting."
