---
name: hatch
description: Initializes the autonomous agent in the current project. Creates the state directory, templates, OPERATOR.md, and config.json. Detects installed hermits. Run once per project, like git init.
disable-model-invocation: true
---

# Initialize Autonomous Agent

Set up the autonomous agent for this project. This creates the per-project state directory, configures the project for session-based work, and optionally activates hermits.

**`AskUserQuestion` convention — applies to every question in this skill, both branches.** Each question needs 2-4 `options` (Other is auto-provided for free text), and each option needs both a `label` and a `description`; a bare label is rejected as an invalid tool parameter. Where a step lists options as bare labels (the tables in Step 5a, the activation prompts), write a short description for each before sending the call.

## Plan

### 1. Check if already initialized

Check whether `.hermit/config.json` exists in the current project. That file (written at Step 5) is the authoritative "already initialized" signal — not the bare presence of the `.hermit/` directory. An empty `state/` tree or a half-written tree left by an aborted prior run both count as **not** initialized.

- If `.hermit/config.json` exists: inform the operator that the agent is already initialized. Ask if they want to reinitialize (which resets templates but preserves sessions, proposals, config, and OPERATOR.md). Record the choice as `is_reinit` (true if operator opted to reinitialize).
- Otherwise: `is_reinit = false`, proceed with initialization.

### 1.5. Pre-flight (silent — no operator interaction)

Before the setup-mode gate or any file writes, gather context silently. Run all commands in parallel where possible:

1. **Auto-detect language and timezone**:
   - Language: `echo $LANG | cut -d_ -f1` (fallback: `en`)
   - Timezone: `cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || date +%Z` (fallback: `UTC`)

