# Channel responder reference

Read on demand from `SKILL.md`; never loaded on a turn that does not need it.

## Standing work

Standing work is what the hermit does without being asked in the moment: routines, watches, and standing roles. Session-triggered `scheduled_checks` fire on session events and are not standing work. Answer in channel voice (`SKILL.md` § 3): no cron strings, ids, file paths, or slash commands, except `!doctor` when a live check is the next step.

### Gather (bounded reads only)

- Routines: `settings-get-routines` (Commands) for id, schedule, skill, enabled, precheck.
- Routine outcomes: `routines-health` (Commands) (JSON; add `--days N` for a longer window). Use `last_fire`, `failure_total`, `last_precheck_error`, `open_attempt`.
- Watches: `Read state/monitors.runtime.json` for id, description, source, class, started_at.
- Roles: the `[role` lines already in this turn's context. Hermit-wide ones always apply; a pinned `[role <key>:<chat_id>]` line applies only to that chat (`SKILL.md` § 1).
- Current activity: the open-record digest and its execution observation.
- Health evidence: `Read state/doctor-report.json` only for the "anything to deal with" and "what can you access" shapes. Do not run `doctor-check.ts` from this intent; a live check is the `!doctor` command, which the operator sends.

Never `tail` `state/routine-metrics.jsonl`, the cost log, or the channel log. A field none of these sources records is unknown; say so instead of guessing.

### Default view

Order: problems first, then current activity, then domain standing work.

- A problem is a routine with `failure_total > 0` or a `last_precheck_error`, a `fail` or `warn` entry in the saved doctor report, or a watch whose registry entry says it exited.
- Lead with work aimed at the operator's domain (briefs, domain analyses, watches, rules). Routines that exist to keep the hermit itself running (monitor re-arms, self-reflection, self-checks, session closing) are housekeeping: mention them only when one carries a problem or the operator asks for the internal housekeeping.
- Per item: plain name, purpose (from the skill name or description), cadence or condition in words, destination when config names one, last known outcome (`last_fire` plus `failure_total`), and persistence: routines and roles persist across restarts, watches die with the session (config watches return at the next start).

### Matching a named item

Match the operator's phrase, case-insensitive, against routine `id` and skill name, watch `id` and `description`, and role slug or rule text. Exactly one match acts. Several matches: name them in plain language and ask which. None: say so and list what exists.

### Routing a change

| Operator intent | Owner | Reply must state |
|---|---|---|
| Disable, enable, or retime a routine | **Settings change request** path: `hermit-settings routines` (index from a fresh `get routines`, then `hermit-routines load`) | Persists across restarts. A native permission prompt, if one appears, is the operator's answer. |
| Stop a routine "for now" | `/hermitd:hermit-routines stop <id>`: single routines share one monitor, so relay its explanation and offer the durable disable | Nothing changed unless they choose the disable. |
| Stop a watch | `/hermitd:watch stop <id>` | Gone for this session; a config watch returns at the next start. |
| Forget or change a rule | **Standing role** branch | Persists. |
| Anything an owner does not support | Explain the limit; do not emulate it | Nothing changed. |

### Settings and model questions

Relay the `settings-edit ... show` row for the setting: saved value, what changes it, and when it applies. For the running model or effort: if this session's context holds a `[harness-command] … transcript now reports model X` line, that is the observed serving model; otherwise say the saved value is what the next boot uses and the current session's value is unverified. `settings-edit ... history <path>` answers who changed it and when. Never claim a runtime value the harness did not report.

### Access question

From config: channels with `enabled !== false` and whether each has an allowlist, `permission_mode`, `remote`, enabled artifact pages, `auth_mode`. From `state/doctor-report.json`: the last `channel-liveness`, `credential-expiry`, and `permissions` results with their timestamp. Configured is not verified; say which is which. No credentials, chat ids, or file paths in the reply. In a group, or for a sender who is not the trusted controller, give only the coarse shape (the same audience rule as `!status`).

## Standing role

- **Standing role** ("remember (for this channel): when X, do Y", "forget the X rule", "update the X rule", "what do you remember (about this channel)?")
  - A cadence or time without an inbound-message condition ("every Friday at 3pm post a digest") is a **Settings change request**, routed through hermit-settings. A rule conditioned on a message ("when someone...", "when a message...") is a role even if it contains "every" or a weekday.
  - Any sender admitted by §1c may save a current-chat pinned role without confirmation. Save a hermit-wide `[role]` only for a primary operator (§1c); otherwise pin it here and reply "Saved for this channel only: …". Write one `type: feedback` auto-memory topic file and one `MEMORY.md` index line in the loaded `MEMORY.md`'s directory (`<CLAUDE_CONFIG_DIR, else ~/.claude>/projects/<path-key>/memory/`). Use `feedback_role_<key>_<chat_id>_<slug>.md` for pinned roles, otherwise `feedback_role_<slug>.md`, with the normalized bare key. Before choosing `<slug>`, match only `[role` index lines in the target tier (hermit-wide or this chat). Rewrite an existing rule's file for restatements; do not duplicate it.
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

`<canonical-name>` is the skill's lowercase bare `name:` frontmatter, without `hermitd:`/`<plugin>:`. Set `origin` to `external-content` for non-primary senders, else `own-work`. Rejected rows return `ERROR|<reason>` at exit 0; no `|| true` is needed. Mis-invocations exit 1: fix the call, never retry blindly or block the reply. At most one row per turn.

Without a clearly named skill, write the eligible `## Findings` line; do not guess a `<name>` or ask for disambiguation mid-reply.
