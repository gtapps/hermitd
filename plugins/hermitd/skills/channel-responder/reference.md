# Channel responder reference

Read on demand from `SKILL.md`; never loaded on a turn that does not need it.

## Standing work

Standing work is what the hermit does without being asked in the moment: routines, watches, and standing roles. Session-triggered `scheduled_checks` fire on session events and are not standing work. Answer in channel voice (`SKILL.md` § 3): no cron strings, ids, file paths, or slash commands, except `!doctor` when a live check is the next step.

### Gather (bounded reads only)

- Routines: `settings-get-routines` (Commands) for id, schedule, skill, enabled, precheck.
- Routine outcomes: `routines-health` (Commands) (JSON; add `--days N` for a longer window). Use `last_fire`, `failure_total`, `last_precheck_error`, `open_attempt`.
- Config watches: read `.hermit/config.json` → `monitors[]` for id, description, enabled; match by id to `.hermit/state/watch-monitor.runtime.json` → `watches[]` for pid, started_at, restarts, last_exit_code. An enabled watch absent from runtime is pending reconciliation.
- Ad-hoc and session watches: read `.hermit/state/monitors.runtime.json` for id, description, source, class, started_at.
- Roles: the `[role` lines already in this turn's context. Hermit-wide ones always apply; a pinned `[role <key>:<chat_id>]` line applies only to that chat (`SKILL.md` § 1). Also list the current chat's `[chat instructions]` line when present.
- Current activity: the open-record digest and its execution observation.
- Health evidence: `Read state/doctor-report.json` only for the "anything to deal with" and "what can you access" shapes. Do not run `doctor-check.ts` from this intent; a live check is the `!doctor` command, which the operator sends.

Never `tail` `state/routine-metrics.jsonl`, the cost log, or the channel log. A field none of these sources records is unknown; say so instead of guessing.

### Default view

Order: problems first, then current activity, then domain standing work.

- A problem is a routine with `failure_total > 0` or a `last_precheck_error`, a `fail` or `warn` entry in the saved doctor report, an ad-hoc watch whose registry entry says it exited, or a config watch whose `watch-monitor.runtime.json` row shows `restarts > 0` with a nonzero `last_exit_code`.
- Lead with work aimed at the operator's domain (briefs, domain analyses, watches, rules). Routines that exist to keep the hermit itself running (monitor re-arms, self-reflection, self-checks, session closing) are housekeeping: mention them only when one carries a problem or the operator asks for the internal housekeeping.
- Per item: plain name, purpose (from the skill name or description), cadence or condition in words, destination when config names one, last known outcome (`last_fire` plus `failure_total`), and persistence: routines and roles persist across restarts. An enabled config watch returns at the next start. A stopped config watch stays disabled. An ad-hoc watch ends with the session.

### Matching a named item

Match the operator's phrase, case-insensitive, against routine `id` and skill name, watch `id` and `description`, and role slug or rule text. Exactly one match acts. Several matches: name them in plain language and ask which. None: say so and list what exists.

### Routing a change

| Operator intent | Owner | Reply must state |
|---|---|---|
| Disable, enable, or retime a routine | **Settings change request** path: `hermit-settings routines` (index from a fresh `get routines`, then `hermit-routines load`) | Persists across restarts. A native permission prompt, if one appears, is the operator's answer. |
| Stop a routine "for now" | `/hermitd:hermit-routines stop <id>`: single routines share one monitor, so relay its explanation and offer the durable disable | Nothing changed unless they choose the disable. |
| Stop a watch | `/hermitd:watch stop <id>` | An ad-hoc watch is gone for this session. A config watch is set to `enabled: false` and stays off. |
| Forget or change a rule | **Standing role** branch | Persists. |
| Anything an owner does not support | Explain the limit; do not emulate it | Nothing changed. |

### Settings and model questions

Answer from the setting's row in `settings-edit ... show`: its saved `value` (absent: not set on a `nullable` row, else the default applies), the `arg` that changes it, and when it `applies`. For the running model or effort: if this session's context holds a `[harness-command] … transcript now reports model X` line, that is the observed serving model; otherwise say the saved value is what the next boot uses and the current session's value is unverified. `settings-edit ... history <path>` answers who changed it and when. Never claim a runtime value the harness did not report.

### Access question

From config: channels with `enabled !== false` and whether each has an allowlist, `permission_mode`, `remote`, enabled artifact pages, `auth_mode`. From `state/doctor-report.json`: the last `channel-liveness` and `credential-expiry` results with their timestamp. Configured is not verified; say which is which. No credentials, chat ids, or file paths in the reply. In a group, or for a sender who is not the trusted controller, give only the coarse shape (the same audience rule as `!status`).

