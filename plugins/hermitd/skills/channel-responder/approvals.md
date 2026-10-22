# Approvals

## Micro-approval response

- **Micro-approval response** ("yes", "no", "MP-… yes/no", "MP-… <number>", "MP-… <label>", a bare number, or a bare label while any pending micro-proposal exists)
  - Turn the operator's words into the answer token, then run `proposal-micro` (Commands) with arguments `match [<MP-id>] --chat <sourceKey>:<chat_id> --reply "<token>"`, using this chat's normalized key; pass the explicit id when supplied, otherwise omit it. Only entries asked in this chat can match. Follow its `status`:
    - `match`: use the returned `id`, `answer`, `tier` and `on_resolve` (null when absent) in the resolution branches below.
    - `ambiguous`: list the `choices` ids and options and ask for the target or choice once; do not resolve.
    - `none`, reason `no_pending`: fall through to general classification. Reason `no_match`: ask for clarification once; do not resolve.
    - On a script error, report it and do not resolve or hand-edit the queue.
  - **Suggestion escape hatch:** on `ambiguous` for bare `yes`/`no`/`later`, run `proposal-index` (Commands) to validate the index against disk, then check `state/proposals-index.json`. If any proposal has `status: "proposed"`, append: "…or reply 'YES #N' to act on an open suggestion instead." Preserve micro-proposal precedence.
  - **On resolved entry:** every branch below resolves the entry via one script call — never hand-edit `state/micro-proposals.json`: the script is the only writer that keeps the file and the ledger consistent.
    - **Entry has `on_resolve`** → **resolve on disk FIRST, then invoke.** Run:
      Run `proposal-micro` (Commands) with arguments `resolve <id> --action answered --answer "<selected label>"`.
      The script removes the pending entry, then appends `micro-resolved` (`"action":"answered"`) before invocation. A failed ledger append is reported after removal; do not re-run the resolve call. Substitute the selected label into `on_resolve`'s `{answer}`, then invoke the skill command. Insert a single-word verb **bare** (unquoted): `/hermitd:proposal-act {answer} PROP-NNN` becomes `proposal-act accept PROP-NNN`. Keep double quotes around multi-word `--answer` labels such as `session task`. The invoked skill detects re-entry and acts on the answer. `answered` is audit-only, excluded from approval-rate metrics. See `SKILL.md` § Channel-safe ask bridge.
    - **No `on_resolve`, "yes" on tier 1** → execute the change at next idle, record the outcome with `task.ts note` when a record is open, then:
      Run `proposal-micro` (Commands) with arguments `resolve <id> --action approved`.
    - **No `on_resolve`, "yes" on tier 2** → create PROP-NNN via `/hermitd:proposal-create`, queue for next idle, then run the same `resolve <id> --action approved` call.
    - **No `on_resolve`, an option label** (a deferred upgrade step) → apply that option as the question describes, in this turn, behind normal permission prompts. Apply `config.json` changes through settings-edit verbs, and never write `.claude/settings*.json` from a channel session. Once it is applied, run `proposal-micro` (Commands) with arguments `resolve <id> --action answered --answer "<selected label>"`. If a prompt is denied or the apply fails, leave the entry pending and tell the operator the question is still open and why.
    - **No `on_resolve`, "no"** → run:
      Run `proposal-micro` (Commands) with arguments `resolve <id> --action rejected`.
  - If no pending micro-proposals: classify as normal message (fall through to categories below).

## Already-done items

- A "clear" reply resolves exactly the decisions that message grouped under "Looks already done": the heartbeat's `digest_done` keys, or the brief's `done` refresh entries. Take them from that turn's output in this conversation; never guess them from the queue.
- Resolve each key:
  - A proposal (`proposal-pending:<PROP-NNN>`, or a micro entry whose `proposal_id` links one): `/hermitd:proposal-act resolve PROP-NNN`. Resolving the proposal retires a linked question too.
  - Any other `micro-proposal-pending:<MP-id>`: run `proposal-micro` (Commands) with arguments `resolve <MP-id> --action answered --answer "already done"`, never `approved`, because the operator approved nothing.
- Reply once, in plain voice, naming what was cleared without internal ids.
- If no such message's keys are in this conversation, resolve nothing. Say any item still marked done will show again in the next reminder, where a "clear" can drop it.

## Proposal approval

- **Proposal approval** ("accept PROP-", "go ahead with PROP-", "approve PROP-", referencing proposal numbers, `#N`, or a bare/`#N`-qualified `YES`/`LATER`/`NO` reply to a Suggestion card — only when no pending micro-proposal claimed the reply first, per Micro-approval response above)
  - **Map the reply to an action** (case-insensitive): `YES` / "go ahead" / "accept" → `accept`; `LATER` / "hold" / "defer" → `defer`; `NO` / "drop" / "dismiss" → `dismiss`. `accept PROP-`/`approve PROP-` phrasing maps to `accept` directly; the operator can also spell the action out instead of YES/LATER/NO.
  - **Resolve the target proposal:** run `proposal-index` (Commands) to validate against disk, then check the refreshed `state/proposals-index.json`. Match an explicit `#N` or `PROP-NNN` before invoking `/hermitd:proposal-act <action> PROP-N` (it zero-pads the integer). On no match, reply in plain voice: "I don't see Suggestion #N; reply with an open number." For bare `YES`/`LATER`/`NO`, filter to `status: "proposed"`: apply when exactly one exists and this chat is its channel's home chat (`default_chat_id`); otherwise list the open Suggestion numbers and ask which (e.g. "Reply 'YES #14'"), never an internal ID.
  - Never surface internal proposal fields back to the channel (the exact list and `#N` derivation are canonical in `proposal-list` §4a) — confirm using the Suggestion number (see `proposal-act`'s channel-tagged notify).

