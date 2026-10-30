<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.4.25-green.svg" alt="Version 0.4.25" /></a>
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
  <a href="https://discord.gg/54sJqAxhUh"><img src="https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white" alt="Join" /></a>
</p>

# hermitd-dev

Git safety and dev-session discipline for unattended agents.

Strict git-safety hook for any Claude Code agent — blocks force-push, `--no-verify`, and direct push to protected branches.

<p align="center">
  <img src="../hermitd/assets/cover.png" alt="Always-on Claude Code DevAgent" width="720" />
</p>

```
# Install
claude plugin install hermitd-dev --marketplace gtapps/hermitd --scope local

# Boot Claude Code and run the setup wizard
/hermitd-dev:hatch

# Boot the hermit (core)
hermitd start
```

---

## What you get

**Git safety.** Core's approval prompts cover risky git operations. On always-on hermits, `git-push-guard` adds hard `bash`-time blocking at strict profile.

**Engineering discipline skills.** Two autonomous skills for recurring dev situations: `diagnosing-bugs` builds a tight, red-capable feedback loop before hypothesising (complements `/code-review`'s static reading — it doesn't run repros); `resolving-merge-conflicts` resolves in-progress git conflicts autonomously in 5 steps — never `--abort`, always runs project checks after.

Two hooks, hatch, and three generic development skills.

---

## Quick Start

> **Prerequisites:** [Claude Code](https://code.claude.com) v2.1.308+, a Claude plan (Pro, Max, Teams, or Enterprise), Node.js 24+ (for the `git-push-guard` hook at strict profile), a forge CLI when publishing PRs through the project's workflow.

### 1. Install

```bash
cd /path/to/your/project
claude plugin install hermitd-dev --marketplace gtapps/hermitd --scope local
```

### 2. Initialize

```
/hermitd-dev:hatch
```

The wizard asks for protected branches and hook profile. Defaults to installing `git-push-guard` at strict profile (with an explicit opt-out). Re-run any time to update individual settings; keys already set offer `Keep current (<value>)` for Enter-press sweeps.

### 3. Boot the hermit (core)

```
hermitd start
```

Boots the hermit in a tmux session — sessions, routines, heartbeat, and the learning loop, with detach/reattach so it survives SSH drops. Append `--no-tmux` for a foreground run.

> **Always-on on Docker?** Run [`/hermitd:docker-setup`](https://github.com/gtapps/hermitd/blob/main/plugins/hermitd/docs/always-on.md) for 24/7 background work in a hardened container.

> **Pair with the Chrome extension** for web work: run `claude --chrome` (or `/chrome` mid-session) so the hermit can drive your dev server. See [Chrome integration](https://code.claude.com/docs/en/chrome).

### Upgrading

```bash
claude plugin update hermitd-dev@hermitd --scope local
/hermitd:hermit-evolve
/hermitd-dev:hatch
```

Core `hermit-evolve` runs dev migrations on upgrade.

---

## Configure it

Set by `/hatch`; keys live under `hermitd-dev` in `.hermit/config.json` (except `AGENT_HOOK_PROFILE`, which is in `env`).

| Key | Default / options (default **bold**) |
|-----|--------------------------------------|
| `protected_branches` | branches the push guard blocks — **`["main","master"]`** (globs ok) |
| `AGENT_HOOK_PROFILE` | gates `git-push-guard` — `minimal` / `standard` / **`strict`** |

Full safety model in [Git Safety](#git-safety). Everything else — model, heartbeat, idle behavior, per-routine model — is core, tuned with `/hermit-settings`: see core's [Configure it](https://github.com/gtapps/hermitd/blob/main/plugins/hermitd/README.md#configure-it) and [Tips & tuning](https://github.com/gtapps/hermitd/blob/main/plugins/hermitd/README.md#tips--tuning).

---

## Git Safety

By default Claude Code will happily push to main, run `git commit --no-verify`, and force-push your branch. dev-hermit makes that progressively harder, gated by hook profile:

- **`minimal`** — no push-guard enforcement
- **`standard`** — no push-guard enforcement
- **`strict`** (default after `/hatch`) — `git-push-guard` active

The `git-push-guard` hook (strict only) blocks:

- Direct push to any branch in `hermitd-dev.protected_branches` (defaults to `main`/`master`)
- `--no-verify` on any git command
- Force push: `--force` and `-f` blocked unconditionally; `--force-with-lease` blocked on protected branches or without an explicit refspec (allowed on non-protected branches with an explicit refspec — see [docs/GIT-SAFETY.md](docs/GIT-SAFETY.md))
- `--mirror`, `--all`, `-a` (would push everything, including protected)

Protected branches are configurable in `.hermit/config.json`:

```json
{ "hermitd-dev": { "protected_branches": ["main", "staging", "release/*"] } }
```

See [docs/GIT-SAFETY.md](docs/GIT-SAFETY.md) for the full safety model and the trade-offs of the regex-based guard.

---

## What's Included

- **`worktree-boundary-guard` hook**: Blocks edits outside a linked worktree.
- **`git-push-guard` hook** — Strict-profile-only `PreToolUse` Bash hook. Blocks the dangerous git operations listed above.
- **`hatch` skill** : One-time setup wizard. Idempotent and re-runnable. Captures protected branches and hook profile. Installs `git-push-guard` at strict by default.

- **`domain-brainstorm` skill**: Operator-invoked ideas grounded in git churn, manifest drift, and README coverage.

**Engineering discipline skills** (autonomous — no user prompts required):

- **`diagnosing-bugs` skill** — Diagnosis loop for hard bugs and performance regressions. Builds a tight, red-capable feedback loop before hypothesising. Reads `.hermit/compiled/` for architectural context; drops diagnostic artifacts (logs, repro snapshots) in `.hermit/raw/`. Complements `/code-review` (static read) — that one doesn't run repros; this one does.
- **`resolving-merge-conflicts` skill** — Resolves in-progress git merge/rebase conflicts in 5 steps. Never `--abort`; runs project automated checks (typecheck, tests, format) after resolving; stages and commits to finish.

---

## Built-in Skills Used

These are Claude Code built-ins — no installation needed:

- `/code-review` : read-only correctness review.
- `/batch` — same change across many files in parallel
- `/debug` — enables Claude Code session debug logging (for diagnosing the agent/harness itself, not your code)

---

## Documentation

- [Git Safety](docs/GIT-SAFETY.md)
- [How to Use](docs/HOW-TO-USE.md)
- [Recommended Plugins](docs/RECOMMENDED-PLUGINS.md)

---

## Contributing

Bug fixes, doc improvements, skill improvements — all welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for design constraints and PR workflow.

- [Open an issue](https://github.com/gtapps/hermitd/issues) — bugs, ideas, questions
- [Start a discussion](https://github.com/gtapps/hermitd/discussions) — broader topics, customization

## Credits

- **[hermitd](https://github.com/gtapps/hermitd)** — the core plugin this extends
- **[Claude Code plugins](https://github.com/anthropics/claude-code)** — the platform that makes this possible
- The `git-push-guard` hook is adapted from [Everything Claude Code](https://github.com/affaan-m/everything-claude-code) (MIT)
- The `diagnosing-bugs` and `resolving-merge-conflicts` skills are adapted from [mattpocock/skills](https://github.com/mattpocock/skills) (MIT)

## License

[MIT](LICENSE)