## Standing role

### Direct saves and scope

An admitted sender's durable request about how this chat should behave is a Standing role save, even without the word “remember”. Judge meaning in any language. Save it now as this chat's pinned memory role using the save and one-line confirmation below. A task-output preference owned by an editable skill follows the resident's Knowledge Discipline rule: fold it into that skill. An ambiguous scope gets one short clarifying question before any write. Inside an annotated task thread, the message remains steering; do not directly save it as a role. The scheduled review can consider repeated corrections there later. A direct save never changes chat instructions.

### Pending review proposals

When the turn's context carries `[pending role proposals]`, run `.hermit/bin/hermitd-run role-review .hermit get --chat <key>` before interpreting the reply or any Standing role update or forget, using the normalized `<sourceKey>:<chat_id>` and shell-quoted arguments. Without that line this chat has no pending proposal, so skip the check; never read the raw state file. Respect §0's command/pause exceptions and the existing micro-approval and task-thread precedence. A check may precede the reply despite §1's bookkeeping restriction.

Match the reply's meaning to the returned proposals for this chat, in any language. Do not match keywords or assume a bare yes approves every proposal. When several fit, ask once which change they mean and write nothing. A reply that refers to none continues normal classification. Refuse a selected `stale:true` proposal plainly because its current wording changed or disappeared; do not apply its saved replacement. A missing proposal is not authority to reconstruct one from chat history.

- Memory acceptance: use its saved `proposed_text` to rewrite the authorized role topic file and matching `[role <key>:<chat_id>]` index line, preserving provenance and file structure. Then run `.hermit/bin/hermitd-run role-review .hermit resolve <proposal-id> applied` and confirm in channel voice.
- Instructions acceptance: route to **Settings change request** with the saved replacement text and exact current chat entry. The native prompt decides; a chat reply does not replace that approval. Resolve `applied` only after the settings write succeeds. Respect a No without retrying or resolving it as applied.
- A clear decline runs `.hermit/bin/hermitd-run role-review .hermit resolve <proposal-id> declined`, then acknowledges it.

Without an acceptance, leave the proposal pending and the target unchanged. Direct updates and forgets still use the fresh pending-proposal check first; this does not turn an unrelated update into acceptance of a proposal.

### Save, list, update and forget

- **Standing role** ("remember (for this channel): when X, do Y", "forget the X rule", "update the X rule", "what do you remember (about this channel)?")
  - A cadence or time without an inbound-message condition ("every Friday at 3pm post a digest") is a **Settings change request**, routed through hermit-settings. A rule conditioned on a message ("when someone...", "when a message...") is a role even if it contains "every" or a weekday.
  - Any sender admitted by §1c may save a current-chat pinned role without confirmation. Save a hermit-wide `[role]` only for a primary operator (§1c); otherwise pin it here and reply "Saved for this channel only: …". Write one `type: feedback` auto-memory topic file and one `MEMORY.md` index line in the loaded `MEMORY.md`'s directory (`<CLAUDE_CONFIG_DIR, else ~/.claude>/projects/<path-key>/memory/`). Use `feedback_role_<key>_<chat_id>_<slug>.md` for pinned roles, otherwise `feedback_role_<slug>.md`, with the normalized bare key. Before choosing `<slug>`, match only `[role` index lines in the target tier (hermit-wide or this chat). Rewrite an existing rule's file for restatements; do not duplicate it.
  - Saving, restating or forgetting a memory role never changes chat instructions; changes to those go to **Settings change request**.
  - Preserve the operator's sentence in `- [Standing role: <slug>](<file>): [role] when X, do Y`, or `[role <key>:<chat_id>] when X, do Y` for pinned roles. Trim only to fit one index line, keeping the full text in the topic file; the harness warns near `MEMORY.md`'s cap. Pinned roles apply only to that chat's channel turns; hermit-wide roles apply to every turn.
  - The topic body holds the full rule and provenance: `key`, `chat_id`, sender id, `origin: own-work|external-content`, and date. Use `external-content` when the sender is not a primary operator (§1c), otherwise `own-work`. The same sender test decides both `origin` and hermit-wide authority.
  - Reply in channel voice: "Saved for this channel: when X, do Y. Say 'forget the <short name> rule' to remove it." For a hermit-wide role, say "Saved for everywhere" instead.
  - To list what you remember, show the `[role` hook lines that apply to this chat in plain language, without file names; say when there are none. Do not include routines; a broader question about what you are keeping an eye on is **Standing work** above.
  - To forget or update a hermit-wide role, require a primary operator (§1c). Otherwise say it is the operator's rule and write nothing. Any admitted sender may change this chat's pinned roles. Delete or rewrite the authorized topic file and index line, then echo the result. For unclear "forget" requests, name candidates and await the answer.
  - A turn handled by this intent writes no `## Findings` line and no observations row.

