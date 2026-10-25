# Changelog — laravel-forge-hermit

## [0.0.23] - 2026-10-25

### Changed
- Hatch matches existing routines by full skill string or namespaced id and assigns new rows `hermitd-laravel-forge:` ids, preserving existing operator fields. Requires hermitd 1.4.21.

### Upgrade Instructions
1. Run `.hermit/bin/hermitd-run settings-edit .hermit/config.json migrate plugin-routine-ids --plugin hermitd-laravel-forge --ids forge-failed-deploys` and report the receipt.

**Leftover check:** The operator's own files may still refer to the routine id `forge-failed-deploys`, which this release renamed to `hermitd-laravel-forge:<id>`. Find those references, ask once before changing anything, and update each to the new id.

## [0.0.22] - 2026-10-22

### Fixed
- Upgrades also list operator scripts and routine checks that still read the old `forge.php` output.

### Upgrade Instructions
1. Find `forge.php` invocations that branch on the pre-0.0.20 output shapes listed in 0.0.20 Upgrade Instructions item 1. Look in the project's `.claude/skills/`, `.claude/commands/` and `.claude/agents/` (including bundled scripts of any language), `routines[].precheck` and `monitors[].command` in `.hermit/config.json`, hook commands in `.claude/settings.json` and `.claude/settings.local.json`, and `.hermit/dashboard-render.ts`. Skip gitignored files, `.claude/worktrees/`, nested repositories, backups, plugin directories, and lines already listed by 0.0.20 item 1 in the same run. A line that only checks a real failure's exit code is not a hit. Never edit files here. Skip silently when none remain. Otherwise list the hits with file and line and defer per core's hermit-evolve Step 10 with `options: ["Fix them", "Leave them"]` and no `on_resolve`:
   - *Fix them*: update each line to the shape the Forge skill running the same command describes. Report each file changed.
   - *Leave them*: change nothing and say those lines misread `forge.php` output until updated.

## [0.0.21] - 2026-10-19

### Changed
- Hatch no longer writes an instruction block into `CLAUDE.md`; the plugin's skills, agents and hooks carry its guidance. Requires hermitd 1.4.17.

### Fixed
- `forge.php check` reports a rejected or forbidden (403) token as `invalid` instead of `unreachable`
- `forge.php failed-deploys` pauses after a rate-limited deployment fetch

## [0.0.20] - 2026-10-17

### Changed
- Requires core `>=1.4.16`, whose `domain-hatch` prints one JSON object.
- `forge.php` commands print one JSON object, including `policy` and `failed-deploys` (which drops its `--json` flag and prose mode); errors are `{"error":"<token>"}` on stdout, and policy denials, plan refusals and unmatched or ambiguous names are `status` outcomes at exit 0
- `native-permissions.ts` prints `OK` or one JSON object instead of prose and uncaught throws

### Fixed
- `/hatch` relays `next_steps` when core needs bootstrapping and the `remedy` when core is below the floor. A refused block sync names the file with the duplicate marker.
- `forge.php --help` exits 0
- Scrubbed `forge.php` output redacts double-quoted values in JSON-encoded results, single-quoted values, and literal credentials on `composer config` auth lines.

### Upgrade Instructions

1. **Offer to migrate operator skills to the helper-output convention.** Look only in the project root's `.claude/skills/` and `.claude/commands/`; skip `.claude/worktrees/`, nested project repositories, backups and plugin directories. List each skill line that runs a `hermitd-laravel-forge` helper through this plugin's install path and branches on its old output: `forge.php check` read as a bare `ok`/`missing`/`invalid`/`unreachable` word, `Deployment started:` or `key=value` text, a bare `deploy-status` word, a `Plan:` preview block, `servers`/`sites` columns, `No ... matching` or `Ambiguous` text, `(no deployments found)`, `policy` or `failed-deploys` text, or a non-zero exit from a policy refusal or an unmatched name. A line about the project's own script output, a placeholder, or a call that only checks the exit code of a real failure is not a hit. Skip silently when there are none. Otherwise show them with file and line, and **defer per SKILL.md Step 10** with `options: ["Migrate them to the convention", "Keep them as they are"]`, no `on_resolve`; the chosen branch is applied in attended Step 10 only:
   - *Migrate them to the convention*: update each line to the shape the `hermitd-laravel-forge` skill running the same command describes, per core's `docs/creating-your-own-hermit.md` § Helper-script output. Report each file changed.
   - *Keep them as they are*: change nothing, and tell the operator that these lines misread `hermitd-laravel-forge` output until they are updated.

## [0.0.19] - 2026-10-02

### Changed
- The plugin is named `hermitd-laravel-forge` in the `hermitd` marketplace, with namespaced skills and core commands updated to match.

