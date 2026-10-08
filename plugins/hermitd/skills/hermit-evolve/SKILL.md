---
name: hermit-evolve
description: Evolves hermit configuration and templates after a plugin update. Detects version gaps and runs the upgrade (migrations, templates, new settings) in an isolated subagent. Run after updating the plugin.
---

# Evolve Hermit

Upgrade the project's hermit configuration after a plugin update.

## Commands
- `proposal-queue-micro`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts queue-micro .hermit`

## Execution routing

Every run of this skill (interactive or unattended) delegates steps 0–9 to the `hermitd:evolve-runner` subagent, so the upgrade's transient churn (changelog slice, migration execution, file diffs) never lands in the calling session. The main loop keeps only step 10 (summary + operator notification).

> **Tool note:** `hermitd:evolve-runner` is a **subagent** — invoke it via the Agent tool, never the Skill tool. The `plugin:name` form it shares with skills does not imply the Skill tool.

- **If you are running AS the `evolve-runner` subagent**, skip this section and execute steps 0–9 directly (you are the delegate — do not re-dispatch).
- **Otherwise (main loop, any mode):**
  1. **Determine execution and delivery separately** and remember both for step 10:
     - Positional argument `unattended` ⇒ execution *unattended*, delivery *automated-maintainer*.
     - No `unattended` argument + an inbound `<channel source="...">` tag ⇒ execution *unattended*
       (never block on `AskUserQuestion`), delivery *direct-channel-reply*.
     - Otherwise ⇒ execution *interactive*, delivery *inline*.
     Only the explicit `unattended` argument authorizes a proactive maintainer notification. A
     direct channel request must answer the channel that invoked it.
  2. **Check the runner reference:** run `test -f "${CLAUDE_PLUGIN_ROOT}/skills/hermit-evolve/reference.md"`. If it fails, **abort** — log `"hermit-evolve aborted: plugin root unresolved; cannot dispatch evolve-runner."` and stop. Do not dispatch with a broken path.
  3. **Dispatch** the `hermitd:evolve-runner` subagent via the Agent tool. Pass the report contract (below); the runner body supplies its own plugin root and Commands entries. Do **not** execute steps 0–9 yourself.
  4. **Go to step 10** with the subagent's returned report.

## Delegated mode

Steps 0–9 (in `reference.md`, read only by the `evolve-runner` subagent) are executed with no `AskUserQuestion` — the subagent cannot pause to ask. Each step's **"Delegated mode:"** note states the non-interactive behavior. The rule in every case: never guess on a destructive choice, never block.

- For any interactive choice with a safe non-destructive default (new settings, file deletions, `## Plan` strip, template conflicts, an `### Upgrade Instructions` step that names a single non-destructive command such as `deny ask-only`), take the default silently and report the outcome.
- For a genuine either/or with **no safe default** (an `### Upgrade Instructions` migration step in 2b/7 that poses a choice and names no default), **defer**: skip that step and record a verbatim deferred-migration block in the report (see the report contract in step 10). Never guess. Step 10 resolves it — interactive asks the operator; direct-channel and automated-maintainer execution relay it through their respective delivery routes. Never apply a deferred instruction that would write `.claude/settings*.json` from a channel session.

### 10. Report

After a successful upgrade, arm `/hermitd:later add 1d "doctor stays green after upgrading to <version>" | .hermit/bin/hermitd-run doctor-check .hermit --verdict` (hermit origin, `--timeout-s 120`: the doctor run probes credentials and docker and gets the same budget as its routine). The resolver form survives the next plugin update; a baked plugin path points at a cache directory that may be gone by the time the claim is checked.

**Step 10 runs in the main loop** (not the subagent), consuming the `evolve-runner`'s returned report. The subagent's report is the single source for what follows.

**Report contract** — the subagent's final message is exactly this; non-deferred runs carry no deferred block, so the common payload is tiny:

```
Upgrade: vOLD -> vNEW | core current vNEW | blocked: <reason>
Settings added: <keys | none>
Templates: <refreshed/restored/kept-N/conflicts-parked-N | none>
Bin wrappers: <restored/replaced(.bak) | none>
Docker entrypoint: <refreshed | conflict-replaced(<backup path>) | migrated(<N> moved, <M> in <patch path>) | n/a>
Docker templates: <name merged(3-way[; n conflicts resolved]) | kept(bootstrap, upstream not merged: <path>) | conflict(n): upstream copy at <path>; ... | report-only(<names>) | none>
Docker rebuild: <needed + order | base-patched | no>
CLAUDE-APPEND: <updated | unchanged | kept (resident duties duplicated until you accept the shrink)>
RESIDENT: <created | updated | unchanged>
Context reload: <required (comma-separated plugin names) | no>
Sibling hermits: <one or more of the following per sibling, space-separated, or "none">
  <name vOLD->vNEW>           (confirmed by finalizer — only from siblings_confirmed)
  <name current>              (no version gap)
  <name block-drifted>        (no gap but CLAUDE-APPEND differs from template — advisory only, not edited)
  <name path-unresolved>      (in _hermit_versions but no project-effective plugin-list match)
  <name SKIPPED-by-finalizer> (finalizer's siblings_skipped — never report as upgraded)
Siblings detected but not activated: <name ... | none>
Siblings warnings: <one line per siblings_warnings entry | none>
Permissions added: <entries | none>
Audit scope: <whole-run | version-only>
Operator notes: <one line per version-specific operator note collected in steps 2b/7 | none>
Deferred for operator: <none | one or more verbatim blocks, each:>
  --- deferred-migration ---
  source: <plugin>@<version>
  instruction: |
    <exact verbatim ### Upgrade Instructions step text — copied, not summarized>
  options: <the either/or choices presented>
  skipped: <the safe/no-op branch taken, or "skipped pending operator">
  --- end ---
```

**Audit scope.** `whole-run` needs no mention — say nothing. On `version-only`, tell the operator once that this upgrade's config changes were not recorded in the settings history (the upgrade itself succeeded; only the attribution is missing), so a later "why did this setting change?" gets an honest answer instead of a confident wrong one.

**Operator notes.** If `Operator notes` is not `none`, append every line to the delivered result as its own line, in every delivery mode (inline, direct-channel-reply, automated-maintainer). These are the CHANGELOG's version-specific notes for the operator and the report is their only route out of the subagent. Relay each line verbatim: a line starting with `**Operator action required:**` keeps that marker so it renders bold. Never fold these lines into the one-line summary and never merge them with deferred-migration text. Omit the section when `none`.

**Sibling report integrity:** parse the finalizer JSON `siblings_confirmed` and `siblings_skipped`. Only names in `siblings_confirmed` may be reported as `vOLD->vNEW`. Any name in `siblings_skipped` must be reported as `SKIPPED-by-finalizer` — never as upgraded, even if Step 7 said it ran.

**Failure fallback.** If the Agent call returned null/empty (subagent died — same partial-state risk
as an in-loop failure), report "evolve delegation failed — run
`/hermitd:hermit-evolve` manually". In automated-maintainer delivery, send that as a
maintainer-only notice; in direct-channel or inline delivery, return it only to the invoking
conversation. Stop.

**Print the summary** from the report fields. Omit lines where nothing changed. End with "Run /hermitd:hermit-settings to adjust any settings." if settings were added.

**Project-context reload notice.** If `Context reload` is `required (<names>)`, append this to the summary in every delivery mode: "Project instructions updated for <names>. Run `/compact` to load them now; `/clear` or restarting the Claude session also works. `/reload-plugins` alone does not reload CLAUDE.md." If the field is `no`, omit the notice. Deliver it on a `blocked:` report too — a blocked version bump does not undo a CLAUDE-APPEND write, and a re-run sees the block as already current, so this is the only time the operator hears about it. Never issue `/compact`, `/clear`, or a restart on the operator's behalf.

**Resolve deferrals by execution and delivery mode.** If "Deferred for operator" is non-empty:
- **Interactive execution:** for each deferred-migration block, present its `instruction` + `options` to the operator via `AskUserQuestion`, then apply the chosen branch inline (this is the only place changelog/migration text re-enters the main loop, and only for the rare deferred step). **A branch that changes `.hermit/config.json` is applied with settings-edit verbs, never the Edit or Write tool** — `bun ${CLAUDE_PLUGIN_ROOT}/scripts/settings-edit.ts .hermit/config.json get|set|unset <dotted.path> [value]`, using the harness-substituted path. That keeps the change validated and in the settings ledger, and under the strict profile a tool write to `config.json` is hook-blocked outright. If a verb refuses, treat the branch as not applied and fall through to the version-bump caveat below.
- **Unattended execution:** relay each deferred block verbatim ("migration deferred for operator review: <source> — <instruction>") through the selected delivery route: direct reply for direct-channel delivery, maintainer-only notice for automated-maintainer delivery. **Do not apply — never run the migration's settings writes from this session.** If the deferred `instruction` text contains an explicit channel resolution stanza (a fenced `options: [...]` array and an `on_resolve: "..."` skill invocation with an `{answer}` placeholder), additionally queue a micro-proposal entry per `reflect` § Queuing procedure using that exact `options` and `on_resolve` (`tier: 1`, `"kind":"ask"` on the `micro-queued` event) and render the numbered options in the relay, so the operator's reply resolves it through `channel-responder/approvals.md` § Micro-approval response — the same bridge any other skill's bounded ask uses. An `on_resolve` reached this way may only alter hermit config/state, never `.claude/settings*.json` — a boot-time wrapper (e.g. `hermitd-start`) applies any resulting permission grant out-of-session, never this session.
- **Version-bump caveat (all delivery modes):** the subagent already bumped `_hermit_versions` to `<to>` in step 9, having *skipped* the deferred migration. We keep that bump — withholding it would replay the whole oldest-first slice next evolve and double-apply non-idempotent migrations. So if an interactive apply **fails or the operator declines**, report loudly through the selected delivery route: "version already bumped to v`<to>`; migration `<source>` was NOT applied; apply manually: `<instruction>`" — otherwise a rerun-says-up-to-date would silently hide it. On success, report it applied.

