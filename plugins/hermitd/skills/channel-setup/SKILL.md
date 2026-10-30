---
name: channel-setup
description: Guided channel activation for local/tmux users — adds a channel entry when none is configured, installs the plugin, configures the bot token in the project-local state dir, and walks through pairing. Run after hatch, or any time to add or re-enable a channel.
disable-model-invocation: true
---

# Channel Setup

Activate a channel, adding the `config.json` entry first when there isn't one. Local/tmux pairing is this skill's own flow; a Docker hermit is routed by the check below.

## Commands
- `channel-preflight`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-preflight.ts .hermit <channel>`
- `channel-bot-id-write`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-bot-id.ts .hermit <channel> --write`
- `channel-pair-restrict`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-access.ts "<hermit_state_dir>" pair <channel> <code> --restrict`
- `channel-group-add`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-access.ts "<hermit_state_dir>" group-add`

## Plan

### 1. Read config and detect channels

**Runtime routing (first):** detect container status and read project status. A resident (`HERMIT_RESIDENT=1`) or container must never run `hermitd restart`; give the separate host-terminal recovery command. When compose exists, run `docker-preflight.ts` from the plugin scripts: a non-null `live_owner` keeps a live host tmux agent on the local flow. Otherwise inspect `docker compose -f docker-compose.hermit.yml ps --status running --format '{{.Service}}'`; a failed inspection stops with its output. Record whether your agent is live for the shared restart stage. An offline Docker agent needs host `hermitd start`; diagnostics are `hermitd docker logs --tail=60`.


Read `.hermit/config.json`. Collect all entries under `channels` that are valid objects, tracking which are disabled (`enabled: false`).

**Adding an entry.** Where a branch below says *create the entry*, run (`<name>` is the lowercase channel key — `discord`, `telegram` — never the capitalized option label):

```
echo '{"channels":{"<name>":{"enabled":true}}}' | bun ${CLAUDE_PLUGIN_ROOT}/scripts/hatch-config.ts "$(pwd)" --reinit
```

The script fills `enabled`, `default_chat_id: null`, and `state_dir` (`.claude.local/channels/<name>`), validates the whole config, preserves every other key, and merges onto an existing entry rather than replacing it. It prints `OK`. On `error` nothing was written: report it and stop — never fall through into steps 2–6 against a channel that isn't in `config.json`.

- If no channels configured: offer to add one — `AskUserQuestion` (header: "Channel") with options **Discord**, **Telegram**, **iMessage** on macOS, **Cancel**, plus Other for `plugin@marketplace`. On **Cancel**, stop without writing. Otherwise create the entry and continue with that channel selected. iMessage has no token or Hermit pairing. For Other persist `plugin` and `marketplace` in the channel entry and follow that plugin’s own setup.
- If entries exist but all are disabled: name them, then ask with `AskUserQuestion` (header: "Channel") — the disabled channel names plus **Cancel** — which to re-enable. On **Cancel**, stop without writing. Otherwise create the entry for the chosen name (this flips `enabled` and leaves `default_chat_id`, `state_dir`, and `allowed_users` intact) and continue with it selected.
- If exactly one enabled channel and nothing disabled: use it automatically.
- Otherwise (several enabled, or enabled and disabled side by side): ask with `AskUserQuestion` (header: "Channel") — every channel name as an option, disabled ones labelled `<name> — disabled`, plus **All** (enabled channels only) — which to set up. If a disabled name is chosen, create the entry for it first (re-enabling it), then continue with it selected.

Run steps 2–6 for each selected channel. On a Docker host (runtime routing 4–5), apply those overrides instead of the local/tmux default.

### 2. Check prerequisites

Run both checks in a single Bash call:

```bash
bun --version 2>/dev/null; uname -s
```

- **Bun missing** (command fails / no output): tell the operator —
  > Bun is required for channel plugins but is not installed.
  > Install: https://bun.sh
  > Then re-run this skill.

  Stop for this channel.

- **iMessage on non-macOS**: if `uname -s` is not `Darwin` and the channel is `imessage`, note it's macOS-only and skip this channel.

