---
name: channel-setup
description: Guided channel activation for local/tmux users; adds a channel entry when none is configured, installs the plugin, configures the bot token in the project-local state dir, and walks through pairing. Run after hatch, or any time to add or re-enable a channel.
disable-model-invocation: true
---

# Channel Setup

Activate a channel, adding the `config.json` entry first when there isn't one. This wizard prepares the credential, brings up the channel, and guides access.

## Commands
- `channel-group-add`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-access.ts "<hermit_state_dir>" group-add`
- `channel-register`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/settings-edit.ts .hermit/config.json channel-register`
- `channel-pair`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-access.ts "<hermit_state_dir>" pair <channel> <code>`
- `channel-policy`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-access.ts "<hermit_state_dir>" policy <channel> allowlist`
- `channel-ensure-defaults`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-access.ts "<hermit_state_dir>" ensure-defaults <channel>`
- `channel-bot-id`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-bot-id.ts "<hermit_state_dir>" <channel> --write`
- `channel-config-merge`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/hatch-config.ts "$(pwd)" --reinit`
- `channel-env-check`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/apply-settings.ts .claude/settings.local.json channel-env <CHANNEL_UPPERCASE> "<absolute_state_dir>"`
- `channel-session-check`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/request-restart.ts "<hermit_state_dir>" --check --session-id "${CLAUDE_SESSION_ID}"`
- `channel-restart`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/request-restart.ts "<hermit_state_dir>" --session-id "${CLAUDE_SESSION_ID}"`

## Plan

### 1. Pick

**Runtime routing (first):** evaluate in this order.

1. **Inside the container.** Run `[ -f /.dockerenv ] || [ -f /run/.containerenv ] && echo container || echo host`. If `container`: read `.hermit/config.json`. For each enabled channel object, resolve `state_dir` (config `state_dir`, default `.claude.local/channels/<channel>`; if relative, make it absolute against the project root) and print that absolute path literally. Print and stop:
   > DM the bot for a code, then run `hermitd setup channel-setup` from a host terminal at the project root.
   If no enabled channel, print only the host-run sentence and stop. No `AskUserQuestion` on this path.

2. **Own managed host session.** When `HERMIT_MANAGED=1`, run `channel-session-check` (Commands). On `resident`, this is the agent's own session: if an enabled channel already has a home chat, direct the operator to a separate host session for channel setup and stop before the picker; otherwise use the own-session path in Step 5. On `guest`, continue to routing 3.
3. **Live host owner.** Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/docker-preflight.ts "$(pwd)"`. Use `live_owner.mode` to identify a running host agent (`tmux` or `interactive`). A live host owner takes precedence over a compose file.
4. **Compose present without a live host owner.** Build the stack in its precedence order, `COMPOSE_FILES=(-f docker-compose.hermit.yml); [ ! -f docker-compose.security.yml ] || COMPOSE_FILES+=(-f docker-compose.security.yml); [ ! -f docker-compose.override.yml ] || COMPOSE_FILES+=(-f docker-compose.override.yml)`, then run `docker compose "${COMPOSE_FILES[@]}" ps --status running --format '{{.Service}}'`. On a nonzero exit, show its output and stop. Record whether `hermit` is running.
5. **Docker host.** Follow Step 4 on the host and use the operator-run lifecycle handoff in Step 5. Skip Step 3 because the container installs its plugins at boot. Without compose, use the host flow.

Read `.hermit/config.json`. Collect all entries under `channels` that are valid objects, tracking which are disabled (`enabled: false`).

**Adding an entry.** Where a branch below says *create the entry*, run `channel-config-merge` (Commands) with `{"channels":{"<name>":{"enabled":true}}}` on stdin. Use the lowercase channel key `discord` or `telegram` for `<name>`.

The script fills `enabled`, `default_chat_id: null`, and `state_dir` (`.claude.local/channels/<name>`), validates the whole config, preserves every other key, and merges onto an existing entry rather than replacing it. It prints `OK`. On `error` nothing was written: report it and stop; never fall through into steps 2 through 6 against a channel that isn't in `config.json`.

- If no channels configured: ask one `AskUserQuestion` (header: "Channel") offering **Telegram**, **Discord**, **Other**, **Cancel**. Cancel stops without writing. Discord or Telegram creates the entry and selects it. Other reads [the Other channel reference](references/other-channel.md) and follows its plugin-owned procedures within the shared stages.
- If any channels configured: always ask one `AskUserQuestion` listing every existing channel name (mark disabled entries) plus **Add another channel**. Add another channel leads to the same four options above. Selecting a disabled channel creates the entry to re-enable it; an existing custom channel then uses the Other reference. No channel is selected automatically.

Run the stages for the selected channel. Use the Other reference for custom-channel registration and plugin procedures.

### 2. Install: prerequisites

Run both checks in a single Bash call:

```bash
bun --version 2>/dev/null; uname -s
```

- **Bun missing** (command fails / no output): tell the operator —
  > Bun is required for channel plugins but is not installed.
  > Install: https://bun.sh
  > Then re-run this skill.

  Stop for this channel.

- **iMessage on non-macOS or Docker**: if the channel is `imessage` and `uname -s` is not `Darwin` or this is a Docker host, note it's macOS-only and skip this channel.

### 3. Install: plugin

Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-siblings.ts "$(pwd)"` to get the project-or-local + enabled plugin list (JSON array; user-scope, managed, disabled, and cross-project entries already dropped). Each entry carries `plugin`, `marketplace_name`, `scope`, `enabled`.

