---
name: hatch
description: One-time setup for hermit-scribe: installs publication approval rules and registers the plugin version. Run once per project.
disable-model-invocation: true
---

# Activate hermit-scribe

Hatch installs publication approval rules and registers the plugin version. There are no routines or channels.

## Plan

### 1. Check prerequisites

Check if `.hermit/` exists in the current project.

- Missing: ask the operator (`AskUserQuestion`) "Core hermit isn't set up yet. Run `/hermitd:hatch` now?" with options `Yes — run now` / `No — I'll do it later`. If yes, invoke `/hermitd:hatch` via the Skill tool and stop. If no, stop.
- Present: proceed.

### 1.5. Install publication approval rules

Run `.hermit/bin/hermitd-run domain-hatch preflight hermitd-scribe`. If it prints `error`, tell the operator in plain words what its token means, then stop. If `action` is `bootstrap_core`, `upgrade_core_package` or `upgrade_core_applied`, tell the operator to run the `next_steps` commands in order, then stop. An older core prints the dashed form of these with a `remedy` instead: relay `remedy` and stop. Map `target` (or `target_default` when absent): `local` to `.claude/settings.local.json`, `committed` to `.claude/settings.json`.

Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/native-permissions.ts <resolved-settings-file>` on every hatch, including when the version is current. It prints `OK`, or `{"status":"installed","deny_conflicts":[...]}` naming operator denies that still override these asks: name them in the final report. If it fails, stop.

### 2. Stamp version

Write `_hermit_versions["hermitd-scribe"]` into `.hermit/config.json` with the current plugin version. Registering here also makes `hermit-scribe` a resolvable Conventional-Commits scope for `file-issue.ts classify` (which reads `_hermit_versions`).

### 3. Final report

Print: "hermit-scribe active. Issue filing goes through `/hermitd-scribe:hermit-scribe`, always with an in-session preview before posting." Then name any `deny_conflicts` from step 1.5 as operator denies that block those commands outright.
