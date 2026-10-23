Record notes only inside an open record's turn, using `task-note` (Commands) with arguments `<id>` with the note on stdin. Otherwise skip record notes. Never edit a task file directly.

# Hermit Evolve — Upgrade Steps Reference

This file is the instruction spec for the isolated-context subagent dispatched by `hermit-evolve/SKILL.md`'s `## Execution routing` section (`evolve-runner`). The subagent reads this file directly — not `SKILL.md`, which stays a thin routing stub — and executes steps 0 through 9 exactly as written below. Step 10 (report handling) lives in `SKILL.md` and runs in the main loop after the subagent returns its report.

The evolve-runner body supplies the absolute plugin root for non-command files and the Commands entries used below. Run those entries verbatim with the stated arguments.

### 0. Verify Claude Code CLI version

- Read `.claude-plugin/hermit-meta.json` under the plugin root. If the file
  doesn't exist or `min_claude_code_version` is not set, skip this step.
- Run `claude --version` and parse the leading semver (format:
  `X.Y.Z (Claude Code)`). If the command fails or the version cannot be parsed,
  report: "Could not detect Claude Code CLI version — proceeding anyway." and
  skip the comparison.
- Compare the detected version against `min_claude_code_version` (supports
  `>=X.Y.Z` or bare `X.Y.Z`, treated as `>=`). If the CLI version is below the
  minimum, report:

  ```
  This hermit version requires Claude Code >=<min> (you have <detected>).

  Upgrade Claude Code (`claude update` or your package manager) and re-run
  /hermitd:hermit-evolve.
  ```

  Substitute `<min>` with the value from `min_claude_code_version` and
  `<detected>` with the parsed CLI version. Then stop. Do not prompt to bypass.

### 0b. Verify the bun runtime (hard gate)

- Read `required_bun_version` from the same `hermit-meta.json`. If not set, skip
  this step.
- Run `bun --version`. If the command fails (bun not installed) or the version is
  below the requirement, report:

  ```
  This hermit version requires bun <required> — hooks and scripts run on it.
  You have: <detected or "not installed">.

  Install:  curl -fsSL https://bun.sh/install | bash
  Upgrade:  bun upgrade

  Then re-run /hermitd:hermit-evolve.
  ```

  Then **stop. Do not prompt to bypass and do not continue the upgrade** — completing
  it without bun would leave every hook fire erroring at spawn. (Docker operators are
  unaffected: the image bakes bun in.)

### 1. Resolve hatch target, then run the pre-pass

First determine `hatch_target` for settings routing in Step 8:

Run `domain-hatch-preflight` (Commands) and take `target` as `hatch_target`. It owns the whole chain (the stamped file first, then install-scope detection), so hatch, evolve and every domain hatch resolve the target identically. A `plugin_*` `error` at exit 1 still carries the target fields; read them the same way.

If it returns `needs_target_question: true` the project has no stamped target. Use the returned `target_default` and stamp it with `domain-hatch-ensure-target` (Commands) with arguments `--target <target_default>`, so the next run of anything reads an answered file instead of re-deriving.

Then run the deterministic pre-pass — a single read-only analyzer that computes the version gap, the bounded CHANGELOG slice, new config keys, and changed templates/bin, so the steps below act on its output instead of reading and diffing whole files:

Run `evolve-plan` (Commands).

Parse stdout as JSON (the "plan"). The plan's `errors` array is the **sole error channel** — objects of `{code, message}`:

- If `errors` contains an entry with `code == "no_config"` → report "No config found — type `/hermitd:hatch` first, in a terminal or the Claude app." and stop.
- Else if `errors` is non-empty (any other code) **or** stdout is not valid JSON → report "evolve-plan failed: <joined messages> — re-run or report." and stop. Do not fall back to reading and diffing the files by hand.

**Stale-runtime check (before everything else):** if the plan's `loaded_core_older_than_applied` is `true`, this session loaded an older plugin copy (v`to`) than the version this hermit has already applied (v`from`) — a stale install, not a pending upgrade. Report: "This session is running plugin v<to>, older than this hermit's applied state v<from> — a stale plugin install. hermit-evolve cannot fix it: update the install that resolves to this plugin root, then re-run." **Stop there.** Do not run any other step: Step 7's sibling migrations would apply while Step 9 refuses to stamp, leaving siblings migrated but unstamped and replaying on the next run. Sibling work waits until the install is fixed — sibling stamps stay where they are and re-plan cleanly.

