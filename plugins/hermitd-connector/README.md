# hermitd-connector

Talk to your agent from the Claude app, **typed or in voice mode**, and let people you pair do the same. Each person adds the agent as a custom connector in their own Claude app. Claude passes on what they say, then shows or speaks the agent's answer.

The agent works in its usual session, with its memory and tools. Everyone who comes in through the connector is a **plain member**, you included: they can ask for work, but they can't pause, steer or reconfigure the agent.

For your own typed work, [Remote Control](https://code.claude.com/docs/en/remote-control) gives you the full session; use the connector for voice and for other people.

## How it works

```
Claude app, typed or voice
  -> your public HTTPS address (your tunnel)
  -> connector server on the agent's machine: sign-in, pairing, hourly cap, message record
  -> this channel -> the agent, as a member
  <- the agent's reply, shown or spoken in the app
```

The connector server ships with core `hermitd` and starts and stops with the agent. On Docker it runs as its own service, outside the agent's reach: the agent can't read the sign-ins or the message record. On a plain tmux install both run as the same user, so there it is not a boundary. This plugin is only the channel inside the agent that carries messages both ways.

## Requirements

- Core `hermitd` 1.4.36 or newer, set up and running.
- A **public HTTPS address on port 443**, for example `https://agent.example.com`. Claude does not connect to a connector URL with any other port ([Anthropic help](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)). If another service already holds 443 on that host name, use another host name.
- A **tunnel** (or reverse proxy) from that address to a local port on the agent's machine, such as Tailscale Funnel or Cloudflare Tunnel (commands below). The connector server listens on `127.0.0.1` only.
- On Docker, an agent that does not use host networking.
- A Claude account for each person. Free accounts can add one custom connector.

## Set up

**Let an AI assistant do it.** On the agent's machine, open Claude Code, Codex or another coding assistant in the agent's folder and send this, with your tunnel filled in:

```text
Set up the hermitd connector for the agent in this folder by following https://github.com/gtapps/hermitd/blob/main/plugins/hermitd-connector/README.md. For the tunnel I want <Tailscale Funnel, or Cloudflare Tunnel on agent.example.com>. Stop and tell me when something needs my login or approval, and before restarting the agent.
```

**Or do it by hand.** Run these on the agent's machine, from the agent's folder.

1. **Open a tunnel** to a free local port, here `8790`. Any tunnel that serves public HTTPS on 443 works. Two common ones:

   - **Tailscale Funnel**, no domain needed. Your address is the machine's `https://<machine>.<tailnet>.ts.net`:

     ```bash
     tailscale funnel --bg 8790
     ```

   - **Cloudflare Tunnel**, for a host name on a domain you have in Cloudflare:

     ```bash
     cloudflared tunnel login
     cloudflared tunnel create agent
     cloudflared tunnel route dns agent agent.example.com
     cloudflared tunnel run --url http://127.0.0.1:8790 agent
     ```

     Keep `cloudflared` running, for example as a system service. Skip quick tunnels (`cloudflared tunnel --url` alone): they get a new address on every run, which breaks every person's connector.

2. **Enable the connector server** with the same port and your public address:

   ```bash
   hermitd connector enable --port 8790 --public-url https://agent.example.com
   ```

3. **Install the channel** and add it to the agent:

   ```bash
   claude plugin install hermitd-connector --marketplace gtapps/hermitd --scope local
   ```

   In Claude Code, type `/hermitd:channel-setup`, choose **Other**, and use channel key `connector`. Then ask the agent to set `channels.connector.members_only` to `true` (a protected setting, so it asks for your approval), so nobody on it gets operator authority and the agent never sends notices there. Leave `allowed_users` unset: only people you pair get through the connector server.

4. **Restart the agent** with `hermitd restart`, or `hermitd restart --build` on Docker, where the image must allow the new channel and the approval prompt names it. On a tmux install, first add the Claude Code channel policy that `/hermitd:channel-setup` gives you. `hermitd connector status` should show the server `running` and the channel connected.

## Pair someone

1. In the Claude app, they open **Customize > Connectors**, click **+ Add**, then **Add custom connector**. They name it after the agent and enter your address with `/mcp` at the end, for example `https://agent.example.com/mcp`.
2. They sign in. The page shows an 8-character pairing code, valid for 10 minutes.
3. They send you the code however you already talk, and you run:

   ```bash
   hermitd connector pair <code> --name Ana
   ```

   Their page completes and they're connected. Pair yourself the same way to use it yourself.

A pairing is not a verified Claude account: it is whoever completed the sign-in page with the code you approved, so only approve codes you got from the person directly.

On Team and Enterprise plans, an Owner adds the custom connector once under **Organization settings > Connectors**. Each member then clicks **Connect** under **Customize > Connectors** and is paired the same way.

## Use it

In a chat, turn the connector on (the **+** button, then **Connectors**) and ask Claude to pass something to the agent by name:

- **Typed:** "Ask Atlas whether last night's backup finished."
- **Voice mode:** say the same thing. Claude sends it, waits for the answer and reads it out.

If the agent needs longer, Claude says nothing has arrived yet; ask "anything from Atlas?" and it checks again. If the agent is offline, the message is held until it's back. Voice mode may shorten a long answer.

Each person has their own chat with the agent, but it is still one agent: everyone talks to the same session, with the same tools and accounts. People who must not see each other's work need separate agents.

## Manage it

```bash
hermitd connector status         # server and channel state
hermitd connector list           # who is paired
hermitd connector revoke <id>    # remove one person
hermitd connector disable        # stop at the next restart, pairings kept
```

`enable` also takes `--wait-seconds` (how long a call waits for the agent, default 25, at most 200) and `--rate-per-hour` (per person, default 60). Run it again and restart the agent to change either.

Limits and the security model: [connector guide](../hermitd/docs/connector.md). On Docker the server runs as its own service: [Docker security](../hermitd/docs/docker-security.md#connector).

## What the agent sees

One `<channel source="connector">` event per message, with `chat_id` (one per paired person), `message_id`, `user_id`, `user` (the pairing name), `ts` and `via`. The agent answers with the `reply` tool, which returns `sent` when the person is waiting and `queued` otherwise. Admission is the pairing on the host; there is no credential to set up in the agent.
