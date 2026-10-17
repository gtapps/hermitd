---
name: channel-setup
description: Guided channel activation for local/tmux users — adds a channel entry when none is configured, installs the plugin, configures the bot token in the project-local state dir, and walks through pairing. Run after hatch, or any time to add or re-enable a channel.
disable-model-invocation: true
---

# Channel Setup

Activate a channel, adding the `config.json` entry first when there isn't one. Local/tmux pairing is this skill's own flow; a Docker hermit is routed by the check below.

## Commands
- `channel-group-add`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-access.ts "<hermit_state_dir>" group-add`

## Plan

### 1. Read config and detect channels

**Runtime routing (first):** evaluate in this order.

1. **Inside the container.** Run `[ -f /.dockerenv ] || [ -f /run/.containerenv ] && echo container || echo host`. If `container`: read `.hermit/config.json`. For each enabled channel object, resolve `state_dir` as step 4 does (config `state_dir`, default `.claude.local/channels/<channel>`; if relative, make it absolute against the project root) and print that absolute path literally. Print and stop:
   > DM the bot for a code, then run `/hermitd:channel-setup` from a normal host session at the project root.
   If no enabled channel, print only the host-run sentence and stop. No `AskUserQuestion` on this path.

2. **No compose file.** If `docker-compose.hermit.yml` is absent at the project root, continue with the local/tmux flow below.

3. **Live tmux hermit.** Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/docker-preflight.ts "$(pwd)"`. If its `live_owner` is non-null, a host tmux hermit owns this project despite the compose file: continue with the local/tmux flow below.

4. **Compose present.** Run `docker compose -f docker-compose.hermit.yml ps --status running --format '{{.Service}}'`. Non-zero exit → print its output, stop. If `hermit` is absent from the output: after channel selection, run steps 2 and 4, skip 3, then stop with `hermitd start` and "re-run this skill to pair". If `hermit` is present: docker-running.

5. **docker-running.** After channel selection, skip step 3 (the container installs channel plugins at boot). Run step 4; a `channel-bot-id.ts` skip with `http_401` or `http_403` is reported as "token rejected by <platform>, fix it before restarting". If this run created the config entry or wrote the token → stop: "The bot is offline until the container restarts and loads it: `hermitd restart`, then DM the bot for a code and re-run this skill. Still no code after a restart: `hermitd docker logs --tail=60` shows the plugin's own error (wrong token, missing Message Content intent, install failure), and `/hermitd:hermit-doctor` checks the token." Otherwise run §5, §6, §6a, §6b, and §6c against the host-visible channel `<state_dir>`, passing the absolute project `.hermit` directory as `<hermit_state_dir>` to `channel-access.ts`. No restart prompt is needed for an already-running bot. Continue with §6d, §6e, then §7 for each paired channel. Add to the pairing question: "No code from the bot? It has not loaded the token: `hermitd restart`, then re-run this skill."

Read `.hermit/config.json`. Collect all entries under `channels` that are valid objects, tracking which are disabled (`enabled: false`).

**Adding an entry.** Where a branch below says *create the entry*, run (`<name>` is the lowercase channel key — `discord`, `telegram` — never the capitalized option label):

```
echo '{"channels":{"<name>":{"enabled":true}}}' | bun ${CLAUDE_PLUGIN_ROOT}/scripts/hatch-config.ts "$(pwd)" --reinit
```

The script fills `enabled`, `dm_channel_id: null`, `default_chat_id: null`, and `state_dir` (`.claude.local/channels/<name>`), validates the whole config, preserves every other key, and merges onto an existing entry rather than replacing it. It prints `OK`. On `error` nothing was written: report it and stop — never fall through into steps 2–6 against a channel that isn't in `config.json`.

- If no channels configured: offer to add one — `AskUserQuestion` (header: "Channel") with options **Discord**, **Telegram**, **Cancel**. On **Cancel**, stop without writing. Otherwise create the entry and continue with that channel selected. Do not offer iMessage here: step 4 defines token vars for Discord and Telegram only.
- If entries exist but all are disabled: name them, then ask with `AskUserQuestion` (header: "Channel") — the disabled channel names plus **Cancel** — which to re-enable. On **Cancel**, stop without writing. Otherwise create the entry for the chosen name (this flips `enabled` and leaves `dm_channel_id`, `default_chat_id`, `state_dir`, and `allowed_users` intact) and continue with it selected.
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

- the plugin name (substring of `id` left of `@`) equals `<channel>`, AND
- the marketplace name (substring of `id` right of `@`) equals the resolved marketplace.