**Version check:** the plan reports `from`, `to`, `up_to_date`, and `work_pending`. If `work_pending` is `false` (core current AND no sibling gap, path-unresolved, or warnings), report "You're up to date (v<to>). Nothing to upgrade." and stop. If `up_to_date` is `true` but `work_pending` is `true` (sibling-only work), run only Steps 7, 7b, 8, 9, and 10 — the core-content steps (2 through 6) have no pending work when core is current. (Sibling migrations happen inside Step 7.) Otherwise (core has a gap) run all steps.

**Snapshot the config for the audit ledger.** Once the version check above has decided the run proceeds (so a stop-here run writes nothing), record what `config.json` looked like before any migration touches it:

Run `evolve-snapshot` (Commands) with arguments `--core=<to>`.

Step 2b migrations write `config.json` (through settings-edit) before the finalizer runs; without this snapshot, the finalizer's audit `before` is taken after those writes and the ledger could only ever show the version stamp and its own defaults merge. It always exits 0; on a `skip` status, continue the upgrade anyway. The finalizer reports which happened as `audit_scope` in Step 9.

### 2. Read the changelog

Read the plan's `changelog_slice`. It already contains only the entries in `(from, to]`, oldest-first — no full-file read. It is input for Step 2b, not output: the report contract has no changelog field.

### 2b. Execute version migrations

Within `changelog_slice` (already ordered oldest-first), each version entry may contain a `### Upgrade Instructions` section:

1. Find the `### Upgrade Instructions` section within each version's entry
2. If found, execute every instruction in that section — these are the authoritative migration steps
3. Collect any version-specific operator notes for the step-10 report (delegated mode has no operator to present to live)
4. A line beginning `**Leftover check:**` (numbered or not) is collected verbatim with its source plugin for Step 7b, never executed or deferred. **Delegated mode:** if a step is interactive (poses an either/or), do not ask. Apply the non-destructive default (e.g. a delete/cleanup offer → keep the file; a single command such as `deny ask-only`) and note the outcome for step 10. If the step has **no safe default**, **defer** — skip it and record a verbatim deferred-migration block per the Delegated mode rules. A step or line whose text begins with `**Operator action required:**` (numbered or not) is a third category: never execute it and never record it as a deferred-migration block; copy its text verbatim, marker included, into the Operator notes collected for step 10.

The CHANGELOG.md `### Upgrade Instructions` sections are the single source of truth for migrations — do not skip or merely display them. The same pattern applies to sibling-hermit upgrades in Step 7.

**Any instruction that changes `.hermit/config.json` is applied with settings-edit verbs — never the Edit or Write tool**, whatever wording the instruction uses ("read config.json and set…", "edit config.json", "add the key"). Read with `get`, then write one key per call:

Run `settings-get` (Commands) with arguments `<dotted.path>`.
Run `settings-set` (Commands) with arguments `<dotted.path> <json-value>`.
Run `settings-unset` (Commands) with arguments `<dotted.path>`.

Use the absolute Commands entries. This keeps every migration validated and recorded in the settings ledger, and it is what the strict profile requires — there, a tool write to `config.json` is hook-blocked. A conditional instruction ("if it is exactly X, change it to Y") is evaluated from the `get` output first; if the condition does not hold, make no call. If a verb refuses a write, treat that step as a deferred migration (record it verbatim per the Delegated mode rules) rather than falling back to a direct edit.

**Surgical docker-template migrations.** An Upgrade Instruction may surgically patch a wizard-rendered docker template (`Dockerfile.hermit`) and re-record its `template-manifest.json` baseline. When it does, it sets the report's `Docker rebuild` field to `base-patched`. Treat the corresponding `docker_templates` drift entry as resolved — do **not** surface it as unresolved upstream drift in Step 10.

### 3. New config keys

The plan's `new_config_keys` array lists every key in the current `config.json.template` that is missing from the project's config, each as `{path, default}` — a dotted `path` for a nested leaf, or a fully-absent parent carrying its whole default subtree. Operator-set values are never listed, so acting on these never overwrites them.

### 4. Apply new settings

