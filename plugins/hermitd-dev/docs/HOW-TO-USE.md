# How to Use

## Prerequisites

- [Claude Code](https://code.claude.com) v2.1.308+
- [hermitd](https://github.com/gtapps/hermitd) core, installed and hatched; `/hermitd-dev:hatch` enforces the required version from `.claude-plugin/hermit-meta.json`
- Node.js 24+ (for the `git-push-guard` hook at strict profile)

---

## Setup

```bash
claude plugin install hermitd-dev --marketplace gtapps/hermitd --scope local
/hermitd-dev:hatch
```

The wizard configures protected branches and installs strict hook enforcement with an explicit opt-out.

**Already set up?** Re-run `/hermitd-dev:hatch` any time. Every key offers `Keep current (<value>)` as the recommended option, so you can sweep through with Enter-presses to fast-confirm — or change individual values.

---

## The Dev Cycle

After `/hatch`, git safety uses core's approval prompts and the strict push guard.

### 1. Plan

Break the task into ordered steps in the Progress Log. Skip for trivial single-step work.

### 2. Branch and implement

Follow the project's development workflow. Core's approval prompts and, on always-on hermits, `git-push-guard` at strict enforce git safety.

### 3. Verify and publish

Follow the project's own tests and workflow. Run `/simplify` for cleanup and verify the final changes. When publishing is authorized, push the feature branch and open a PR through the project's workflow or the forge CLI. Record the PR URL in the Progress Log before archiving the task.

### 4. Reflect

At every task boundary, the hermit invokes `reflect` to surface patterns. These become proposals you can accept, defer, or dismiss.

---

## Branch Cleanup

Use the project's branch cleanup workflow:

```bash
# Delete merged feature branches (skip protected branches):
git branch --merged main | grep -vE '^\*|main|master' | xargs -r git branch -d
```

Or set up a recurring routine via `/hermitd:hermit-routines` if you want it automated.

---

## Parallel Work

- **Same change across many files** — use `/batch` (built-in)
- **Independent tasks** — use multiple `Agent` tool calls in a single message, or implement sequentially
- **After parallel work** — run `/simplify` in the main session

---

## Optional Plugins

See [Recommended Plugins](RECOMMENDED-PLUGINS.md) for plugins you can add yourself.

---

## Tips

- **First session in a new project?** Let the agent orient itself before starting work — read existing code, review tests, scan the README.
- **Talk to your hermit.** "What slowed you down?" / "Suggest improvements" — feedback feeds into the learning loop.
- **After plugin updates**, run `/hermitd:hermit-evolve` to run dev migrations.
- **Proposals have categories.** Dev-specific prefixes (`[missing-tests]`, `[tech-debt]`, `[dependency]`, `[tooling]`, `[architecture]`) keep things organized.
- **"What should I be fixing?"** Run `/hermitd-dev:domain-brainstorm`. It reads git churn, manifest drift, and README coverage to surface at most 2 grounded improvement ideas as PROPs : no manual triage needed.
- **Channel activation**: run `/hermitd:channel-setup` for messaging between operator and hermit.