## Harness command details

  - `!model`, `!effort`, `!compact`, `!clear`, and `!advisor` run through the core mod without an agent turn or tmux keystroke. `/compact` still makes its summarization call. Replies report observed success, failure text, or an unknown outcome at the deadline; they are direct on Discord and Telegram and model-relayed elsewhere (or if a direct send fails).
  - Claude Code saves `model`, `effortLevel`, and `advisorModel` in user settings, affecting sessions sharing that config directory. Boot re-asserts configured model and effort overrides; with `config.effort: null`, the saved effort can survive restart. Boot does not re-assert advisor. Permission mode lasts for the current session and resets to `config.permission_mode` at boot.
  - The mod approves only its dispatched `/model` target, after settings-level deny or ask decisions have had their say. A terminal `/model` still asks “Switch model?”. If the mod is unavailable, doctor reports “chat harness commands unavailable”; there is no tmux fallback for the six commands.
  - `!permission-mode` accepts `default`, `acceptEdits`, or `auto`. Relay other modes' refusal reasons: `plan` blocks replies, `bypassPermissions` requires a terminal decision, and `dontAsk` is unreachable mid-session. The hook drives Claude Code's mode cycle and reads the status bar. Report the actual mode supplied in the next prompt, not the requested mode.
  - `!advisor <model>` adds a second model for decision-point consultation (experimental, Anthropic API only); `!advisor off` clears it. Claude Code validates the model; do not invent a value list. The mod relays observed rejections to the requesting chat. There is no cached-context pause. The selection persists in Claude Code's user settings across restarts and sessions sharing that config directory; boot does not re-assert it. Each advisor call adds spend; clear it with `!advisor off`.
  - `!doctor` runs Claude Code's own `/doctor` checkup, which only a user can start, so the mod starts it as its own turn; that turn delivers the result to the requesting chat. Like `!model`, it requires the operator's own chat.
  - Near-misses (argument-free `!model`, bare `clear`, or prose mentions) are not intercepted; classify below. Never invoke bare `!advisor`: its picker blocks the session. Ask for `!advisor <model>` or `!advisor off`.

## Capture Interactive Patterns

A durable chat-behavior rule follows **Standing role**, not `task.ts lesson`, Findings or observations. One-off corrections remain lessons under the rules below. Task-thread steering and preferences owned by an editable skill keep their existing routes.

**Do not write a finding** for: one-off questions, research turns with no preference signal, task assignments, status checks, or micro-approval responses. When in doubt, write nothing — the next scheduled reflect catches genuine recurrence via task-record evidence.

Format (one line, piped into `task.ts lesson .hermit <id>`; with no open record, write nothing):

```
[HH:MM] Channel pattern: <one-line description of the preference or recurrence>
```

If the sender's user ID (verified in §1c) is not a primary operator (§1c), append ` [origin: external]` to the line:

```
[HH:MM] Channel pattern: <description> [origin: external]
```

Do not classify tier, tag Evidence Source, or decide memory-vs-proposal. Reflect reads this line as `current-session` evidence (`Evidence Source: current-session`, `Sessions: current`) and uses the `[origin: external]` marker (if present) to set `Evidence Origin: external-content` when passing to the judge.

**Resolved corrections → observations ledger, not Findings.** For a correction or emergency implying a durable preference that clearly names an installed skill/component (e.g. "the brief is too verbose", not a vague "you"), append a ledger row **instead of** a `## Findings` line:

Run `observations-observe` (Commands) with arguments `skill-correction --origin=<own-work|external-content>` and the following stdin payload:
```text
skill-correction:<canonical-name>
```

`<canonical-name>` is the skill's lowercase bare `name:` frontmatter, without `hermitd:`/`<plugin>:`. Set `origin` to `external-content` for non-primary senders, else `own-work`. A rejected row or mis-invocation exits 1: fix the call, never retry blindly or block the reply. At most one row per turn.

Without a clearly named skill, write the eligible `## Findings` line; do not guess a `<name>` or ask for disambiguation mid-reply.