**Delegated mode:** you write nothing here for most keys — Step 9's finalizer applies every still-missing template default itself. There is no prompting (the subagent can't `AskUserQuestion`), and operator-set values are never listed by the plan, so nothing overwrites a choice. If `new_config_keys` is empty, skip this step.

Special-default keys — the **only** keys this step writes, because their value is detected, not templated:
- `language` (0.0.1) / `timezone` (0.0.1): when one appears in `new_config_keys`, **auto-detect** the value (`$LANG` / system timezone via `date +%Z`/`timedatectl`) and write it now via a settings-edit verb, so the finalizer sees it as already present and skips it:

  Run `settings-set` (Commands) with arguments `language <detected>`.

  (These are 0.0.1 keys, set at hatch, so they are almost never missing at evolve time.)
- All other keys: **do nothing** — the finalizer writes them from `state-templates/config.json.template`, the same source `evolve-plan.ts` derives `new_config_keys[].default` from, and reports what it added as `settings_added`. The operator tunes them via `/hermit-settings` afterward.

### 4b. Legacy plan-table check

### 5. Update templates

`templates_changed` is a list of classified file objects `{ name, class }`. Each entry represents a file that differs from upstream or is absent. Resolve by class:

- **`missing`**: `templates/<name>` was absent. Copy `state-templates/<name>` under the plugin root → `.hermit/templates/<name>`. Report: "Restored missing template: `<name>`."
- **`unmodified`**: operator never customized it (baseline == on-disk, or no manifest entry). Copy upstream over it silently.
- **`customized-kept`**: operator edited it and the template hasn't moved. **Keep the operator's copy unchanged.** Collect in a summary line at the end: "Kept N operator-customized template(s): `<name>`, ..."
- **`conflict`**: both the operator and the template changed since hatch.
  - **Delegated mode** (always — non-boot templates): write upstream as `<name>.new` beside the operator's copy, keep the operator's copy live (lossless; conflict resolution needs a prompt the subagent can't issue). Collect for the step-10 report: "N template conflict(s) parked as .new — review when convenient: `<name>`, ..."

If `templates_changed` is empty, skip.

After all template resolutions (see manifest-write note at end of Step 5b).

**Never refresh from templates:** sessions, proposals, OPERATOR.md, HEARTBEAT.md, resident-prompt.md and helper-prompt.md (operator-editable), or config.json (handled separately).

Only update files in `templates/`:

- `SESSION-REPORT.md.template`
- `PROPOSAL.md.template`

### 5a. Migrate obsidian/ surface

If `<project-root>/obsidian/` exists in the target project:

- Leave the directory untouched — operators may have customised it.
- Append to open record notes: `"obsidian/ no longer maintained by hermit; safe to delete or keep as personal vault."`
- Also leave `.hermit/cortex-manifest.json` in place if present — operator-managed.

### 5b. Update boot script wrappers

`bin_changed` entries carry `boot_critical: true` (all bin/ wrappers are boot wrappers — a stale one can dead-end the hermit). Resolution by class:

- **`missing`**: wrapper was absent. Copy `state-templates/bin/<name>` under the plugin root → `.hermit/bin/<name>`. `chmod +x`. Report: "**Restored missing boot wrapper: `<name>`.**"
- **`unmodified`**: operator never customized it. Copy upstream over it silently.
- **`customized-kept`**: operator edited it; template hasn't moved. Keep the operator's copy. Summary line: "Kept N operator-customized wrapper(s): `<name>`, ..."
- **`conflict`** (any context — **no `.new` parking for boot-critical files**): replace with the upstream version (`chmod +x`) and save the operator's copy as `<name>.bak`. Report loudly in the run report and channel (if applicable): "**Boot wrapper `<name>` had local changes — replaced with new version; your copy saved as `<name>.bak`.**"

If `bin_changed` is empty, skip the copy (still confirm executability for all files in `bin/`).

**Bootstrap safety net** (`manifest_bootstrap: true` in the plan): on the first evolve after this feature ships (no manifest yet), any template or bin file that gets overwritten or restored also gets a one-time `<name>.bak` alongside it. This makes the quiet bootstrap recoverable: if an existing customization was already present before the manifest was seeded, it survives in the `.bak`. One noisy set of `.bak` files, once, then quiet thereafter.

### 5c. Update the Docker entrypoint (boot-critical, manifest-managed)

`docker_entrypoint` in the plan is a single classified object `{ name, class, boot_critical }`, or `null` when the project has no deployed `docker-entrypoint.hermit.sh` (non-Docker project — skip this step). The entrypoint is placeholder-free, so it is managed exactly like a boot-critical `bin/` wrapper. On-disk file: `<project-root>/docker-entrypoint.hermit.sh`; upstream: `state-templates/docker/docker-entrypoint.hermit.sh.template` under the plugin root. Resolve by class:

- **`unmodified`**: operator never customized it. Copy upstream over it silently.
- **`customized-kept`**: operator edited it; template hasn't moved. Keep the operator's copy. Summary line: "Kept operator-customized docker-entrypoint.hermit.sh." **Unless the entry carries `base_path`** — then the sidecar migration below supersedes this action and the file is replaced with upstream, exactly as for `conflict`.
- **`conflict`** (any context — no `.new` parking for boot-critical files): replace with the upstream version, and save the operator's copy to a **gitignore-safe backup inside the state tree**: `.hermit/state/docker-entrypoint.hermit.sh.<UTC-timestamp>.bak`. Do NOT write the backup next to the project-root entrypoint — that path is not gitignored and would surface as an untracked file in the operator's repo. Report loudly (run report + channel): "**docker-entrypoint.hermit.sh had local changes — replaced with the new version; your copy saved as `<backup path>`.** The update that launched evolve builds and restarts with this file; when evolve runs separately, rebuild to apply with `hermitd update`."
- (`missing` is never emitted for the entrypoint — the plan returns `null` when it is absent — so there is no restore branch.)

**Sidecar migration (`base_path` present on the entry).** `manifest-seed.ts` keeps the baseline *content* at `state/pristine/docker/docker-entrypoint.hermit.sh`; the plan surfaces it as `base_path` when it exists. With a base you can see which lines are the operator's, so a `conflict` (and a `customized-kept`, which otherwise keeps a copy that drifts further from upstream every release) also moves those lines to the operator sidecar, `<project-root>/docker-entrypoint.hermit-local.sh`, which upstream never touches. Without `base_path`, do exactly the class actions above and nothing here.

1. **Apply the `conflict` action first — for both classes**: the operator's copy to `.hermit/state/docker-entrypoint.hermit.sh.<UTC-timestamp>.bak`, upstream over the managed file, `chmod +x`. A `customized-kept` entry gets the `.bak` too, even though its own class action never writes one: the next step diffs against it. The managed file is at upstream from here on, whatever happens next, so there is no rollback to get wrong.
2. **Park the delta, always**: `diff -u <base_path> <the .bak> > .hermit/state/docker-entrypoint.delta.<UTC-timestamp>.patch || true`. This is the operator's exact hunks even if every later step fails. The `|| true` is required, not defensive: `diff` exits 1 whenever the files differ, which is the only case that reaches this step, so without it the always-taken path reads as a failed command.
3. **Move what the sidecar can carry.** For each hunk, decide the phase from intent: env exports, package installs, directory setup and pre-session checks → `pre-boot`; side services and last-second overrides → `pre-launch`. Append to `docker-entrypoint.hermit-local.sh` under `# --- hermit-evolve <UTC-timestamp>: migrated from docker-entrypoint.hermit.sh ---`, inside an `if [ "$HERMIT_ENTRY_PHASE" = pre-boot ]; then … fi` (or `pre-launch`) branch. Create the file with a `#!/usr/bin/env bash` line if absent (it is sourced, never executed, so it needs no `chmod +x`); **never overwrite existing content** — an operator sidecar is theirs.
4. **A hunk inside a heredoc** (`<<'JSEOF'` … `JSEOF`, or any other), **inside a loop body, or inside the plugin-install logic is never moved.** This is a rule, not a judgment call: the sidecar is sourced between phases, so it cannot reach inside one, and a re-expressed heredoc cannot be verified. Leave those hunks in the parked patch and say which phase they touched — that note is the evidence for a future hook point, or for an upstream fix.
5. **Syntax-check**: `bash -n <project-root>/docker-entrypoint.hermit-local.sh`. On failure, remove the block appended in step 3 and treat every hunk as unmoved. The sidecar is sourced under `set -euo pipefail`, so a broken one would abort the boot.
6. **Report**: `Docker entrypoint: migrated(<moved> moved, <unmoved> in <patch path>)`. Channel notice names `docker-entrypoint.hermit-local.sh` and the counts, no paths: the update that launched evolve builds and restarts with the replaced managed file and moved customizations; when evolve runs separately, apply them with `hermitd update`. Anything unmoved is the operator's to re-home, and the patch is where it is.

After a migration the operator's next upgrade sees `unmodified` and Step 5c is a plain overwrite. The sidecar is never classified, never backed up, and never read by the plan.

**Per-file bootstrap (`bootstrap: true` on the entry).** The plan sets this when no docker entrypoint baseline was recorded yet (e.g. a Docker deploy from before this version, where the manifest exists for `templates/`/`bin/` but `/docker-setup` never recorded the entrypoint hash). In that state the class falls back to `unmodified`, but a silent overwrite would destroy an operator customization that can't be distinguished from an old upstream copy. So: **whenever `bootstrap` is true and you are about to overwrite, FIRST write the operator's current copy to the gitignore-safe `.hermit/state/docker-entrypoint.hermit.sh.<UTC-timestamp>.bak`**, then apply the class action, and report the backup path. This is a one-time net — the manifest records the baseline below, so it won't recur. (The global `manifest_bootstrap: true` net does NOT cover this case: the manifest is present, just missing the docker key.)

The replaced entrypoint takes effect after a rebuild. An update-launched evolve leaves that build and restart to the waiting update; Step 10 requests `hermitd update` only when evolve runs separately.

### 5d. Merge compose and Dockerfile template changes in place

Each `docker_templates` entry is a classified `{ name, class, base_path?, theirs_path, bootstrap }`. It names either `<project-root>/docker-compose.hermit.yml` or `<project-root>/Dockerfile.hermit`. `theirs_path` is a fresh render from the current upstream template. A `base_path` is present only when the prior pristine template passed its recorded-hash check and was re-rendered with the same live inputs. These files have no phase sidecar: reconcile the operator's changes into the managed file itself.

**Entries that are not merged at all — check these first, before touching any file:**

- **An entry with `status` instead of `class`** (`{ name, status: "changed" | "unknown" }`) is the report-only fallback: the plan could not derive the live render inputs, so there is no `theirs_path` to install and nothing to diff. Never write to the project file for such an entry. Collect the names and report `Docker templates: report-only(<names>)`.
- **`class: "customized-kept"`** means the operator edited the file and the upstream template did **not** move since the recorded baseline. There is no upstream change to merge — keep the operator's file untouched, write no `.bak`, no patch, and no new baseline. Summary line: "Kept operator-customized `<name>`." Do not report it as merged, and do not emit a rebuild notice for it.
- **`Docker rebuild: base-patched`** (set by a surgical migration such as the bun pin) already refreshed `Dockerfile.hermit` and re-recorded its baseline. Skip the `Dockerfile.hermit` entry entirely in this step.

**`class: "unmodified"` without `bootstrap`** means the operator never touched the file and upstream moved: copy `theirs_path` over the project file, record the new baseline, and report `merged(3-way)`. No `.bak`, no patch, no hunk re-application — there is no operator delta to preserve.

Everything below applies only to `class: "conflict"`, and to `bootstrap: true` entries (whose class always reads `unmodified` because no baseline was recordable).

Use one UTC timestamp for every path created while handling an entry. First copy the operator's file to `.hermit/state/<name>.<UTC-timestamp>.bak`. Never place the backup beside the project file.

**Verified 3-way branch (`base_path` present).** `cp <the .bak> <tmp>` then `git merge-file <tmp> <base_path> <theirs_path>`. The bun-pin migration runs before this step, so a bun install-block change is not an operator hunk and must not be re-applied.

`git merge-file` returns the conflict count on a merge (capped at 127) and 128 or higher on its own failure, so read the status against those bands — a status of 128+ is an error, never a conflict count. The checks below run on `<tmp>` before anything is installed, in each of the three status branches that follow.

- Exit 0: run the checks. Green → install `<tmp>` over the project file, report `<name> merged(3-way)`. Red → unsettled.
- Exit 1-127: edit `<tmp>` only between `<<<<<<<` and `>>>>>>>` markers, in interactive and unattended runs alike. In a region holding the `/home/claude/.gitconfig` volume line, keep the operator's mount source when it differs from the one in `<base_path>`. Every region settled and the checks green → install `<tmp>` over the project file, report `<name> merged(3-way; <n> conflicts resolved)`. Any region unsettled or a check red → unsettled.
- Exit 128 or higher: the merge itself failed and `<tmp>` still holds the operator's bytes with no markers to resolve. Never install it → unsettled, with `n` unknown.
- **Unsettled**: project file untouched, `cp <theirs_path> .hermit/state/<name>.<UTC-timestamp>.upstream`, report `<name> conflict(<n>): upstream copy at <path>`.

**Bootstrap (`bootstrap: true`, no `base_path`).** Never write the project file. Park `theirs_path` at `.hermit/state/<name>.<UTC-timestamp>.upstream`. Record no baseline. Report `<name> kept(bootstrap, upstream not merged: <path>)`.

Validate `<tmp>` before installing it. Bootstrap never reaches these checks.

1. Scan for conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) and required structure. Compose must still parse as one document with top-level `services` and `volumes`, plus `services.hermit`; Dockerfile must retain its `FROM`, build arguments, entrypoint copy, and final non-root `USER`. On failure, leave the project file untouched (do not install `<tmp>`).
2. The host wrapper runs `docker compose config -q` before every `up` or `build`. It refuses the action on failure, prints Compose's error, and names the state-tree `.bak` the operator can restore.