## [0.0.18] - 2026-09-28

### Fixed

- Installed instructions use `forge.php` on the plugin PATH, preserving the caller’s project directory.

## [0.0.17] - 2026-09-25

### Added

- Hatch installs a native `Edit(.env)` deny, so the agent cannot lift Forge policy tiers through `.env`.

### Removed

- Plugin-root `settings.json` permission list, which Claude Code never applied; native rules are installed into project settings.

### Upgrade Instructions

Set `DOMAIN_PLUGIN_ROOT` to this installed plugin's absolute directory and re-run the native-permissions installer from the project root. It adds the `Edit(.env)` deny to the resolved project settings file and preserves existing operator rules.

```bash
native_settings=$(.claude-code-hermit/bin/hermit-run domain-hatch preflight laravel-forge-hermit | bun -e 'const p = await Bun.stdin.json(); if (!p.ok || !["local", "committed"].includes(p.target)) throw new Error("Resolve the domain hatch target first"); console.log(p.target === "local" ? ".claude/settings.local.json" : ".claude/settings.json");') &&
bun "${DOMAIN_PLUGIN_ROOT:?Set the installed plugin directory}/scripts/native-permissions.ts" "$native_settings"
```

## [0.0.16] - 2026-09-16

### Changed

- Core 1.4.0 is required for task records and resident startup.
- Deploy watches use resident readiness and routine registrations omit retired lifecycle fields.

## [0.0.15] - 2026-09-10

### Changed

- Deploy, reboot, and plan execution use native approval without confirmation flags or a duplicate hook.
- Permission installation uses one repeatable operation without migration markers.

### Upgrade Instructions

Before using the updated write commands, set `DOMAIN_PLUGIN_ROOT` to this installed plugin's absolute directory and run the following from the project root. Prepare `NATIVE_APPROVAL_BLOCK` as a temporary Markdown file containing the updated `state-templates/CLAUDE-APPEND.md` block merged with any operator edits from the installed block (`target_file` in preflight). Preserve those edits and the marker pair; the refresh replaces only this marked block, leaving surrounding project instructions intact. The installer preserves operator settings and denies. Existing migration marker files may remain; they are no longer used.

```bash
native_settings=$(.claude-code-hermit/bin/hermit-run domain-hatch preflight laravel-forge-hermit | bun -e 'const p = await Bun.stdin.json(); if (!p.ok || !["local", "committed"].includes(p.target)) throw new Error("Resolve the domain hatch target first"); console.log(p.target === "local" ? ".claude/settings.local.json" : ".claude/settings.json");') &&
bun "${DOMAIN_PLUGIN_ROOT:?Set the installed plugin directory}/scripts/native-permissions.ts" "$native_settings" &&
.claude-code-hermit/bin/hermit-run domain-hatch sync-block laravel-forge-hermit --rendered-stdin < "${NATIVE_APPROVAL_BLOCK:?Set the merged temporary block file}"
```

Remove obsolete confirmation flags from operator-maintained command examples. Direct CLI execution outside Claude Code has no confirmation-only checkpoint. Validation and policy denials remain; Forge also retains request matching, expiry, and single-use plans.

## [0.0.14] - 2026-09-07

### Fixed
- Forge validation failures now include scrubbed field-level error details in generic read and write output.

### Changed
- Failed-deployment scans run as an ordinary daily routine. Core 1.3.3 is required.

### Upgrade Instructions

1. Complete core's periodic-check conversion first.
2. Re-read `.claude-code-hermit/config.json`. Append each of the following routines only when its id is absent from `config.routines`. Preserve every existing routine, including custom schedules, model pins, and disabled entries.
   ```json
   {"id": "forge-failed-deploys", "schedule": "5 9 * * *", "skill": "claude-code-hermit:reflect --check-id forge-failed-deploys --check laravel-forge-hermit:forge-failed-deploys", "run_during_waiting": true, "enabled": true}
   ```
3. Save the config and run `/claude-code-hermit:hermit-routines load`.

## [0.0.13] - 2026-09-06

### Changed
- `hatch` Step 3 no longer reads `.env` at all (previously via `Read`, to check the key was present); credential verification is fully deferred to `forge.php check` in Step 4.

## [0.0.12] - 2026-08-31

### Changed
- `hatch` is operator-invoked only through `disable-model-invocation`. If core is not initialized, it prints `/claude-code-hermit:hatch` for the operator to type instead of offering to run it.

## [0.0.11] - 2026-08-14

### Fixed
- Guzzle `7.15.2` hardens request-host validation, cookie-domain matching, and derived `Host` regeneration.

