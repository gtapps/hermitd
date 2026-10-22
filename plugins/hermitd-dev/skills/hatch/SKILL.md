---
name: hatch
description: Activate the dev hermit in the current project. Installs the git-push-guard hook at strict profile by default. Run once per project after /hermitd:hatch; re-run to update individual settings.
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
  - `bootstrap_core` / `upgrade_core_package` / `upgrade_core_applied` → tell the operator to run the `next_steps` commands in order, then stop. An older core prints the dashed form of these with a `remedy` instead: relay `remedy` and stop.
  - `verify` → this version (`self_version`) is already stamped; continue; Keep-current options make re-runs idempotent.
  - `full` → continue through the wizard.
  - `error`, or any `domain-hatch` command in this skill that prints `error` → tell the operator in plain words what its token means, then stop.

### 2. Detect protected-branch candidates

- Base-branch detection: `git branch -r --format='%(refname:short)' 2>/dev/null | sed 's|^origin/||'`. Collect `main`, `master`, `develop`, `development`, `dev`, and `trunk` as suggested protected branches for Round 1.

### 3. Ask about remaining settings

#### Round 1: protected branches

Ask a single `AskUserQuestion` with header `Protected` for protected branches (comma-separated, glob patterns OK). Offer at most four options: `Keep current (<value>)` first and recommended when already configured, the detected candidates joined as one comma-separated option, `main, master`, and `Other` for a custom list. Substitute actual values for placeholders before asking.

#### Round 2: hook profile

`git-push-guard` defaults to **strict**. The wizard does not ask which profile to use; it installs strict and offers an opt-out.

If `env.AGENT_HOOK_PROFILE` is already `"strict"` in config, replace the Hook question's options below with a single `Keep current (strict already active)` confirmation — never present an opt-out path that would silently downgrade an existing strict install.

```
questions: [
  {
    header: "Hook",
    question: "Install git-push-guard at strict profile? (Blocks direct push to protected branches, --no-verify, force-push, --mirror/--all.)",
    options: [
      { label: "Yes — strict (recommended)", description: "Hook hard-blocks the listed operations" },
      { label: "No — leave at standard", description: "No hook enforcement" }
    ]
  }
]
```

### 4. Write config and stamp version

Single atomic config.json write:

- `hermitd-dev.protected_branches` — array. The prompt accepts a comma-separated string; split on `,`, trim each entry, drop empties before writing.
- `env.AGENT_HOOK_PROFILE`:
  - If the operator accepted strict in Round 2 → write `"strict"`.
  - Else if the existing value is already `"strict"` → preserve it (never silently downgrade).
  - Else → write `"standard"` explicitly. Do not leave the key unset; an explicit value makes the operator's choice durable across `hermit-evolve` runs and prevents silent re-prompting.
- `_hermit_versions["hermitd-dev"]` — set to `self_version` from Step 1's preflight.

### 5. Knowledge-schema extension

Read `.hermit/knowledge-schema.md`.

Check if `## Work Products` already has a `- domain-brainstorm:` or `- **domain-brainstorm**:` bullet (another domain plugin's hatch may have added it).

If **absent**, append the following bullet under `## Work Products` (create the section header if absent):

```
- domain-brainstorm: report from a domain plugin's `domain-brainstorm` skill, written only when the run created at least one proposal. location: compiled/domain-brainstorm-<YYYY-MM-DD-HHMM>.md
```

If already present: skip (idempotent).

Use Edit to make the changes.

### 6. Report results

Print a summary that reflects what actually happened:

```
Dev hermit activated (hermitd-dev vX.Y.Z).

Git safety:
  Hook profile: strict (git-push-guard active)  [or: standard — no hook enforcement]
  Protected branches: main, master  [or whatever was set]

Updated:
  .hermit/knowledge-schema.md: domain-brainstorm type [added / already present]

Available skills:
  /hermitd-dev:hatch    — re-run to update settings (idempotent)

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
- **Never downgrade hook profile.** If the operator chooses "No — leave at standard" but `env.AGENT_HOOK_PROFILE` is already `strict`, preserve `strict`. The opt-out only applies on first install.