After a successful merge, record the new baseline through `manifest-seed.ts` with the source set to the corresponding rendered-from-upstream template in `state-templates/docker/` under the plugin root, never the merged project file. Entry shape: `{ "key": "docker/Dockerfile.hermit.template", "file": "<absolute path to state-templates/docker/Dockerfile.hermit.template under the plugin root>" }` (and `{ "key": "docker/docker-compose.hermit.yml.template", "file": "<absolute path to state-templates/docker/docker-compose.hermit.yml.template under the plugin root>" }` for compose). This keeps `state/pristine/docker/<template>` and the manifest hash on upstream bytes, so the next change has a verified 3-way base. Record no baseline on `conflict(...)` or `kept(bootstrap, ...)`: the project file still holds the operator's bytes, and a baseline the file never contained would make the next merge read this release's changes as operator deletions and revert them silently.

Report the per-entry outcome (`merged(3-way)`, `merged(3-way; <n> conflicts resolved)`, `kept(bootstrap, upstream not merged: <path>)`, `conflict(<n>): upstream copy at <path>`) semicolon-separated across entries — an outcome can itself contain a comma; Step 10 matches on `merged(...)` to emit the rebuild notice.

**After resolving Steps 5 (templates), 5b (bin/), and 5c (docker entrypoint)**, record the new pristine-baselines in `state/template-manifest.json` via `manifest-seed.ts` — **do not hand-compute the hashes** (the script makes them correct by construction; an LLM cannot sha256 reliably). Decide *which* files to record, then hand them to the script:
- **Which files:** every file that was copied, replaced, or restored in Steps 5/5b/5c. Build one `{ "key": "<prefix>/<name>", "file": "<on-disk path of the new content>" }` entry per such file. Prefixes: `templates/` (file `.hermit/templates/<name>`), `bin/` (file `.hermit/bin/<name>`), and for the entrypoint the literal key `docker/docker-entrypoint.hermit.sh` (file: the project-root `docker-entrypoint.hermit.sh`).
- **`customized-kept` files:** do NOT include them — the script preserves their existing manifest entry unchanged via foreign-key preservation.
- **If `manifest_bootstrap` was true:** include the full managed set — every `templates/` and `bin/` file (and the entrypoint, if deployed), hashing whatever is now on-disk after any overwrites. This is the one-time baseline seeding.
- **Run** `manifest-seed` (Commands) with `{ "plugin_version": "<plan.to>", "entries": [ ... ] }` on stdin. The script hashes each on-disk file, merges into the existing `files` map — preserving untouched prefixes, sibling-hermit keys, and the `docker/docker-compose.hermit.yml.template` / `docker/Dockerfile.hermit.template` baselines `/docker-setup` records (Step 10 reads them) — and writes `{ "version": 1, "files": { ... } }`. It refuses to overwrite a present-but-corrupt manifest. - **Ordering:** run this *after* Step 8 has ensured the plugin permissions, so `bun */scripts/manifest-seed.ts*` is allowed. The files resolved in Steps 5/5b/5c are stable on disk, so deferring the manifest write to after Step 8 does not change the recorded hashes.

