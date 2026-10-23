# Creating Your Own Hermit

Every Hermit is yours from the moment you run `/hermitd:hatch`. This guide covers how to shape it — from editing a single file to packaging a reusable plugin.

---

## Start Anywhere

An existing codebase, an empty folder for a personal assistant, a research project — `/hermitd:hatch` adapts to whatever it finds. The wizard scans your folder, asks a few questions, and generates an `OPERATOR.md` that shapes how your hermit works for you.

That's the first customization lever, and for most people it's the only one they need.

---

## OPERATOR.md — The 80% Case

`OPERATOR.md` is how you turn a generic assistant into _your_ assistant. Budget limits, off-limits directories, naming conventions, communication preferences — write it once, your hermit reads it every session.

See [Getting Started](how-to-use.md#operatormd) for the good/bad examples and formatting tips.

---

## Let Your Hermit Suggest What It Needs

You don't have to design capabilities upfront. After a few sessions, ask:

- **"Suggest specialized agents for this project."** — Your hermit reviews its experience and proposes agents based on the kind of work you've been doing. A project heavy on database changes might get a migration specialist. One that keeps hitting CI failures might get a test reviewer.
- **"What would make you more efficient here?"** — Might suggest workflow changes, new skills, or configuration tweaks.
- **"Create a self-improvement proposal."** — Formalizes its suggestions into a proposal you can accept or reject.

You approve, it creates the files. The specialization emerges from how you actually work.

---

## Adding Agents Manually

For when you know exactly what you want. Create a markdown file in `.claude/agents/` with YAML frontmatter and a system prompt.

```markdown
---
name: db-migrator
description: Creates and validates database migrations. Use for schema changes.
model: sonnet
maxTurns: 30
tools: [Read, Write, Edit, Bash, Glob, Grep]
disallowedTools: [WebSearch, WebFetch]
memory: project
---

You are a database migration specialist.

## Before Starting

1. Read the current schema from `db/schema.sql`
2. Check `OPERATOR.md` for database constraints

## While Working

- Generate both `up` and `down` migrations
- Never drop columns without explicit operator approval

## When Done

Return: tables affected, reversibility, any data backfill needed
```

Once the file exists, your hermit can delegate to it by name. For more on [sub-agents](https://code.claude.com/docs/en/sub-agents), see the Claude Code docs.

**Conventions:** Always include `disallowedTools`. Use `memory: project` so it learns across sessions. Use `isolation: worktree` for agents that modify files. Match model to complexity: Haiku for scanning, Sonnet for reasoning.

---

## Adding Skills

Skills are multi-step workflows invoked with a slash command. Create a directory in `.claude/skills/` with a `SKILL.md` file — the directory name becomes the command. A skill you write yourself is tracked like any project file; one you ask your hermit to create for you follows the project's hatch visibility choice instead, private to this install by default.

`.claude/skills/deploy/SKILL.md` -> `/deploy`:

```markdown
---
name: deploy
description: Deploys the current branch to staging or production.
---

# Deploy

1. Validate `$1` is `staging` or `production`
2. Run `npm test` — stop on failure
3. Run `npm run build`
4. If production: ask for confirmation
5. Run `./scripts/deploy-$1.sh`
6. Inside an open record's turn, add a deploy entry with `task.ts note <id>`; otherwise skip the note.
```

For more on [skills](https://code.claude.com/docs/en/skills), see the Claude Code docs.

### Personal and third-party skills in Docker

You can bring an existing collection or your own skills to a Hermit. Choose a Claude plugin when you want a publisher-maintained bundle, or use the [Skills CLI](https://github.com/vercel-labs/skills) to install selected, editable skills from a Git repository or local folder. Choose one installation method for a collection to avoid duplicates; follow its setup instructions after installing.

For one Hermit, project scope is the simplest default. You can run skill installation commands inside the container from the mounted project root: the standard Hermit image includes Node.js, npm, and `npx`. Installing skill files there needs no image rebuild. You can also run the commands from the same project on the host if Node.js and npm are installed there. Docker rebuilds, restarts, and Compose validation remain host-only.

In these examples, replace `OWNER/SKILLS-REPO` with your chosen repository, or `./my-personal-skills` with your local source folder, and select the skills you want:

```bash
npx skills@latest add OWNER/SKILLS-REPO --agent claude-code
npx skills@latest add ./my-personal-skills --agent claude-code
```

The second example assumes your source folder is accessible in the shell running the command. A personal Git repository URL works too; private repositories need authentication in that environment. A local-source install creates an installed copy, so editing the source folder later does not automatically change that copy. You can also author a skill directly in `.claude/skills/<name>/SKILL.md`, with scripts and supporting files alongside it, as described in [Claude Code's skill documentation](https://code.claude.com/docs/en/skills).

**Where the files live matters.** A host/tmux Hermit uses host paths and its Claude configuration directory. A Docker Hermit sees the mounted project and its own Claude configuration volume. A host session can install project skills into that shared project, but installing to the host's global skills directory does not make those skills available in the container. Docker also runs Claude inside tmux; being in tmux alone does not identify which environment you are using.

In the CLI's default symlink mode, project installations keep the skill contents under `.agents/skills/`, links under `.claude/skills/`, and update metadata in `skills-lock.json`. The standard Hermit project mount preserves all three across container recreation. Keep them together when backing up or moving the project. For personal files you do not want committed, exclude the relevant installed files, links, and metadata from Git; project scope does not itself mean private.

Avoid assuming that `--global` inside Docker is persistent. Its links under `/home/claude/.claude/skills/` can point to `/home/claude/.agents/skills/`, while update records normally live in `/home/claude/.agents/.skill-lock.json`. The standard container persists the Claude configuration directory, but not `.agents` in the container home. Recreation can leave broken links and lose update records. `--copy` alone does not preserve those update records. Import existing host skills with their actual contents, not just links to unmounted directories.

Keep your own source skills backed up. Before updating an edited third-party skill, preserve the changes in a personal copy or fork; an upstream update is not a merge of your edits. Use the CLI's [list](https://github.com/vercel-labs/skills#skills-list), [update](https://github.com/vercel-labs/skills#skills-update), and [remove](https://github.com/vercel-labs/skills#skills-remove) instructions for CLI installations, and Claude's plugin management for plugin installations.

For skills marked `disable-model-invocation: true`, type the skill command in a terminal or the Claude app. Confirm an installed skill is available before relying on it from chat. If its scripts need packages, environment variables, or persistent tool downloads, use [/hermitd:docker-customize](../skills/docker-customize/SKILL.md) for the container setup.

---

## Building a Reusable Hermit

When you're copying the same agents between projects, package them as a [Claude Code plugin](https://code.claude.com/docs/en/plugins).

### Naming

`hermitd-{domain}`. Examples: `hermitd-data`, `hermitd-infra`.

### How it layers on core

Your hermit handles domain-specific work. Core handles session lifecycle.

```
/hermitd:resident-start -> your domain workflow -> task evidence or confirmation
```

### Required files

| File                                  | Purpose                                                            |
| ------------------------------------- | ------------------------------------------------------------------ |
| `skills/hatch/SKILL.md`               | Optional — setup/init skill. Checks core prerequisite and version registration; is idempotent |
| `skills/domain-session/SKILL.md`      | Your main workflow, bookended with core's session lifecycle        |

### Hatch pattern (optional)

Only needed if your hermit has setup steps beyond what core's `/hermitd:hatch` does (e.g. creating extra state dirs, registering routines). If your plugin is a thin layer of agents/skills with no setup needed, skip this entirely.

Name the skill simply `hatch` — the plugin namespace already disambiguates it from core's hatch (`/hermitd-your-domain:hatch` vs `/hermitd:hatch`).

```markdown
---
name: hatch
description: Initialize your domain hermit. Requires hermitd core.
---

Run `.hermit/bin/hermitd-run domain-hatch preflight <plugin>` and follow its core prerequisite verdict.
Use preflight `verify` and `config.json`'s `_hermit_versions` for hatch idempotency.
Keep guidance in the plugin's skills, agent bodies and hooks.
```

### Custom boot skill

`config.boot_skill` is an operator-only choice, set or cleared through `/hermitd:hermit-settings boot-skill`. It replaces the default `/hermitd:resident-start` bootstrap at launch; core does not run `resident-start` first. A chosen skill owns that turn and invokes core startup only if the operator wants it. Clearing the setting restores core startup.

Sibling plugins never declare or set this choice, including during hatch. Expose domain setup as an ordinary skill or routine instead, such as a house status check or scheduled context refresh.

### Credential registry

If your hermit holds a credential that expires (OAuth token, API key with a rotation window), declare it in `.claude-plugin/hermit-meta.json` so core's `hermit-doctor` and heartbeat surface its expiry alongside every other installed plugin's credentials — one nag surface instead of a bespoke re-auth check per hermit:

```json
{
  "credentials": [
    {
      "name": "strava-oauth",
      "state_path": "state/strava-tokens.json",
      "expiry_probe": "bun ${CLAUDE_PLUGIN_ROOT}/scripts/check-token.ts",
      "reauth_skill": "/hermitd-fitness:strava-auth"
    }
  ]
}
```

- `name` (required) — short id shown in the doctor line.
- `state_path` (optional) — where the credential lives, relative to the hermit state dir. Informational only; the doctor check does not read it.
- `expiry_probe` (required) — a shell command run via `bash -c` with a 5s timeout. It **must print exactly one line** to stdout:
  - `OK` — credential valid, no known expiry.
  - `EXPIRES:<iso8601>` — valid until the given timestamp.
  - `EXPIRED` — already expired.
  Anything else (multi-word output, a non-parseable date, a timeout, a nonzero exit) degrades to a warn-level "probe failed" — it never crashes doctor and never counts as a hard failure.
- `reauth_skill` (optional) — the namespaced skill the operator (or heartbeat) should run to re-authenticate. Named in the doctor detail and the heartbeat nudge when the credential needs attention.

Core's `credential-expiry` doctor check aggregates the built-in Claude OAuth check with every sibling plugin's declared `credentials[]`, warning when any credential is `EXPIRED` or expires within 7 days. The shipped `HEARTBEAT.md` standing check surfaces any non-ok credential to the operator by name.

### Brief skills

Ship your own brief routine under your own id; never replace or disable core's. A domain brief reads its own domain state and sends a self-contained message. Core's brief and domain briefs can coexist at the operator's chosen times.

See [Routine Authoring](routine-authoring.md) for plugin routine ids and hatch matching.

### Hook patterns

Follow core's `scripts/` directory as reference. Profile-gate safety hooks to `strict`, quality hooks to `standard,strict`. Fail open (exit 0 on parse errors). Drain stdin. No npm dependencies.

### Helper-script output

Scripts your skills run follow the same output convention as core, which matches Claude Code's own:

- Exit 0 for every expected outcome, including no match, skip or duplicate. Exit 1 only for a real failure: Claude Code's Bash tool reports any exit 1 as a failure, and a failing `` !`command` `` aborts the whole skill.
- Print one JSON object on stdout. Keys, `status` values and `reason`/`error` tokens are snake_case.
- An alternative outcome is `{"status":"<value>","reason":"<token>"}` plus any data. A check or write with nothing to report prints bare `OK`. A failure prints `{"error":"<token>[:detail]"}`.
- No positional `A|B|C` lines. Hooks follow the [hook contract](https://code.claude.com/docs/en/hooks); routine gate scripts print `SKIP` or `WAKE` ([routine authoring](routine-authoring.md)); expiry probes use the protocol in [Credential registry](#credential-registry).

Your skill then names only the fields it branches on.

### Upgrade steps that change or remove what operators call

An Upgrade Instructions step that changes a helper's output or removes a file, verb or config key follows this consumer-scan convention:

- Scan the project's `.claude/skills/`, `.claude/commands/` and `.claude/agents/`, including bundled scripts of any language; the paths and commands in `.hermit/config.json` (`routines[].precheck` and `monitors[].command`); hook commands in `.claude/settings.json` and `.claude/settings.local.json`; `.hermit/dashboard-render.ts`; and project-scope `.hermit/OPERATOR.md` and `.hermit/HEARTBEAT.md`.
- Skip gitignored files, `.claude/worktrees/`, nested repositories, backups and plugin directories.
- Count a hit only when a line invokes the changed helper (`hermitd-run <verb>`, the script name or the plugin's own command) and depends on the changed contract. A line that only checks a real failure's exit code is not a hit.
- Never edit files during the upgrade. Skip silently when there are no real hits. Otherwise list the hits with file and line in one deferred step, with plain options such as "Fix them" / "Leave them" and no `on_resolve`. Describe what each option does: `hermit-evolve` queues it as a micro-proposal, and the operator's chat reply applies the chosen option.

### Docker dependencies

If your hermit needs system packages in Docker (e.g. `python3-yaml`, `postgresql-client`), declare them with a `## Docker apt dependencies` section in your `hatch` SKILL.md or in a `DOCKER.md` file at the plugin root:

```markdown
## Docker apt dependencies

- python3-yaml
- python3-dotenv
```

Rules: one Debian-bookworm package name per bullet; names must match `^[a-z0-9][a-z0-9+\-.]+$`. Lines starting with `#` are ignored.

During `/docker-setup`, the wizard reads this section for every mirrored plugin, validates the names, and presents them to the operator in a unified confirmation prompt alongside the project-level signal scan. Approved packages are baked into `Dockerfile.hermit` at build time — no runtime venv or post-install scripts needed.

**Scope:** declare only packages your plugin's own scripts need (hermit-owned). Do not declare the user's project's build deps (e.g. `libsqlite3-dev` for a native addon) — those are live-scanned from the project tree each time `/docker-setup` runs and would drift if declared statically in your plugin.

**Why not write to `docker.packages` from your hatch?** The plugin directory lives in Docker's `claude-config` named volume, which is wiped on `docker compose down -v`, plugin updates, and fresh installs. Anything written there (venvs, caches, stamps) is ephemeral. Using the declaration convention bakes deps into the image at build time, making them permanent and removing the need for runtime installation.

Operators can review the approved package list via `/hermit-settings docker`. It is read only when `/docker-setup` renders the templates, so adjusting it there installs nothing on its own — an already-built container takes a package through the operator block of `Dockerfile.hermit` (`/docker-customize`) plus a rebuild.

### Docker network requirements

If your hermit needs specific network access — outbound domains for an external API, a LAN IP for a local service — declare them so `/hermitd:docker-security` can surface them as pre-checked additions during the LAN containment + DNS policy prompt.

In your `hatch` SKILL.md or in a `DOCKER.md` file at the plugin root, add a `## Docker network requirements` section. Two subsections, both optional:

```markdown
## Docker network requirements

### Domains (DNS allowlist)
- api.example.com
- www.example.com

### LAN allowlist suggestions
- ASK_OPERATOR_FOR_HA_IP    # special token: wizard prompts operator for the IP
- 10.42.0.0/24              # or a literal CIDR if you know it
```

**Validation rules** (the wizard rejects entries that fail; do not write entries that won't validate):

- **Domains**: regex `^[a-z0-9][a-z0-9.-]+$`. Lowercase, dots, hyphens. No protocols, ports, or paths.
- **LAN allowlist suggestions**: either an IPv4 CIDR (`192.168.1.50` or `10.0.0.0/24`) OR a special token of the form `ASK_OPERATOR_FOR_<NAME>_IP`. The wizard will prompt the operator for the IP via an Other field and substitute the typed value (validated as CIDR).

**Scope:** declare only network access your plugin's *own* code needs. Don't declare the user's project's network needs — operators add those via the wizard's "Extra LAN carve-outs" / "Extra domains" prompts.

**Backward compatible:** plugins without this section contribute nothing. The wizard skips silently.

**What it looks like to the operator:** during `/docker-security`, after they confirm LAN containment, the wizard scans installed fleet plugins, parses these declarations, and presents:

```
Fleet plugins request these network exceptions:
  api.example.com           — your-plugin (DNS)
  ASK_OPERATOR_FOR_HA_IP    — your-plugin (LAN, will prompt for IP)
```

The operator picks "Include all" (default), "Pick each", or "Skip all". Each `ASK_OPERATOR_FOR_*_IP` token gets a follow-up prompt for the actual IP. Confirmed entries land in the rendered `nftables.conf` and `dnsmasq.allowlist` files, with provenance comments noting the source plugin.

See [Docker Security — For plugin authors](docker-security.md#for-plugin-authors--declaring-network-requirements).

### Knowledge outputs

All domain artifacts must live in exactly two directories — `raw/` and `compiled/`. See **[`docs/plugin-hermit-storage.md`](plugin-hermit-storage.md)** for the full convention, compliant/non-compliant path examples, and a reviewer checklist.

Short version:

- **`raw/<type>-<slug>-<date>.md`** — ephemeral inputs (API data, snapshots, logs). Archived after `knowledge.raw_retention_days`.
- **`compiled/<type>-<slug>-<date>.md`** — durable outputs (briefings, decisions, audit results). Injected into session context at startup within `compiled_budget_chars` (default 2500 chars). Use `/recall` for deep retrieval of specific past content.

**Never create new top-level folders inside `.hermit/`** (no `audits/`, `reports/`, `reviews/`, `memory/`, `tmp/`). **Never add subdirectories inside `raw/` or `compiled/`** (e.g. `raw/audits/`). Use the `type` field in frontmatter — not the filesystem — to discriminate work products within each directory.

Tag compiled artifacts `foundational` to pin them to every session start regardless of age. Cite the raw source in compiled frontmatter (`source: raw/<type>-<slug>-<date>.md`).

Add a `knowledge-schema.md` to document what your hermit produces and when — this is the behavioral contract operators read. Your `hatch` skill should create `raw/`, `compiled/`, and `raw/.archive/` alongside the core scaffold.

### Periodic skill invocation via reflect

Register cadence-driven skills as ordinary routines. Each routine invokes one skill through `reflect --check-id <id> --check <namespaced skill>` and routes its findings through the proposal pipeline. Routines due together can all run.

**How to register.** Your hatch skill appends an entry to `config.json.routines` only when its id is absent, preserving existing operator edits:

```json
{
  "id": "ha-patterns",
  "schedule": "5 9 * * 1",
  "skill": "hermitd:reflect --check-id ha-patterns --check hermitd-homeassistant:ha-analyze-patterns",
  "enabled": true
}
```

Run `/hermitd:hermit-routines load` to activate it. See [Routine Authoring](routine-authoring.md) for model pins and optional pre-wake gates, and [Config Reference](config-reference.md#routines) for the schema.

**Skill contract:**

- Keep analysis idempotent and bounded; read only the state the check needs.
- Return actionable or contextual findings, or a quiet result. Findings become one candidate with `Evidence Source: scheduled-check/<id>` and `Sessions: none`. Judge and triage gates skip cross-session recurrence but enforce meaningful consequence and operator actionability. A failed gate stops candidate processing.
- Let the routine own scheduling. Skill arguments after `--check` are passed verbatim, and quiet results produce no cadence-change proposal.
- Report missing prerequisites or failures clearly. The Progress Log records the outcome; a future invocation follows the routine schedule.

Use `scheduled_checks` only for `trigger: "session"` skills that run at task completion, managed through `/hermit-settings scheduled-checks`.

### Operator notification routing

Skills should say "notify the operator" instead of referencing specific channels. Core's `prompts/resident.md` includes the Operator Notification routing section: conversation output in interactive mode and `channel-send --notice` in always-on mode. This keeps your hermit plugin channel-agnostic.

### Checklist before publishing

- [ ] Every agent has `disallowedTools`
- [ ] Destructive agents use `isolation: worktree`
- [ ] If present, `hatch` checks for core and is idempotent
- [ ] Skills use "notify the operator" instead of channel-specific references
- [ ] Hooks are profile-gated
- [ ] Zero dependencies — no `package.json`, no build step
- [ ] All scripts handle missing state files gracefully
- [ ] Cadence-driven skills registered in `routines`
- [ ] Docker system packages (if any) declared in a `## Docker apt dependencies` section in the hatch SKILL.md or `DOCKER.md` at plugin root
- [ ] Docker network requirements (if any) declared in a `## Docker network requirements` section so `/docker-security` can surface them — outbound domains and LAN-IP suggestions (use `ASK_OPERATOR_FOR_<NAME>_IP` if the IP is operator-specific)
- [ ] Each agent's `model:` matches task complexity (Haiku for scanning, Sonnet for reasoning) — use the short alias, not a pinned ID
- [ ] Expiring credentials (if any) declared in `hermit-meta.json` `credentials[]` with an `expiry_probe` and `reauth_skill`