### 3. Install plugin

Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-siblings.ts "$(pwd)"` to get the project-or-local + enabled plugin list (JSON array; user-scope, managed, disabled, and cross-project entries already dropped). Each entry carries `plugin`, `marketplace_name`, `scope`, `enabled`.

Resolve the expected marketplace for this channel:

- If `channels.<channel>.marketplace` is set in `config.json`, use that value (third-party channel plugin path).
- Otherwise, use `claude-plugins-official` (built-in channels: discord, telegram, imessage).

Then check whether the surviving set contains an entry where:

- the plugin name (substring of `id` left of `@`) equals the configured `plugin` or, when absent, `<channel>`, AND
- the marketplace name (substring of `id` right of `@`) equals the resolved marketplace.

(Both clauses matter — `discord@some-other-marketplace` is a different plugin from a different source and must not satisfy this gate.)

- **Found**: skip silently. The channel plugin is already installed and enabled at project or local scope for this project — the canonical filter guarantees `enabled == true`, and `*_STATE_DIR` (set by `hermitd-start` at boot) points at `.claude.local/channels/<channel>/`.
- **Not found**: run, in order:
  ```bash
  claude plugin install <plugin>@<marketplace> --scope local
  claude plugin enable  <plugin>@<marketplace> --scope local
  ```
  Explicit `enable` covers the disabled-but-installed-at-project/local case — the filter excluded such entries (enabled-only), and `install` is a separate command from `enable` per the CLI surface, so it may no-op without re-enabling. A user-scope install elsewhere does not satisfy this gate; channel tokens and access policy are project-local.

Your agent loads the installed plugin at its next start; the shared access stage uses scripts without requiring a reload in this setup session.

### 4. Token configuration

Read [channel connection stages](references/connection-stages.md) and run credentials and check. Offer private terminal entry with `hermitd run channel-token-set <channel>` and `.hermit/bin/hermitd-run channel-token-set <channel>` as specified there.

### 5. Restart + pairing

Continue the same reference through restart and access. Then verify the access location below.

### 6. Verify access.json location

For iMessage and third-party plugins, follow their own access procedure and skip Hermit-specific access commands below.

Check if `access.json` exists at `<state_dir>/access.json`.

- If yes: done.
- If no: check `~/.claude/channels/<channel>/access.json`. If found there, move it:
  ```bash
  mkdir -p <state_dir>
  mv ~/.claude/channels/<channel>/access.json <state_dir>/access.json
  ```
  Confirm: "Moved access.json to `<state_dir>/`."
- If found in neither location: note — "access.json not found. Pairing may not have completed. Run `/hermitd:channel-setup` after DMing your bot."

After `file` `home` or `home+state`, the bot that handed out the code still reads `~/.claude`; the hermit reads the state directory, which `home+state` already updated and the move above covers otherwise. Use `${CLAUDE_CONFIG_DIR}` instead of `~/.claude` when that environment override is set.

If access.json is verified, continue to step 6a.

### 6a. Access control

Once per channel after verifying `<state_dir>/access.json`, read its `allowFrom` and the current channel config. Include iMessage: these settings are hermit-owned. Ask the row in one `AskUserQuestion` call, with the default option recommended:

| Header | Question | Options (`label`: description) |
|---|---|---|
| Access ctrl | Who may wake the hermit on this channel? | `Only <paired id>`: use the paired id from `allowFrom` (default) / `Allow everyone`: no hermit sender restriction / Other: additional user ids |

Drop Access ctrl when `channels.<channel>.allowed_users` is already present, preserving it. Use the paired id from `allowFrom`; if it is ambiguous or unavailable, have the operator identify the intended ids through Other instead of guessing. Encode selected ids as a string array, including the paired id for additional ids. For Allow everyone omit `allowed_users`.

Merge the answer through the existing reinit command:

```bash
echo '{"channels":{"<channel>":{"allowed_users":<selected_string_array>}}}' | bun ${CLAUDE_PLUGIN_ROOT}/scripts/hatch-config.ts "$(pwd)" --reinit
```

Omit `allowed_users` when the row was dropped or Allow everyone was chosen. Never use Edit/Write on `config.json`. Stop on a non-zero merge exit as in Adding an entry. Repeating the same answers must leave the file byte-identical. Continue to §6b.

### 6b. Default delivery settings

Once §6 verifies the channel state, skip iMessage; otherwise run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-access.ts "<hermit_state_dir>" ensure-defaults <channel>
```

Relay `ack` (`set` or `kept`). The default is `👀` only when `ackReaction` is absent; an empty string and customized values are preserved. On `{"error"}`, report the token and stop.

### 6c. Server channel / group chat (optional)

Skip for iMessage or when pairing did not complete. Run [the group questionnaire](references/group-enrollment.md) with the channel key, absolute `<hermit_state_dir>`, and native `AskUserQuestion` prompts. Carry forward the returned group answers, then continue to §6d.

