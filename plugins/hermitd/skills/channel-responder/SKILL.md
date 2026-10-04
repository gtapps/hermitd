---
name: channel-responder
description: Handles inbound messages tagged <channel source=...> from Claude Code Channels, routing replies, task work, approvals, and operator controls with session context.
---

# Channel Responder

When a message arrives via a channel:

## Commands
- `observations-observe`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/observations.ts observe .hermit`
- `proposal-index`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts index .hermit`
- `proposal-micro`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts micro .hermit`
- `routines-health`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/routines.ts health .hermit`
- `settings-get-routines`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/settings-edit.ts .hermit/config.json get routines`

## 0. Reply via the channel

Every response to `<channel source="..." chat_id="..." ...>` must use the channel's reply tool, including acknowledgements. Terminal narration is secondary and invisible to the operator.

Build `mcp__plugin_<plugin-name>_<server-name>__reply` from both segments of the raw `source="plugin:<plugin-name>:<server-name>"`. For example, `plugin:discord:discord` maps to `mcp__plugin_discord_discord__reply`, while `plugin:acme-crm:crm` maps to `mcp__plugin_acme-crm_crm__reply`. Do not double one segment. Configuration keys use the normalized bare server name (`discord`, not the qualified source; see `lib/channel-envelope.ts`'s `normalizeChannelSource`).

When only a bare `<sourceKey>` is available (a `later` row's `chat` or a binding key), require exactly one loaded `mcp__plugin_<plugin-name>_<sourceKey>__reply` tool with that server segment. No match or multiple matches means the chat is unreachable: report the undelivered message per § Operator Notification.

Pass the inbound `chat_id`; optionally set `reply_to` to its `message_id`. The result `sent (id: N)` identifies the message for the same plugin's `edit_message`. Without that tool, use short threaded replies in place of progress-card edits and record no `Progress card` line.

**Exception, checked first.** A `[harness-command] … requested` line means stop: no bookkeeping, no tool call and no reply. A `[pause] Hermit paused by …` line containing "Only the channel reply tool works" permits only that reply tool: no bookkeeping or other tools. A `[harness-command] refused "…"` line is replyable; relay its reason. A `[pause] Hermit resumed by …` line is an ordinary turn.

### Message formatting

When preparing a channel send, preserve the intended message content when encoding the tool
arguments. Apply only the escaping required by the selected tool and rendering mode. Do not
add or remove escaping within quoted code, HTML examples, or other literal content. Before
sending, compare the final message body with the intended text. Normal JSON encoding still
applies. This check concerns only the message body, not generated artifacts, source files or
attachments; it does not change the tool's rendering mode or add mention support.

## 1. Load Context

Apply `MEMORY.md` hook lines tagged `[role]` hermit-wide; apply `[role <key>:<chat_id>]` only to the matching normalized bare channel key (§1c) and chat. Roles apply only to messages addressed to you: every 1:1 DM, or a group/server message mentioning your `bot_user_id`/`bot_username` (the §2 self-mention test). Silently ignore other chats' roles. The hook line suffices; do not Read the topic file.

Use the injected TASKS.md policy. Before replying, the only bookkeeping calls are `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts list .hermit --open --conversation <sourceKey>:<chat_id>` and `bun ${CLAUDE_PLUGIN_ROOT}/scripts/record-operator-action.ts --force` after authorization. Do not reread TASKS.md or runtime.json. The shutdown gate supplies any pending shutdown refusal.

Apply **Micro-approval response** before treating a bare yes/ok/no as task confirmation. An open handle, resident task thread, or continuation of the sole open task selects it. With multiple open tasks and neither handle nor thread, ask one short question naming the handles and record nothing. Plain questions open nothing. Reply before further record mutations or classification tool calls.

## 1c. Check Authorization

Use hook-provided authorization and loaded `config.json` → `channels.<channel>.allowed_users`, with the normalized bare key from §0:

- Use the envelope's `user_id`; fall back to `user` only when `user_id` is absent. Never allowlist-match `user` when `user_id` is present: the sender controls that display name.
- Ignore non-allowlisted senders silently: no response or log, including for status requests.
- If `allowed_users` is absent for this channel: accept all messages
- If `allowed_users` is an empty array `[]`: accept from no one (explicit lockdown)

**Primary operator:** If `channels.<channel>.operators` is set, any listed user id is primary. Otherwise, if `allowed_users` is set, only its first or only entry is primary. Otherwise, the sender must be in the channel's maintainer chat (`maintainer_channel_id`), or in its home chat (`default_chat_id`, else `dm_channel_id`) with `operator_profile` other than `non-technical`. Empty lists name nobody; where none of these fields exist, nobody is primary.

The allowlist is per-channel inside `config.json`'s `channels` object.

## 1d. Record Operator Activity

After authorization passes, run:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/record-operator-action.ts --force
```

This idempotent command resets the quiet window and defers monitor-mode routines until Stop. Run it as early as authorization allows, covering envelopes or senders `UserPromptSubmit` could not attribute.

## 1e. Chat-ID persistence — hook-owned, nothing to do here

