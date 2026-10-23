# hermitd

A personal assistant that lives in your project: memory-driven learning, daily rhythm, idle agency, and operational hygiene for Claude Code.

This directory is a Claude Code plugin, not a standalone project. Operators install it from the marketplace (commands in `README.md`) and run `/hermitd:hatch` in the target project to create the state directory.

## Plugin structure

Standard Claude Code plugin layout (`agents/`, `skills/`, `hooks/hooks.json`, `scripts/`, `.claude-plugin/plugin.json`). The non-obvious dir is `state-templates/`: what `hatch` copies into a target project and `hermit-evolve` refreshes. Skills are namespaced `/hermitd:*`.

## Subagent delegation

The shipped hermit is main-as-orchestrator: the long-lived main session delegates a sub-step to an isolated-context subagent when the step's intermediate context dwarfs its conclusion, it needs no operator contact mid-flight, and main needs only the verdict. A dispatch costs the `CLAUDE.md`/`CLAUDE.local.md` re-seed plus at least two main turns at full context (dispatch and completion ingestion), so batch dispatches and keep trivial sub-steps inline. A delegated step returns a verdict plus an optional `operator_message`; main owns `AskUserQuestion` and operator notification. The operator-facing version is in `prompts/resident.md` § Rules.

## Per-project state

Installed state lives in the target project's `.hermit/`:

- `tasks/T-*.md` commitments, maintained through `scripts/task.ts`
- `proposals/PROP-NNN-<slug>-HHMMSS.md`
- `state/` machine state: runtime, alert and reflection state, metrics JSONL, monitor registry
- `raw/` domain inputs and `compiled/` durable domain outputs (injected at session start). Both flat, no subdirectories; `raw/.archive/` holds expired artifacts. Contract: [plugin-hermit-storage](docs/plugin-hermit-storage.md).
- `knowledge-schema.md`, `config.json`, and `OPERATOR.md` (operator-curated; the hermit edits OPERATOR.md only on operator request, behind the native approval prompt under Standard, and proposes a diff under Hardened)
- `bin/` lifecycle scripts, `docker/`, `HEARTBEAT.md`, `TASKS.md`; the full set is `state-templates/`

### State ownership under residency

A hatched folder can hold more than one session, so every state file has exactly one owner. `startup-context.ts` decides resident-vs-guest once per session and records the verdict with `lib/guest-marker.ts`; hooks read it with `isGuest(stateDir, payload.session_id)` (they run per turn with no model in the loop) and normalize payload IDs through `cc-compat.sessionId`.

- **Resident-owned**: liveness signals, context-reset stamps, operator-activity and open-turn markers, CC-payload snapshots, channel-control queues. Gate hook writes on the guest verdict; guest prompts skip resident channel-control stages and guest Stops do not drain resident commands. Startup seeds activity only after residency classification.
- **Folder-shared**: cost and usage logs retain guest provenance. Task records use the locked `task.ts` writer.
- **Session-keyed**: anything that must vary per session is keyed by session id, never a singleton.

## Hatch target routing

`scripts/domain-hatch.ts` owns target resolution and stamping for every consumer: core `hatch`, `hermit-evolve`, `docker-setup`, and every domain hatch. Routing derives from the plugin's install scope (`claude plugin list --json`): `local` → `.claude/settings.local.json`; `project` → `.claude/settings.json`; `user` or undetectable → the `.local` file. Advanced mode lets the operator override via the Visibility prompt. The result is stamped into `state/hatch-options.json` by `domain-hatch.ts` alone. Domain hatches reach it only through `.hermit/bin/hermitd-run domain-hatch <preflight|ensure-target> <plugin-id>`: `preflight` returns `target`/`target_file`/`target_default`/`needs_target_question` plus the version verdict, `ensure-target` records an operator override. `hermit-evolve` steps 6 to 8 are target-aware and will not re-add committed files after a `.local` migration.

## Migrations and feature defaults