### 6d. Maintainer channel check (optional)

If `channels.<channel>.maintainer_channel_id` is set in `config.json`, this channel routes technical, operational, and spend alerts to a second outbound-only destination (same bot/token, a different chat) instead of the primary chat, used on client-facing installs so the person on the primary chat never sees ops detail. Doctor's channel-liveness probe only checks the primary chat, so a typo'd maintainer id would otherwise fail silently on every alert rather than at setup.

When it's set, send **one** test message to the maintainer chat to confirm reachability:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-send.ts .hermit --tier maintainer -
```

with a short line on stdin (e.g. "Maintainer channel check: technical and spend alerts will arrive here."). Record the result in the §7 summary: **sent** confirms the id; a **failure** means the id is wrong or the chat isn't reachable, so surface it so the operator fixes it now. If `maintainer_channel_id` is absent, skip silently.

A maintainer-send failure means **the bot isn't present or permissioned in the target server/channel** — the fix is to invite/permission the bot there. This chat is reached by a direct API POST with the bot token, never through `access.json`, so running `/<channel>:access` will not fix a failed send here.

### 6e. Recall, operators, primary channel, and recording

Once per selected channel, re-read config after the preceding merges. Ask the applicable rows in one `AskUserQuestion` call (at most four rows); drop conditional rows whose conditions are false. Skip the call if no rows remain. The defaults below describe a fresh setup; preserve existing customization when an answer is omitted.

| Header | Question | Options (`label`: description) |
|---|---|---|
| Recall scope | Which chats on this channel may this chat recall? | `Each chat only itself`: leave `isolate_chats` absent (default) / `Every chat on this channel`: set `isolate_chats: false` |
| Operators | Who may manage hermit-wide standing roles? | `First allowed user (<id>)`: use the first allowed id (default) / Other: operator user ids |
| Primary | Which enabled channel should receive default outbound messages? | `<this channel>`: use this channel (default) / each other enabled channel by name |
| Record | Record chats on this channel for recall? | `Inherit global setting, currently <on|off>`: leave `log_chats` absent (default) / `No, never`: set `log_chats: false` / `Yes, always`: set `log_chats: true` |

Show Recall scope only if a group was added in §6c. Show Operators only if `channels.<channel>.allowed_users` contains at least two ids; for the default option omit `operators` (absence already means the first allowed user); for Other write the selected ids as the `operators` string array. Show Primary only if at least two channel objects have `enabled: true` and `channels.primary` is unset. Always show Record; read `knowledge.channel_log_enabled` to render the current global setting as on or off.

Merge the answered per-channel keys in one payload, omitting unselected keys and keys whose default is absence:

```bash
echo '{"channels":{"<channel>":{<answered_per_channel_keys>}}}' | bun ${CLAUDE_PLUGIN_ROOT}/scripts/hatch-config.ts "$(pwd)" --reinit
```

Never use Edit/Write on `config.json`. Stop on a non-zero merge exit as in Adding an entry. Omission preserves existing values on reinit; do not describe an existing override as cleared by omission. If a key is already customized, show that current value as the recommendation and preserve it unless an explicit replacement was selected. When the operator selects an absence default (`Each chat only itself`, `Inherit global setting`, `First allowed user`) for a key that is currently set, clear it with `bun ${CLAUDE_PLUGIN_ROOT}/scripts/settings-edit.ts .hermit/config.json unset channels.<channel>.<key>`; stop on a non-zero exit. Repeating the same answers must leave the file byte-identical.

For the Primary answer, run separately, substituting the selected enabled channel name:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/settings-edit.ts .hermit/config.json set channels.primary <name>
```

Stop on a non-zero exit. Never include `primary` in a `hatch-config.ts` payload: that merger treats every entry under `channels` as a channel object. Continue to §7.

### 7. Summary

```
Channel setup complete!

  Channel:        <channel>
  Plugin:         installed (--scope local)
  Token:          configured (<state_dir>/.env)
  Paired:         yes / skipped
  Server channels: <id1> (mention: yes/no), <id2> (mention: no) / skipped
  State dir:      <state_dir>

  hermitd-start passes --channels automatically on next boot.
  Later changes: /hermitd:hermit-settings channels (recall, record, operators)
```

If anything was skipped, list the remaining steps.

### 7a. Two-way proof

Run the Two-way proof stage in [channel connection stages](references/connection-stages.md). Include the actual verdict in the summary. If `.hermit/state/first-chat.json` exists, leave it armed so the operator's next message reaches the first chat.
