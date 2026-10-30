---
name: mcp-login
description: "Sign MCP servers and claude.ai connectors back in from chat by relaying their sign-in links. Activates on 'mcp login', 'reconnect', 'reconnect my tools', 'log in to Slack', or a tool that needs a sign-in."
---

# MCP Login

Signs this hermit's MCP servers and claude.ai connectors back in without anyone touching the box. When the hermit's own Claude sign-in is the problem, use `/hermitd:relogin` instead.

## Step 1: Send the links

Your tool list, deferred or loaded, names an `mcp__<server>__authenticate` tool for every server that needs a sign-in. If there are none, say every tool is signed in and stop. Otherwise load any deferred ones in one ToolSearch (`select:<name>,<name>`), starting with any tool the operator named, and call them in parallel.

Send the operator one message with a link per tool. When a `maintainer_channel_id` is configured for the active channel, send it through the maintainer channel with `{"maintainer":"<message>","sensitive":true}` on stdin, which keeps the links out of the channel log:

```
.hermit/bin/hermitd-run channel-send .hermit --notice
```

Any status but `delivered` means the links reached nobody: say so in the primary chat, without the links.

## Step 2: Take the address back

After approving access, the operator's browser fails to load a `http://localhost:<port>/callback?...` address. When they paste it from the primary chat, pass it whole as `callback_url` to the `mcp__<server>__complete_authentication` tool whose `authenticate` result named that port. The address is a one-time secret: never repeat it in a reply, task note or report. If completion fails, tell the operator that tool is still signed out and offer a fresh link from Step 1.

## Limits

Name these with their step when Step 1 meets them:

- A tool result that asks for `/mcp`: open `/mcp` in the Claude app over Remote Control, or run `claude mcp login <name> --no-browser` on the box.
- A project server pending approval: approve it in the project settings.
- Google or Microsoft services added as plain servers: connect them at claude.ai under Settings, Connectors.
- A hermit on a `setup-token` credential gets no claude.ai connectors; switching to a sign-in means setting `auth_mode` to `login` with `/hermitd:hermit-settings`, then running `/hermitd:relogin`.