### 6. Clean up session settings

Remove every resolved Hermit env key and every `*_BOT_TOKEN` from `.claude/settings.local.json`'s env object; remove `language`, and remove `outputStyle` only when it equals `outputStyleFor(config.voice)`. The resolved keys are config.env without AGENT_HOOK_PROFILE plus each channel's state-dir key; also remove the legacy AGENT_HOOK_PROFILE key. Preserve unrelated settings and a null-voice operator style. Leave malformed JSON intact and report it.

### 7. Hermit upgrades

The plan's `siblings[]` array is the authoritative list (registry-driven from `_hermit_versions`; path-resolved by `evolve-plan.ts` with the project-scope + realpath filter). Do not re-run `claude plugin list --json` here.

For each entry in `plan.siblings`:

- **Version gap (`up_to_date == false`):**
  - Read the sibling's `changelog_slice` (already bounded to the gap range, oldest-first).
  - **Execute migrations** — within `changelog_slice`, find each version's `### Upgrade Instructions` section and execute every instruction in version order. Collect `**Leftover check:**` lines verbatim with their source plugin for Step 7b, never execute or defer them. Same rules as Step 2b: non-interactive default on ambiguous steps; defer if no safe default; a step or line whose text begins with `**Operator action required:**` is copied verbatim into Operator notes, never executed and never deferred.
  - Collect the sibling name for the `--sibling=<name>=<to>` flag in Step 9.