## [0.0.10] - 2026-07-30

### Added
- `forge.php preview <method>` and `forge.php execute <plan-id>` — a request-bound write path for any SDK method. `preview` runs the SDK against a capture-only Guzzle handler, so it gets the exact outbound HTTP request without sending it, then stores that request under a SHA-256 as a single-use plan expiring in 15 minutes. `execute` re-derives the request from the stored plan and refuses unless it still hashes the same, so an edited payload, a reused plan or a stale window sends nothing.
- `forge.php policy` prints what is reachable, which deny tiers are active, which `.env` lifts are in effect, and any warnings. Runs with no credentials and no network.
- Output scrubber on everything `call` and `execute` print — `KEY=`/`PASSWORD=`/`*_TOKEN=` assignments, `Bearer` blobs, PEM blocks, credentials in connection URLs, and long high-entropy strings become `[REDACTED]`. Log-reading methods return free-form text, which no method-name policy could ever cover.
- `forge.php check` reports an active policy lift alongside the credential state.

### Changed
- Generic dispatch reaches the whole SDK minus two deny tiers instead of a hand-maintained ~100-entry read allowlist. The Forge API token is what authorizes an operation; this plugin owns autonomy and context hygiene. `secrets` (methods returning credential material) and `destructive` (captured verb `DELETE`) stay denied unless the operator lifts them in `.env`.
- Reachability is now derived from the installed SDK rather than listed. `isEndpointMethod()` classifies by declaring file, which covers all 11 non-endpoint publics including `setApiKey` and the raw transports; `takesOrgFirst()` decides org prepending by reflection, fixing 19 endpoint methods that a one-name exemption list would have called with the org shifted into their first argument.
- Destructive operations are classified by the captured HTTP verb, not a name prefix. `disableQuickDeploy` and `disablePushToDeploy` issue `DELETE` without a `delete` prefix and were previously unclassifiable.
- `serverKey`, `deployKey` and the `storageProvider*` reads are explicitly allowed. All three are public keys or metadata per the SDK's own docblocks and field lists.
- Org resolution is lazy for generic dispatch, so `policy` and org-less methods no longer pay for or depend on an org lookup.
- `deploy`, `server-reboot` and their previews are unchanged, `--confirm` included. Their two layers are still the hook plus the in-PHP flag check; the generic write path's two layers are the plan hash and the operator's approval.

### Fixed
- `forge.php call <method>` walks every page of a paginated result instead of printing only the first. An estate larger than one page was silently reported as truncated.

### Upgrade Instructions

1. Nothing to migrate — no state format changed, and no new file is created until the first `preview`.
2. Generic dispatch now reaches SDK methods that were previously unreachable. If you want a narrower surface than the shipped tiers, add `{"deny": ["<method>", "<prefix>*"]}` to `.claude-code-hermit/forge-policy.json`. Treat it as a reminder to the agent, not a boundary: the agent is permitted to edit that file.
3. To let this hermit delete Forge resources or read credential-bearing endpoints, add `FORGE_POLICY_ALLOW_TIERS=destructive` (and/or `secrets`), or `FORGE_POLICY_ALLOW=<method>,<method>` for named methods only, to `.env` in the project root. Both are off by default. `.env` is operator-only — the agent cannot edit it.
4. Run `php <plugin>/php/forge.php policy` to confirm the effective boundary after upgrading.

## [0.0.9] - 2026-07-26

### Added
- `forge.php deploy-watch <server-id> <site-id> <deploy-id>` replaces the hand-transcribed watch loop in `forge-deploy`; terminal statuses now come from the shared `STATUS_*` constants. `deploy` points at it in its `Watch with:` hint, and a failing poll now emits the exception class as a watch event instead of surfacing only as a `status=timeout` 15 minutes on.

### Changed
- `hatch` reads the required core version from `.claude-plugin/hermit-meta.json` at runtime via `domain-hatch preflight`, instead of the hardcoded `1.1.1` floor its prose carried. That floor sat many minor versions below what the manifest declared, so the wizard proceeded against a core too old for it. The PHP 8.5 floor is unaffected and still checked in Step 2.
- Target resolution and CLAUDE-APPEND writing are delegated to core: `domain-hatch preflight laravel-forge-hermit` resolves the target, `ensure-target` records an operator override, `sync-block` writes the block. The skill no longer detects install scope from `claude plugin list --json` or stamps `hatch-options.json`.
- `hatch` re-reads `config.json` immediately before merging its scheduled check, runtime-dir registration and version stamp, instead of reusing the copy it loaded before the wizard ran. Anything written to the file during the wizard is no longer clobbered.
- Requires core `>=1.2.34` for the shared `domain-hatch` protocol. `bin/hermit-run` resolves a script by bare filesystem probe, so pairing this version with an older core fails with a misleading "plugin may predate this command" error.
- The CLAUDE-APPEND block keeps the surface-then-approve rule and the outage warning but drops the restated 4-step walk (`forge-deploy` and `forge-servers` own it), two of three `call` examples, and the `forge-failed-deploys` contract. 2,993 B → ~2,265 B. Enforcement is now stated accurately: the hook and the in-PHP gate are two layers with the PHP gate authoritative, replacing "neither can be bypassed".
- `[hygiene]` and `[deploy-safety]` proposal prefixes removed — no skill produces either, so both were vocabulary paid for in every session. `[reliability]` remains.

