# Upgrading

Hermit is backwards compatible — nothing breaks if you don't upgrade. But upgrading unlocks new features and refreshes templates.

---

## Core Plugin

### One command (recommended)

From the project root, run `hermitd update`. It moves the durable plugin pins and queues `/reload-plugins` for the running session's core mod. For version gaps it runs `hermit-evolve` after the reload. It waits for migrations, builds the Docker image from approved copies when applicable and restarts the resident once with resume requested. A changed resident prompt starts a fresh conversation.

```bash
# Docker hermits:
hermitd update
# Local / tmux hermits:
hermitd update
```

Docker agents also accept `--plugins-only` (update plugins and restart the container without rebuilding the image), `--cc-only` (rebuild with the latest Claude Code without updating plugins), `--dry-run` (show the plan) and `--yes` (skip the update confirmation). Local agents accept `--dry-run`. A Docker update requires the project's host tmux session to be stopped.

Docker updates check for pending Docker input changes before updating the host plugin. The upgrade inside the container can also change those inputs and trigger a second check before rebuilding or restarting. Approval requires a terminal `y`, including with `--yes`. If the command stops for approval, run `hermitd approve` in a terminal, then rerun `hermitd update` to finish. See the [host trust boundary](docker-security.md#host-trust-boundary).

Always-on agents do this on their own: when one starts with a version gap, it finishes its startup turn, runs `hermit-evolve unattended` from its own command queue, and restarts once when quiet so the next start runs on the migrated state. If the agent's command queue is not loaded, the upgrade waits and `hermitd doctor` reports the gap.

### Typed management commands

A host agent's own session takes four management commands, typed by the operator in a terminal or in the Claude app (Remote Control). Chat cannot start them; the upgrade at start above is the only one the agent runs by itself:

- `/hermitd:hermit-update` runs `hermitd update` without its prompt, then restarts the agent once the upgrade has applied and the agent is quiet.
- `/hermitd:hermit-restart` restarts the agent once it has been quiet for about a minute; the conversation resumes. If the agent stays busy for 15 minutes, the restart is dropped and the agent says so.
- `/hermitd:doctor-fix` runs `hermitd doctor --fix` and relays its result.
- `/hermitd:hermit-evolve` applies a pending upgrade by hand.

Each one runs only on a turn that opens with that typed command; asking in prose, from chat or from another command is refused. Typed update and repair work on Standard and Hardened alike. On a Docker agent, `/hermitd:hermit-restart` restarts the session inside the container, while update and repair answer that they run on the host: use `hermitd update` and `hermitd doctor --fix` there. The `hermitd update` spellings are denied in the agent's own shell on every install. See [security](security.md#trust-model).

Both host and Docker updates restart the resident to load the rewritten launch overlay and monitors. The update does not wait for the agent to be quiet. It waits for `hermit-evolve`, queued behind any running turn, and for the turn that ran it, so it never restarts during an upgrade; another turn still running at the restart is cut off and the conversation resumes. After a wait for evolve times out, or after an interrupt before the restart, nothing restarts right away, and the update asks you to rerun `hermitd update`. Once evolve has applied, the watchdog may still restart the resident at its next quiet moment; only the rerun rebuilds the image. The first update from a watchdog without `await-upgrade` prints a note and proceeds without waiting for evolve.

External updates end with `hermitd doctor --fix` after removing the update marker. The pass queues a pending core upgrade once, repairs a policy-safe watchdog scheduler, then re-checks and prints the remaining manual actions. It does not change the update's exit status. `.hermit/state/update-history.jsonl` records a `doctor` field: `ran` with non-ok check ids and statuses from a report inside the pass window, `error` if the pass failed or produced no current report, or `skipped` with reason `self_run` for a host update run by the resident. A doctor error asks you to run `hermitd doctor` from a terminal.

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
