---
name: downstream-impact
description: Explain in plain language what a fix, feature, PR, or plan will actually change for downstream hermits and the operators chatting with them — a before/after flow plus a diagram. Use whenever the operator asks "what will really change for downstream hermits and operators", "how does this affect operators", "will operators notice", "before and after for hermits", "what changes in the flow", "downstream impact", "show me the impact in a diagram", or types /downstream-impact [target]. Works on the current diff, a branch, a PR number, a plan file, or a change described in chat. Do NOT use for changelog-vs-code audits (/pre-release-review), docs audits (/docs-drift), or a generic diagram with no downstream-hermit angle (delta-diagrams alone).
---

# Downstream Impact

The question behind every invocation: **if this ships, what does a hermit running on someone else's box do differently, and what does the person chatting with it notice?** Not the diff, not the architecture. The reader is the maintainer deciding whether a change is worth shipping, how to word the changelog, or how to explain it to an operator on Discord.

Read-only. Never edits, commits, or releases.

## Usage

- `/downstream-impact` — the change under discussion in this conversation; otherwise `git diff main...HEAD` plus the working tree; on a clean `main`, every plugin's `[Unreleased]` section.
- `/downstream-impact <PR number>` — `gh pr diff <N>` and the PR body.
- `/downstream-impact <branch>` — that branch against `main`.
- `/downstream-impact <plan file>` — the plan's steps, before anything is built.
- `/downstream-impact "<described change>"` — a change that exists only as an idea; label every claim as assumed.

## Step 1 — Locate the touchpoints

A change reaches downstream only through a few surfaces. Read only what the diff (or plan) touches and check each surface:

- **Operator chat**: channel notices, push notifications, `AskUserQuestion` prompts, skill text that composes messages. Does the operator see new, fewer, or differently worded messages? Is there a new thing they can ask for?
- **Hermit flow**: hooks, heartbeat, routines, watches, watchdog, session start/close. Does the hermit wake more, less, or for a different reason? Did a step move from the model to a script, or the reverse?
- **Upgrade path**: `templates/`, migrations, `### Upgrade Instructions`. What does `hermit-evolve` rewrite, what does the operator do by hand, what operator-edited file survives.
- **Gates**: `engines["claude-code"]`, `required_core_version`, new config keys, permission or deny rules, default on or off. Who is excluded, who has to opt in.
- **Cost**: per-wake context, hook stdout, new always-loaded text.
- **Reach**: `main` is staging. Installed operators see nothing until the plugin's `version` bumps; `--plugin-dir` testers and fresh installs see `main` HEAD. Say which group this reaches today.

If the change touches none of these (tests, docs, a behavior-preserving refactor), the answer is **"no visible change"** in one line, plus who could still notice (contributors, CI). Do not invent an impact to fill the template.

## Step 2 — Write it

Load `delta-diagrams` before drawing. Output in this order, and keep the whole thing to one screen:

1. **Verdict, one sentence.** Who notices, and whether anyone has to do anything.
2. **Operator: before → after.** What they see in chat and what they must do. Two or three lines.
3. **Hermit: before → after.** What it does on its own, and when. Two or three lines.
4. **Diagram.** The `delta-diagrams` straight before/after flow of the operator ↔ hermit loop. Use the decision-tree shape only when the change forks (opt-in vs default, old CC vs new CC).
5. **On upgrade.** What `hermit-evolve` does and anything the operator must do by hand. "Nothing" is a valid and common answer.
6. **Not changing.** One line naming what someone might assume changed but does not.

Add a final **For the maintainer** line only when there is detail the operator-facing text had to leave out (version floors, spend, the surface that carries it).

## Voice and calibration

- Plain language an operator on Discord could read. Sections 1 through 6 carry no file paths, function names, PROP or issue IDs, slash commands, or token counts; those go in the maintainer line. Say "the hermit now compacts before it hits the ceiling", not "watchdog threshold changed".
- Every "after" claim traces to a diff hunk or a plan step. If you cannot point at one, drop it or mark it *assumed*.
- Downstream hermits are custom and dynamic: describe the mechanism that changes, not one install's state.
- Never use this hermit's own session history as evidence of downstream behavior. Target users are operators who do not open feature branches.
