---
name: hatch
description: Activate the dev hermit in the current project. Appends the dev safety rules to CLAUDE.md, installs the git-push-guard hook at strict profile by default, and offers companion plugins. Run once per project after /hermitd:hatch; re-run to update individual settings.
disable-model-invocation: true
---

# Activate Dev Hermit

Set up the language-agnostic safety layer for this project. Requires `hermitd` core to be initialized first.

## Plan

### 1. Check prerequisites

Check if `.hermit/config.json` exists in the current project.

- Missing: print this block and stop:

  ```markdown
  ## ▶ Next step — type this now

      /hermitd:hatch

  I can't run setup wizards for you (they're operator-run by design).
  After it finishes, come back and type `/hermitd-dev:hatch`.
  ```
- Present: run `.hermit/bin/hermitd-run domain-hatch preflight hermitd-dev` and parse the JSON verdict. Branch on `action`:
  - `upgrade-core-package` / `upgrade-core-applied` → relay the `remedy` string verbatim to the operator and stop.
  - `verify` → this version (`self_version`) is already stamped; continue through the wizard, Step 3's block sync is the idempotency guard.
  - `full` → continue through the wizard.
  - `ok: false` → relay `message` and stop.

### 2. Detect protected-branch candidates and companions

- Installed plugins: `claude plugin list 2>/dev/null` or read `.claude/settings.json`.
- Base-branch detection: `git branch -r --format='%(refname:short)' 2>/dev/null | sed 's|^origin/||'`. Collect `main`, `master`, `develop`, `development`, `dev`, and `trunk` as suggested protected branches for Round 1.
- Read `OPERATOR.md` if present and check for `## Development Conventions`.

### 3. Update CLAUDE.md / CLAUDE.local.md dev block

**Resolve target file:** Step 1's preflight already returned `target`, `target_file`, `target_default` and `needs_target_question`.

If `needs_target_question` is true, ask with `AskUserQuestion` (header: "Visibility") — `target_default` at position 0 with `(recommended)` in the label: **`.local` files** (gitignored — operator-personal) / **Committed files** (shared with teammates). Then record the choice:

```bash
.hermit/bin/hermitd-run domain-hatch ensure-target hermitd-dev --target <choice>
```

**Write the block.**

```bash
.hermit/bin/hermitd-run domain-hatch sync-block hermitd-dev
```

The command appends when the marker is absent, replaces when the content differs, and skips when it is already current. Shared rules land in the hatch-resolved CLAUDE file, and resident duties in `.hermit/RESIDENT.md`.

Stray-block migration (block stranded in the non-target file after a target flip) is handled one-shot by the Upgrade Instructions in this version's CHANGELOG entry, executed by `hermit-evolve` Step 7. Hatch itself stays focused on target-aware setup and steady-state refresh.

### 4. Ask about remaining settings

#### Round 1: protected branches

Ask a single `AskUserQuestion` with header `Protected` for protected branches (comma-separated, glob patterns OK). Offer at most four options: `Keep current (<value>)` first and recommended when already configured, the detected candidates joined as one comma-separated option, `main, master`, and `Other` for a custom list. Substitute actual values for placeholders before asking.

#### Round 2 — hook profile and companions

`git-push-guard` defaults to **strict**. The wizard does not ask which profile to use; it installs strict and offers an opt-out.

If `env.AGENT_HOOK_PROFILE` is already `"strict"` in config, replace the Hook question's options below with a single `Keep current (strict already active)` confirmation — never present an opt-out path that would silently downgrade an existing strict install.

```
questions: [
  {
    header: "Hook",
    question: "Install git-push-guard at strict profile? (Blocks direct push to protected branches, --no-verify, force-push, --mirror/--all.)",
    options: [
      { label: "Yes — strict (recommended)", description: "Hook hard-blocks the listed operations" },
      { label: "No — leave at standard", description: "Prose rules in CLAUDE-APPEND still apply, but no hook enforcement" }
    ]
  },
  {
    header: "Docs MCP",
    question: "Install context7? Live library docs via MCP — no always-loaded cost.",
    options: [
      { label: "Yes", description: "claude plugin install context7@claude-plugins-official" },
      { label: "No", description: "Skip — add it later with claude plugin install" }
    ]
  }
]
```

Skip the `Docs MCP` question entirely if `context7` is already installed (per the `claude plugin list` detection above).

