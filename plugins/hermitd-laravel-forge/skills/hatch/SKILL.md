---
name: hatch
description: One-time Laravel Forge hermit setup. Installs the Forge PHP SDK, verifies credentials, and wires the estate scan into config.json. Run once per project after /hermitd:hatch.
disable-model-invocation: true
---

# Hatch — hermitd-laravel-forge

Idempotent setup wizard for the Laravel Forge plugin. Run **after** `/hermitd:hatch` has been completed.

---

## Step 1 — Prerequisite check

Check whether `.hermit/config.json` exists.

If it does not:

Print this block and stop:

```markdown
## ▶ Next step — type this now

    /hermitd:hatch

I can't run setup wizards for you (they're operator-run by design).
After it finishes, come back and type `/hermitd-laravel-forge:hatch`.
```

If it does exist, run `.hermit/bin/hermitd-run domain-hatch preflight hermitd-laravel-forge` and parse the JSON verdict. Branch on `action`:

- **`upgrade-core-package` / `upgrade-core-applied`** → relay the `remedy` string verbatim to the operator and stop.
- **`verify`** → say:

  > "hermitd-laravel-forge {self_version} is already installed. Reply 'verify' to re-run checks only, or 'full' to re-run the full wizard."

  Use `AskUserQuestion`: "(verify / full)" — **verify** → skip to Step 4; **full** → continue from Step 2.
- **`full`** → continue from Step 2.
- **`ok: false`** → relay `message` and stop.

---

## Step 2 — PHP/Composer preflight + SDK install

**Check PHP version.** Run `php -r 'echo PHP_VERSION;'` via Bash. Parse the output. If `php` is not found or the version is below 8.5.0, relay this and stop:

> "PHP 8.5+ is required but not found (got: {version or 'not found'}).
>
> - **Docker**: re-run `/docker-setup` after the core base image is updated to Ubuntu 26.04 (which ships PHP 8.5 natively). If the core base is still 24.04, the Docker path is blocked pending that upgrade.
> - **Bare-metal**: install `php8.5-cli` and `php8.5-curl` (or your distro's equivalent)."

**Check Composer.** Run `composer --version`. If not found, relay this and stop:

> "Composer is not found. Install it from https://getcomposer.org/."

**Install the Forge SDK into project space.** The SDK goes into `.hermit/forge-runtime/` (hermit-owned, isolated from your app's own `composer.json`/`vendor/`).

Run these Bash commands:

```bash
mkdir -p .hermit/forge-runtime
cp "${CLAUDE_PLUGIN_ROOT}/php/composer.json" .hermit/forge-runtime/composer.json
cp "${CLAUDE_PLUGIN_ROOT}/php/composer.lock" .hermit/forge-runtime/composer.lock
```

**Idempotent install check**: if `.hermit/forge-runtime/vendor/` exists and the staged `composer.lock` content matches `${CLAUDE_PLUGIN_ROOT}/php/composer.lock`, skip the install. Otherwise run:

```bash
composer install --no-dev --no-interaction --working-dir=.hermit/forge-runtime
```

If composer exits non-zero, surface the error. Common cause: egress blocked — `packagist.org`, `repo.packagist.org`, `api.github.com`, `codeload.github.com` must be reachable. In Docker, verify the DNS allowlist in DOCKER.md is present.

---

## Step 3 — Verify .env + consumer .gitignore

Credential verification belongs to `forge.php check` in Step 4. Do not read `.env` into context.

Tell the operator:

> "Add your Forge API credentials to `.env` in the project root:
>
> ```
> FORGE_API_TOKEN=your-forge-api-token
> FORGE_ORG=your-org-slug        # optional if you have exactly one org
> ```
>
> Get your token at https://forge.laravel.com/profile/api. Reply 'done' when set, or 'skip' to continue (credential check happens in Step 4)."

Use `AskUserQuestion`: "(done / skip)"

**Read the consumer's `.gitignore`** (this file is not a secret — only the `.env` content is). Check if `.env` and `.env.*` patterns are present. If missing, offer to add them:

```
.env
.env.*
```

Append any missing patterns via Edit.

---

## Step 4 — CLI probe (credential check)

Run: `php ${CLAUDE_PLUGIN_ROOT}/php/forge.php check` and branch on `status`. A `policy_lift` field lists `.env` lifts of the shipped deny tiers; mention it in the final report.

- **`missing`** → tell the operator to add `FORGE_API_TOKEN` to `.env` and re-run Step 3.
- **`invalid`** → token found but API rejected it; tell the operator to check the token at https://forge.laravel.com/profile/api.
- **`unreachable`** → token present but the API could not be reached (network/egress blocked). In Docker, verify the DNS allowlist in DOCKER.md (`forge.laravel.com`). Re-run once connectivity is confirmed.
- **`ok`** → continue.

If `php` is not found at this point: re-run Step 2.

---

## Step 5 — CLAUDE.md / CLAUDE.local.md inject

**Resolve target file**: Step 1's preflight already returned `target`, `target_file`, `target_default` and `needs_target_question`.

If `needs_target_question` is true, ask with `AskUserQuestion` (header: "Visibility") — `target_default` at position 0 with `(recommended)`: **`.local` files** (gitignored, operator-personal) / **Committed files** (shared with teammates). Then record it:

```bash
.hermit/bin/hermitd-run domain-hatch ensure-target hermitd-laravel-forge --target <choice>
```

Then write the block:

```bash
.hermit/bin/hermitd-run domain-hatch sync-block hermitd-laravel-forge
```

It appends the `<!-- hermitd-laravel-forge: Forge Workflow -->` block when the marker is absent and skips when it is already present; `hermit-evolve` handles replacement on upgrade.

---

## Step 6 — Knowledge-schema extension

Read `.hermit/knowledge-schema.md`.

Check for `deploy-incident:` in the file. If absent, append under `## Work Products`:

```
- deploy-incident: per-failure deployment record with scrubbed log tail and resolution. Producer: forge-deploy skill on a failed terminal deploy status. location: compiled/deploy-incident-<site>-<YYYY-MM-DD>.md
```

Use Edit. Skip if already present (idempotent).

---

## Step 7 — Stamp + register in config.json

Re-read `.hermit/config.json` now — the wizard has been running since Step 1 and the on-disk file may have changed. Apply the merges below to that fresh copy.

**Stamp version**: set `_hermit_versions["hermitd-laravel-forge"]` to `self_version` from Step 1's preflight.

**Merge the failed-deployment routine**

Merge these entries into `config.routines` by id. Create the array if absent. Append each missing id; skip any existing id, preserving operator edits and all other config fields. No prompt is needed for these read-only analyses.

```json
{"id": "forge-failed-deploys", "schedule": "5 9 * * *", "skill": "hermitd:reflect --check-id forge-failed-deploys --check hermitd-laravel-forge:forge-failed-deploys", "enabled": true}
```

Each routine owns its cadence and passes findings through reflection gates into the proposal pipeline.

**Register runtime dir**: ensure `config.storage_drift` exists and `config.storage_drift.ignore` is an array that includes `"forge-runtime"`. If the key is absent, add `"storage_drift": {"ignore": ["forge-runtime"]}`. If the array exists but does not include `"forge-runtime"`, append it. Skip if already present.

Write the updated `config.json` via Write tool (full file replacement for valid JSON).

---

## Native approval rules

Resolve the project settings target through `.hermit/bin/hermitd-run domain-hatch preflight hermitd-laravel-forge`. Map `target` (or `target_default` when absent): `local` to `.claude/settings.local.json`, `committed` to `.claude/settings.json`. Its `target_file` is the instruction destination, not the settings file.

Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/native-permissions.ts <resolved-settings-file>`. It prints `OK`; `{"status":"installed","deny_conflicts":[...]}` means existing operator denies override those asks, so name them in the final report. On `{"error":...}`, surface the error and stop.

## Step 8 — Final report

```
hermitd-laravel-forge {version} setup complete.

Installation summary:
  ✓ Prerequisite: hermitd {base_version} confirmed
  ✓ PHP 8.5+ found: {php_version}
  ✓ Composer found
  ✓ Forge SDK installed → .hermit/forge-runtime/vendor/
  ✓ .env: FORGE_API_TOKEN present, API check: ok
  ✓ .gitignore: .env covered
  ✓ CLAUDE.md: Forge Workflow block injected (or already present)
  ✓ knowledge-schema.md: deploy-incident type added (or already present)
  ✓ config.json: _hermit_versions stamped, forge-failed-deploys routine registered

Next steps:
  - Restart Claude Code so the updated CLAUDE.md loads.
  - Run /hermitd:hermit-routines load to activate the daily estate scan.
  - In Docker: the forge-runtime/ vendor is in your project tree (bind-mounted/persistent) — it survives container restarts.

Installed skills:
  /hermitd-laravel-forge:forge-servers        — list / detail / reboot servers
  /hermitd-laravel-forge:forge-sites          — list / detail sites
  /hermitd-laravel-forge:forge-deploy         — preview → approve → deploy
  /hermitd-laravel-forge:forge-logs           — read site / server / deployment logs
  /hermitd-laravel-forge:forge-failed-deploys — daily estate scan (daily routine)

Security reminder: FORGE_API_TOKEN is in .env — verify it is gitignored before any git push.
```

---

## Docker network requirements

Read by `/hermitd:docker-security` when the operator enables LAN containment + DNS policy.

### Domains (DNS allowlist)

- forge.laravel.com
- packagist.org
- repo.packagist.org
- api.github.com
- codeload.github.com