- **No version gap (`up_to_date == true`):** report `<name> current`, skip.

If `plan.siblings_path_unresolved` is non-empty, report each as `<name> path-unresolved` (registered in `_hermit_versions` but not found in the project-effective plugin list).

If `plan.siblings_detected_unregistered` is non-empty, report each as "detected but not activated: <name> — run `/<name>:hatch` to register." Never auto-activate; the opt-in gate stays.

If `plan.siblings_warnings` is non-empty, surface each warning (e.g. plugin-list unavailable, CHANGELOG unreadable).

### 7b. Leftover check

Collect the declarations from Steps 2b and 7 into one batch. Infer subjects as `{id, terms, kind: "routine_id" | "name", to?}` from the declared old names and replacements; expand lists of routine ids individually. A rename is live only when its new name exists in current config or the current install; a removal is always live. Check current state, never this run's migration receipt, so replay after a migration still scans. If one old name has two live replacements, list both and leave that reference for the operator to decide.

Pass `{"subjects":[...]}` on stdin to `leftover-check` (Commands). This read-only command enumerates candidate references once. Judge whether each candidate actually invokes the subject and depends on the declared change: prose and references already in the new form are not hits. Open `context_filtered` example lines when they could be real references; use its counts to check remaining filtered lines in the scoped files when needed. Search further only when a declaration calls for it. A `truncated` result means the scan is incomplete: report that, never report none. Do not edit any files in this step. With no real hits, say nothing.

