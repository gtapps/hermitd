---
name: claude-harness-canary
description: Run the minimum current-Claude compatibility canary for hermitd by driving real interactive Claude Code instances in tmux with --plugin-dir. Use before a core release or after a Claude Code upgrade to verify cached model switching, unattended prompt safety, and native Monitor/Cron routine lifecycle. Core only; not application testing or CI.
---

# Claude Harness Canary

Run all three groups serially against the currently installed Claude Code. Take no arguments and do not offer group selectors. Target 5–8 minutes, but preserve bounded waits and evidence over that estimate.

Keep this canary core-only, current-Claude-only, interactive-tmux-only, and loaded through `--plugin-dir`. Never add it to CI, release commands, or `$pre-release-review`.

## Shared probe prerequisite

Reuse the installed `$probe` lifecycle. Before creating canary state, read its active `SKILL.md` and require all of these properties:

- real interactive Claude in tmux, never `claude -p`, Codex, or another PTY;
- no interactive `--no-session-persistence`;
- `tmux pipe-pane` starts before any input;
- one bounded readiness phase that detects the trust dialog, accepts it only when present, handles only explicitly recognized startup onboarding, and waits for the normal prompt;
- a unique output-only completion nonce whose complete value is never contiguous in the injected prompt;
- completion accepted only from assistant output after the requested evidence, never prompt echo;
- one bounded wait per canary action;
- teardown with `rm -r` only after validating the exact scratch path.

If any property is absent, stop before preflight and report:

`PREREQUISITE BLOCKED — update the local $probe protocol`

Do not recreate generic tmux lifecycle rules locally or hand-roll a fallback. Extend the probe lifecycle only for the multi-action assertions below.

## Preflight

Run from the repository root.

1. Resolve the absolute core path at `plugins/hermitd`.
2. Record bounded output from:

   ```bash
   claude --version
   claude --help
   tmux -V
   claude auth status --json
   ```

3. Require current help to expose `--plugin-dir`, `--model`, `--permission-mode`, and `--session-id`.
4. Require authentication through the default profile. Do not set `CLAUDE_CONFIG_DIR`.
5. Require these core files:

   - `.claude-plugin/plugin.json`
   - `hooks/hooks.json`
   - `scripts/lib/harness-command.ts`
   - `scripts/stop-pipeline.ts`
   - `scripts/hermitd-watchdog.ts`
   - `scripts/ask-gate.ts`
   - `scripts/apply-settings.ts`
   - `scripts/routines.ts`
   - `scripts/routine-monitor.sh`
   - `skills/hermit-routines/SKILL.md`

6. List tmux sessions and require no session whose exact name begins `claude-harness-canary-`. Do not kill an unknown prior session; report the prerequisite collision.
7. Inspect help for strict external-MCP isolation. When supported, use an empty file containing `{"mcpServers":{}}` with `--mcp-config` and `--strict-mcp-config`. If `--no-chrome` is supported, use it too: strict MCP config does not disable Claude's in-process Chrome integration. If the installed version does not support the strict MCP flags, record that limitation and continue with `--setting-sources project,local`; do not invent flags.
8. Apply the shared probe's one-time fullscreen-renderer onboarding normalization before the canary run. Do not attempt to detect that dialog by grepping raw `pipe-pane` output; current renderer terminal deltas scramble the visible wording.

Classify missing tmux, failed authentication, a stale canary session, or a deficient `$probe` as `PREREQUISITE BLOCKED`. Classify missing/rejected `--plugin-dir` as compatibility `FAIL`. Classify missing core files as implementation/setup `FAIL`.

## Run workspace

Generate a lowercase alphanumeric run ID and create exactly:

`/tmp/claude-harness-canary-<run-id>/`

Resolve and record the absolute path. Create one subdirectory per group and one replacement subdirectory only if that group uses its permitted retry. Give every process a unique tmux name and a UUID produced by `uuidgen` or an equivalent UUID generator.

For every group project, create:

```text
<group>/
├── .claude/
│   └── settings.local.json
├── .hermit/
│   ├── config.json
│   ├── sessions/SHELL.md
│   └── state/
│       ├── runtime.json
│       └── micro-proposals.json
├── empty-mcp.json
└── evidence/
```

Use the core `state-templates/SHELL.md.template` as `sessions/SHELL.md`. Initialize `micro-proposals.json` to the schema currently consumed by core; use an empty object/array only if the live reader accepts it. Keep every fixture minimal.

### Workspace trust

Plugin hooks are disabled until Claude trusts the exact project directory. A normal prompt is not proof of trust: Claude Code can reach it for a new `/tmp` project while recording `hasTrustDialogAccepted: false` and silently skipping every hook (observed on 2.1.220, 2026-07-27; still true on 2.1.258).