(Both clauses matter — `discord@some-other-marketplace` is a different plugin from a different source and must not satisfy this gate.)

- **Found**: skip silently. The channel plugin is already installed and enabled at project or local scope for this project — the canonical filter guarantees `enabled == true`, and `*_STATE_DIR` (set by `hermitd-start` at boot) points at `.claude.local/channels/<channel>/`.
- **Not found**: run, in order:
  ```bash
  claude plugin install <channel>@<marketplace> --scope local
  claude plugin enable  <channel>@<marketplace> --scope local
  ```
  Explicit `enable` covers the disabled-but-installed-at-project/local case — the filter excluded such entries (enabled-only), and `install` is a separate command from `enable` per the CLI surface, so it may no-op without re-enabling. A user-scope install elsewhere does not satisfy this gate; channel tokens and access policy are project-local.

After any install (or if already present): tell the operator to run `/reload-plugins` in this session to activate the plugin's configure and access commands before pairing.

### 4. Token configuration (AskUserQuestion)

Before the token question, print the applicable platform prerequisite: Discord: Developer Portal, Bot tab: turn Message Content intent on; turn Public Bot off unless anyone may add it. Telegram: privacy mode only matters for respond-to-all; see §6c. No extra question.

Token env var names: `discord` → `DISCORD_BOT_TOKEN`, `telegram` → `TELEGRAM_BOT_TOKEN`.

Resolve `state_dir`:
- Read `channels.<channel>.state_dir` from config.json.
- If not set, default to `.claude.local/channels/<channel>`.
- If relative, it is relative to the project root (current directory).

Check if the token file already exists: `<state_dir>/.env` and contains the token var name.
- If yes: "Token already configured at `<state_dir>/.env`." → proceed to step 5.
- If no: display the official setup guide reference and ask for the token:

> To create your bot and get a token, follow the official guide:
> https://code.claude.com/docs/en/channels

```
questions: [
  {
    header: "Bot token",
    question: "Paste your bot token (or skip to add it later):",
    options: [
      { label: "Skip", description: "I'll add the token to <state_dir>/.env manually" }
    ]
  }
]
```

Operator pastes the token via Other, or selects Skip.

**If token provided:**
1. `mkdir -p <state_dir>`
2. Write `<TOKEN_VAR>=<pasted-token>` to `<state_dir>/.env` (overwrite if exists)
3. `chmod 600 <state_dir>/.env`
4. Ensure `.claude.local/` is in `.gitignore`: check if `.gitignore` exists and contains `.claude.local/`; if missing, append `.claude.local/`.
5. If `channels.<channel>.state_dir` was not set in config.json (a legacy entry, or one reached through the single-enabled-channel branch that never ran *Adding an entry*), run the same `hatch-config.ts … --reinit` one-liner for `<channel>` now, but with an **empty** entry — `echo '{"channels":{"<name>":{}}}' | …` — so an existing `enabled: false` is preserved (the `{"enabled":true}` payload would flip it). It fills the conventional `state_dir`, validates, and audits, leaving every other field intact. Never write the key with Edit/Write.
6. Validate `<CHANNEL_UPPERCASE>_STATE_DIR` for the next resident start. Compute the absolute path of `state_dir`, then run:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts .claude/settings.local.json channel-env <CHANNEL_UPPERCASE> <absolute_state_dir>
   ```
   This validates and reports the state directory without writing settings. The configured state dir takes effect in the resident environment and launch overlay at the next start. Tokens stay in the channel's `.env`. Confirm: "Configured `<CHANNEL_UPPERCASE>_STATE_DIR` → `<absolute_state_dir>` (takes effect at the next start)."

7. Capture the bot's own identity so the hermit recognizes mentions of itself:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-bot-id.ts .hermit <channel> --write
   ```
   Writes `bot_user_id` (and `bot_username`) into the channel's `config.json` entry, overwriting a stale value from a previous bot. A `skip` status is a non-event — report it and continue; setup never fails on it.

**If token already configured:** also run steps 6 and 7 before proceeding to step 5.

**If Skip:** print the manual command:
```
echo '<TOKEN_VAR>=your-token' > <state_dir>/.env && chmod 600 <state_dir>/.env
```
Then proceed to step 5 without a token (pairing will be skipped in step 5).

### 5. Restart + pairing (AskUserQuestion)

