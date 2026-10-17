# Routine Authoring

How to convert a costly, broad-context routine into a purpose-built scoped skill — sometimes
called a "**-light skill**" (e.g. `inbox-check-light`) — the pattern that separates a cheap
always-on routine from an expensive one.

---

For the config schema and registration mechanics (linked again under **Where this fits**
below), see [Config Reference § Routines](config-reference.md#routines) and
`skills/hermit-routines/SKILL.md`. This doc covers the authoring decision those references
don't: *when* a routine needs a scoped skill instead of a broad one, and how to build it.

## Plugin checks

A periodic plugin check is an ordinary routine, for example:

```json
{"id":"my-check","schedule":"5 9 * * 1","skill":"hermitd:reflect --check-id my-check --check my-plugin:my-audit-skill","enabled":true}
```

The wrapper invokes exactly that skill, with all arguments after `--check` passed verbatim. Actionable or contextual findings become one candidate with `Evidence Source: scheduled-check/my-check` and `Sessions: none`, routed through judge, triage, and the existing approval path. Quiet results produce no proposal. The routine owns cadence, model pins, and optional pre-wake gating; `scheduled_checks` is only for task-completion checks.

## When a routine needs this pattern

A routine has a cost signature worth fixing when it:

- Runs frequently (daily or more) and shows up as a high-\$/run line — `/hermitd:hermit-doctor`'s
  `routine-cost` check flags it automatically (a routine whose \$/run exceeds both 3× the peer
  median and `doctor.routine_cost_floor_usd`), or scan `.claude/cost-log.jsonl` /
  `/hermitd:cost-reflect` by hand. Both sides of \$/run come from cost rows stamped
  `source_attribution_version: 2`; rows written before the attribution fix are ignored, so a
  freshly-upgraded hermit reports "insufficient history" until a routine has 3 clean fires
  (about 3 days for a daily routine, ~3 months for a monthly one). Subagent rows and the turn
  that ingests a subagent-completion notification add cost to the routine without adding a
  fire, so a delegating routine's \$/run reflects its whole delegated cost.
- Invokes a broad, `/resident-start`-style skill that loads a lot of context (recovery matrices,
  full state reads, conversational framing) to answer one narrow question ("is there anything to
  do?", "did this threshold cross?", "is this file stale?").
- Runs at the session model (no `model` override) even though its decision doesn't need the
  live conversation — it's stateless and self-contained.

None of this means every routine should be scoped. Routines whose value *is* the chat output —
a morning brief, an evening summary — need the live session and full prose; converting those
loses the thing they're for. Scope the routines that make a small decision, not the ones that
produce a report.

## The conversion checklist

1. **Author a purpose-built scoped skill** that reads only the state its decision needs, instead
   of reusing a broad skill built for interactive `/resident-start` entry. A scoped skill is small
   on purpose — it exists to answer one question, not to onboard a session.

2. **Pin it to haiku** via the routine's optional `model` field
   (`skills/hermit-routines/SKILL.md`, "Model-override substitution"). Setting `model` dispatches the skill to an isolated
   subagent (via the Agent tool) instead of running it in the live session — no session
   conversation is inherited, only filesystem access. Two shipped defaults already do this:
   `doctor` is `"model": "haiku"` in
   `state-templates/config.json.template`. Never set `model` on `heartbeat-restart` — its re-arm
   append must run in-session, and `load` ignores the override there regardless.

3. **Return a verdict line, not transcript prose.** A dispatched routine's subagent "returns only
   a one-line status" (`skills/hermit-routines/SKILL.md`, "Model-override substitution", and the `model` Notes entry in the sibling `reference.md`) — design the
   scoped skill's output around that from the start, rather than writing a skill that produces
   rich output and then truncating it.

4. **Add a deterministic precheck script when the gate doesn't need the model at all.** If the
   decision "is there anything to do here?" can be answered in bash — a file's mtime, a threshold
   comparison, a hash — write a precheck script that prints one token and exits 0, and only load
   the skill body on the branch that needs it. The shipped archetypes:
   - `scripts/heartbeat.ts precheck`; emits `SKIP|<reason>`, `OK`, or `EVALUATE`.
     Only `EVALUATE` loads the heartbeat skill body.
   - `scripts/reflect-precheck.ts`: emits status `empty` or `run` with its due `phases`. On `empty` the precheck itself
     owns the audit trail (updates `reflection-state.json`, appends the Progress Log line) so
     reflect's skill body never loads on a no-op day.

   **Declare it as the routine's `precheck` and the check runs before the wake, not after it.**
   Set `"precheck": "tools/your-gate.sh"` (project-relative) on the routine entry: the routine
   monitor runs it at fire time, in its own subprocess, and a first stdout line of `SKIP` consumes
   the fire and stamps `skipped-precheck` without waking the session at all — zero tokens, and the
   skip still counts as a run in `routines.ts health`. `WAKE`, a non-zero exit, unparseable output,
   or the timeout (`precheck_timeout_s`, default 30s, max 300) all fire the routine exactly as an
   ungated one would; a failure stamps `precheck-error` with the reason, and the `routine-precheck`
   doctor check surfaces a gate that has never succeeded. Three builtins ship: `"precheck": "reflect"` (cadence), `"precheck": "doctor"` (findings owed to the operator), and `"precheck": "later"` (due claims or open records with results and checks).

   Rules for the script: **verdict only** — nothing it prints reaches the session, so a gate that
   found work hands nothing over; the skill re-queries its own source using the `ROUTINE_LAST_FIRED`
   env var (ISO timestamp of the last successful fire, empty on the first, meaning "everything is
   new"). It also gets `HERMIT_DIR`, `ROUTINE_ID`, `PATH`, and, when set, `HOME`, `LANG`,
   `CLAUDE_CONFIG_DIR`, and `HERMIT_PLUGIN_ROOT`. No other monitor variables are forwarded;
   secrets belong in a file the script reads, not in the monitor's env. Keep it read-only and cheap:
   mutation belongs in the skill, which only runs when the gate says so. Declaring a gate from chat
   raises Claude Code's native permission prompt (see [`docs/security.md`](security.md) § Settings from chat).
   In CronCreate fallback mode the gate still runs, but after the
   wake: same behavior, no token saving.

   Where a gate is not declared, the older in-prompt pattern still works — run the script from the
   routine's execution prompt and branch on its line, the way `hermit-routines` does for its `reflect`
   special case (`skills/hermit-routines/SKILL.md`, Shared execution semantics). That saves the skill
   body, but not the wake.

Applying all four steps turns a routine that always pays for a full skill load and a session-model
turn into one that usually costs a single cheap bash check, and only pays for the skill (at
haiku, in an isolated subagent) on the ticks where there's actually something to decide.

## Worked example

A content/marketing hermit ran a revenue-tracking routine daily through a broad skill that
re-derived its answer from a wide state read every time — no session-model override, no precheck.
Its \$/run was a clear outlier against the hermit's other "light" routines (illustrative figures:
roughly \$15/run against a fleet median near \$0.40/run for comparable routines).

Applying the checklist:

- Replaced the broad skill with a scoped one that reads only the specific state slice the
  decision needs.
- Pinned `model: "haiku"` on the routine, moving the run into an isolated subagent.
- Changed the skill's return to a single verdict line instead of a narrative summary.
- Added a precheck script ahead of it for the common "nothing changed since last run" case, so
  most ticks never load the skill body at all.

Before, in `config.json`:

```json
{ "id": "monthly-revenue", "schedule": "0 8 * * *", "skill": "hermitd:resident-start" }
```

After — a scoped `-light` skill, haiku-pinned, no session entry:

```json
{ "id": "monthly-revenue", "schedule": "0 8 * * *", "skill": "revenue-check-light", "model": "haiku" }
```

`revenue-check-light/SKILL.md` reads only the revenue ledger slice it needs and returns one line
(`"no change since last run"` or `"revenue crossed $X — notify"`) instead of onboarding a full
session.

The routine kept its behavior and schedule; the \$/run dropped by roughly two orders of magnitude
because most fires now resolve in a bash precheck, and the ticks that do need a decision run a
narrow haiku subagent instead of a broad session-model skill.

## Declaring a routine's output — the exception, not the rule

**Most routines should not declare one.** `expect_artifact` is a receipt for a narrow class of
routine, not a step in the checklist above, and reaching for it by default is how a hermit stops
being an agent that decides what's worth doing and starts being a scheduler that must produce a
file to be considered working. Do not shape a routine around having a declarable output.

It fits exactly one shape: **a single file, at a path known before the run starts, written on
every run.** A routine that does not match all three should leave the field unset and keep the
legacy behavior. Disqualifying cases, all legitimate:

- the routine's value is what it says in chat — a morning brief, an evening summary
- the output is variable — zero, one, or many files depending on what upstream returned
- the filename depends on what the run found, rather than on the date
- it updates a living page in place (`compiled/topic-<slug>.md`) chosen at runtime
- the routine's real job is a decision, not an artifact — most `-light` skills are in this group

Where it does fit, set the exact path:

```json
{ "id": "calendar-fetch", "schedule": "0 6 * * *", "skill": "calendar-fetch-light",
  "model": "haiku", "expect_artifact": "raw/snapshot-calendar-{date}.md" }
```

`routines.ts finish` then records `fired` only when that file actually changed during the run, and
`failed-artifact-missing` / `failed-artifact-unchanged` otherwise, notifying the operator. Exact
paths only (no globs), one optional `{date}` token, resolved in `config.timezone` at fire start.
Two enabled routines may not declare the same path.

Why it exists: a scoped skill dispatched to a subagent returns one line of self-report, and that
line used to be the only evidence the fire succeeded — a subagent that wrote nothing, or wrote to a
cwd-relative path outside the state dir, still reported success and still logged `fired`.

This is a receipt, not a substitute for the skill writing correctly. The skill should still write
atomically and validate its own output before returning; the declaration only catches the case
where it didn't and said otherwise.

## Where this fits

- [Config Reference § Routines](config-reference.md#routines) — the `routines` array
  schema, cron rules, and the `model` field this pattern relies on.
- `skills/hermit-routines/SKILL.md` — the registration mechanism (`load`/`run`; `list`/`status`/`stop` live in the sibling `reference.md`)
  and the model-override dispatch behavior cited above.
- `scripts/heartbeat.ts precheck`, `scripts/reflect-precheck.ts` — the shipped precheck
  archetypes to copy the shape of, not reinvent.
- `scripts/lib/routines/finish.ts` — the finalizer that verifies a declared `expect_artifact` and
  owns the fire's terminal ledger row.

## Calling a sibling plugin from a gate

Use `"$HERMIT_DIR/bin/hermitd-run" sibling-run <plugin-name> <relative.ts> [args…]`.
Core matches `plugin.json.name` through its existing sibling discovery: flat installs or
the newest sibling version in a versioned cache. It runs the selected TypeScript file
with inherited stdio and the caller's cwd, forwarding arguments verbatim and returning
the child's exit code. A resolution failure prints one JSON object on stdout and exits 1:
`{"error":"no_sibling:<name>"}`, `{"error":"ambiguous_sibling:<name>"}`,
`{"error":"invalid_script"}` (an absolute path, any `..`, or a path without `.ts`), or
`{"error":"missing_script"}`. Gates receive `CLAUDE_CONFIG_DIR` and `HERMIT_PLUGIN_ROOT` when set so the shim
resolves the configured core installation.