Before each formal group launch:

1. Resolve the group project and require it to be a direct child of the recorded run root.
2. Read the default profile's `~/.claude.json` and require the exact `.projects["<absolute-group-project>"]` entry to be absent. A pre-existing entry means the supposedly fresh group is not isolated; stop rather than overwriting it.
3. Because the canary created and controls every byte in this exact directory, atomically add only that exact project entry with `{"hasTrustDialogAccepted":true}`. Preserve every unrelated key and the file's mode. Use an optimistic read/verify/write; if the profile file changes concurrently, re-read and retry rather than replacing a newer file. Never trust the run root, `/tmp`, the repository, a parent directory, or any path the canary did not create.
4. Re-read the profile and require the exact flag to be `true` before launching Claude. Record the trust preparation without copying unrelated profile state into evidence.
5. After readiness and before the first action, require `state/last-operator-action.json` to exist with a parseable `at` timestamp. This is the deterministic SessionStart-hook sentinel. A normal prompt without this file is `FAIL — workspace trust/hook readiness not established`; do not continue the group.

The trust entry is temporary canary state. During cleanup, after the exact group's Claude process is gone, atomically remove only its exact `.projects[...]` entry if it was absent before preparation. Preserve all unrelated profile state and handle concurrent writes with the same optimistic retry. Do this on PASS, FAIL, and INCONCLUSIVE; removing the project entry does not remove its transcript.

Set in every inner process:

- `AGENT_DIR=<absolute-group-project>/.hermit`
- `CLAUDE_PROJECT_DIR=<absolute-group-project>`
- a group-specific `AGENT_HOOK_PROFILE`
- `HERMIT_MANAGED` only where the group requires it
- `CLAUDE_CODE_TASK_LIST_ID` unset with `env -u CLAUDE_CODE_TASK_LIST_ID`

Write `state/runtime.json` with the exact group tmux name, `runtime_mode: "tmux"`, and a running status. Do not include `transition`, `shutdown_requested_at`, or `shutdown_completed_at`.

Never use `--continue` or `--resume`. Launch from the group project with the current equivalent of:

```bash
env -u CLAUDE_CODE_TASK_LIST_ID \
  AGENT_DIR="<absolute-hermit-dir>" \
  CLAUDE_PROJECT_DIR="<absolute-project-dir>" \
  AGENT_HOOK_PROFILE="<profile>" \
  claude --model "<group-model>" \
    --permission-mode "<mode>" \
    --session-id "<uuid>" \
    --setting-sources project,local \
    --plugin-dir "<absolute-core-path>" \
    <supported-empty-mcp-and-no-chrome-flags>
```

Start each process in a 220×50 tmux pane behind the shared probe’s one-shot FIFO launch gate. Attach `tmux pipe-pane` while the gate is closed, then release `exec claude` once so no startup screen can race logging. Use the shared probe readiness phase: one bounded 60-second wait that handles an optional trust dialog and returns only at the normal prompt. The profile flag and SessionStart sentinel above are still mandatory; renderer readiness alone is insufficient.

For each action, generate a new nonce split into two prompt fragments. Wait for the concatenated output-only nonce with one bounded `timeout`/`tail -F` action wait, capped at 60 seconds for this canary. Record the log offset before the action so earlier output cannot satisfy the wait. Verify every match belongs to a Claude assistant response block and follows the action evidence. If 60 seconds expires, stop the passive wait and immediately take one `tmux capture-pane -p -t <session>` for diagnosis; inspect the known transcript rather than waiting for the generic probe's ten-minute ceiling.

Locate transcripts only by the known session UUID under the default Claude profile. Never inspect or record unrelated transcripts.

## Retry policy

Retry a group once only when the model did not exercise the requested action, for example:

- no `AskUserQuestion` call;
- no required `CronList`, `Monitor`, `TaskStop`, `CronCreate`, or `CronDelete` call;
- no requested output nonce.

Before retrying, tear down every exact native resource harvested from that attempt and kill only its named tmux session. Use a fresh project, tmux name, and Claude UUID.

Never retry a directly observed compatibility failure, authentication/tmux failure, unexpected or missing required `/model` dialog, hook contradiction, nonempty scheduler baseline, explicit native tool failure, or cleanup failure.

## Group 1 — Cached `/model` switch

### Setup

Use Haiku with `acceptEdits`, the full core hook manifest, and `AGENT_HOOK_PROFILE=minimal`. Set `HERMIT_MANAGED` to empty. Seed a minimal interactive config with no channels, heartbeat, routines, transitions, or shutdown stamps. Point `runtime.json` at this group’s exact tmux session.

This journey begins at `state/pending-harness-command.json`. Stage it outside the inner Claude process by importing and calling the core module’s exported `writePendingCommand()` with:

