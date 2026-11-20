# Channel access

Use the shared procedures for Discord, Telegram, and custom channels with an official-shape `access.json`. For a custom channel, use [Credentials and plugin procedures](other-channel.md#credentials-and-plugin-procedures) and check the [Shared flow boundary](other-channel.md#shared-flow-boundary) before choosing the admission procedure.

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

Run `channel-show` (Commands) to verify the file shape and see its approvers. For **Already paired**, use the verified paired ID of the operator completing setup. If multiple IDs are possible, ask which one is theirs and verify it against the returned approvers.

## Who may wake the agent?

Read `approvals` and the current channel config. When `allowed_users` already exists, preserve it. Use the receipt's `sender_id` or the verified ID from access verification.

- With `approvals: "team"`, leave `allowed_users` unset. Explain that anyone admitted by the channel plugin can talk to the agent. To restrict access later, use `/hermitd:channel-access` for a chat or `/hermitd:hermit-settings channels` for the channel-wide list.
- In personal mode, apply **Only <paired id>** in the agent's own managed session. In a separate setup session, ask once who may wake the agent. Offer **Only <paired id>** (recommended), **Allow everyone**, or additional IDs through Other. For additional IDs include the paired ID.

For an ID selection, run `channel-config-merge` (Commands) with `{"channels":{"<channel>":{"allowed_users":<selected_string_array>}}}` on stdin. Whenever setup leaves `allowed_users` unset, merge `{"channels":{"<channel>":{"operators":["<paired id>"]}}}` if `operators` is absent. In both modes this keeps operator authority with the named person even in a group home chat. Preserve an existing `operators`. If no paired ID can be verified, report that operator authority was not set and ask for the ID before finishing access. Stop this channel on a nonzero merge exit.

## Default delivery settings

After verifying an official-shape project file with `channel-show` (Commands), run `channel-ensure-defaults` (Commands) for that channel. Report `ack` (`set` or `kept`). The default is `👀` only when `ackReaction` is absent. An empty string and customized values are preserved. On `{"error"}`, report the error token and stop this channel. Return the access result to the calling wizard.