**If no token is configured** (skipped in step 4): print restart instructions and stop:
> Restart Claude Code with channels active once you've added your token:
> - With hermit: `hermitd-start` (passes `--channels` automatically)
> - Manual: `claude --channels plugin:<channel>@<marketplace>`
>   (use the same `<marketplace>` resolved in step 3 — `claude-plugins-official` for built-in channels, or `channels.<channel>.marketplace` for third-party plugins.)

**If token is configured:** on docker-running go straight to the pairing question batch. Otherwise check whether the channel is already active in the current session by checking if the channel's reply tool is available. If active, skip the restart prompt and go straight to the pairing question batch.

If not active, display:
> Token saved. Restart Claude Code to activate the channel:
> - With hermit: `hermitd-start` (passes `--channels` automatically)
> - Manual: `claude --channels plugin:<channel>@<marketplace>`
>   (use the same `<marketplace>` resolved in step 3.)
>
> After restarting, DM your bot: it will reply with a 6-character pairing code.
> Only people who may approve tool use should be DM-paired, because every `allowFrom` DM receives and can answer native permission prompts; everyone else joins through a group whose admission is independent of `allowFrom`, and `allowed_users` narrows who can wake the hermit, never who can approve.

Then ask:

```
questions: [
  {
    header: "Pairing",
    question: "Channel state?",
    options: [
      { label: "Already paired", description: "Just verify access.json" },
      { label: "Ready to pair", description: "Restarted, DM'd the bot, have the 6-char code" },
      { label: "Skip", description: "I'll pair later" }
    ]
  }
]
```

- **Already paired**: skip pairing, go to access.json verification in step 6.
- **Ready to pair**: proceed with pairing flow below.
- **Skip**: stop — "Run `/hermitd:channel-setup` again after restarting to complete pairing."

**Pairing flow:**

Ask with `AskUserQuestion`:

```
questions: [
  {
    header: "Pairing code",
    question: "Paste the 6-character code your bot replied with:",
    options: [
      { label: "Skip", description: "Pair later" }
    ]
  }
]
```

If code provided (via Other), use the absolute project `.hermit` directory as `<hermit_state_dir>` (distinct from the channel's `<state_dir>`):

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-access.ts "<hermit_state_dir>" pair <channel> <code>
bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-access.ts "<hermit_state_dir>" policy <channel> allowlist
```

Run the policy command only after pairing succeeds. Relay the result, retaining pairing's `file` (`state`, `home` or `home+state`) for §6. On `{"error"}`, report the token and stop. Pairing and policy each raise the native permission prompt; bypass-mode callers are refused. Verify the location in §6.

If Skip: "DM the bot later, then run `/hermitd:channel-setup` from a normal host session." Stop.

### 6. Verify access.json location

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

### 7a. Send owner welcome (once, only when exactly one channel was newly paired)

Run this once, after step 7's summary, across the *whole* run — not per channel inside the steps 2–6 loop.

Skip entirely if no channel selected "Ready to pair" in step 5 this run — an operator re-running setup against an already-paired channel ("Already paired") or one they skipped shouldn't get a repeat welcome.

Also skip, with a note in the summary ("Welcome message skipped — more than one channel was newly paired this run; let the owner know directly"), if *more than one* channel selected "Ready to pair" this run (the "All" path pairing several channels at once). `channel-send.ts` has no per-channel target — it resolves one generic outbound channel (`primary`, else first eligible in config order) — so with several freshly-paired channels there's no reliable way to know which one it would reach.

Otherwise (exactly one channel newly paired), compose a short welcome in the operator's configured `language` (`config.json`), in your own voice, so the owner has something the moment the bot can reach them. Not the full guide, just an orientation pointer covering: they can talk to you anytime in plain language; when you have a suggestion or need a decision you will ask, and yes, later, or no is enough; `!pause` stops you until `!resume` (both must start with `!`); you track AI spend and warn when it nears any configured limit; if you go quiet or something is confusing, they should reach whoever set you up (who also has the full written guide). No file paths or internal jargon: it's the owner's first message, and the only chat commands allowed are the five control commands `!pause`, `!stop`, `!resume`, `!snooze`, `!status`. Send it on stdin:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-send.ts .hermit - <<'HERMIT_WELCOME'
<the composed welcome>
HERMIT_WELCOME
```

Use this send as the post-hatch delivery confirmation and report it explicitly in the summary. On success: "Test message sent — check <channel> and tell me if it didn't arrive." If the send fails, don't block setup: "Channel paired, but the test message didn't arrive (`<error>`) — check the pairing before relying on this channel."
