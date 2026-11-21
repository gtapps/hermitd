# hermitd-connector

Talk to your agent from **Claude, ChatGPT, Grok or Gemini**, by voice or text. It supports multiple users. Each user adds the agent as a custom connector in their own AI app. The app passes on what they say, then shows or speaks the agent's answer.

The agent works in its usual session, with its memory and tools. Everyone who comes in through the connector is a **plain member**, you included: they can ask for work, but they can't pause, steer or reconfigure the agent.

For your own typed work, [Remote Control](https://code.claude.com/docs/en/remote-control) gives you the full session; use the connector for voice and for other people.

## Requirements

- Core `hermitd` 1.4.39 or newer, set up and running.
- A **public HTTPS address on port 443**, for example `https://agent.example.com`. Every supported app reaches it there, and Claude does not connect to a connector URL with any other port ([Anthropic help](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)). If another service already holds 443 on that host name, use another host name.
- A **tunnel** (or reverse proxy) from that address to a local port on the agent's machine, such as Tailscale Funnel or Cloudflare Tunnel (see [manual setup](docs/setup.md)). The connector server listens on `127.0.0.1` only.
- On Docker, an agent that does not use host networking.
- An account on a supported app for each person

## Set up

**Let an AI assistant do it.** On the agent's machine, open Claude Code, Codex or another coding assistant and send:

```text
Set up the hermitd connector using https://github.com/gtapps/hermitd/blob/main/plugins/hermitd-connector/docs/setup.md. First ask which agent and tunnel to use. Check what's already set up and continue from there. Run the steps you can, hand me any Claude Code commands I need to type, and pause when a step needs my login, approval or sudo.
```

**Set it up yourself.** Follow the [manual setup guide](docs/setup.md).

## Pair someone

1. In their app they add a custom connector named after the agent, with your address and `/mcp` at the end, for example `https://agent.example.com/mcp`. In Claude: **Customize > Connectors > + Add > Add custom connector**. In ChatGPT: developer mode, then add a custom MCP server. In Grok: **grok.com/connectors > New Connector > Custom**. In Gemini: **Settings > Connected Apps > Add a custom app**, on the web. [Connector docs](../hermitd/docs/connector.md#how-people-connect) has the details.
2. They sign in and send you the 8-character pairing code. The code is valid for 10 minutes. Run the approval command on the host.

   ```bash
   hermitd connector <name> pair <code> --name Ana
   ```

   Once you approve the code, their app connects. Follow the same steps to pair yourself.

A pairing is not a verified app account: it is whoever completed the sign-in page with the code you approved, so only approve codes you got from the person directly.

On Team and Enterprise plans, an Owner adds the custom connector once under **Organization settings > Connectors**. Each member then clicks **Connect** under **Customize > Connectors** and is paired the same way.

## Use it

Turn on the connector in your app and say “Have Atlas pull last month’s invoices, match them against the expense sheet, and flag what’s missing.” You can type the same instruction in chat.

Add one custom connector per agent to delegate different kinds of work. For example, say “Brainstorm with Scout about how to make it easier for new contributors to get started. Bring back three ideas we could try.” See [how to set up several agents on one host](docs/setup.md#several-agents-on-one-host).

To work with the same agent throughout a voice chat, say “For the rest of this chat, pass any work I give you directly to Atlas and read back its replies.”

If the agent needs longer, say “Check whether Atlas has an update.” Messages wait while the agent is offline. Voice mode may shorten a long reply.

Each person has their own chat with the agent. Everyone paired with that agent shares its session, tools, and accounts. Use separate agents when people need to keep their work private.

## Manage it

```bash
hermitd connector <name> status         # server and channel state
hermitd connector <name> list           # who is paired
hermitd connector <name> revoke <id>    # remove one person
hermitd connector <name> disable        # stop at the next restart, pairings kept
```

Use `status` to see whether the server is running, the channel is polling, and any dispatched messages are still unanswered. If something looks wrong, see [Recovery](docs/setup.md#recovery).

`enable` also takes `--wait-seconds` (how long a call waits for the agent, default 25, at most 200) and `--rate-per-hour` (per person, default 60). Run it again and restart the agent to change either.

Limits and the security model: [connector guide](../hermitd/docs/connector.md). On Docker the server runs as its own service: [Docker security](../hermitd/docs/docker-security.md#connector).

## Troubleshooting

**Claude Team or Enterprise: the channel never registers.** `status` shows `channel: absent`, and the agent's startup notice says the plugin is not on the organization's approved list, or that an admin must enable channels. Claude Code blocks channels on these plans until an admin sets `channelsEnabled: true`, and an `allowedChannelPlugins` list replaces Anthropic's default list, so the connector, and any official channel you also use, must be named in it. An Owner sets this in Organization settings > Claude Code > Managed settings (the Channels toggle in Organization settings > Claude Code > Channels also covers `channelsEnabled`):

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "claude-plugins-official", "plugin": "discord" },
    { "marketplace": "hermitd", "plugin": "hermitd-connector" }
  ]
}
```

Drop the `discord` line if you use no official channel, and add one line per official channel you do use. Then restart the agent (`hermitd restart <name>`, with `--build` on Docker). [Claude Code channel controls](https://code.claude.com/docs/en/channels#enterprise-controls)

## How it works

```
AI app, voice or text
  -> your public HTTPS address (your tunnel)
  -> connector server on the agent's machine: sign-in, pairing, hourly cap, message record
  -> this channel -> the agent, as a member
  <- the agent's reply, shown or spoken in the app
```

The connector server ships with core `hermitd` and starts and stops with the agent. On Docker it runs as its own service, outside the agent's reach: the agent can't read the sign-ins or the message record. On a plain tmux install both run as the same user, so there it is not a boundary. This plugin is only the channel inside the agent that carries messages both ways.