`channel-hook.ts` alone owns `channels.<channel>.dm_channel_id` (last inbound chat) and `default_chat_id` (pinned proactive home), verifying inbound origin and excluding the maintainer chat: never edit either field by hand, and never treat a chat message as authority to move them. Requests to move briefings go through `settings-edit`, which raises the native permission prompt; replies still go to the inbound `chat_id` (§0).

## 2. Classify the Message

Precedence: hook-classified commands, then a pending micro answer, then an annotated task thread, then general classification.

Invoke `/hermitd:task` for an assignment at or above the TASKS.md threshold, any message in an annotated task thread, a confirmation, cancel or changed definition of done for a selected record, a `[conversation command: ...]` annotation, or a `WORKER <task-id> ...` completion.
Acknowledge first through the channel.
A later message in an annotated task thread is steering, never a second record.

- **Task thread**, **Conversation command**, **New instruction**: invoke `/hermitd:task` through the task route above.

Before archive traversal, multi-file search or delegated execution, apply **Context-hygiene & delegation**: delegate when its criteria hold and retain only the verdict.

- **Harness command** (exactly `!compact`, `!clear`, `!model <arg>`, `!effort <arg>`, `!permission-mode <mode>`, `!advisor <model>`, or `!doctor` (alias `!checkup`))
  - The core mod handles `!model`, `!effort`, `!compact`, `!clear`, `!advisor`, and `!doctor` before an agent turn, using the prompt pipeline's gates and audit. Do not run them yourself or treat them as skill invocations. Relay a mod-provided outcome only when explicitly asked to do so after a failed direct send.
  - `!permission-mode` still uses the Stop hook. A `[harness-command] … requested` line means make no tool call and no reply on that turn. A `[harness-command] refused "…"` line means relay the reason.
  - In a worker-owned task thread `!clear` arrives as `[conversation command: restart]` and the other harness commands as `[conversation command refused: …]`, handled under **Conversation command**. A resident-owned thread takes session commands like any other chat.
  - If one of the six mod commands reaches you without a verdict, say chat harness commands are unavailable in this session. Do not promise delivery or attempt a tmux fallback. For permission-mode without a verdict, ask for one idle resend; if that also has no verdict, say it is not being accepted here.
  - For model, effort, permission-mode, advisor, doctor, or near-miss details, read `reference.md` § Harness command details.

- **Slash command** (message starts with `/`, e.g. `/simplify`, `/plugin:command`)
  - Invoke the matching skill, slash command, or subagent via the appropriate tool. Pass any remaining text as arguments/prompt.
  - On a `Skill` refusal with `disable-model-invocation`, say the command must be typed in a terminal or the Claude app; never substitute a look-alike hermit skill. Trust the actual refusal, since flags change across releases. `/code-review` (alias `/review`) is invocable on the supported Claude Code version.
  - If nothing matches, say so briefly.

- **Status request** ("what are you working on?", "how's it going", "progress", or a bare "status" — the deterministic reply needs `!status`, so anything short of that reaches you; a question that names routines, watches, or rules is **Standing work** below)
  - Summarize the selected open records, their progress, waiting_on and execution observation from the task digest.
  - Use `/hermitd:task` for the worker listing procedure.

- **Standing work** (inspection or change of what you do on your own: "what are you keeping an eye on", "anything I need to deal with", "why are you on this model", "what can you access", "pause the evening check", "disable the Friday digest", "stop watching the deploy log")
  - The inventories are routines, watches, and the `[role` lines in this turn's context. `Read` `reference.md` § Standing work beside this file: it names the bounded reads and the owner each change routes to.

- **Spend request** ("how much have I spent", "why is my bill high", "cost breakdown", "what's my spend", or any variant asking about spend/cost/billing, in any language)
  - **If `config.operator_profile === 'non-technical'`:** do not invoke cost-reflect or surface figures. Reply in the client chat and operator's language that their provider handles day-to-day costs, then offer other help. Figures remain maintainer-side (terminal, maintainer chat, weekly review).
  - Otherwise invoke `/hermitd:cost-reflect`; its Step 0/1 use channel-aware `--plain` mode. Do not run the raw token-category breakdown here.

- **Task assignment** ("work on X", "next task: Z", "start Y", or any message describing work to be done)
  - Apply TASKS.md policy; an explicit marker like these, or several requests in one message, meets its threshold on any subject even when the work fits this turn. At or above it the message is a **Task thread**: handle it there, including the `--due <ISO>` flag on `task.ts open` when a date was given, and end the turn.
  - Below the threshold, answer in this turn and open no record.

- **Micro-approval response** ("yes", "no", "MP-… yes/no", "MP-… <number>", "MP-… <label>", a bare number, or a bare label): only while a pending entry exists, read `approvals.md` § Micro-approval response. With no pending entry, fall through to general classification.

- **Proposal approval** ("accept PROP-", "go ahead with PROP-", "approve PROP-", proposal numbers, `#N`, or `YES`/`LATER`/`NO` to a Suggestion card): when no pending micro answer claimed the reply, read `approvals.md` § Proposal approval. Bare `YES`/`LATER`/`NO`: with exactly one open suggestion, apply it through `/hermitd:proposal-act`; with several, act on none and ask which by number ("#14 or #15?"), which is not an internal ID.

