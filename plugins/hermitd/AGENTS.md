# Core Hermit

The continuously running layer inside Claude Code owns lifecycle, scheduling, channels, learning, and upgrades. `state-templates/` seeds installed project state; the plugin tree and the operator's `.hermit/` are separate ownership domains.

## State and lifecycle

- `state/runtime.json` owns process lifecycle; `state/execution.json` records harness execution and `tasks/` holds commitments written through `task.ts`.
- Every state write needs an owner: resident-only, folder-shared, or session-keyed. `scripts/startup-context.ts` classifies residency; hooks use `scripts/lib/guest-marker.ts` and normalize payload session IDs through `scripts/lib/cc-compat.ts`.
- Guests must not update resident liveness, operator activity, open-turn markers, reset stamps, task bindings, or channel-control queues. Shared cost/usage records retain guest provenance.
- Task record writes use the task writer lock. Do not add an unlocked record mutation path.
- A registered monitor or old fired event is not liveness. Preserve boot/runtime ownership and real liveness checks when changing startup, recovery, or scheduling. Read [architecture](docs/architecture.md) for the ownership boundaries.
- Treat `startup-context.ts` as a high-impact hook: preserve guest/resident side effects and startup/resume/clear/compact output contracts, and justify any recurring context injection.

## Installed state and upgrades

- `state-templates/config.json.template` owns defaults. Hatch overlays operator choices rather than declaring another default object in skill prose. Update the hatch references checked by `tests/template-skill-sync.test.ts` when adding a field.
- `OPERATOR.md`, `HEARTBEAT.md`, `knowledge-schema.md`, and declared configuration extension points are operator-authored. Preserve custom skill strings, routine prompts, Docker packages, and existing edits through upgrades. `OPERATOR.md` has its own approval boundary; it is not a machine-maintained config cache.
- `bin/hermitd-run` resolves shipped verbs through `scripts/hermitd-exec.sh`. Its bare-name/path rejection is part of the permission boundary. Do not introduce local-verb fallbacks or an operator-extensible dispatch table.
- Before exposing script arguments through a sealed permission grant, read [Script Argument Trust](docs/security.md#script-argument-trust). Bind state targets to the current project and preserve path containment checks. Native auto-mode classification is separate from the sealed allow-list.
- Template changes alone do not migrate operator-editable files. Document the installed-state migration and preservation behavior in Upgrade Instructions.

## Shipped agent workflows

The resident handles operator contact. Isolated workers return a verdict or composed operator message to it. Use delegation where the intermediate context materially exceeds the result, and account for dispatch/completion turns; trivial bookkeeping belongs in a script or the current turn. The installed workflow contract is in `prompts/resident.md`, not this development guide.

## Runtime and Docker changes

- Read the Bun floor from `.claude-plugin/hermit-meta.json` (`required_bun_version`). Keep the Docker template's `BUN_VERSION` aligned when raising it.
- `hermitd-docker update` builds from the on-disk Dockerfile, compose file, and entrypoint. Template upgrade instructions must refresh/merge them through `hermit-evolve` before rebuilding.
- Do not reintroduce container `read_only: true` without proving Claude's credential-refresh writes work with the volume/tmpfs layout.
- Netguard log-only mode forwards unmatched DNS; enforce mode blocks it. Preserve that distinction and static allowlist records when changing the entrypoint. See [Docker security](docs/docker-security.md).

Preserve subprocess coverage for stdin, environment, exit-code, and side-effect contracts. Use explicit readiness/completion signals for process synchronization instead of fixed sleeps. For fixtures and hook checks, use [testing guidance](docs/testing.md).