For real hits, write one `Findings:` line per subject with replacement(s), hit count, file:line examples and a shared marker for tracked files. Record exactly one deferred-migration block for the whole batch: `source: leftover-check`, the live declarations verbatim as its steps, options `Fix them` / `Leave them`, no `on_resolve`, and `skipped: Leave them`.

Whether or not there are hits, if any live declaration renames routine ids, collect one Operator note for the whole run: run history stays under the old ids, so a gated routine may run once early.

**Fix procedure** (interactive Step 10 and chat answers): re-run the scanner with the same subjects and re-find each reference by matched text rather than stale line numbers. Skip references already gone and report those already fixed. Update the working tree only, never commit. Leave ambiguous references with multiple live replacements for the operator.

- Read `.hermit/config.json` hits with `.hermit/bin/hermitd-run settings-edit .hermit/config.json get <dotted.path>`, then change them with `.hermit/bin/hermitd-run settings-edit .hermit/config.json set <dotted.path> <json-value>`, preserving unrelated values and the settings ledger.
- In a channel session, list `.claude/settings*.json` hits for manual fixing in an interactive session. Interactively, apply them behind the native permission prompt.
- If auto mode blocks an edit to `.claude/skills`, `.claude/commands` or `.claude/agents`, apply the rest, then ask once in plain words for explicit go-ahead, naming every file and old-to-new change. Retry once only after the explicit reply.
- Report changed files, marking shared (tracked) files, and say that changes are uncommitted.