Resolve `<plugin>` from `channels.<channel>.plugin`, falling back to the channel key. Resolve the expected marketplace for this channel:

- If `channels.<channel>.marketplace` is set in `config.json`, use that value (third-party channel plugin path).
- Otherwise, use `claude-plugins-official` (built-in channels: discord, telegram, imessage).

Then check whether the surviving set contains an entry where:

- the plugin name (substring of `id` left of `@`) equals `<plugin>`, AND
- the marketplace name (substring of `id` right of `@`) equals the resolved marketplace.

(Both clauses matter; `discord@some-other-marketplace` is a different plugin from a different source and must not satisfy this gate.)

- **Found**: skip silently. The channel plugin is already installed and enabled at project or local scope for this project; the canonical filter guarantees `enabled == true`, and `*_STATE_DIR` (set by `hermitd-start` at boot) points at `.claude.local/channels/<channel>/`.
- **Not found**: run, in order:
  ```bash
  claude plugin install <plugin>@<marketplace> --scope local
  claude plugin enable  <plugin>@<marketplace> --scope local
  ```
  Explicit `enable` covers the disabled-but-installed-at-project/local case; the filter excluded such entries (enabled-only), and `install` is a separate command from `enable` per the CLI surface, so it may no-op without re-enabling. A user-scope install elsewhere does not satisfy this gate; channel tokens and access policy are project-local.

If the operator needs this host session to use newly installed plugin skills, tell them to run `/reload-plugins` to expose those skills. Continue the wizard.

### 4. Credential

Follow the [channel credential stage](references/credential.md).

### 5. Activate the channel

Invocation arguments: `$ARGUMENTS`. The `start` argument selects always-on host setup before first boot has recorded `always_on`.

- **Docker host:** When `hermit` is running and this run neither created or re-enabled the entry nor wrote the credential, the container already loads the channel: continue to access, and use the handoff below only if the bot sends no code. Otherwise, when the credential is configured, ask the operator to run `hermitd start` if the service is stopped, or `hermitd restart` if it is running. Add `--build` when the channel has its own `marketplace`. The operator runs this in their own terminal at the project root, where they can review and answer any approval diff. Wait for them to confirm success. Repeat the Compose check from routing 4 and continue only once `hermit` is running. If the bot stays silent after activation, inspect `hermitd docker logs --tail=60` and the plugin guide before naming a cause. State what was checked when the cause is unknown.
- **Own managed host session:** If the selected channel's reply tool is available, continue to access. Otherwise, when the credential is configured, tell the operator that you are requesting a restart that resumes this conversation. Tell them to DM the bot and type `/hermitd:channel-setup` here again to finish admission. If the channel stays unavailable, they can run the wizard again from the saved credential. Run `channel-restart` (Commands) as the final act. This requests the restart through the watchdog. If it returns `watchdog_missing`, relay the error and stop. If it returns `refused`, this is a separate session: run routing 3 and use the matching separate-session branch below.
- **Separate session, running host tmux agent (`live_owner.mode` is `tmux`):** When this run neither created or re-enabled the entry nor wrote the credential, the agent already loads the channel: continue to access. Otherwise, when the credential is configured, ask once, **Restart now** or **Later**. Explain that restart keeps the conversation. On Later, summarize what was saved and stop before access. On Restart now, run plain `hermitd restart`.
- **Separate session, stopped always-on host agent:** If `live_owner` is null and either `always_on` is true in config or the invocation includes `start`, run `hermitd start` without asking, even if the credential was skipped.
- **Foreground interactive:** If the selected channel's reply tool is available, continue to access. Otherwise tell the operator to restart Claude Code with `claude --channels plugin:<plugin>@<marketplace>` using the plugin and marketplace resolved in Step 3. They can also use `hermitd-start`, which passes `--channels` automatically. Stop here.

After a successful host start or restart in a separate session, re-read `live_owner` about every 10 seconds, for up to two minutes, until it reports a running tmux agent. If the command fails or the agent does not come up in that time, report the failure and stop before access.

If the credential was skipped, stop before access and tell the operator how to resume from the credential stage. Otherwise, once the agent is up with the channel, continue to Step 5a.

### 5a. Access

