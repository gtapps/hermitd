# hermitd-laravel-forge

A Laravel Forge domain layer for `hermitd`: deployment skills, server/site management, estate health monitoring, and a daily failed-deployment scan, all over the official `laravel/forge-sdk` PHP v4.

## Structure

- `skills/`: `hatch`, `forge-servers` (list, detail, reboot flow), `forge-sites`, `forge-deploy` (preview → approve → deploy; failure → deploy-incident artifact), `forge-logs` (deployment + server logs, triage mode), `forge-failed-deploys` (daily scheduled estate scan, analysis-only). `tests/skill-structure.test.ts` pins the `SKILLS` list; a new skill goes there too.
- `php/forge.php`: dispatch script: curated commands, generic dispatch, native approval
- `php/forge-operation.php`: the write gateway: request capture, canonicalization, plan store, hash-checked execution
- `php/forge-lib.php`: derived predicates (`isEndpointMethod`, `takesOrgFirst`), deny tiers, policy loading, output scrubber
- `php/composer.json` + `php/composer.lock`: shipped; `php/vendor/` is gitignored
- `state-templates/CLAUDE-APPEND.md`: Forge Workflow block injected by hatch; `DOCKER.md`: apt deps + DNS allowlist for `/docker-setup`

## Architecture

Hatch registers the `forge-failed-deploys` routine with `reflect --check-id forge-failed-deploys --check hermitd-laravel-forge:forge-failed-deploys`; its cadence lives in `config.routines`.

The agent calls `forge.php <command>` directly via Bash. The SDK handles all HTTP: no hand-rolled API client, no bun CLI, no bridge process. The vendor tree is not committed; hatch installs `laravel/forge-sdk` `--no-dev` via Composer into the consumer project's `.hermit/forge-runtime/vendor/` (persistent, bind-mounted in Docker, isolated from the app's own Composer files).

## Rules

- **Surface-then-approve on every write.** Preview first, relay the canonical target, invoke the execution command for native approval. No exceptions.
- **Write approval.** Curated deploy/reboot and generic plan execution use Claude Code native approval. Generic execution also re-captures the request and enforces its hash, expiry, policy, and single use.
- **Never echo, cat, or Read `.env`.** Check credential state with `forge.php check` (one JSON object; branch on `status`: `missing`, `invalid`, `unreachable`, or `ok`).
- **Deployment and server logs may contain secrets.** Scrub before relay and before persistence (the CLAUDE-APPEND secret-hygiene rule).
- **Generic dispatch reaches the whole SDK minus two deny tiers** (`secrets`, `destructive`), because the Forge API token is what authorizes an operation; this plugin owns autonomy and context hygiene, not authorization. Reads go through `call`, writes through `preview` → approval → `execute <plan-id>`. Reachability is derived from the installed SDK by reflection and from the captured HTTP verb, never from a hand-maintained list. `forge.php policy` prints the effective state.
- **`php/forge-operation.php` is the security-critical file.** Capture, canonicalization, plan storage, and the hash check live there, with no CLI parsing or output formatting, so `php/tests/run.php` drives it directly. Its Blocks A and B run first in the suite for a reason: if the captured request is not what the SDK would really send, every other guarantee is decorative.

## Hatch target routing

Core's `scripts/domain-hatch.ts` owns target resolution and `hatch-options.json`. `/hatch` Step 1 runs `.hermit/bin/hermitd-run domain-hatch preflight hermitd-laravel-forge`; Step 5 records any override with `domain-hatch ensure-target hermitd-laravel-forge --target <choice>` and writes the block with `domain-hatch sync-block hermitd-laravel-forge`.

## Development

From the repo root, `bun run dev <target-project>`, hatch core, then `/hermitd-laravel-forge:hatch`. Tests: `bash tests/run-all.sh` from this directory, with PHP and Composer available; the runner installs the SDK fixture into `php/vendor/` itself, then runs `php/tests/run.php`, the CLI and permission tests, and the structural lints separately. Plain `bun test` is not a substitute: the structural files call `process.exit()` and can end its runner early.

The native-permissions installer adds missing project ask rules and the `Edit(.env)` deny without changing operator settings.