## [0.0.8] - 2026-07-21

### Fixed
- No-op `Write(<path>)` allow rules were removed from `settings.json`; their `Edit(...)` equivalents still grant access and avoid the boot warning.

## [0.0.7] - 2026-07-15

### Added
- Log access for apps running as Forge background processes through `background-process-log <server> <process-id>` and `backgroundProcessLog` (#606).
- Previously unreachable site logs through `site-log <server> <site> <type>` for `application`, `nginx-access`, and `nginx-error`.
- 43 SDK detail, output, and config read methods in the allowlist, while secret-bearing reads remain excluded and test-enforced.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. No further action needed — the new log commands are picked up from the plugin install path on the next session.

No config.json changes required.

## [0.0.6] - 2026-07-10

### Fixed
- `server-log <server> php` now resolves the server's PHP-FPM log key, such as `php-8.3`, from `php_version`.
- Missing `server-log` keys now show a readable message instead of throwing an uncaught exception.

## [0.0.5] - 2026-07-03

### Changed
- The `forge-failed-deploys` skill now names `reflect --scheduled-checks`, the surviving core invocation; the scheduled-check behavior is unchanged.

## [0.0.4] - 2026-06-26

### Fixed
- Hatch now idempotently adds `forge-runtime` to `config.storage_drift.ignore`, preventing false storage-drift reports for the Composer vendor tree. Requires `claude-code-hermit` 1.2.12 or later.
- Nginx `server-log` keys use hyphens: `nginx-error` and `nginx-access`; underscored variants return 404.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Register `forge-runtime` in `storage_drift.ignore`.** Read `.claude-code-hermit/config.json`. If `storage_drift.ignore` is absent or not an array, add `"storage_drift": {"ignore": ["forge-runtime"]}` at the top level. If it is already an array but does not contain `"forge-runtime"`, append it. Write the updated file.

No other `config.json` changes required.

## [0.0.3] - 2026-06-24

### Fixed
- Hatch writes a state marker before delegating to core, which automatically resumes this skill without a manual rerun. Requires `claude-code-hermit` 1.2.11 or later.

## [0.0.2] - 2026-06-23

### Fixed

- The Forge API token URL now uses `/profile/api` instead of `/user-profile/api`, including the `forge.php` “no orgs found” error.
- Hatch now shows the domain-resume instruction before invoking core, so the terminal action does not drop Step 2.

### Upgrade Instructions

Run `/claude-code-hermit:hermit-evolve`. The evolve skill handles:

1. **Refresh the laravel-forge hermit plugin** — `/claude-code-hermit:hermit-evolve` pulls the updated skill and script.

No `config.json` changes required.

## [0.0.1] — 2026-06-22

### Added

- A pure-PHP `forge.php` dispatcher over `laravel/forge-sdk` v4, with closed-allowlist reads, previews, `--confirm`-gated writes, deploy polling, and estate-wide failed-deploy scans.
- A fail-open `write-confirm-gate` PreToolUse Bash hook that blocks `deploy` and `server-reboot` without `--confirm`.
- Six skills: `hatch`, `forge-servers`, `forge-sites`, `forge-deploy`, `forge-logs`, and `forge-failed-deploys`.
- Non-blocking `forge-deploy` watches through `/claude-code-hermit:watch`, polling `deploy-status` and relaying terminal outcomes through the Operator Notification protocol.
- A daily analysis-only `forge-failed-deploys` check using `organizationSites()->lazy()` that routes `[reliability]` proposals.
- A scrubbed failed-deploy log artifact at `compiled/deploy-incident-<site>-<date>.md`.
- Vendor-free shipping with `composer.json` and `composer.lock`; Hatch installs the SDK with `--no-dev` into `<project>/.claude-code-hermit/forge-runtime/`.
- Docker support in `DOCKER.md` for `php-cli`, `php-curl`, and `composer`, plus Forge and package-registry DNS allowlists on Ubuntu 26.04 LTS.
