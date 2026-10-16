# Channel plugins

Hermit uses Claude Code's channel interface. The official channel plugins and the [channels reference](https://code.claude.com/docs/en/channels-reference) define the baseline. A plugin owns access, pairing, credentials, sender gating and its tools; Claude Code owns channel registration and approval decisions. Core adds task routing, reply capture, pause exemptions and optional script notices. Third-party channels are configured manually in `channels.<server-key>`; `/channel-setup` remains for the supported official channels.

## Plugin contract

Install a packaged Claude Code plugin declaring `claude/channel` and emitting channel notifications. Its `<channel>` tag must carry the chat id, message id and sender identity. Official field names are `chat_id`, `message_id`, `user_id` and the display name `user`. A `reply` tool takes the chat id; `edit_message` is optional for progress cards. The plugin must gate inbound senders before emitting events. Hermit's `allowed_users` narrows admission further and does not replace the plugin's access controls or permission-relay policy.

The config key is the server portion of `source="plugin:<plugin>:<server>"`. Set `plugin` when the installable plugin name differs from that key, and `marketplace` to its registered marketplace name. Boot uses `plugin:<plugin-or-key>@<marketplace>`. Bare `.mcp.json` `server:` channels are outside this integration.

Find a plugin's field names in its README, MCP server instructions, reply-tool input schema, and notification `meta` fields in its source. Inspect an incoming tag when necessary. Map canonical fields to wire names through `attributes`; omitted names retain official defaults. `user_id` and `user` must map to different names. A duplicate sender-id attribute voids identity, so it cannot impersonate an allowlisted sender.

A conforming plugin with thread support needs only these integration fields (the names here are examples):

```json
{
  "channels": {
    "teamchat": {
      "plugin": "teamchat-channel",
      "marketplace": "team-tools",
      "attributes": { "thread_id": "thread_ts" }
    }
  }
}
```

A plugin shaped like the Slack PR #23 integration can map its fields:

```json
{
  "channels": {
    "slack": {
      "plugin": "slack-channel",
      "marketplace": "slack-tools",
      "allowed_users": ["U0123"],
      "attributes": {
        "chat_id": "channel_id",
        "message_id": "ts",
        "user_id": "user",
        "user": "user_name",
        "thread_id": "thread_ts",
        "mentioned": "event=mention"
      }
    }
  }
}
```

Use names from the installed plugin, not these placeholder marketplace names. `attributes.mentioned` accepts an attribute name (matching the value `"true"`) or `attribute=value`. In `passive_chats`, that marker can wake the hermit without matching an `@handle`; configure group delivery in the plugin's own access settings.

## Threads and notices

With `attributes.thread_id`, tasks use `<server>:<chat>~<thread>` keys. `conversation.ts .hermit thread-open --source <server> --chat-id <chat> --message-id <message> --name <title>` prints the task's key, destination chat and any reply parameter as JSON for every channel. It calls a platform API only to create a native Discord thread in a server channel; a mapped thread attribute applies on any other channel, built-in ones included. A top-level message, including a DM with no thread attribute, is outside that thread. Status, shutdown and harness replies keep the incoming thread. Routine, heartbeat and alert notices target the configured chat, not a thread. Without a mapping, Telegram forum topics remain one chat.

Model replies use the channel's tools. Script-owned notices on a third-party channel require `send_script`, an executable project-relative path with no `..` segments. The real executable must stay inside the real project root, including through symlinks. Official Discord and Telegram senders keep their direct API paths.

For example, configure `"send_script": "tools/send-teamchat.sh"`, make that wrapper executable, and adapt it to the plugin's documented sending command:

```sh
#!/bin/sh
set -eu
# This example assumes the plugin provides a teamchat-send command.
# Load credentials only as the plugin documents; none are inherited here.
if [ -n "${HERMIT_THREAD_ID:-}" ]; then
  exec teamchat-send --state-dir "$CHANNEL_STATE_DIR" \
    --chat "$HERMIT_CHAT_ID" --thread "$HERMIT_THREAD_ID" --stdin
fi
exec teamchat-send --state-dir "$CHANNEL_STATE_DIR" \
  --chat "$HERMIT_CHAT_ID" --stdin
```

Text arrives on stdin. The environment contains only `PATH`, `HERMIT_DIR`, `HERMIT_CHAT_ID`, `CHANNEL_STATE_DIR`, and `HERMIT_THREAD_ID` when the target carries a thread. The script runs from the project root within the send timeout; exit 0 means delivery succeeded. Successful sends enter the outbound chat log unless marked sensitive or logging is disabled. Routine `chat` ownership is supported when the channel has a send script.

A configured channel without a send script returns `no_send_path`. Routing stays on that channel; core never sends its message to another app or person. Proactive notices fail when a third-party channel without a send script resolves first: it is `channels.primary`, or, when `channels.primary` names no enabled Discord or Telegram channel with a chat, it comes before every such channel in config order once it has a chat. Set `channels.primary` to `discord` or `telegram` so proactive notices have a send path. No doctor or boot warning detects unapproved channels or missing send scripts.

## Approval and installation

Claude Code applies its own [channel controls](https://code.claude.com/docs/en/channels#enterprise-controls). For a personal installation, an administrator can create `/etc/claude-code/managed-settings.d/hermitd-channels.json` as root on Linux (use the platform's managed-settings directory elsewhere):

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "claude-plugins-official", "plugin": "discord" },
    { "marketplace": "team-tools", "plugin": "teamchat-channel" }
  ]
}
```

List every channel you want available, including official ones: an explicit allowlist replaces the default approved set. Keep existing administrator policy intact. See [managed settings and drop-in files](https://code.claude.com/docs/en/managed-settings) for precedence and platform paths. For Team or Enterprise, an Owner sets the policy in Organization settings > Claude Code > Managed settings; organization policy can take precedence over local files.

Docker rendering writes the drop-in automatically when third-party marketplaces are configured. Existing Docker hermits run `/hermitd:hermit-evolve`, then `hermitd-docker update` to merge templates and rebuild. The entrypoint uses the configured plugin and server names for MCP approval. Official plugins retain their official install path. Third-party plugins must be installed through `docker.recommended_plugins`, for example:

```json
{
  "docker": {
    "recommended_plugins": [
      {
        "plugin": "teamchat-channel",
        "marketplace": "acme/team-tools",
        "scope": "local",
        "enabled": true
      }
    ]
  }
}
```

Use the plugin's documented marketplace source and the [recommended plugin schema](config-reference.md#recommended_plugins-entry-schema). Add its network hosts through `docker.security.network.additional_domains` via `/hermitd:docker-security`, as described in [Docker security](docker-security.md). Installation and approval are separate prerequisites.

At boot, channel keys whose uppercase `<KEY>_STATE_DIR` matches `^[A-Z_][A-Z0-9_]*$` receive a state directory environment variable. Keys containing hyphens do not. Set `state_dir` for the channel's documented location. Other non-secret variables belong in `config.env`; tokens belong wherever the plugin documents, in ignored credential files. A send wrapper must explicitly load credentials it needs. Hermit does not add pairing commands, access commands, probes or liveness diagnostics for third-party plugins.
