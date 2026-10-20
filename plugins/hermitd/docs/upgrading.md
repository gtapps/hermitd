# Upgrading

Hermit is backwards compatible — nothing breaks if you don't upgrade. But upgrading unlocks new features and refreshes templates.

---

## Upgrading from claude-code-hermit

Before migrating, update every registered agent in the Claude config directory to core **1.4.8** and stop all of them, including Docker agents. Run once on the host:

```bash
curl -fsSL https://gtapps.github.io/hermitd/migrate.sh | bash
```

The migration records every agent before replacing the marketplace, moves project state to `.hermit/`, refreshes launchers and permissions, and rebuilds Docker images. Customized managed files receive `.bak` copies. If interrupted, rerun the same command to resume. Disabled plugin installs are reported and are not reinstalled.

Follow the printed start command for each agent, then run `/hermitd:hermit-evolve`. Pending `later` commands that still use old paths are reported for re-arming.

## Core Plugin

### One command (recommended)

From the project root, run the wrapper for your deployment: it waits for quiet, moves the durable plugin pins, reloads the running session, and runs `hermit-evolve` for version gaps. It waits for migrations, builds the Docker image from the merged files when applicable, waits for quiet again, then restarts once with resume requested. A changed resident prompt starts a fresh conversation.

```bash
# Docker hermits:
hermitd update
# Local / tmux hermits:
hermitd update
```

Always-on hermits do this on their own: the resident-start upgrade banner triggers `hermit-evolve unattended` automatically.

Both host and Docker updates restart the resident to load the rewritten launch overlay and monitors. A busy resident or worker can delay the update; a wait timeout restarts nothing and asks you to rerun `hermitd update`. The first update from a watchdog without `await-upgrade` prints a note and proceeds without the quiet guard.

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

- **OPERATOR.md** — Edit directly; your hermit can propose a change for you to apply. Keep critical context and instructions in the first 50 lines and 2,000 characters; they reload at start, `/clear` and compaction.
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