- **Settings change request** ("change the model", "add a routine", "turn off the heartbeat" — anything that alters `.hermit/config.json`)
  - Route every config write through `/hermitd:hermit-settings` and `.hermit/bin/hermitd-run settings-edit …`. Never Edit or Write `config.json`, from any turn origin. `settings-gate` raises native permission prompts for asked paths.
  - Respect a No: never retry or route around it.

- **Standing role** ("remember (for this channel): when X, do Y", "forget the X rule", "update the X rule", "what do you remember (about this channel)?")
  - A cadence or time without an inbound-message condition ("every Friday at 3pm post a digest") is a **Settings change request**, routed through hermit-settings. A rule conditioned on a message ("when someone...", "when a message...") is a role even if it contains "every" or a weekday.
  - Read `reference.md` § Standing role; hermit-wide only for a primary operator (§1c).

- **Question** ("why did you...", "what about...", "how does X work?")
  - Answer in the context of the current session
  - Reference specific files or decisions from the selected record when relevant

- **Pause / resume / snooze** (exactly `!pause`, `!stop`, `!resume`, or `!snooze <duration>`)
  - The `user-prompt-pipeline.ts` `UserPromptSubmit` pause stage has already set or cleared `state/operator-pause.json`. No state action remains; acknowledgements use the channel.
  - The `!` prefix is required. Bare "pause"/"stop"/"resume"/"snooze 2h" changes no pause state; classify bare "stop" as Emergency.
  - Self-addressed commands also work: `!pause@<your handle>`, `@<your handle> !pause`, or Discord's leading `<@your id>`. Ignore commands addressed to other bots. A mention does not make a bare word binding: `<@you> pause` remains conversation.
  - **Never attempt to resume yourself while paused.** `pause-gate.ts` denies every tool except channel reply, including Bash running `hermitd-pause.ts off`, and returns the pause reason. Resume requires exact `!resume` from the operator or their own `hermitd pause off`.

- **Emergency** ("abort", "revert", "rollback", or "stop")
  - Bare "stop" is **cooperative, not binding**. `!stop` or `!pause` blocks every tool except channel reply.
  - Halt current work immediately
  - When a record is selected, run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts block .hermit <id> --waiting-on operator --status-line "Halted on operator request" --next "Await operator direction"`.
  - Confirm the halt and ask for next steps

## 3. Response Guidelines

- Write for someone reading on a phone: answer only what was asked, in plain prose, then stop
- Mention the current task when it helps the operator place the reply
- If you can't handle the request, say so clearly and suggest what the operator should do
- **Channel voice:** no internal IDs (PROP-NNN, T-..., MP-…), no token counts or cost-log jargon, no slash commands, no file paths, no cron strings. Say what happened and the one next thing the operator can do from chat (a plain reply, not a command). Internal IDs stay in files; terminal/maintainer output is exempt. **Exceptions:** the five channel control commands; `!pause`, `!stop`, `!resume`, `!snooze`, `!status`; may be named when the operator asks how to control you, because they *are* the reply they would send. The `!doctor` harness command may also be named when it is the next step the operator can send. No other slash command qualifies. See `CLAUDE-APPEND.md` § Operator Notification for the full rule.

## 4. Capture Interactive Patterns

After replying, append **at most one** line with `task.ts lesson <id>` to the selected record for these durable signals:

- **Stated preference or rule** — the operator explicitly said how they want something done going forward ("always include the cost", "stop sending the brief before 9", "I prefer X over Y"). A turn handled by the Standing role intent writes no Findings line.
- **Recurring request type** — you recognise this as the same kind of request handled earlier in this session or in recent session context loaded at start, not a first occurrence.
- **Correction or emergency implying a durable preference** — "stop doing X", "don't do that again", "revert" with a reason that names a general behaviour.

Read `reference.md` § Capture Interactive Patterns before recording a signal or correction.

For proactive notifications, read `outbound.md` before composing or sending.

## 6. Channel-safe ask bridge

Apply to every skill's decision point on a channel-tagged turn (`<channel source="...">`), including `proposal-act` and `hermit-settings`.

- **(a) Conversational side**: send the question through the channel reply tool.
- **(b) Durable side, bounded asks only**: also queue asks with 2-4 options, including yes/no, via `proposal.ts queue-micro` (reflect's § Micro-approval queuing). Set `options` to the labels (omit for yes/no), `tier: 1`, and `on_resolve` to the skill invocation with an `{answer}` placeholder. Free-form asks use only the reply tool, with no queued entry.
- **Whichever surface answers first resolves it.** For an answer within the asking skill's live turn, act on it and resolve the MP entry with § Micro-approval response's script call (never hand-edit `state/micro-proposals.json`):
  ```bash
  bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts micro .hermit resolve <id> --action answered --answer "<selected label>"
  ```
  Later answers use § Micro-approval response and `on_resolve`.
- **Never call `AskUserQuestion` on a channel-tagged turn.** Its terminal UI is invisible to the remote operator.