2. **Silent hermit detection + core scope detection** (split out so it's available before the mode gate without an operator prompt):
   - **Core scope detection:** run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-siblings.ts "$(pwd)" --role core-scope`. It emits `{ "core_scope": "local"|"project"|"user"|null, "target": "committed"|"local" }` — set `core_install_scope` from `core_scope` and `hatch_target` from `target`. (project → committed; local/user/null → local, the safer default the operator can override in Advanced.)
   - **Sibling hermit detection:** run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-siblings.ts "$(pwd)" --role siblings --core-root "${CLAUDE_PLUGIN_ROOT}"`. It emits a JSON array of the project-or-local + enabled hermit siblings (each carrying `plugin`, `id`, `marketplace_name`, `installPath`), already excluding user-scope, disabled, cross-project, and `hermitd` itself.
   - Stash the array as `detected_hermits`. Step 3 reads activation metadata from each entry's `installPath` directly.
   - Note: sibling detection is intentionally restrictive. A hermit installed at user scope does NOT auto-detect — operator can install it at project scope and re-run, or activate via `/hermit-settings`.

3. **Detect git-init eligibility** — run in parallel with items 1–2. Set `git_init_eligible = true` if and only if all three hold:
   - `is_reinit == false`.
   - `git rev-parse --is-inside-work-tree 2>/dev/null` is falsy (not already under version control).
   - `ls -A` of the project root yields only names from this **explicit allowed set**: `.hermit`, `.claude`, `.gitignore`, `.worktreeinclude`, `.bash_profile`, `.bashrc`, `.zshrc`, `.zprofile`, `.profile`, `.gitconfig`, `.ripgreprc`. The dotfile entries (`.bash_profile` through `.ripgreprc`) come from the sandbox-dotfile block at the bottom of `state-templates/GITIGNORE-APPEND.txt` — keep those in sync if that block changes.

4. **Print one summary line** so the operator sees what was detected:

   > Initializing hermit in `<project-name>`. Detected: language=<lang>, timezone=<tz>, scope=<project|local|user>, target=<committed|local>, hermit candidates=<N> (<comma-separated names or "none">), git=<fresh|existing|n/a>.

### 1.6. Setup mode gate

**If `is_reinit == true`: skip this gate entirely and run Advanced** — Quick is for first-time install. Re-init operators have existing customizations to preserve, and Advanced's merge logic is the right tool. Quick re-running on an existing config would risk destructive overwrites of operator-tuned fields.

Otherwise, ask:

```
questions: [
  {
    header: "Setup mode",
    question: "How would you like to configure hermit?",
    options: [
      { label: "Quick", description: "Sensible defaults, ~4 questions, ~3 min. Tweak via /hermit-settings later." },
      { label: "Advanced", description: "Full wizard — every option exposed (~15 questions, ~15 min)." }
    ]
  }
]
```

Branch on choice:
- **Advanced** → continue to Step 2 file writes, then Step 3 hermit activation prompt, then Step 4 setup wizard.
- **Quick** → continue to Step 2 file writes, then jump to Section "Quick Branch" (after Step 9).

Both branches share Steps 2 (file writes) and 5-9 (config write, CLAUDE.md/.gitignore/settings, deny patterns, report). Quick replaces Steps 3-4 with the Quick Branch turns described later.

### 2. Create state directory structure

Run the scaffold script once (it builds the whole tree and seeds every static file; the layout is `state-templates/` plus `hatch-scaffold.ts`'s own enumeration):

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/hatch-scaffold.ts <PROJECT_ROOT> --reinit=<is_reinit>
```

Pass `--reinit=true` only when Step 1 recorded `is_reinit = true`; otherwise `--reinit=false`. The script:

- Seeds `state/reflection-state.json` (with a live ISO `counters.since`), the empty append-only ledgers `state/routine-metrics.jsonl`, `state/proposal-metrics.jsonl`, `state/observations.jsonl`, `state/update-history.jsonl`, `state/channel-replies.jsonl`, plus `state/alert-state.json`, `state/micro-proposals.json`, the `templates/` files, `HEARTBEAT.md`, `knowledge-schema.md`, `OPERATOR.md`, and copies + `chmod +x` every file under `state-templates/bin/` (enumerated, not hardcoded).
- **Preserves operator/state artifacts** — `OPERATOR.md`, `HEARTBEAT.md`, `knowledge-schema.md`, and every `state/*` file are created only if absent (in both modes), so re-init never clobbers accumulated learning/proposal state or operator edits. `--reinit=true` only refreshes the hermit-owned pristine files (`templates/*`, `bin/*`).

Parse the JSON it prints — `{ created, overwritten, preserved, operator_existed }` — and **remember `operator_existed` for Step 5a** (the OPERATOR.md guard).

The reasoned artifacts are NOT scaffolded here: `config.json` (Step 5), the OPERATOR.md *content* draft (Step 5a) keep their own steps.

- `state/template-manifest.json` is seeded at the end of Step 8, once the `bun */scripts/manifest-seed.ts*` permission is in place.

### 3. Hermit activation prompt (Advanced branch only)

**Quick mode handles activation in Quick Turn 1 — skip this entire step in the Quick branch.**

Use the `detected_hermits` list cached in Step 1.5 (no re-globbing).

If the list is non-empty:
- Present the candidates and ask: "Activate a hermit for this project?"
- If the operator selects one: record the full entry from `detected_hermits` as `activated_hermit` (carries `plugin`, `id`, `marketplace_name`, `installPath`).
  - Read `<activated_hermit.installPath>/.claude-plugin/hermit-meta.json`: if it declares a `hermit.boot_skill` field (e.g. `"/hermitd-homeassistant:ha-boot"`), record it for step 5 to write as `boot_skill` in `config.json`. This replaces the default `/hermitd:resident-start` bootstrap so the domain hermit's custom boot logic fires on every always-on launch. If the field is absent, leave `boot_skill` unset (core behavior).
  - Step 5 sends `activated_hermit.plugin` as `slug` together with the `boot_skill` above in the `hatch-config.ts` answers payload. Do not read the sibling's `plugin.json` version — core does not stamp `_hermit_versions` for an activated hermit.
- If the list is empty or the operator declines: skip.

### 4. Setup wizard

Collect project preferences in the phases below. Use `AskUserQuestion` for all questions, following the label+description convention at the top of this skill.

#### Phase 1 — Auto-detect (already done in Step 1.5)

Step 1.5 already ran the language/timezone detection silently. Reuse those values — do not re-run the commands.

#### Phase 2 — Identity

**4a. Agent name** — ask with `AskUserQuestion` (header: "Agent name"). Options: **Atlas** / **Hermit** / **Skip** — plus Other for a custom name.

- If "Skip" or Other left blank: record as `agent_name: null`
- Otherwise: record the selected or typed value as `agent_name`

**4b+4c. Language + Timezone** — batch both in one `AskUserQuestion` call (header: "Language" / "Timezone"). For each, offer the auto-detected value as the first option and one common alternative (e.g., "en" / "UTC"). If auto-detected already matches the alternative, swap in a different one to avoid duplicates.

- Record selected label or Other free-text as the value

#### Phase 3 — Behavior (AskUserQuestion batch, 2 questions)

Ask both in a single `AskUserQuestion` call (the option marked `(default)` is the Recommended pre-selection):

| Header | Question | Options (`label`: description) |
|---|---|---|
| Autonomy | How autonomous should your assistant be? | `Balanced`: act on routine tasks, escalate significant changes (default) / `Conservative`: ask before most non-trivial actions / `Autonomous`: proceed unless blocked, minimize interruptions |
| Remote ctrl | Enable remote control via claude.ai/code? | `Yes`: connect from claude.ai/code or phone (default) / `No`: local terminal only |

Record: `escalation` (conservative/balanced/autonomous), `remote` (true/false).

#### Phase 4 — Channels (AskUserQuestion, single question)

```
questions: [
  {
    header: "Channels",
    question: "How do you want to communicate with your agent?",
    options: [{ label: "Discord", description: "Communicate with your agent via Discord" }, { label: "Telegram", description: "Communicate with your agent via Telegram" }, { label: "Claude app (for now)", description: "Push notifications + Remote Control. Pair Discord or Telegram anytime later." }]
  }
]
```

- **If Claude app (for now):** record `channels: {}`. Proceed to Phase 5. Do not ask channel follow-ups.
- **If Discord or Telegram:** create a channel entry under the `channels` object (e.g., `channels.discord`). Boot script maps the key to the full plugin identifier. Then ask follow-ups below.
- Channel plugins require Bun and manual setup (bot creation, token, pairing). After saving the preference to `config.json`, note:

  > **Channel preference saved.** Activation depends on how you run hermit:
  >
  > - **Docker (always-on):** `/hermitd:docker-setup` pairs during first run. Afterwards run `/hermitd:channel-setup` from the host to pair or re-pair. A channel or token added later needs `hermitd-docker restart` first (the bot is offline until then). For pairing, use `/hermitd:channel-setup` from the host.
  > - **tmux (always-on, host):** boot with `hermitd start` (passes `--channels` automatically), then run `/hermitd:channel-setup` to set the token and pair.
  > - **Interactive (just trying it):** run `/hermitd:channel-setup` for token + pairing, then restart with `claude --channels plugin:<channel>@claude-plugins-official` so the channel is active in your session.
  > - Full guide: https://code.claude.com/docs/en/channels

**Channel follow-ups (only if Discord or Telegram was selected above — AskUserQuestion batch, 2 questions; the option marked `(default)` is the Recommended pre-selection):**

| Header | Question | Options (`label`: description) |
|---|---|---|
| Access ctrl | Restrict who can send commands via this channel? | `Allow everyone`: no restrictions on who can message (default) / `Restrict`: type your Discord/Telegram user ID via Other |
| Brief | Enable morning brief delivery via channel? | `Yes — 07:00`: daily summary delivered each morning / `No`: no automated brief delivery (default) |

- **Access control:** If "Restrict" and a numeric ID was typed via Other, record in `channels.<channel>.allowed_users` as `["<id>"]`. If "Allow everyone" or no ID provided, omit the key (absent = accept all). Note: "Add more user IDs later with `/hermitd:hermit-settings channels`. An empty array [] blocks all messages."
- **Morning brief:** If "Yes — 07:00", record as `channels.<channel>.morning_brief: { "enabled": true, "time": "07:00" }`. If "No", omit the key (or set to `null`).

#### Phase 5 — Deployment (AskUserQuestion batch, 3 questions)

The Visibility question uses the scope-derived `hatch_target` to recommend an option. Place the recommended option at index 0 with `(recommended)` in the label so the recommendation is clear:

- If `hatch_target == "local"` (scope=local or scope=user): `.local files` is position 0 with `(recommended)`.
- If `hatch_target == "committed"` (scope=project): `Committed files` is position 0 with `(recommended)`.

```
questions: [
  {
    header: "Permissions",
    question: "Permission mode for Claude Code?",
    options: [
      { label: "auto", description: "**Default.** Classifier-reviewed autonomy — each action reviewed before it runs. Generally available to all users across subscription plans and API usage; supported models and provider configuration can vary. If Claude reports it unavailable for the current selection, choose a supported model or another permission mode." },
      { label: "acceptEdits", description: "Auto-approve file edits, prompt for shell commands. Good balance if auto is unavailable on your plan." },
      { label: "default", description: "Prompt for permission on first use of each tool" },
      { label: "dontAsk", description: "Deny all tools not in permissions.allow — requires curated allowlist" },
      { label: "bypassPermissions", description: "No permission prompts. Opt-in for fully unattended Docker-isolated hermits that cannot tolerate any pause." }
    ]
  },
  {
    header: "Routines",
    question: "Set up morning and evening routines? (morning brief reviews priorities, evening summarizes the day)",
    options: [
      { label: "Yes", description: "Morning at 08:30, evening at 22:30 (default)" },
      { label: "No", description: "No scheduled routines" }
    ]
  },
  {
    header: "Visibility",
    question: "Where should hermit-personal hatch outputs live? (hook permissions, deny patterns, hermit-created skills/agents)",
    // Build options with recommended at index 0 based on hatch_target:
    // When hatch_target == "local":
    //   options: [
    //     { label: ".local files (recommended)", description: "Gitignored — operator-personal. Plugin installed at <scope> scope." },
    //     { label: "Committed files", description: "Shared with teammates. Override scope-derived default." }
    //   ]
    // When hatch_target == "committed":
    //   options: [
    //     { label: "Committed files (recommended)", description: "Shared with teammates. Plugin installed at project scope." },
    //     { label: ".local files", description: "Gitignored — operator-personal. Override scope-derived default." }
    //   ]
  }
]
```

Substitute `<scope>` with the actual `core_install_scope` value.

Record the operator's Visibility choice as `hatch_target` (overrides scope-derived default if different).

Record: `permission_mode` (auto/acceptEdits/default/dontAsk/bypassPermissions/plan). `plan` mode can be typed via Other if needed.

For routines — if Yes: use the config defaults (`active_hours.start = 08:00`, `end = 23:00`) to derive morning = `08:30` and evening = `22:30`. Add to `routines` array:

- `{"id":"morning","schedule":"30 8 * * *","skill":"hermitd:brief --morning","enabled":true}`
- `{"id":"evening","schedule":"30 22 * * *","skill":"hermitd:brief --evening","enabled":true}`
- Always add (regardless of routine choice): `{"id":"heartbeat-restart","schedule":"0 4 * * *","skill":"hermitd:hermit-routines load","enabled":true}`
- If no routines: still add heartbeat-restart to the `routines` array (it's infrastructure, not a user routine)
- **Routines auto-register only on always-on launches via `hermitd-start.ts`** (as one persistent routine monitor; CronCreate fallback where Monitor is unavailable). Interactive users who want routines active in interactive mode must run `/hermitd:hermit-routines load` themselves. Mention this once at the end of hatch if the operator is running interactively.
- Keep the template's `"precheck": "reflect"` on the reflect routine: it is the wake gate, and it is what keeps a day with nothing to reflect on from waking the session at all.
- If the operator wants a custom routine beyond the morning/evening defaults, point them at [Routine Authoring](../../docs/routine-authoring.md) for the cost-conscious authoring pattern (scoped skill, haiku pin, a `precheck` wake gate with its optional `precheck_timeout_s`) rather than hand-deriving it.

### 5. Write config.json

**Source of truth: `${CLAUDE_SKILL_DIR}/../../state-templates/config.json.template`.** `hatch-config.ts` reads it as the base — it encodes every default field shipped by the current plugin version (including `model`, `always_on`, `chrome`, `monitors`, `compact`, `knowledge`, etc.). Do NOT maintain a parallel inline default object here — anything written inline in this skill drifts the moment a field is added to the template.

Build an **answers payload** from the wizard's collected answers, then run:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/hatch-config.ts <PROJECT_ROOT> [--reinit]
```

with the answers payload as JSON on stdin. The script reads the template (or, on `--reinit`, the existing `.hermit/config.json`), overlays the answers, validates the result, and writes `.hermit/config.json`.

**Answers payload** — include a key only when the wizard actually collected that answer (the script overlays by presence, so an omitted key leaves the existing/template value untouched):

```json
{
  "project_name": "<project directory name, fresh hatch only>",
  "activated_hermit": { "slug": "<plugin>", "boot_skill": "<hermit.boot_skill from hermit-meta.json, or null>" },
  "agent_name": "...", "language": "...", "timezone": "...",
  "escalation": "...", "remote": true,
  "permission_mode": "...",
  "routines": { "enabled": true, "morning_time": "08:30", "evening_time": "22:30" },
  "channels": { "discord": { "enabled": true, "allowed_users": ["<id>"], "morning_brief_time": "07:00" } }
}
```

- **Phase 2** → `agent_name`, `language`, `timezone`.
- **Phase 3** → `escalation`, `remote`.
- **Phase 4** → `channels.<name>`: `enabled`, `allowed_users` (omit if the operator skipped access control), `morning_brief_time` (omit if declined; on re-init, send it as `null` to turn off a brief the operator previously enabled). The script fills in `dm_channel_id: null`, `default_chat_id: null`, and `state_dir: .claude.local/channels/<name>` on first creation and preserves all three (plus any other channel it doesn't recognize, `channels.primary`, and third-party `marketplace` channels) on re-init merge. Do **not** include `push_notifications` in the payload — the script never touches it; it stays at the template default (`true`) or, on re-init, whatever value is already on disk. The runtime channel-first/push-fallback guard in prompts/resident.md already prevents double-notification.
- **Phase 5** → `permission_mode`, `routines` (morning/evening only — `heartbeat-restart` and the other infrastructure routines are already in the template and are never touched by this payload).
- **Never in a hatch payload** → `auth_mode`. It records which credential the hermit already runs on, and hatch has not established one yet; it stays at the template default (`null`, resolved from the credential volume at read time) and is written later by `/docker-setup`, `hermitd-docker login`, or a completed renewal.
- **Step 3 hermit activation** → `activated_hermit`. `slug` is `activated_hermit.plugin`; `boot_skill` is read from `<activated_hermit.installPath>/.claude-plugin/hermit-meta.json`'s `hermit.boot_skill` field (or `null` if absent).

**Re-initialization** is `--reinit` on the same call — the script reads the existing config as its base (never the template), so any field the payload doesn't mention (custom operator keys, `push_notifications`, `docker`, `monitors`, ...) survives untouched, `_hermit_versions` entries are never advanced (only added if a slug is newly absent), and session-triggered `scheduled_checks`, `channels`, and `routines` are reconciled/merged by id rather than replaced wholesale. `shutdown_skill` is never written by this script — leave it `null`; the operator sets it via config edit if they run always-on services that need stopping on full close.

Periodic plugin checks are registered as ordinary routines by domain hatches, for example `skill: "hermitd:reflect --check-id my-check --check my-plugin:my-audit-skill"` with a cron schedule. `scheduled_checks` holds only task-completion checks.

**Template-only fields** (the wizard never asks about these; they come straight from `config.json.template`, and `hatch-config.ts` never touches them; the operator can tune them via `/hermit-settings` later): `model`, `effort`, `auto_session`, `always_on`, `chrome`, `monitors`, `compact`, `heartbeat`, `knowledge`, `env`, `quality_gate`, `watchdog`, `budget`, `telemetry_export`, `artifacts`, `context_hygiene`, `reflection`, `routine_wake_lint`, `routine_max_lateness_minutes`, `doctor`, `storage_drift`, `backup`, `ask_gate`, `operator_profile`. Defaults and semantics for each: [`docs/config-reference.md`](../../docs/config-reference.md). Publish authorization for unattended sessions is Step 9c below. `voice` is the one exception in the other direction: the template ships it unset and **§5a Phase 4b** writes it through `settings-edit`, not through this payload; the questionnaire that asks for it runs after this step.

`tmux_session_name` is derived from `project_name` on fresh hatch only (`hermit-<project_name>`) — re-init never re-substitutes it.

**Persist hatch options.** After config.json is written, before any settings or CLAUDE write, run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/domain-hatch.ts ensure-target hermitd --target <local|committed>
```

with this run's final `hatch_target` (the Step 1.5 scope default or the Advanced Visibility answer). The script owns the whole schema: it stamps the five canonical fields on a fresh file, and on an existing one (a domain hatch may have stamped it first) it preserves the original `stamped_at`/`stamped_by` and records this run in `last_updated_at`/`last_updated_by`. It also repairs a file that exists without a usable `target`. It prints `{action, target, path}` (or `{error}` at exit 1), where `action` is `created`, `repaired`, `updated` or `unchanged`.

This file is read by `hermit-evolve`, `docker-setup`, and every domain hatch to inherit the operator's target choice without re-running scope detection.

### 5b. Localize artifact chrome (non-`en` operators only)

The script-rendered Artifact pages (dashboard, proposals) read their fixed UI chrome from `.hermit/state/artifact-strings.json` when present, overlaying it per key over the English defaults (a missing key or an absent file falls back to English). Model-authored content already follows `language`; this closes the gap for the ~35 hardcoded chrome labels so a non-`en` dashboard isn't half-English.

Run **only** when the chosen `language` is set and is not `en`:

1. Emit the English scaffold: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/artifact.ts scaffold-strings <language> <current-ISO-timestamp>`.
2. Translate every value inside the `strings` object into the operator's language. Leave the keys and any `{placeholder}` tokens **verbatim** (word order may move around a token, but the token text must not change or be translated). Leave the `language` and `generated` fields as emitted.
3. Write the result to `.hermit/state/artifact-strings.json`.

When `language` is `en` or unset, skip — absent file ⇒ English chrome.

### 5a. OPERATOR.md onboarding

Generate OPERATOR.md through a project scan and targeted conversation instead of asking the operator to edit it manually.

**Re-init guard:** If `operator_existed` is true (from step 2):

- Ask: "OPERATOR.md already exists — regenerate it from a fresh project scan? Your current one will be saved as OPERATOR.md.bak."
- If yes: rename existing to `.hermit/OPERATOR.md.bak`, then proceed with phases below.
- If no: skip this entire step.

#### Phase 1 — Project scan (silent, no output to operator)

Scan the target project for context. Read ONLY the following if they exist — never read source code files. **Read all existing files in parallel** (batch into a single tool-call turn) to minimize scan time:

<!-- Intentionally NOT in this list: `.hermit/config.json`.
     Reading config.json during the draft scan would invite the model to
     mine it for OPERATOR.md content, which is exactly the leak Phase 4's
     scrub exists to prevent. The model is config-blind during draft by
     design; the scrub catches any leakage from CLAUDE.md or Phase 3
     answers. Do not add config.json to this scan. -->

| File                 | Read scope                                   |
| -------------------- | -------------------------------------------- |
| `CLAUDE.md`          | Full file                                    |
| `README.md`          | First 200 lines                              |
| `package.json`       | Full file                                    |
| `requirements.txt`   | Full file                                    |
| `pyproject.toml`     | Full file                                    |
| `Cargo.toml`         | Full file                                    |
| `go.mod`             | Full file                                    |
| `docker-compose.yml` | Full file                                    |
| `.github/workflows/` | List filenames; read the first workflow file |
| `.gitlab-ci.yml`     | First 100 lines                              |
| `Makefile`           | First 50 lines                               |

Also get the directory structure (2 levels deep) to understand the project layout.

Collect findings silently. Do NOT print scan results to the operator.

#### Phase 2 — Draft OPERATOR.md

Using the scan results, write a concise context document. Follow these rules:

1. **Never duplicate CLAUDE.md content.** If CLAUDE.md already covers a topic (testing, conventions, build commands), don't repeat it.
2. **Never duplicate `config.json` fields.** `routines`, `channels` (including Discord/Telegram user IDs and `morning_brief`), `permission_mode`, `agent_name`, `escalation`, `boot_skill`, `shutdown_skill`, and `_hermit_versions` are already loaded structurally — do not restate them as prose. OPERATOR.md is for context the model can't infer from config (project focus, constraints, approval gates, project rationale). Tone and comms style have their own home — `config.json`'s `voice` block, written in Phase 4b.
3. **Only include high-confidence inferences.** If the scan clearly reveals something (e.g., package.json shows Node.js, README describes the project), include it. If uncertain, leave it for Phase 3 questions.
4. **Keep it under 50 lines.** OPERATOR.md is loaded every SessionStart — bloat costs tokens. Write concise prose, not documentation.
5. **No rigid sections required.** Use headers if they help organize, but don't create empty sections. The goal is a useful context document, not a filled-in form.

Write the draft to `.hermit/OPERATOR.md`.

#### Phase 3 — Targeted questions (AskUserQuestion batch)

Questions are split into two `AskUserQuestion` calls (max 4 per call). Q1–Q4 are never skipped and always form the first call. Call 2 carries exactly one follow-up, picked by the Phase 1 scan.

**Call 1 — always sent (4 questions):**

| #   | Header      | Question                                                                | Options (+ Other for free text)                  |
| --- | ----------- | ----------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | Focus       | "What should I focus on in this project?"                               | Active development / Stabilization / Exploration |
| 2   | Constraints | "Are there hard rules or areas I should avoid touching without asking?" | None / Config files                              |
| 3   | Approval    | "What actions require your explicit approval before I proceed?"         | Deploys only / Breaking changes / Nothing extra  |
| 4   | Comms style | "How do you prefer I communicate?"                                      | Default / Concise                                |

Accept any answer including free-text via Other. Expand Q1–Q3 into OPERATOR.md prose in Phase 4 — don't take options too literally.

**Call 2 — one question, chosen by the scan:**

| #   | Header  | Question                                                                                 | Options                        | Ask when...                          |
| --- | ------- | ---------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------ |
| 5   | CI/CD   | "Any CI/CD quirks I should know about? (flaky tests, required checks, deploy process)"   | Standard / Has quirks          | Phase 1 found a CI config             |
| 6   | Team    | "Who's working on this? (solo / small team / large team — and any ownership boundaries)" | Solo / Small team / Large team | Phase 1 found no CI config (Q5 skipped) |

Tell the operator before Call 1: "I've scanned your project and drafted OPERATOR.md. A few questions to fill in what I couldn't infer:"

All questions use the `AskUserQuestion` structures defined above. Accept short answers or free-text via Other; expand into prose in Phase 4. If the operator selects "Skip", leaves Other blank, or gives a minimal answer, don't include that topic in OPERATOR.md.

**Hermit extension:** If a hermit was activated in step 3 and provides a file at `<activated_hermit.installPath>/state-templates/OPERATOR-QUESTIONS.md`, read it and append those questions to Call 2 (or start a Call 3 if Call 2 is already at 4).

#### Phase 4 — Write final OPERATOR.md

Incorporate the operator's answers into the draft:

- Weave answers into the document as concise prose
- Use headers only where they add clarity — don't force a section for every answer
- Strip the HTML comment from the template (replace with actual content)
- For hermit-specific context, append after the core content

**Draft from Q1–Q3 and the Phase 1 scan only.** Q4 (comms style) has its own home — `config.json`'s `voice` block, written in Phase 4b — so it must not reach this file.

**Before writing, re-check the draft against Phase 2 rule 2** (no `config.json` mirroring). If removing a sentence leaves a paragraph hollow, drop the paragraph.

Write the final version to `.hermit/OPERATOR.md`.

#### Phase 4b — Style

No dialog here — this applies the Q4 answer from Phase 3. The hermit's tone lives in a native Claude Code output style, so it reaches the **system prompt** instead of SessionStart context: it holds for the whole session and survives compaction. `config.json`'s `voice` block is what the operator owns; the style key and the style file are rendered from it, at hatch and again at every boot.

1. If `.claude/output-styles/hermit-voice.md` already exists, its prose is the operator's — adopt it instead of asking again. Take the text between the closing `-->` of its comment block and the `## Precedence` heading and write it into `voice.prose`, then set `style = custom` (the two commands in step 2's Other branch, in that order). The next render reproduces that prose verbatim. Skip the Q4 answer entirely and go to step 3.
2. Otherwise write the Q4 answer:
   - **Default** → `apply-known voice default`. **Concise** → `apply-known voice Concise`. Neither writes a file.
   - **Other (free text)** → the operator's own words become the voice, verbatim. Write the prose **first**, then the style (the reverse order is refused — `custom` without prose is invalid):

     ```
     bun ${CLAUDE_PLUGIN_ROOT}/scripts/settings-edit.ts .hermit/config.json set voice.prose '"<their words>"'
     bun ${CLAUDE_PLUGIN_ROOT}/scripts/settings-edit.ts .hermit/config.json apply-known voice custom
     ```

     Pass their wording through unchanged, or with only mechanical wrapping into instructions-to-yourself form (depth, cadence, how much reasoning to show, when to lead with the answer). Never paraphrase it into something weaker than a built-in already provides. Don't restate channel-routing rules (they ship with the plugin), don't put work context here (that's OPERATOR.md), and keep it short: it costs tokens on every API call.
3. Render it:

   ```
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts .claude/settings.local.json voice-render
   ```

   **Local scope, not the hatch target** — that is the scope Claude Code's own `/config` picker writes and the one that outranks committed settings, and a custom voice file is gitignored, so a committed pointer would name a file a teammate doesn't have. The op refuses any other target. It prints the applied `style`; carry that into Phase 5.

#### Phase 5 — Confirm

Tell the operator: "OPERATOR.md is ready. You can review it at `.hermit/OPERATOR.md`. Edit it anytime; tell me what changed and I'll propose the edit." Then report the style from what Phase 4b step 3 printed:

- **A built-in** (`default` / `Concise`): "Communication style is set to `<style>`. Change it any time with `/hermitd:hermit-settings voice` — from a chat too, once a channel is set up."
- **A custom voice** (`hermit-voice`): "How I talk to you is your own wording, at `.claude/output-styles/hermit-voice.md`. Change it with `/hermitd:hermit-settings voice`; it takes effect next session."

Either way the file is a render of `config.json` — say so if the operator asks about editing it directly, so they don't lose an edit at the next restart.

### 7. Update .gitignore

Use `${CLAUDE_SKILL_DIR}/../../state-templates/GITIGNORE-APPEND.txt`.

**First, check for the backup marker.** If `.gitignore` contains the line `# .hermit state is tracked here`, workspace-mode backup owns this file — it deliberately un-ignored the hermit-state lines so they can be committed. Skip this whole step silently; re-adding them would silently stop that hermit's backups.

Read the template. Determine which lines are missing from the project's `.gitignore` (per-line idempotent check — do not re-add lines already present). Only the missing lines are candidates to append.

- If `.gitignore` exists and candidate lines are non-empty: show the operator only the missing lines that will be appended, and ask with `AskUserQuestion` (header: "Update .gitignore") — options: **Yes — append** (add missing entries, default) / **No — skip** (you'll manage .gitignore manually). Append only if confirmed.
- If `.gitignore` exists and no lines are missing: skip silently.
- If `.gitignore` doesn't exist: show the operator the full template that will be written, and ask with `AskUserQuestion` (header: "Create .gitignore") — options: **Yes — create** (default) / **No — skip**. Create only if confirmed.

### 7a. Update .worktreeinclude

Use `${CLAUDE_SKILL_DIR}/../../state-templates/WORKTREEINCLUDE-APPEND.txt`.

The file contains a managed block bounded by marker comments (`# >>> hermitd ...` / `# <<< hermitd >>>`). This block carries hermit context (OPERATOR.md, config.json, bin/hermitd-run, compiled/) into `claude --worktree` worktrees; `config.json` is there so config keys such as `commands.*` are readable at the relative path inside the worktree, and `bin/hermitd-run` so the state-writing commands the resident prompt documents resolve there too (a worktree session has Write/Edit blocked, so Bash is its only path to them). The rest of `bin/` is deliberately left out — those are lifecycle wrappers that act on the main hermit. **Write it even in a non-git project:** a `.worktreeinclude` there is harmless and ready when the operator later runs `git init`.

- If `.worktreeinclude` is absent: show the operator the template that will be written, and ask with `AskUserQuestion` (header: "Create .worktreeinclude") — options: **Yes — create** (default) / **No — skip**. Create only if confirmed.
- If `.worktreeinclude` exists and the `# >>> hermitd` marker is already present: skip silently.
- If `.worktreeinclude` exists and the marker is absent: append the managed block (preceded by a blank line) — ask with `AskUserQuestion` (header: "Update .worktreeinclude") — options: **Yes — append** (default) / **No — skip**. Append only if confirmed.

### 7.5. Initialize git repo (fresh dirs only)

**Skip this step entirely if `git_init_eligible` is false.** Skip silently with no operator interaction.

If `git_init_eligible`:

- **Advanced branch:** ask with `AskUserQuestion` (header: "Git init") — "Initialize a local git repo here? The hermit's build output will be tracked; its internal churn (sessions, proposals, state) stays gitignored." — options: **Yes** (default) / **No**. Run `git init` only on Yes.
- **Quick branch:** announced in the Quick Turn 5 confirm bundle and run as part of the shared steps only after the operator confirms (see "Quick — silent defaults applied to shared steps" table — Step 7.5 row). Never auto-runs before confirmation.

When run, `git init` creates the repo at the project root. The `.gitignore` written in Step 7 is immediately in effect.

### 8. Ensure plugin permissions in settings file

The plugin's hooks and boot scripts require specific Bash permissions to run without prompting. The target settings file is determined by `hatch_target`:
- `hatch_target == "local"` → merge into `.claude/settings.local.json` (gitignored)
- `hatch_target == "committed"` → merge into `.claude/settings.json` (committed, current behavior)

**Do not restate the permission list here or anywhere else.** `apply-settings.ts` holds the
only copy (its sealed `HERMIT_ALLOW`); ask it what the target file is missing:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts <resolved-settings-file> permissions-plan
```

It writes nothing and prints one JSON line: `{"missing":[...],"obsolete":[...],"obsolete_deny":[...]}` — the
sealed entries the target lacks, and any entries from retired plugin versions it still carries in
`permissions.allow` and `permissions.deny` respectively.

**What the permissions buy:**

- `bun */scripts/<name>.ts`; Stop hooks (cost-tracker) and precheck scripts (`heartbeat.ts precheck`, reflect-precheck), scoped to plugin scripts only. Includes `manifest-seed.ts`, which the seeding sub-step below runs to write the template-manifest baseline (deferred from Step 2 so the permission is in place first). Includes `channel-log.ts`, which weekly-review's consolidation step runs unattended to list/mark/prune the episodic channel log. Includes `proposal.ts`; the single proposal CLI. Its create/patch/routine verbs perform every `.hermit/` state-dir write proposal-create and proposal-act make; without it, proposal creation and every accept/defer/dismiss/resolve mutation would be functionally denied in background/worktree sessions (the harness's isolation guard blocks the Write/Edit tools there, not Bash). Its resolve-id/gate/queue-micro/micro/index/metrics/success-signal verbs are the proposal-act/proposal-create/reflect mechanics; without them, ID resolution, gate-verdict routing, and micro-approval queuing would all be functionally denied headlessly. Includes `apply-reflection-actions.ts` and `transcript-digest.ts`; reflect's transactional resolution-action apply and its behavioral-telemetry digest; without these a scheduled reflect silently degrades to introspection-only and never resolves a proposal. Includes `setup-token-mint.ts`; the login-token renewal driver `/relogin` runs; that skill exists to be driven from chat when the hermit's login is about to lapse, so a permission prompt there is an outright denial and the renewal it was meant to perform never happens
- `.hermit/bin/hermitd-run proposal micro *` / `proposal metrics *` — domain plugins (HA's `ha-morning-brief`, the `domain-brainstorm` skills) reach core's shared scripts through the project-resident `bin/hermitd-run`, since their own `${CLAUDE_PLUGIN_ROOT}` can't resolve core's versioned cache dir. Each grant is pinned to the one verb that plugin needs, never a bare `hermitd-run proposal *` — that would also expose `create`, `patch` and `routine`, i.e. arbitrary state-dir writes. The space before `*` is a word boundary — matches `proposal micro .hermit brief-cycle`, not a `micro…`-prefixed verb — and `hermitd-exec.sh` additionally rejects `/`/`..` in the script name, so the route can't reach a script outside core's `scripts/`. Without these, headless domain briefs and brainstorm metrics checks are functionally denied
- `.hermit/bin/hermitd-run domain-hatch preflight *` / `ensure-target *`: the shared domain-hatch protocol checks core's version floor and resolves and stamps the settings target. Grants stay pinned per verb so a read-only preflight call cannot write core state.
- `.hermit/bin/hermitd-run channel-send *` / `observations observe *` / `task note *` / `task list *` — the scripts the model invokes **ad hoc mid-session**, rather than from a skill's verbatim command block. The resident prompt names the send, observation and task-note routes; sibling skills use task notes and listings. Notes apply only inside an open record's turn, with no note otherwise. Their `bun */scripts/<name>.ts` twins are wildcarded-interpreter rules, which auto mode suspends (`docs/security.md` § Auto-mode Classifier), so on the fleet's default permission mode the model was left hand-deriving a versioned plugin-cache path — and the shortenings it improvises (an env-var prefix) both draw classifier denials and fall outside every prefix-match rule. `channel-send` is granted mode-less rather than verb-pinned because it has modes (`--notice`/`--tier`), not verbs; that is safe only because `channel-send.ts` pins its own state dir, so the grant confers exactly what the existing `bun */scripts/channel-send.ts*` entry already confers. Without these, proactive operator notifications and settled-knowledge bookkeeping are classifier-stochastic on an auto-mode install
- `bash -c 'AGENT_DIR=...` — SessionStart hook that loads session context on every startup
- `Edit` on `.hermit/**`; scripts maintain runtime state and skills update operator-editable content without prompting (Edit rules cover all file-editing tools, including Write)

**Steps:**

1. Run `permissions-plan` (command above) against the resolved settings file and parse the JSON line.
2. If `missing`, `obsolete` and `obsolete_deny` are all empty: skip silently.
3. Otherwise show the operator the entries — what will be added, and what retired entries will be removed from `permissions.allow` (`obsolete`) and `permissions.deny` (`obsolete_deny`) — and ask with `AskUserQuestion` (header: "Hook perms") — options: **Yes — add** (merge so hooks run without prompting, default) / **No — skip** (you'll be prompted during sessions).
4. If the operator confirms: run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts <resolved-settings-file> permissions-sync`
   (Adds every missing sealed entry and removes only entries from retired plugin versions. Operator-authored rules are never touched.)
   (No auto-mode step here: the classifier reads `autoMode` only from user scope, managed settings, or `--settings`, so there is nothing useful to seed into a project settings file. `hermitd-start` renders the hermit's classifier policy into a per-session overlay at every boot and launches with `--settings`.)
5. If the operator declines: skip, and note: "You may be prompted to approve hook commands during sessions. Run `/hermitd:hermit-settings permissions` to add them later."

**Seed `state/template-manifest.json`** (deferred from Step 2 — now that the `bun */scripts/manifest-seed.ts*` permission is in place). It records the sha256 pristine-baseline that the `hermit-evolve` drift signals depend on. The script computes the hashes (an LLM cannot sha256 reliably). Read the current plugin version from `${CLAUDE_SKILL_DIR}/../../.claude-plugin/plugin.json` and run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/manifest-seed.ts .hermit` with this JSON on stdin:

```json
{
  "plugin_version": "<version>",
  "entries": [
    { "key": "templates/PROPOSAL.md.template", "file": "${CLAUDE_PLUGIN_ROOT}/state-templates/PROPOSAL.md.template" },
    { "key_prefix": "bin", "dir": "${CLAUDE_PLUGIN_ROOT}/state-templates/bin" }
  ]
}
```

The `bin` entry enumerates the **source** `state-templates/bin/` (the authoritative core set), never the project's `.hermit/bin/` (which can hold operator/add-on files). The script writes `{ "version": 1, "files": { ... } }` and on re-init preserves foreign keys (add-on hermit entries) while overwriting only the keys it re-seeds; it refuses to overwrite a present-but-corrupt manifest. The source files it hashes are stable, so seeding here does not change the recorded hashes.

The bare `.hermit` argv is cwd-relative, which is safe here: `hatch` runs from the project root and never invokes `docker compose` or `tmux`, so cwd does not drift (unlike `/docker-setup` Step 7b.6, which anchors to an absolute `<PROJECT_ROOT>` for that reason).

### 9. Generate deny patterns (AskUserQuestion, single question)

Seed native Claude Code permission rules into the target settings file. Canonical source: `state-templates/deny-patterns.json` (`deny` + `ask`). The target file is the same as Step 8 (`hatch_target == "local"` → `.claude/settings.local.json`; else → `.claude/settings.json`). After this seed, the operator owns the file — later upgrades never re-apply or remove these entries.

```
questions: [
  {
    header: "Safety rules",
    question: "Which permission rules should I seed?",
    options: [
      { label: "Standard", description: "Safety denies + approval prompts for risky ops (default)" },
      { label: "Hardened", description: "Everything hard-blocked — client-facing/prompt-averse" },
      { label: "Skip", description: "Nothing seeded — add later in the settings file" }
    ]
  }
]
```

- If **Standard** (default): run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts <resolved-settings-file> deny standard`. Merges `deny` into `permissions.deny` and `ask` into `permissions.ask`.
- If **Hardened**: run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts <resolved-settings-file> deny hardened`. Merges both arrays into `permissions.deny`.
- If **Skip**: seed nothing. Note: "You can add rules later in the settings file under `permissions.deny` / `permissions.ask`. To seed Standard later from a terminal session: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts <resolved-settings-file> deny standard`."

If the operator picked `permission_mode: dontAsk` earlier in hatch, note: "`permission_mode: dontAsk` turns ask entries into denies — Standard's approval prompts will hard-block instead of prompting."

### 9a. Sandbox nudge (informational only, no question, no write)

Claude Code ships its own native bash sandbox (`sandbox.*` settings, `bwrap`/`sandbox-exec`) with its own setup command (`/sandbox`). Hermit does not probe for it or configure it: whether CC's own sandbox spawn will succeed cannot be predicted from outside CC. This step only prints a one-time pointer; it never writes `sandbox.*`.

**Step:**

1. **Resolve target settings file** using `hatch_target` (`local` → `.claude/settings.local.json`; `committed` → `.claude/settings.json`).

2. **Branch on deployment:**

   **If `deployment == docker`**: print a one-line informational note (never a recommendation — recommending an in-container sandbox would push operators toward the Ubuntu 24.04+ AppArmor path where `bwrap` can't start in-container): "In Docker the container is your isolation boundary — one of the approaches Anthropic lists for unattended runs (https://code.claude.com/docs/en/sandbox-environments). Claude Code's bash sandbox is off by default; `bubblewrap`/`socat` are installed, so `/sandbox` is available if you want in-container defense-in-depth." No settings write.

   For non-Docker deployments (`tmux` or `interactive`), check the target settings file for an already-declared `sandbox.enabled` key (either value):
   - **Not declared**: print a one-time recommendation — "Bash sandboxing isn't set up. Claude Code can isolate Bash calls at the OS level — recommended. Run `/sandbox` to enable it (its Dependencies tab checks bubblewrap/socat for you); docs: https://code.claude.com/docs/en/sandboxing."
   - **Already declared**: stay silent — the operator already made the call.

No `AskUserQuestion` — enabling or disabling `sandbox.*` is entirely the operator's call via `/sandbox` or by editing their settings file directly.

### 9c. Artifact publish permission

Skip this step entirely if `artifacts.dashboard`, `artifacts.proposals`, and `artifacts.weekly_review` are all `false` in the config just written (Step 5) — nothing to authorize.

Otherwise, run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts <resolved-settings-file> artifact-allow` (same target-file resolution as Step 8; additive merge, never removes existing entries). This adds `Artifact` to `permissions.allow` so unattended sessions never stall on the first-publish permission ask — a headless "ask" is an effective deny, which would otherwise silently no-op every artifact refresh. No prompt: it follows the same opt-out model as the feature itself (default-on, disable any page via `/hermit-settings`), and rides Claude Code's own governed Artifacts path (org toggle, RBAC, retention, audit log).

Then run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/settings-edit.ts .hermit/config.json set artifacts.publish_authorized true` — this arms `hermitd-start`'s boot-time grant (`applyArtifactGrant`) so the permission stays in place even if the settings file is later wiped or migrated, without ever needing another unattended settings write.

Note to the operator: "Artifact publishing is on — added `Artifact` to `permissions.allow` so refreshes from `/brief`, `/weekly-review`, `/proposal-create`, and `/proposal-act` never prompt. Re-ensured at every boot; revoke with `/hermit-settings artifact-authorization` (bank first publishes instead). Disable any page via `/hermit-settings artifact-dashboard|artifact-proposals|artifact-weekly-review`."

---

## Quick Branch

Replaces Steps 3-4 with batched turns + confirm; resumes shared Steps 5-9 after approval. Same files written, same `config.json` fields populated, same OPERATOR.md questionnaire, same security gates — Quick just defaults incidental decisions and shows the resolved bundle before any config writes.

**Entry condition:** Step 1.6 returned `Quick` AND `is_reinit` is `false` (re-init forces Advanced).

### Quick Turn 1 — Hermit activation (conditional)

Only fires if `detected_hermits` from Step 1.5 is non-empty. Same prompt shape as Step 3 of the Advanced branch — uses the cached candidate list, does not re-glob. If multiple hermits detected, list all + Skip. If none, this turn is skipped entirely.

If a hermit is selected: record the full entry from `detected_hermits` as `activated_hermit` (carries `plugin`, `id`, `marketplace_name`, `installPath`). Read `<activated_hermit.installPath>/.claude-plugin/hermit-meta.json` for the `hermit.boot_skill` field; stash it for Step 5's `hatch-config.ts` answers payload.

### Quick Turn 2 — Identity batch (one `AskUserQuestion`, 3 questions)

```
questions: [
  {
    header: "Agent name",
    question: "What should I be called?",
    options: [
      { label: "Atlas", description: "Use Atlas as agent name" },
      { label: "Hermit", description: "Use Hermit as agent name" },
      { label: "Skip", description: "Leave agent name unset" }
    ]
  },
  {
    header: "Language",
    question: "Primary language?",
    options: [
      { label: "<auto-detected from Step 1.5> (auto-detected)", description: "Use detected primary language" },
      { label: "<one common alternative — e.g. en if auto = pt, otherwise pt>", description: "Use suggested alternative language" }
    ]
  },
  {
    header: "Timezone",
    question: "Timezone?",
    options: [
      { label: "<auto-detected from Step 1.5> (auto-detected)", description: "Use detected local timezone" },
      { label: "UTC", description: "Use Coordinated Universal Time" }
    ]
  }
]
```

Record `agent_name` (null if Skip), `language`, `timezone`.

### Quick Turn 3 — Deployment + Channel batch

Ask both questions in one `AskUserQuestion` call.

```
questions: [
  {
    header: "Deployment",
    question: "How will you run the agent?",
    options: [
      { label: "tmux always-on", description: "Runs on the host as you, no image build. Boots via hermitd start; the watchdog scheduler installs on first boot (opt out with watchdog.scheduler_enabled: false)" },
      { label: "Docker always-on", description: "Isolated container that restarts itself; guided end to end by /docker-setup" },
      { label: "Interactive", description: "Just trying it, right here in your terminal" }
    ]
  },
  {
    header: "Chat",
    question: "How do you want to communicate with your agent?",
    options: [
      { label: "Claude app (for now)", description: "Push notifications + Remote Control. Pair Discord or Telegram anytime later." },
      { label: "Discord + Remote Control", description: "Communicate with your agent via Discord + Remote Control if available" },
      { label: "Telegram + Remote Control", description: "Communicate with your agent via Telegram + Remote Control if available" }
    ]
  }
]
```

Record `deployment` (one of `docker` / `tmux` / `interactive`), `channel` (one of `none` / `discord` / `telegram`). Map the labels to those values — **"Claude app (for now)" is `none`**, not the label text; downstream code (the confirm bundle, Step 5's `channels` overlay) compares against the sentinel.

`push_notifications` is left at the template default (`true`) — no follow-up question. Push is dormant whenever a channel is reachable (the runtime guard in prompts/resident.md sends channel-first) and fires only as fallback when a channel is unreachable or absent.

**Derived values from this turn (used in the confirm bundle and Step 5 overlay):**
- `permission_mode`: `auto` (same default for both Docker and non-Docker deployments). Generally available to all users across subscription plans and API usage; supported models and provider configuration can vary. If Claude reports it unavailable for the current selection, choose a supported model or run `/hermit-settings permissions` to select another mode.
- Deny pattern profile: Standard (`deny standard`). Applied at Step 9 silently.

### Quick Turn 4 — OPERATOR.md questionnaire (run "5a. OPERATOR.md onboarding" verbatim)

Run the existing "5a. OPERATOR.md onboarding" step verbatim — same scan, same draft, same Phase 3 questions (Call 1 always + Call 2 conditional per the existing skip-condition rules), same Phase 4 scrub. No changes to scan list, draft logic, or question wording. The questionnaire produces a complete OPERATOR.md before the confirm screen so the operator's answers shape the autonomous-mode context the hermit uses immediately.

### Quick Turn 5 — Confirm bundle

Get the preview data from the script, so what the operator approves is derived from the answers rather than re-typed:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/hatch-report.ts confirm <PROJECT_ROOT> <<'HERMIT_ANSWERS'
{ ...the same answers payload Step 5 will send to hatch-config.ts, plus "deployment", "channel", "plugins", "hatch_target", "git_init" }
HERMIT_ANSWERS
```

**Compose the preview as message text before calling `AskUserQuestion`.** The operator cannot see Bash output (the transcript collapses it), so your message is the only preview; asking first means they approve a configuration they never saw. Show every `will_apply` fact as a short table in plain words (`channel: "none"` is the Claude app for now; a chat channel pairs after setup), mark each key in `defaults` as a default, and close with: nothing is written yet, and every default is tunable later with `/hermit-settings`.

Then ask:

```
questions: [
  {
    header: "Confirm",
    question: "Apply this configuration?",
    options: [
      { label: "Yes", description: "Apply and continue" },
      { label: "Customize", description: "Restart in Advanced (your Quick answers will not carry over)" }
    ]
  }
]
```

- **Customize**: jump to Step 3 of the Advanced branch (no prefill — Advanced restarts from scratch). Discard all Quick answers.
- **Yes**: continue to the shared steps below.

### Quick — silent defaults applied to shared steps

Quick replaces Step 4 entirely and applies these defaults silently at the shared Steps 5-9c (no prompts):

| Source | Field | Quick value |
|---|---|---|
| Advanced Phase 3 equivalent | escalation, remote | template defaults (balanced, true) — don't override |
| Advanced 5a Phase 4b equivalent | `voice` | Quick Turn 4 runs 5a verbatim, so the comms question and the render happen there too |
| Step 5 (end) | persist hatch options | run `ensure-target` with this run's final `hatch_target` before settings or CLAUDE writes |
| Step 5b | artifact chrome localization | run verbatim — generate the translated table only when `language` is set and not `en`; skip silently otherwise |
| Advanced Phase 4 equivalent | channels.<name>.* | state_dir + enabled + dm_channel_id=null + default_chat_id=null; omit allowed_users + morning_brief |
| Quick Turn 3 channel choice | push_notifications | template default (true) — don't override |
| Advanced Phase 5 equivalent | permission_mode, routines | permission_mode = `auto`; routines = morning 08:30 + evening 22:30 + (template) heartbeat 04:00 |
| Step 7 | .gitignore append | apply silently (per-line idempotent) |
| Step 7a | .worktreeinclude managed block | apply silently (marker-block idempotent — skip if marker already present) |
| Step 7.5 | git init (fresh dirs only) | run `git init` if `git_init_eligible`; omit otherwise |
| Step 8 | plugin permissions (target settings file) | merge silently into `hatch_target` settings file (auto-mode policy needs no seeding — it ships in the per-session overlay `hermitd-start` renders at boot) |
| Step 9 | deny patterns (target settings file) | Standard (`deny standard`) silently; write to `hatch_target` settings file |
| Step 9c | Artifact publish permission | same as Advanced — `artifact-allow` applied silently (skip entirely if all three `artifacts.*` are `false`) and `artifacts.publish_authorized` set to `true` in config |

### 10. Report results

On the host, install the operator command after setup, from the project root:

```bash
.hermit/bin/hermitd-run hermitd-cli install
```

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/hatch-report.ts final <PROJECT_ROOT> --deployment <docker|tmux|interactive>
```

Compose the report from its JSON as message text (the operator cannot see Bash output), stating only what the JSON carries, because it is what the script observed on disk rather than a file list from this session:

- `status: "incomplete"`: hatch did not complete (`.hermit/config.json` is not present); tell them to re-run `/hermitd:hatch` and report nothing else.
- Otherwise: `agent_name` is hatched; each absence in `observed` (null `permissions_file`, false `gitignore` or `worktreeinclude`, any `missing_bin_scripts`) as a warning you offer to fix; `next_steps` as a numbered list in order, saying nothing runs until step `running_after_step` finishes; then the `anytime` commands, and that they edit OPERATOR.md themselves, or tell you what changed and you propose the edit.

`--deployment` is the one thing it cannot read: Quick Turn 3 asks for it and nothing persists it. On the Advanced branch, pass the deployment the operator described, or `interactive` if they didn't say.

---

After the report, add: `.hermit/claude-settings.json` is the optional hermit-only settings file.

### Hand off pending domain hatches

Applies on **both** Quick and Advanced paths and is the **last** action of the skill. After the report, build the pending set from `detected_hermits` (Step 1.5). A sibling is **pending** when a file exists at `<installPath>/skills/hatch/SKILL.md` and its `plugin` was **not** already present in `config.json._hermit_versions` when Step 1 read the config. An activated hermit is never stamped by core, so the generic rule covers it.

For each pending sibling, print the block below with its `plugin` field substituted for `<slug>` — the bare plugin name, not `id`, which carries an `@marketplace` suffix. Repeat the complete block once per pending sibling. Do not invoke the Skill tool. If none are pending, stop after the report.

```markdown
## ▶ Next step — type this now

    /<slug>:hatch

I can't run setup wizards for you (they're operator-run by design).
After it finishes, that hermit's setup is complete; then type the next printed domain-hatch command, if any.
```

These blocks are terminal output. Print nothing after the final block.
