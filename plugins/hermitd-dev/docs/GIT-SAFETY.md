# Git Safety

Git safety uses core's native approval prompts and the `git-push-guard` hook (strict profile only).

## git-push-guard Hook (Strict Profile)

A `PreToolUse` hook that intercepts Bash commands before they execute. Strict profile only (`AGENT_HOOK_PROFILE=strict`). At lower profiles the hook exits 0 immediately and does not inspect commands.

**Protected branches** — configured via `hermitd-dev.protected_branches` in `.hermit/config.json`. Defaults to `["main", "master"]` if absent or unreadable. Glob patterns are supported (`release/*` matches `release/1.2`, `release/2.0-beta`, etc.).

```json
{
  "hermitd-dev": {
    "protected_branches": ["main", "staging", "release/*"]
  }
}
```

**Blocks (at strict):**

| Pattern | Why |
|---------|-----|
| `git push` to a protected branch (in any refspec form: `main`, `:main`, `+main`, `HEAD:main`, `refs/heads/main`) | Mainline protection |
| `git push --delete` / `:branch` to a protected branch | Prevents remote branch deletion |
| `git push --mirror`, `--all`, `-a` | Would push everything, including protected |
| `--no-verify` anywhere on the command line | Prevents bypassing pre-commit hooks |
| `--force`, `-f` (bare force) | History rewrite without lease protection |
| `--force-with-lease` to a protected branch | Mainline protection takes precedence over the lease |
| `--force-with-lease` without an explicit refspec (e.g. `git push --force-with-lease origin`) | Ambiguous target — blocked to avoid pushing to the wrong branch |

**Allowed:** `--force-with-lease` to a non-protected branch with an explicit refspec (e.g. `git push --force-with-lease origin feature/x`). This is the safe operation `--force-with-lease` was designed for: lease-protected overwrite of your own feature branch after a rebase. The blanket block in earlier v0.3.0 betas was harsher than the safety story warranted — see CHANGELOG `[0.3.0]` for the reasoning.

**Allows:**

- Push to non-protected feature branches
- All non-git commands
- Everything at non-strict profiles

**Trade-offs of the regex-based guard** (v0.3.0 simplified the prior 286-line tokenizer to ~80 lines of regex):

- **False positive on commit messages**: `git commit -m "fix --no-verify behavior"` is blocked. Use a different word in the message.
- **False positive on nested branch names with glob protection**: with `release/*` configured, `git push origin feature/release/x` is blocked. Rename the branch.
- **False negative on plain `git push`** (no remote, no refspec): not inspected — the guard cannot resolve tracking-branch configuration without git access. At strict, if you rely on tracking-branch pushes, also use explicit refspecs.

The trade-off rationale: false positives are 5-second annoyances; false negatives let bad pushes through.

**Implementation:** `scripts/git-push-guard.ts` reads JSON from stdin, exits 0 (allow) or 2 (block). Fails open on parse errors (exit 0). No runtime dependencies. Adapted from [Everything Claude Code](https://github.com/affaan-m/everything-claude-code) (MIT).

---

## worktree-boundary-guard Hook

A `PreToolUse` hook on `Edit`/`Write` for the `claude --worktree` workflow. When the session runs inside a linked git worktree (Claude Code's default layout nests these under `<repo>/.claude/worktrees/<name>/`, sharing a path prefix with the main checkout), the agent can drift into editing the main checkout instead of the worktree. This hook hard-blocks any edit whose resolved `file_path` escapes the worktree into the main checkout.

- **Detection is the gate, not a profile.** It runs `git rev-parse` to compare the session's git dir against the common git dir; outside a linked worktree it exits 0 immediately. It ships **always-on** (no `AGENT_HOOK_PROFILE` gate) — a `claude --worktree` launch that omits the strict profile won't silently skip it.
- **Carve-out:** writes under the main checkout's `.hermit/` are allowed: a worktree session's hermit state (tasks/, state/) intentionally resolves up to that gitignored directory.
- **Escape hatch:** set `WORKTREE_GUARD=off` to disable without editing code.
- **Scope:** `Bash` command-string parsing (`cd`/`git -C` into main) is deliberately not handled — `Edit`/`Write` are the actual file-mutation path and always carry an absolute `file_path`. `NotebookEdit` is not covered (its path field differs).

**Implementation:** `scripts/worktree-boundary-guard.ts`, exits 0 (allow) or 2 (block), fails open on any error. No runtime dependencies.

---

## Hook Profiles

| Profile | Hook behavior | When to use |
|---------|---------------|-------------|
| `minimal` / `standard` | `git-push-guard` exits 0 immediately | Use core's permission rules without push-guard enforcement |
| `strict` (default after `/hatch`) | `git-push-guard` blocks the patterns above | Day-to-day work; always-on / Docker deployments; anything production-adjacent |

`/hatch` defaults to installing strict and offers an explicit opt-out. Once strict, re-running `/hatch` never silently downgrades.

To change the profile manually:

```
/hermitd:hermit-settings env
→ set AGENT_HOOK_PROFILE to strict (or standard / minimal)
```

Or edit `.hermit/config.json` directly: `"env": { "AGENT_HOOK_PROFILE": "strict" }`.

---

## Core permission rules

Core hermit seeds native Claude Code `permissions.deny` / `permissions.ask` at hatch. Standard (default) hard-blocks catastrophic commands (`rm -rf`, credential dumps, marketplace edits) and prompts for risky ops (`ssh`, `docker`, `kubectl`, `npm publish`, force push, `--no-verify`, settings / OPERATOR.md edits). Hardened puts both classes in `permissions.deny`. Skip seeds nothing.

`git-push-guard` is **complementary**, not redundant. It activates under `AGENT_HOOK_PROFILE=strict` and is independent of the seeded rules:

| Trigger | Covers |
|---------|--------|
| Core seeded permission rules | Hatch-time Standard/Hardened entries in the project settings file |
| `git-push-guard` (`strict` profile) | Interactive or autonomous mode with `AGENT_HOOK_PROFILE=strict` |

---

## Approval prompts and push guard

Core seeds approval prompts for risky operations. The strict push guard adds a hard `bash`-time block on always-on hermits.
