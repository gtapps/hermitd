---
name: mcp-login
description: "Sign MCP servers and claude.ai connectors back in from chat by relaying their sign-in links. Activates on 'mcp login', 'reconnect', 'reconnect my tools', 'log in to Slack', or a tool that needs a sign-in."
---

# MCP Login

Signs this hermit's MCP servers and claude.ai connectors back in without anyone touching the box. When the hermit's own Claude sign-in is the problem, use `/hermitd:relogin` instead.

## Step 1 — Send the links

The deferred tool list names an `mcp__<server>__authenticate` tool for every server that needs a sign-in. If there are none, say every tool is signed in and stop. Otherwise load them in one ToolSearch (`select:<name>,<name>`), starting with any tool the operator named, and call them in parallel.

Send the operator one message with a link per tool. When a `maintainer_channel_id` is configured for the active channel, send it through the maintainer channel, text on stdin:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-send.ts .hermit --tier maintainer -
```

## Step 2 — Take the address back

After approving access, the operator's browser fails to load a `http://localhost:<port>/callback?...` address. When they paste it from the primary chat, pass it whole as `callback_url` to the `mcp__<server>__complete_authentication` tool whose `authenticate` result named that port. The address is a one-time secret: never repeat it in a reply, task note or report.

## Limits

Name these with their step when Step 1 meets them:

- A tool result that asks for `/mcp`: open `/mcp` in the Claude app over Remote Control, or run `claude mcp login <name> --no-browser` on the box.
- A project server pending approval: approve it in the project settings.
- Google or Microsoft services added as plain servers: connect them at claude.ai under Settings, Connectors.
- A hermit on a `setup-token` credential gets no claude.ai connectors; switching to a sign-in runs through `/hermitd:relogin`.