### 8. Ensure plugin permissions in settings file

Same logic as init step 8, but target the file determined by `hatch_target` (resolved in Step 1):
- `hatch_target == "local"` → `.claude/settings.local.json`
- `hatch_target == "committed"` → `.claude/settings.json`

Run the sync verb — it is the single owner of this list, so do not restate the entries here or diff them by hand. It holds the canonical `HERMIT_ALLOW` (so it can't drift from what `hatch` installs), writes via `fs` (so it works even under the strict hook profile, where an `Edit`/`Write` to `.claude/settings*.json` is denied), and is idempotent:

Run `apply-settings` (Commands).

where `<resolved-settings-file>` is `.claude/settings.local.json` (local) or `.claude/settings.json` (committed) per `hatch_target`, using the absolute Commands entry.

**Delegated mode: run it without asking** (a missing `bun` permission breaks hooks, so this is non-optional). It adds every sealed entry the target lacks and removes only entries this plugin shipped in a previous version and has since retired; an operator's own rules are never touched, and a target that is already current is not rewritten at all. Parse its one JSON line, `{"missing":[...],"obsolete":[...],"obsolete_deny":[...]}`, and report the three counts in the step-10 report, naming each `obsolete_deny` entry verbatim, since those are `permissions.deny` rules the operator may have wanted and can re-add by hand. When `other_file` is present, also report its `settings_file` and removal counts, naming each `other_file.obsolete_deny` entry verbatim. All three empty and no `other_file` means both files were already current; say nothing.

(On a hermit whose allow-list predates `apply-settings.ts` itself, this command may hit a permission gate inside this subagent, which can't prompt — relay that to the step-10 report so the operator can add `Bash(bun */scripts/apply-settings.ts*)` and re-run, rather than wedging.)

### 9. Write updated config

- **Do not merge `new_config_keys` by hand, and never Edit/Write `config.json`.** The finalizer below re-reads config from disk and applies every still-missing template default itself, in the same atomic write as the version stamp. Operator values and anything Step 2b or Step 4 already wrote are present by then, so they are never revisited. (Under the strict profile a tool write to `config.json` is hook-blocked outright.)
- **Bump `_hermit_versions` deterministically — do NOT hand-edit this key.** Run the finalizer. It writes the merged defaults and the version bumps atomically, then prints the confirmed on-disk values:

  Run `evolve-finalize` (Commands) with arguments `--core=<to> --plugin-root=<absolute plugin root from the runner body> [--sibling=<name>=<vNEW> ...]`.

  - `<to>` is the plan's `to`. Add one `--sibling=<name>=<vNEW>` for each sibling hermit with a **version gap** that was upgraded in Step 7 (where `name` is the sibling's plugin name and `vNEW` is its `sibling.to`). Omit `--sibling` for no-gap siblings (no version to bump). Omit `--sibling` entirely if no siblings had a gap.
  - **When `plan.up_to_date` is `true` (core current, sibling-only run):** the plan's `to` is still used as `--core=<to>`. Here `to` equals the on-disk stamp, so evolve-finalize re-stamps the same version — a genuine no-op that keeps the finalizer as the single atomic writer. (This is only reached when core is *current*; the config-ahead case never gets here, because the stale-runtime check above stops the run before Step 2. The finalizer independently refuses a lower `--core` with `core_version_regression`.)
  - Parse stdout as JSON. The finalizer's `core.confirmed` is the **authoritative on-disk version** — use it as `vNEW` in the Step 10 report, NOT `plan.to`.
  - `settings_added` lists the dotted paths it actually added, confirmed against its re-read. Report those as the added settings in Step 10 — not the keys Step 4 recorded, which are only what the plan expected.
  - `audit_scope` reports whether the Step 1 snapshot was usable: `whole_run` means this upgrade's config changes are attributed in the settings ledger, `version_only` means only the version stamp was recorded. Carry it into the Step 10 report. It is never a failure: a `version_only` upgrade succeeded, it just left less history behind.
  - If it prints `error`, the bump did not land: set the `Upgrade:` line in the Step 10 report to `blocked: config version bump failed (<joined errors>)` and stop.