Changes that must reach existing hermits (not just the template for new ones) go in `CHANGELOG.md` under that version's `### Upgrade Instructions`. `hermit-evolve` executes those steps, so write them as imperative steps. They write only to `.hermit/`, never into the plugin tree (the seeded `Edit(//**/.claude/plugins/**)` deny enforces it); plugin-side changes ship in the release. For `**Consumer scan:**` declarations, follow [Upgrade steps that change or remove what operators call](docs/creating-your-own-hermit.md#upgrade-steps-that-change-or-remove-what-operators-call).

New features ship enabled: set the default in `state-templates/config.json.template` so `hatch` gives it to new hermits, and write the Upgrade Instructions so `hermit-evolve` turns it on for existing ones, noting how to disable it. When you choose opt-in instead (credential, per-invocation spend, destructive), say why in the CHANGELOG.

## Authorship layers

An installed hermit belongs to its operator; they rewrite it and the plugin keeps working underneath. Two layers, different rules.

**Contracts (plugin owns, stay strict).** State-file schemas, hook exit codes and fail-open, the `hermitd-run` → `hermitd-exec.sh` verb path, hatch target stamping, deny patterns, the token/script-mediation boundary. Customization works because these are rigid. `hermitd-exec.sh` resolves a bare name to `$PLUGIN_ROOT/scripts/<name>.ts` or `<name>.sh` only, rejecting `*/*` and `*..*`, so a permission glob spanning `/` cannot drive it outside `scripts/`; that guard is load-bearing for the allow-list. There is deliberately no local-verb fallback: `bin/hermitd-run` is a resolver, not an operator-extensible table, and it is a state-template copy that `hermit-evolve` refreshes.

**Core depends on nothing downstream.** Sibling discovery is generic (`resolve-siblings.ts` matches name-contains-`hermit`) and core consumes generic metadata from each sibling's `hermit-meta.json`. Startup skill selection belongs to the operator; siblings never declare or set it. Naming a plugin as an example in a comment, doc, or `docker.recommended_plugins` entry is fine; conditioning behavior on it is not.

**Content (operator owns, stay loose).** Extension is declarative:

| Surface | What the operator can put there |
|---|---|
| `routines[]`, `boot_skill`, `shutdown_skill`, `monitors[]` | any skill string, including their own local plugins' skills |
| `config.env`, `docker.packages`, `docker.recommended_plugins` | arbitrary values |
| `OPERATOR.md`, `HEARTBEAT.md`, `knowledge-schema.md`, `docker/` | free-form rewrite; on-disk beats template (see the `hermitd-docker update` gotcha below) |

Above the contract line, give skills data + goal + voice and let the model compose; don't hardcode content, edge-case copy, checklists, or opinions about how the operator should work. Loose is not vague: a skill still states its goal and verdict shape precisely.

**Skill text describes the present, in a colleague's runbook voice.** The model reading a skill never saw earlier versions, so no version pins, issue or proposal IDs, or migration history ("no longer", "now automatic", "backwards compatible") in instruction text; that belongs in the commit, the CHANGELOG, or a code comment. State each rule once, in the file that owns it, and point at it from elsewhere. Plain declarative sentences: no shouting caps, no "think hard", one clause of why only where the model would otherwise be tempted. Name the audience instead of a length cap ("someone reading on a phone"). When a step's inputs already determine its answer, move it into a script and delete the step.

**The upgrade rule.** Anything operator-editable must survive `hermit-evolve`. A new operator-owned surface says in `### Upgrade Instructions` how existing edits are preserved, not just how the template changes.

## Development

Test locally against a target project from the repo root with `bun run dev <target-project>`, then `/hermitd:hatch`. `HERMIT_PLUGIN_ROOT` makes `hermitd-run` dispatch to the checkout. Unit tests: `bun test` from this directory; fixtures and hook checks in [docs/testing.md](docs/testing.md).

Preserve subprocess coverage for stdin, environment, exit-code, and side-effect contracts. Use explicit readiness/completion signals for process synchronization instead of fixed sleeps.

Constraints:

- **Runtime is Bun, no build step.** Hooks and scripts are `.ts` run directly by `bun`; skills are plain markdown. The minimum Bun version is `required_bun_version` in `.claude-plugin/hermit-meta.json`, read dynamically by `doctor-check` and the `hermitd-start` preflight; the Docker template pins its own `BUN_VERSION`, bump both together.
- **No runtime dependencies.** Shipped code imports only the standard library and Bun built-ins (`Bun.*`, `bun:*`, `node:*`). Root `package.json` is dev-only toolchain (`bunx tsc`, test fuzzing); nothing under `plugins/` imports from `node_modules` outside `*.test.ts`.
- **Hooks fail open on transient errors** (catch, exit 0) and read stdin to completion even when unused. Intentional policy gates may block through the hook's documented denial contract; preserve those decisions.
- **`prompts/resident.md` describes behavior, never config values or plugin paths** (routine schedules, channel user IDs, brief times, `permission_mode`, `agent_name`, `escalation`). Those load structurally from `config.json` every session start; restated values leak into the operator's `CLAUDE.md` and from there into OPERATOR.md prose. Naming a routine by `id` or its `enabled` state is fine.
- **`state-templates/config.json.template` is the source of default config.** Skills, `hatch` especially, overlay operator choices onto it rather than declaring a parallel default object in prose. `tests/template-skill-sync.test.ts` checks that every top-level template key is referenced by name in `hatch/SKILL.md`.
- **`SKILL.md` is what every invocation pays for; siblings are progressive disclosure.** Keep the path every run takes in `SKILL.md`; move what a branch needs only sometimes into a sibling (`reference.md`, `branches.md`) that the branch `Read`s by section. Trim prose before either.
- **Keep the script-mediation boundary.** State costs tokens only where it crosses into context: hook stdout, skill-driven `Read`s, helper-script output, and native tool results (`CronList` returning full prompt text per entry counts). Hooks and helpers print verdict-sized digests, never raw logs or state dumps. Skills never `Read` unbounded surfaces (`cost-log.jsonl`, `*.jsonl` event logs, the channel DB); front them with a script that returns a bounded summary (`cost-report.ts`, `heartbeat.ts precheck`, `lib/search.ts`). A fixed-line log tail is the ceiling, not the norm, and the wrong shape for per-period questions (reflect's cost-spike detector reads `state/cost-index.json` day totals because a 20-line tail of `cost-log.jsonl` spans one date on a busy install). Session-start injection (`startup-context.ts`, `generate-summary.ts`) is the largest recurring cost; a new section there must justify its per-session tokens against how often it changes behavior. No numeric budgets: this is a rule about where digestion happens, not a size quota.

## Debugging gotchas

- `read_only: true` on the hermit container breaks Claude Code's credential-refresh write path: hermits 401 with `Invalid authentication credentials` once the access token expires (~8h after `/login`) because the refresh write fails silently under the tmpfs / named-volume layout. Do not reintroduce without verifying refresh writes survive the layout.
- The hermit Ubuntu image has no `strace`, and `apt install` is blocked while `read_only: true` is on. For fs/network tracing inside hermit use `NODE_DEBUG=fs,http,https,net,tls claude ...`.
- Netguard enforce mode is authoritative (verified live, dnsmasq 2.92): with `no-resolv` + `--conf-file`, unmatched queries NXDOMAIN and are never forwarded. The `forwarded <host> to 127.0.0.11` lines in `docker logs <stack>-hermit-netguard-1` come from log-only mode, which forwards everything by design. Static `address=/host/ip` allowlist records are honored in both modes (`dnsmasq.allowlist.template`).
- `grep` with no match breaks `&&` chains in diagnostic one-liners and silently truncates the rest; use `; grep ... || true` when continuation matters.
- `hermitd-docker update` builds from the on-disk Dockerfile, compose file, and entrypoint. Upgrade Instructions for those templates name `hermit-evolve` as the refresh path. Update waits for evolve before building, so the merged files apply at its one quiet restart.
