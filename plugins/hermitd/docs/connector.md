# Connector

The connector lets people you pair talk to the agent from their own Claude app, typed or in voice mode. Each person adds the agent as a custom connector; Claude in their app calls the agent's tools and shows or speaks what the agent answers. The agent works in its usual session, with its memory and tools, and treats every connector sender as a plain member.

For your own typed steering from the Claude app, use [Remote Control](https://code.claude.com/docs/en/remote-control) instead: it gives you the full session. The connector is for voice, and for other people.

## What it covers

```
person in their Claude app ──> your public HTTPS address (your tunnel)
  ──> trusted server (one per agent, outside the agent's reach)
        sign-in, pairing, a per-person hourly cap, the message record
  ──> agent socket ──> hermitd-connector channel ──> the agent, as a member
  <── the agent's reply ──< shown or spoken in the app
```

- The trusted server keeps sign-in state and the record in a host-only store, `~/.claude/hermitd/connector/<project>/`, which the agent can neither read nor change. On Docker it runs as its own service in its own network namespace; the agent reaches it only through a read-only socket mount.
- Each paired person gets their own chat. The agent sees one channel event per message with that person's label.
- `members_only: true` on the channel entry turns off every elevated path for it, the operator included: control commands, primary-operator and sign-in authority, unscoped recall, home pinning and notice routing. See the [config reference](config-reference.md).

## Enable it

1. On the host, enable the server with the loopback port your tunnel will point at and the public HTTPS address people will use:

   ```bash
   hermitd connector <name> enable --port 8790 --public-url https://agent.example.com
   ```

   Optional: `--wait-seconds` (how long a call waits for the agent, default 25, at most 200) and `--rate-per-hour` (per person, default 60).
2. Install the channel plugin and enrol it as a channel with `members_only: true`, the same way as any [third-party channel](channel-plugins.md): plugin `hermitd-connector`, channel key `connector`. Set `channels.connector.members_only` to `true` before running channel setup (ask the agent; it is a protected setting), so the channel never runs without it; registration keeps it. `/hermitd:hermit-settings channels` changes it later. On Docker the approval prompt names the new channel plugin.
3. Point your tunnel at `127.0.0.1:<port>` and restart the agent: `hermitd restart`, or `hermitd restart --build` on Docker, where the image must allow the new channel plugin. The local port is your choice, but the public address must be HTTPS on the standard port 443: Claude does not connect to a connector URL with another port ([Anthropic help](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)). If another service already holds 443 on that host name, use another host name. `hermitd connector <name> status` shows the server running and the channel connected.

`hermitd connector <name> disable` stops it at the next restart and keeps every pairing, so enabling it again needs no new pairing. `list` shows who is paired and `revoke <id>` removes one person.

## How people connect

- **One person.** In the Claude app they add a custom connector with the address `<public url>/mcp` and sign in. The page shows an 8-character pairing code, valid for 10 minutes. They give it to you by whatever means you already use, and you run `hermitd connector <name> pair <code> --name Ana` on the host. Their page then completes.
- **A team.** On Team and Enterprise plans an Owner adds the custom connector for the organisation once. Each member then connects and signs in individually and is paired one by one.
- **A spoken turn.** The person speaks and Claude calls the agent. If the agent answers within the wait, Claude relays the words. If it is slow, Claude says nothing has arrived yet and can check again. If the agent is offline, the message is held until it is back. If the agent restarted before answering, the next call says the message may not have been received.

Free accounts can add one custom connector.

## Limits

- On a tmux install the agent runs as the same user as the trusted server, so the split is not a boundary there, and nothing restarts the server if it dies until the next `hermitd start`; `/hermit-doctor` reports it meanwhile.
- A separate chat is not a private agent. Every person talks to the same session, which holds all its chats and uses the same tool accounts. People who must not see each other's work need separate agents.
- A pairing is not a verified Claude account: it is whoever completed the sign-in page with the code you approved.
- Replies are an outbound path to every paired person.
- The words reaching the agent are written by Claude in the person's app, which may also read web pages and mail. Member authority caps what such a turn can do; it does not prevent one.
- A tool result is the agent's new messages in that chat, not a guaranteed answer to the last thing said. Voice mode may paraphrase a long message.
- A message sent just before an agent restart may be lost; the person is told and decides whether to repeat it.
- Only the official Claude callback address is accepted.
- Script alerts have no send path on this channel, and with `members_only` it is never chosen for notices.
- `enable` is refused for Docker agents on host networking.
- A flood of sign-in attempts on the public address can stop new sign-ins until it ends; people already paired keep working. Protection at the tunnel is yours.
- `shared_chats` shares a chat with every chat on every channel. Use it with the connector only when every chat on the agent is your own.

To let other tools observe or wake the agent rather than talk to it, see the [external control surface](external-control-surface.md).