Follow the [channel access stage](references/access.md) for admission, access verification, sender restrictions, and delivery defaults. If access was skipped or could not be verified, tell the operator to DM the bot and type `/hermitd:channel-setup` again when ready. On Docker use `hermitd setup channel-setup` from the host.

After access in the agent's own managed session, skip the later questions and proceed to the summary. The ask gate redirects questions once a home chat is established.

### 6d. Maintainer channel check (optional)

If `channels.<channel>.maintainer_channel_id` is set in `config.json`, this channel routes technical, operational, and spend alerts to a second outbound-only destination (same bot/token, a different chat) instead of the primary chat, used on client-facing installs so the person on the primary chat never sees ops detail. Doctor's channel-liveness probe only checks the primary chat, so a typo'd maintainer id would otherwise fail silently on every alert rather than at setup.

When it's set, send **one** test message to the maintainer chat to confirm reachability:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-send.ts .hermit --tier maintainer --channel <channel> -
```

with a short line on stdin (e.g. "Maintainer channel check: technical and spend alerts will arrive here."). Record the result in the §8 summary: **sent** confirms the id; a **failure** means the id is wrong or the chat isn't reachable, so surface it so the operator fixes it now. If `maintainer_channel_id` is absent, skip silently.

A maintainer-send failure means **the bot isn't present or permissioned in the target server/channel**; the fix is to invite/permission the bot there. This chat is reached by a direct API POST with the bot token, never through `access.json`, so running `/<channel>:access` will not fix a failed send here.

### 6e. Operators and primary channel

Once per selected channel, re-read config after the preceding merges. Ask the applicable rows in one `AskUserQuestion` call (at most four rows); drop conditional rows whose conditions are false. Skip the call if no rows remain. The defaults below describe a fresh setup; preserve existing customization when an answer is omitted.

| Header | Question | Options (`label`: description) |
|---|---|---|
| Operators | Who may manage hermit-wide standing roles? | `First allowed user (<id>)`: use the first allowed id (default) / Other: operator user ids |
| Primary | Which enabled channel should receive default outbound messages? | `<this channel>`: use this channel (default) / each other enabled channel by name |

Show Operators only if `channels.<channel>.allowed_users` contains at least two ids; for the default option omit `operators` (absence already means the first allowed user); for Other write the selected ids as the `operators` string array. Show Primary only if at least two channel objects have `enabled: true` and `channels.primary` is unset.

Run `channel-config-merge` (Commands) with `{"channels":{"<channel>":{<answered_per_channel_keys>}}}` on stdin, omitting unselected keys and keys whose default is absence.

Never use Edit/Write on `config.json`. Stop on a non-zero merge exit as in Adding an entry. Omission preserves existing values on reinit; do not describe an existing override as cleared by omission. If a key is already customized, show that current value as the recommendation and preserve it unless an explicit replacement was selected. When the operator selects an absence default (`First allowed user`) for a key that is currently set, clear it with `bun ${CLAUDE_PLUGIN_ROOT}/scripts/settings-edit.ts .hermit/config.json unset channels.<channel>.<key>`; stop on a non-zero exit. Repeating the same answers must leave the file byte-identical.

For the Primary answer, run separately, substituting the selected enabled channel name:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/settings-edit.ts .hermit/config.json set channels.primary <name>
```

Stop on a non-zero exit. Never include `primary` in a `hatch-config.ts` payload: that merger treats every entry under `channels` as a channel object. Continue to the proof stage, then the summary.

### 7. Proof

Have the operator send a message on the selected channel. The running agent answers there through that channel’s reply tool, then setup asks the operator to confirm the reply arrived. Report confirmed or unconfirmed; unconfirmed does not block completion. Setup writes nothing for this check.

### 8. Summary

```
Channel setup complete!

  Channel:        <channel>
  Registration:   registered / not registered / unknown
  Activation:     active / restart needed / unknown
  Proof:          confirmed / unconfirmed
  Plugin:         installed (--scope local)
  Token:          configured (<state_dir>/.env)
  Paired:         yes / skipped
  State dir:      <state_dir>

  hermitd-start passes --channels automatically on next boot.
  Later changes: /hermitd:hermit-settings channels (groups, recall, recording, operators, members-only)
```

When `channels.<channel>.marketplace` is set in `config.json` (third-party channel), also print this line after the block; never for built-in channels:

```
For additional custom channel integration, see the channel plugins guide: https://github.com/gtapps/hermitd/blob/main/plugins/hermitd/docs/channel-plugins.md#threads-and-notices
```

Report three access facts separately: who the plugin admits, the agent's own sender restriction (`allowed_users`), and whether the plugin relays permission prompts to chat. Report separately whether script-sent alerts can reach this channel through an official sender or a configured `send_script`. Use evidence from the plugin and config; write **unknown** for anything that cannot be established. Never infer plugin admission or permission relay from `allowed_users` or a successful reply.

If anything was skipped, list the remaining steps.