If `OPERATOR.md` exists and does NOT contain a `## Development Conventions` section, append the answers under that heading.

### 5. Write config and stamp version

Single atomic config.json write:

- `hermitd-dev.protected_branches` — array. The prompt accepts a comma-separated string; split on `,`, trim each entry, drop empties before writing.
- `env.AGENT_HOOK_PROFILE`:
  - If the operator accepted strict in Round 2 → write `"strict"`.
  - Else if the existing value is already `"strict"` → preserve it (never silently downgrade).
  - Else → write `"standard"` explicitly. Do not leave the key unset; an explicit value makes the operator's choice durable across `hermit-evolve` runs and prevents silent re-prompting.
- `_hermit_versions["hermitd-dev"]` — set to `self_version` from Step 1's preflight.

If the operator answered "Yes" to `Docs MCP`: `claude plugin install context7@claude-plugins-official --scope project`.

### 6. Knowledge-schema extension

Read `.hermit/knowledge-schema.md`.

Check if `## Work Products` already has a `- domain-brainstorm:` or `- **domain-brainstorm**:` bullet (another domain plugin's hatch may have added it).

If **absent**, append the following bullet under `## Work Products` (create the section header if absent):

```
- domain-brainstorm: report from a domain plugin's `domain-brainstorm` skill, written only when the run created at least one proposal. location: compiled/domain-brainstorm-<YYYY-MM-DD-HHMM>.md
```

If already present: skip (idempotent).

Use Edit to make the changes.

### 7. Report results

Print a summary that reflects what actually happened:

```
Dev hermit activated (hermitd-dev vX.Y.Z).

Git safety:
  Hook profile: strict (git-push-guard active)  [or: standard — no hook enforcement]
  Protected branches: main, master  [or whatever was set]

Updated:
  CLAUDE.md — dev block [appended / updated to vX.Y.Z / already current]
  OPERATOR.md — dev conventions [added / already present / skipped]
  .hermit/knowledge-schema.md: domain-brainstorm type [added / already present]

Companion plugin: context7 [installed / already present / skipped]

Available skills:
  /hermitd-dev:hatch    — re-run to update settings (idempotent)

Conventions are in CLAUDE.md (§Git Safety, §Branch Discipline) and `.hermit/RESIDENT.md`.
Any agent doing dev work in this project — native Agent, custom subagent — must follow them.
```

## Docker network requirements

Read by `/hermitd:docker-security` when the operator enables LAN containment + DNS policy. **Intentionally empty** for this plugin.

### Domains (DNS allowlist)

(none — see note below)

### LAN allowlist suggestions

(none — see note below)

> **Why empty.** `hermitd-dev` is a language-agnostic safety layer. Dev workflows are inherently arbitrary — a project might pull packages from any registry (npm, PyPI, RubyGems, crates.io, Maven Central, Docker Hub, custom internal mirrors), reach any cloud provider's API, fetch from any git host, or talk to any local service. We can't pre-declare what your specific project needs without being wrong for the next operator.
>
> **What to do instead:** in `/docker-security`, choose **"Yes — recommended (LAN block + DNS log-only)"** for Prompt 1 the first time you run it. Run your usual dev workflows for a few days, then read `.hermit/state/dns.log` for the domains your project actually contacted. Add the ones you trust to `.hermit/docker/dnsmasq.allowlist` (one `server=/<domain>/1.1.1.1` line each), restart the netguard sidecar, and re-run `/docker-security` to flip to enforce mode. Strict DNS is hostile to arbitrary dev workflows out of the box — log-only is the right starting posture.

---

## Rules

- **Strict-by-default.** The wizard defaults to installing `git-push-guard` at strict. Do not ask "which profile?" — ask "yes or opt out?".
- **Idempotent.** Re-running detects existing `config.json` values and offers `Keep current (<value>)` as the first option per key, so operators can fast-confirm with Enter presses.
- **Single source of truth.** `CLAUDE-APPEND.md` is the source for the project's dev conventions. Step 3 syncs the marked block whenever it differs; operators put overrides elsewhere in their CLAUDE.md.
- **Never downgrade hook profile.** If the operator chooses "No — leave at standard" but `env.AGENT_HOOK_PROFILE` is already `strict`, preserve `strict`. The opt-out only applies on first install.