**Docker rebuild notice.** From the report's `Docker entrypoint` / `Docker rebuild` fields, append a `Docker:` section when a rebuild is needed:
- Entrypoint refreshed → "Docker entrypoint refreshed. Rebuild to apply: `hermitd update`."
- `Docker entrypoint: migrated(...)` → "Your entrypoint customizations moved to `docker-entrypoint.hermit-local.sh`, where upgrades no longer touch them (`<N>` moved). Rebuild to apply the new entrypoint: `hermitd update`." Add, only when `<M>` is non-zero: "`<M>` change(s) could not be moved automatically — they are in `<patch path>` for you to re-apply."
- `Docker rebuild: base-patched` → "Docker base image updated. Rebuild to apply: `hermitd update`. Do **not** re-run `/docker-setup` — your Dockerfile customizations are preserved." When this value is present, **suppress** the `Docker templates:` bullet below for `Dockerfile.hermit` (the migration already handled it).
- `Docker templates: <name> merged(...)` → rebuild notice (this is the only `Docker templates:` outcome that fires one): "Merged upstream changes into `<name>` while preserving the operator customizations. The update that launched evolve built before this merge; run `hermitd update` once more to apply it." Name every merged file. Use the same wording in the channel notice.
- `Docker templates: kept(...)` or `conflict(...)` → not a rebuild. Client voice (inline, direct-channel, and any `client` leg), one next step, no path: "I kept your customised `<name>` and set the new upstream version aside. Ask me to merge it when you want this release's changes." Name every kept or conflicted file. The archived path may go in the maintainer leg.
- `Docker templates: report-only(...)` → "Docker template inputs could not be derived safely. Evolve left `<names>` unchanged for operator review on the host."
- Never auto-rebuild.

**Reconcile routines after a successful always-on upgrade.** If the report represents a completed
upgrade (not blocked or already up to date) and the refreshed `config.json` has `always_on: true`,
ask what actually needs re-arming before loading anything:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/routines.ts arm check .hermit ${CLAUDE_PLUGIN_ROOT}
```

`arm check` is the read-only twin of the daily anchor's verdict — it stamps no fire, so asking
costs one Bash call instead of loading the routines skill. Route on its single line:

- `HEALTHY|…` — both legs are registered and current. Log that line; invoke nothing.
- `ARM|<legs>|…` including `routines` — invoke `/hermitd:hermit-routines load`, which
  makes exact-match routine migrations active immediately in CronCreate fallback mode (a migration
  that changed routines shows up here as `fallback-drift`) and re-arms the heartbeat leg with it.
- `ARM|heartbeat|…` alone — invoke `/hermitd:heartbeat start`.
- `SKIP|paused` — the hermit is paused and fires nothing until resumed. Log the line; invoke nothing.
- `SKIP|restart-required:<legs>` or `RESTART_REQUIRED|command-drift`: arm nothing, then continue to delivery. Append this as its own line, delivered through the same route as Operator notes: the monitors still run the previous version. An always-on hermit with its watchdog running restarts itself to finish the upgrade at its next idle moment; otherwise, restart the resident with `hermitd restart`.
- `ARM|…|check-error:<reason>` — state was unreadable, so nothing is safe to re-arm. Append that
  line and the manual `hermit-routines load` next action to the report.

If reconciliation fails, append that failure and the manual `hermit-routines load` next action to
the report.

**Deliver the result.** Compose a condensed one-line message such as `"Hermit upgraded: vOLD → vNEW.
N settings added, M templates refreshed."` Omit segments where nothing changed. **Append the
deferred/auto-applied segments**: settings set to defaults (Step 4), permission entries added (Step
8), template conflicts parked as `.new` (Step 5), any deferred migrations, and the project-context
reload notice when required — so the operator can follow up via `/hermit-settings`. **Append each
non-`none` Operator notes line after that list**, one line each.

- **Automated-maintainer:** deliver through `channel-send.ts --notice` with
  `{"maintainer":"<complete condensed result>"}` on stdin and no `client` leg. Follow CLAUDE-APPEND.md
  § Operator Notification fallback behavior.
- **Direct-channel-reply or inline:** return the result only to the invoking conversation. Do not
  send a second proactive notice.
