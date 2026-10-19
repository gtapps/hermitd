Use this protocol for proactive notifications (`prompts/resident.md` § Operator Notification). Main owns sends and any `AskUserQuestion`; delegates return composed messages.

- **If no channel is enabled** (channels block absent, `channels === {}`, or every channel-config entry has `enabled === false` — exclude the `primary` string pointer when iterating):
  - If `push_notifications === true` in `config.json`, fire `PushNotification(message="<condensed one line, per `prompts/resident.md` § Operator Notification push format>", status="proactive")`. Push is best-effort; do not retry on failure and do not log a `channel-send-unavailable` issue for this branch — the operator's empty-channels config is intentional.
  - Respond in conversation either way (the conversation response is the durable record).
- **If at least one channel is enabled**, compose the audience version(s) and deliver them in one
  call — do not resolve the channel yourself, the script owns routing:
  ```
  .hermit/bin/hermitd-run channel-send .hermit --notice
  ```
  with a JSON payload on stdin:
  - plain, client-safe notice → `{ "client": "<text>" }`
  - `{ "maintainer": "<text>" }` **alone**: only notices with no client-facing consequence
    (spend detail, FYI diagnostics, or explicitly mandated maintainer-only sends).
    Any decision, reply or operator action requires a plain client version.
  - Actionable content with technical detail → `{ "client": "<plain headline + the ask>",
    "maintainer": "<full detail incl. figures>" }`. The maintainer text must be the **complete
    richer version of the same notice**, since a shared destination drops the client leg.
  - add `"sensitive": true` for credential-bearing text (keeps it out of the searchable channel log).

  Compose each version in the operator's configured `language` and apply §0 Message formatting
  to the completed message bodies before sending.

  The script prints `{ "status", "reason"?, "result" }`.
  - **`delivered`**: every leg landed. Done.
  - **`error`** (`invalid_payload:…`): nothing was sent. Fix and re-run;
    do not push or record a `channel-send-unavailable` issue.
  - **`undelivered`**, or **`degraded`** when unreachable maintainer detail landed
    only in state/watchdog-events.jsonl: if `push_notifications === true`, fire
    `PushNotification(message="<condensed one line, per § Operator Notification push format>", status="proactive")`,
    record a deduped `channel-send-unavailable` issue.
    The sender persists failed client text to state/watchdog-events.jsonl and reports `undelivered_saved` or `persistence_error` in the client result.
    Here even `reason: "no_reachable_channel"` means an enabled channel is unreachable (unpaired, empty `allowed_users`, or unreadable config).
- Never send a proactive notice through a channel reply tool, and never advise `/<channel>:access`
  for a maintainer chat — the maintainer chat is reached by direct API POST, not `access.json` pairing (it is outbound routing for technical alerts, `docs/security.md` § Tiered disclosure, not reply routing).

A request from chat to listen in a group or server channel goes through `hermit-settings channels → edit <name> → group`, never the plugin's `/<channel>:access` skill or a direct `access.json` edit.

