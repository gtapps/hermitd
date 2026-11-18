# Channel access

Built-in channel plugins follow this stage.
For other plugins, follow [Credentials and plugin procedures](other-channel.md#credentials-and-plugin-procedures) for admission and the [Shared flow boundary](other-channel.md#shared-flow-boundary) for agent access control.

Use the absolute project `.hermit` directory as `<hermit_state_dir>`, distinct from the channel's `<state_dir>`. On Docker, use the host-visible channel folder resolved in the credential stage, with no host plugin install. Set `<CHANNEL_UPPERCASE>_STATE_DIR` to that absolute folder for the channel access commands.

## Admission

Only people who may approve tool use should be DM-paired, because every `allowFrom` DM receives and can answer native permission prompts. Everyone else joins through a group whose admission is independent of `allowFrom`. The agent's `allowed_users` controls who can wake it. Native approval authority follows the plugin's DM admission.

Tell the operator a DM to the running bot yields a 6-character pairing code. Ask:

```
questions: [
  {
    header: "Pairing",
    question: "Channel state?",
    options: [
      { label: "Already paired", description: "Just verify access.json" },
      { label: "Ready to pair", description: "DM'd the bot and have the 6-character code" },
      { label: "Skip", description: "I'll pair later" }
    ]
  }
]
```

- **Already paired:** go to Verify access.
- **Ready to pair:** ask for the 6-character code via Other with header "Pairing code" and option **Skip**.
- **Skip** at either question: return to the calling wizard with pairing skipped.

Run `channel-pair` (Commands), then `channel-policy` (Commands) only after pairing succeeds. Each raises the native permission prompt. Bypass-mode callers are refused. On `{"error"}`, report the error token and stop this channel. Retain the pairing receipt's `sender_id` and `file`. Report the outcome: `home: "set"` means this DM became the briefing chat, `kept` preserves the existing home configuration, and `failed` means pairing succeeded and the first message can establish the home chat.

## Verify access

Check for `<state_dir>/access.json`. On a bare host, if it is missing and `~/.claude/channels/<channel>/access.json` exists, create `<state_dir>` and move the file there. Use `CLAUDE_CONFIG_DIR` instead of `~/.claude` when set. Report the move. A `file` receipt of `home` or `home+state` means the code came from the Claude home location. With `home+state` the project file was already updated.

If the project file is still missing, report that pairing could not be verified and return to the calling wizard with that result.

## Who may wake the agent?

Read the current channel config. Only set or ask about `allowed_users` after an admission in this run, when the pairing receipt has a `sender_id` and `allowed_users` is absent. Preserve any existing value.

In the agent's own managed session (`HERMIT_MANAGED=1`), apply **Only <paired id>** without asking and point to `/hermitd:hermit-settings channels` for later changes. In a separate setup session, ask once with header "Access ctrl" and question "Who may wake the hermit on this channel?" Offer **Only <paired id>** (recommended), **Allow everyone**, or additional ids through Other. Use the receipt's `sender_id` for the paired id. For additional ids include the paired id.

For an id selection, run `channel-config-merge` (Commands) with `{"channels":{"<channel>":{"allowed_users":<selected_string_array>}}}` on stdin. Stop this channel on a nonzero exit. For Allow everyone or a skipped setting, omit the key.

## Default delivery settings

After verifying project access, run `channel-ensure-defaults` (Commands) for Discord or Telegram. Report `ack` (`set` or `kept`). The default is `👀` only when `ackReaction` is absent. An empty string and customized values are preserved. On `{"error"}`, report the error token and stop this channel. Return the access result to the calling wizard.
