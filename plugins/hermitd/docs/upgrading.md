# Upgrading

Hermit is backwards compatible — nothing breaks if you don't upgrade. But upgrading unlocks new features and refreshes templates.

---

## Upgrading from claude-code-hermit

Stop every agent that uses this Claude config directory, including Docker agents. Then open a plain Claude Code session at one agent's project root and paste:

```text
Migrate the claude-code-hermit 1.4.8 agents in this Claude config directory to hermitd.

1. Find each agent: projects with `.claude-code-hermit/config.json` whose `_hermit_versions.claude-code-hermit` is `1.4.8`. Stop if one is running or on another version.
2. Record every `claude plugin list --json` row from the `claude-code-hermit` marketplace (id, scope, projectPath, enabled), running the command from each agent's project root so `enabled` reflects that project's settings. Do this on the host and, for Docker agents, inside `docker compose -f docker-compose.hermit.yml run --rm --no-deps --entrypoint bash hermit -lc '…'`.
3. In each place, run `claude plugin marketplace remove claude-code-hermit` and `claude plugin marketplace add gtapps/hermitd`, then reinstall each enabled row as `<new-name>@hermitd` with its scope, running `project` and `local` installs from that row's `projectPath` (skip rows whose folder no longer exists). Mapping: claude-code-hermit→hermitd, claude-code-dev-hermit→hermitd-dev, claude-code-homeassistant-hermit→hermitd-homeassistant, claude-code-fitness-hermit→hermitd-fitness, feed-hermit→hermitd-feed, laravel-forge-hermit→hermitd-laravel-forge, hermit-scribe→hermitd-scribe.
4. In each project, run `mv .claude-code-hermit .hermit`. Stop and report if `.hermit` already exists.
5. In `.hermit/config.json`, rename plugin ids by that mapping in `_hermit_versions` (keep the value `1.4.8`), `boot_skill`, `shutdown_skill`, `routines[].skill`, `scheduled_checks`, `docker.recommended_plugins` (also `gtapps/claude-code-hermit`→`gtapps/hermitd`) and the `claude-code-dev-hermit` section key. Leave every other value alone.
6. In `.gitignore` and `.worktreeinclude`, replace `.claude-code-hermit` with `.hermit`, then `bin/hermit-run` with `bin/hermitd-run`, then the remaining `claude-code-hermit` with `hermitd`. Replace `.claude-code-hermit` with `.hermit` in the `deny`/`ask` rules of `.claude/settings.json` and `.claude/settings.local.json`. Remove `allow` entries that name `.claude-code-hermit` or a `claude-code-hermit` plugin-cache path. Rename `.claude/agent-memory/claude-code-hermit-*` to `hermitd-*`.
7. Delete `.hermit/bin/hermit-*`. Before deleting one, save it as `.bak` when its sha256 differs from `files["bin/hermit-<verb>"].sha256` in `.hermit/state/template-manifest.json`. Delete `~/.local/bin/hermit` if it contains the line `# claude-code-hermit: managed host CLI`.
8. Report the ids of pending rows in `.hermit/state/hypotheses.jsonl` whose `cmd` names `.claude-code-hermit` or `hermit-run`, and any `.bak` files. Then tell me to do this in each agent's project root: open a new Claude Code session there and run `/hermitd:hermit-evolve`; then run `.hermit/bin/hermitd-run hermitd-cli install` on tmux hosts, or `.hermit/bin/hermitd-docker update` on Docker hosts; run `.hermit/bin/hermitd-watchdog install` where `~/.config/systemd/user/hermit-watchdog@*` or `~/Library/LaunchAgents/com.hermit.watchdog.*` existed; then start the agent.
```

Removing the old marketplace uninstalls its plugins from every project in the config directory at once, so migrate all agents in one pass. Agent state in `.hermit/` and channel plugins from other marketplaces are not touched.

## Core Plugin

### One command (recommended)

From the project root, run the wrapper for your deployment: it waits for quiet, moves the durable plugin pins, and queues `/reload-plugins` for the running session's core mod, followed by `hermit-evolve` for version gaps; evolve runs only after the reload completes. It waits for migrations, builds the Docker image from the merged files when applicable, waits for quiet again, then restarts the resident once with resume requested. A changed resident prompt starts a fresh conversation.

```bash
# Docker hermits:
hermitd update
# Local / tmux hermits:
hermitd update
```

Docker hermits also accept `--plugins-only` (update plugins and restart the container once, without rebuilding the image), `--cc-only` (rebuild with the latest Claude Code, without updating plugins), `--dry-run` (show the plan and change nothing) and `--yes` (skip the confirmation). Local hermits accept `--dry-run`. A Docker update is refused while a host tmux session runs the project's hermit; stop it first with `hermitd stop`.

Always-on hermits do this on their own: the resident-start upgrade banner triggers `hermit-evolve unattended` automatically.

From chat, ask a host hermit to update itself: it asks for approval through Claude Code's permission prompt, which only DM-paired users can answer, then restarts once when quiet. Docker hermits are updated from the host. See [security](security.md#trust-model).

Both host and Docker updates restart the resident to load the rewritten launch overlay and monitors. A busy resident or worker can delay the update; after a wait timeout, or an interrupt before the restart, nothing restarts right away, and the update asks you to rerun `hermitd update`. Once evolve has applied, the watchdog may still restart the resident at its next quiet moment; only the rerun rebuilds the image. The first update from a watchdog without `await-upgrade` prints a note and proceeds without the quiet guard.

### Manual

If you'd rather drive it by hand:

**1. Refresh the marketplace catalog first.** `plugin update` moves the pin against whatever version is already in the local cache — it does not git-pull the catalog itself. Auto-refresh is off by default for third-party/local marketplaces like this one, so a new upstream release stays invisible until you refresh:

```bash
claude plugin marketplace update hermitd
```

**2. Move the plugin pin (durable).** Refreshing the marketplace alone does NOT update the installed version — it only stages it; the pin reverts on the next restart. Use `plugin update` with the full marketplace-qualified id and your install scope (a bare plugin name fails with "not found"):

```bash
claude plugin update hermitd@hermitd --scope local
```

**3. Run the upgrade skill.** Inside Claude Code, in each project that uses the plugin:

```
/hermitd:hermit-evolve
```

This detects the version gap, shows what changed, prompts for new settings, refreshes templates and the Docker entrypoint.

### 4. What if I don't upgrade?

`hermitd-start.ts` merges missing config keys from defaults at runtime. Session start shows a soft nudge: "A hermit upgrade is available."

### 5. "Stale Plugin Runtime" — the opposite case

If session start reports `---Stale Plugin Runtime---`, the session is running a plugin copy *older* than the version this hermit has already applied. That is a stale install, not a pending upgrade, and `/hermitd:hermit-evolve` cannot fix it — it would either no-op or try to stamp the older version. The notice prints the path the session loaded; find the entry with that path in `claude plugin list` and update it with that entry's own scope:

```bash
claude plugin update hermitd@hermitd --scope <local|project|user>
```

Then restart the session. A scope-less `plugin update` targets the default scope and can leave the stale entry in place. If the notice appears when running `hermitd start` instead, it is the marketplace clone that lags: `claude plugin marketplace update hermitd`.

**Deliberately rolling back to an older core?** The applied-version stamp in `_hermit_versions` only moves forward — `evolve-finalize` refuses to lower it (`core_version_regression`), because lowering it would claim migrations were reversed when nothing reversed them. A genuine rollback needs the stamp edited by hand in `.hermit/config.json` to match the version you rolled back to; re-running `hatch` will not do it (it only adds missing keys).

---

## Hermit Plugins

Hermits (e.g., `hermitd-dev`) upgrade the same way — the wrappers above update every installed hermit plugin in one pass. To do it by hand, move each hermit's pin with its own id and scope:

```bash
claude plugin update hermitd-dev@your-org --scope local
```

Then `/hermitd:hermit-evolve` — it detects hermit version gaps automatically and runs their migrations.

Each hermit's version is tracked independently in `config.json`:

```json
{
  "_hermit_versions": {
    "hermitd": "1.0.6",
    "hermitd-dev": "1.0.0"
  }
}
```

## Project Customizations

These aren't upgrades — just how your project evolves:

- **OPERATOR.md** — Edit directly, or ask your hermit: it edits behind the approval prompt under Standard and proposes a diff under Hardened. Keep critical context and instructions in the first 50 lines and 2,000 characters; they reload at start, `/clear` and compaction.
- **Custom agents** — Add/modify/remove files in `.claude/agents/`. Live immediately.
- **Custom skills** — Add/modify in `.claude/skills/`. Live immediately.
- **Config** — `/hermitd:hermit-settings` or edit `config.json` directly.
- **Container** — [Customizing the container](always-on.md#customizing-the-container).

---

## For Hermit Authors

1. Keep `plugin.json` version updated
2. Maintain a `CHANGELOG.md`
3. Optionally provide `UPGRADE.md` with hermit-specific instructions
4. Keep guidance current in core `prompts/` or the domain plugin's skills, agents and hooks

---

## Version History

Per-version upgrade instructions live in [CHANGELOG.md](../CHANGELOG.md) under each version's `### Upgrade Instructions` section. `hermit-evolve` reads and executes those instructions automatically — you don't need to apply them manually.

For a full list of what changed in each release, see [CHANGELOG.md](../CHANGELOG.md).

Core rules load through generated resident and helper system prompts. Evolve backs up and retires hermit guidance from operator instruction files with `retire-hermit-blocks`. Move your own lines from that backup to OPERATOR.md for the hermit or CLAUDE.md for every project session, then restart the resident. Domain plugins keep guidance in their own skills, agents and hooks.
