# How to Use

## Prerequisites

- [Claude Code](https://code.claude.com) v2.1.292+
- [hermitd](https://github.com/gtapps/hermitd) core, installed and hatched; `/hermitd-dev:hatch` enforces the required version from `.claude-plugin/hermit-meta.json`
- Node.js 24+ (for the `git-push-guard` hook at strict profile)

---

## Setup

```bash
claude plugin install hermitd-dev --marketplace gtapps/hermitd --scope local
/hermitd-dev:hatch
```

The wizard configures protected branches, installs strict hook enforcement with an explicit opt-out, syncs dev instructions, and offers Context7.

**Already set up?** Re-run `/hermitd-dev:hatch` any time. Every key offers `Keep current (<value>)` as the recommended option, so you can sweep through with Enter-presses to fast-confirm — or change individual values.

---

## The Dev Cycle

After `/hatch`, agents follow Git Safety and Branch Discipline in CLAUDE.md, with resident task bookkeeping in `.hermit/RESIDENT.md`.

### 1. Plan

Break the task into ordered steps in the Progress Log. Skip for trivial single-step work.

### 2. Branch and implement

Per `§Branch Discipline` in the injected CLAUDE.md:

1. Verify clean working tree (`git status --porcelain` empty).
2. Branch from the first entry of `protected_branches` (defaults to `main`): `git checkout -b <prefix>/<slug> origin/<base>`.
3. Name the branch `<prefix>/<slug>` where `prefix ∈ {feature, fix, chore, hotfix}`.
4. Inside an open record's turn, pipe the creation note into `.hermit/bin/hermitd-run task note .hermit <id>`. Otherwise skip the note.

Then write the code. The CLAUDE.md `§Git Safety` rules apply throughout: feature-branch pushes only, no `--no-verify`, no commits to protected, no force-push. At strict hook profile, `git-push-guard` blocks the dangerous commands at `bash` time.

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

## Companion Plugins

The setup wizard offers `context7` from `claude-plugins-official`. See [Recommended Plugins](RECOMMENDED-PLUGINS.md) for details.

---

## Tips

- **First session in a new project?** Let the agent orient itself before starting work — read existing code, review tests, scan the README.
- **Talk to your hermit.** "What slowed you down?" / "Suggest improvements" — feedback feeds into the learning loop.
- **After plugin updates**, run `/hermitd:hermit-evolve` to sync the dev block.
- **Proposals have categories.** Dev-specific prefixes (`[missing-tests]`, `[tech-debt]`, `[dependency]`, `[tooling]`, `[architecture]`) keep things organized.
- **"What should I be fixing?"** Run `/hermitd-dev:domain-brainstorm`. It reads git churn, manifest drift, and README coverage to surface at most 2 grounded improvement ideas as PROPs : no manual triage needed.
- **Channel activation**: run `/hermitd:channel-setup` for messaging between operator and hermit.