```json
{
  "command": "/model",
  "arg": "sonnet",
  "by": "claude-harness-canary",
  "requested_at": "<current ISO timestamp>"
}
```

Do not hand-write marker JSON and do not add a channel fixture.

### Procedure

1. Send a small context-establishing prompt and wait for its output-only nonce.
2. Verify the completed assistant transcript entry is Haiku-class.
3. Call `writePendingCommand()` and verify it returned true and the marker exists.
4. Record the pipe log offset. Send a short trigger prompt and wait for the completed turn. Its real Stop hook must drain the marker.
5. In output after the recorded offset, require the current cached-context model-switch dialog anchors implemented by core:

   - `Switch model?`
   - `This conversation is cached for the current model.`
   - `Yes, switch to`
   - `No, go back`

6. Allow only the real Stop pipeline to confirm it. Send no canary Enter. Wait for the dialog to clear and the normal prompt to return.
7. Send a post-switch prompt with a new output-only nonce.
8. Locate the transcript by UUID and inspect the newest assistant entry’s `message.model`.

### Verdict

PASS only when:

- pane and Stop-hook evidence show one submission event for `/model sonnet`;
- the marker was removed only after successful command submission;
- the required cached-context dialog appeared after the trigger;
- it cleared without canary input;
- no unrelated modal or prompt received Enter;
- the post-switch turn completed;
- the newest assistant model is Sonnet-class, not Haiku.

Count semantic submission events, not incidental hook log repetitions of the command text.

FAIL when the dialog remains open, confirmation is not sent, an unrelated modal receives Enter, the command is submitted twice, the marker disappears without submission, or the post-switch model remains Haiku.

If the switch succeeds directly without the required dialog, do not retry. Report:

`INCONCLUSIVE — switch worked, cached-confirmation contract not exercised`

and add `Not exercised — needs manual review`.

## Group 2 — Native modal and Ask gate

Run both assertions in one fresh Sonnet session (`--model sonnet`). Use Claude’s native manual approval mode (`--permission-mode manual`). Set `HERMIT_MANAGED=1`, `always_on: true`, `ask_gate: true`, and `AGENT_HOOK_PROFILE=standard`.

Seed exactly one eligible fake channel:

```json
{
  "channels": {
    "primary": "canary",
    "canary": {
      "enabled": true,
      "default_chat_id": "canary-chat"
    }
  }
}
```

Do not add `allowed_users`. Do not create `state/channel-health.json`. Keep `.claude/settings.local.json` free of Hermit’s permission allow-list so the first assertion reaches a real native permission dialog.

### A. Native permission modal

1. Choose a unique harmless target inside the group project.
2. Prompt Claude to call `Write` once to create it.
3. Wait for the native permission dialog.
4. Capture the visible pane exactly with:

   ```bash
   tmux capture-pane -p -t "<session>"
   ```

   Do not add `-S` and do not substitute pipe-pane scrollback. Store stdout from this single capture immediately.
5. Import `hasPendingQuestion()` from the live `scripts/hermitd-watchdog.ts`, pass the stored capture bytes from Step 4 without recapturing, and record the boolean.
6. Send Escape once, wait for the normal prompt, and send a harmless nonce prompt to prove the session remains usable.
7. Verify the target does not exist.

PASS requires a real native permission modal, `hasPendingQuestion() === true`, Escape cancellation, no target file, and a usable session.

### B. Ask-gate regression

1. Record the transcript and log offsets.
2. Prompt Claude to invoke `AskUserQuestion` exactly once with three fixed harmless options. Require the call rather than a prose-only answer.
3. Wait for its final assistant response and output-only nonce.
4. Inspect only this action’s transcript entries and log slice.

PASS requires:

- exactly one `AskUserQuestion` tool-use attempt;
- the real `ask-gate.ts` PreToolUse hook denied it with exit 2;
- the hook’s redirect reason reached Claude;
- no native Ask widget rendered;
- Claude did not retry `AskUserQuestion`;
- the session returned to a usable prompt.

Claude may fall back to prose. Do not require a channel reply or micro-proposal.

If Claude never attempts `AskUserQuestion`, cleanly retry the whole group once in a fresh session. If it declines again, report `INCONCLUSIVE` and `Not exercised — needs manual review`.

## Group 3 — Routine scheduler lifecycle

### Setup

Use a fresh Sonnet session (`--model sonnet`) in `acceptEdits`, with `AGENT_HOOK_PROFILE=standard`, no channel, no external integration, and `CLAUDE_CODE_TASK_LIST_ID` unset.

Seed UTC config with:

- one enabled `heartbeat-restart` anchor;
- one enabled routine whose ID includes the run ID and whose harmless skill is an existing core read-only skill;
- schedules on the first day of a month at least five months ahead, separated by five minutes, so neither can fire during this run.

Use the live deterministic settings operation before launch:

```bash
bun "<core>/scripts/apply-settings.ts" \
  "<project>/.claude/settings.local.json" permissions-sync
```

Do not hand-copy the allow-list.

### Isolated baseline

1. First prompt Claude to call `CronList` and make no mutation. Permit `ToolSearch` only when this Claude version requires it to expose the deferred `CronList` tool; forbid every other tool and scheduler mutation.
2. Inspect the transcript call and result.
3. Require an empty list.

If the list is nonempty, perform no scheduler mutation. Report `FAIL — scheduler baseline was not isolated`, preserve evidence, and continue only with tmux cleanup.

Do not use `TaskList` as a substitute for Monitor inventory; it is a checklist surface. The routine skill's own exact-description `TaskList` orphan sweep remains permitted.

### Load

Send:

`/hermitd:hermit-routines load`

Wait with one bounded action wait. Harvest every native creation result from the known transcript:

- Monitor `taskId`;
- every `CronCreate` ID;
- selected runtime branch.

Accept either supported branch.

Monitor branch PASS evidence:

- Monitor returns a task ID;
- description is exactly `routine-monitor`;
- `state/routine-monitor.runtime.json` records `mode: "monitor"` and that task ID;
- `state/routine-monitor-liveness.json` appears;
- the `heartbeat-restart` anchor is created through `CronCreate`.

Cron fallback branch PASS evidence:

- Monitor is explicitly unavailable or fails liveness verification;
- the workflow selects `croncreate-fallback`;
- each expected routine receives a `CronCreate` ID;
- runtime state records `mode: "croncreate-fallback"`.

A correctly selected, working fallback is PASS.

### Exact-ID teardown

Never invoke `hermit-routines stop --all`. Never delete by prompt pattern, routine prefix, description, or an ID not harvested from this run.

1. Send one teardown prompt containing only the exact harvested IDs.
2. Require `TaskStop` only for the Monitor task ID returned by this run.
3. Require `CronDelete` only for Cron IDs returned by this run.
4. Require one final `CronList`.
5. Verify every harvested Cron ID is absent and each native deletion succeeded.
6. Terminate this group’s Claude process, which independently ends its session Monitor and prevents session-scoped crons from firing.
7. Preserve teardown transcript evidence before scratch cleanup.

If Claude omits a required native call without an explicit tool failure, clean exact resources and retry once in a fresh group. Never retry an explicit tool failure or any cleanup failure. Cleanup failure is `FAIL`, not `INCONCLUSIVE`.

## Optional release-specific probe

Do not run `/compact` in the fixed canary.

Run a separate one-off `/compact` tmux probe only when the release changes `/compact` delivery, `PreCompact`, compact `SessionStart`, or compaction-context reinjection. Do not add it to this fixed skill until a cheap, reliable fixture guarantees compactable context.

Treat other Claude-owned assumptions the same way. Promote one into the fixed canary only when repeated failure would stall Hermit, bypass a safety boundary, or disable always-on operation.

## Cleanup

For every outcome:

1. Stop or delete only native resources created by that group and identified by exact returned IDs.
2. Kill only each group’s recorded tmux session.
3. Re-resolve the run root and require exact equality with the recorded `/tmp/claude-harness-canary-<run-id>` path.
4. On an all-PASS run, remove that exact root with `rm -r`.
5. On FAIL or INCONCLUSIVE, preserve evidence after native and tmux cleanup and report its exact path.

Never use `rm -rf`.

## Report

Record the Claude version, model and permission mode per group, tmux and Claude session identifiers, bounded pane/transcript evidence, retry use, and exact cleanup IDs/results. Never record credentials, account identity, unrelated transcripts, or real Hermit state.

Use:

```text
# Claude Harness Canary — <Claude version>

| Group | Verdict | Duration | Evidence |
|-------|---------|----------|----------|
| Cached /model switch | PASS/FAIL/INCONCLUSIVE | ... | ... |
| Prompt safety | PASS/FAIL/INCONCLUSIVE | ... | ... |
| Routine scheduling | PASS/FAIL/INCONCLUSIVE | ... | ... |

Overall: PASS | FAIL | INCONCLUSIVE
```

`PASS` means every required assertion and cleanup check passed. `FAIL` means a required contract was directly contradicted. `INCONCLUSIVE` means the contract was not exercised after the permitted noncompliance retry. Only PASS is green.

Every INCONCLUSIVE row must include:

`Not exercised — needs manual review`

Do not present INCONCLUSIVE as a compatibility failure. If preflight never starts, report `PREREQUISITE BLOCKED` instead of the table.
