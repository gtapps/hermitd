# Connector

The connector lets people you pair talk to the agent from their own AI app: Claude, ChatGPT, Grok or Gemini, typed or, where the app has it, by voice. Each person adds the agent as a custom connector; the assistant in their app calls the agent's tools and shows or speaks what the agent answers. The agent works in its usual session, with its memory and tools, and treats every connector sender as a plain member.

For your own typed steering from the Claude app, use [Remote Control](https://code.claude.com/docs/en/remote-control) instead: it gives you the full session. The connector is for voice, and for other people.

## What it covers

```
person in their AI app ──> your public HTTPS address (your tunnel)
  ──> trusted server (one per agent, outside the agent's reach)
        sign-in, pairing, a per-person hourly cap, the message record
  ──> agent socket ──> hermitd-connector channel ──> the agent, as a member
  <── the agent's reply ──< shown or spoken in the app
```

- The trusted server keeps sign-in state and the record in a host-only store, `~/.claude/hermitd/connector/<project>/`, which the agent can neither read nor change. On Docker it runs as its own service in its own network namespace; the agent reaches it only through a read-only socket mount.
- Each paired person gets their own chat. The agent sees one channel event per message with that person's label.
- `members_only: true` on the channel entry turns off every elevated path for it, the operator included: control commands, primary-operator and sign-in authority, unscoped recall, home pinning and notice routing. See the [config reference](config-reference.md).

## Enable it

Follow the [connector setup runbook](../../hermitd-connector/README.md#set-up) from the host. It covers checking the current setup, configuring the tunnel, channel approval, restart, and verification.

1. Run `hermitd connector <name> enable --public-url https://agent.example.com` with a root HTTPS URL on port 443. Use the returned loopback port for the tunnel and restart the agent to start the server. A saved port is reused. Use `--port` to select another free port when needed. Each agent needs its own public host name and local port.
2. Install `hermitd-connector` in the target folder on tmux, or let Docker install it at boot. Use one approved `channel-register connector` write for the `plugin`, registered `marketplace`, `members_only: true`, and, on Docker, `docker_source: "gtapps/hermitd"`.
3. Follow the runbook's channel approval and restart steps. `hermitd connector <name> status` reports the server state, `channel` (`polling` or `absent`), `unanswered` and `oldest_unanswered_at`. Check the public discovery JSON, pairing and replies separately.

`enable` also takes `--wait-seconds` (default 25, maximum 200) and `--rate-per-hour` (per person, default 60).

`hermitd connector <name> disable` stops it at the next restart and keeps every pairing, so enabling it again needs no new pairing. `list` shows who is paired and `revoke <id>` removes one person.

## How people connect

- **One person.** In their app they add a custom connector with the address `<public url>/mcp` and sign in. The page shows an 8-character pairing code, valid for 10 minutes. They give it to you by whatever means you already use, and you run `hermitd connector <name> pair <code> --name Ana` on the host. Their page then completes.
- **A team.** On Claude Team and Enterprise plans an Owner adds the custom connector for the organisation once. Each member then connects and signs in individually and is paired one by one.
- **A spoken or typed turn.** The person speaks or types and their app calls the agent. If the agent answers within the wait, the app relays the words. If it is slow, the app says nothing has arrived yet and can check again. If the agent is offline, the message is held until it is back. If the agent restarted before answering, the next call says the message may not have been received.

Where each app puts custom connectors, and who may add one, is the vendor's choice and changes over time:

- **Claude:** Customize > Connectors > Add custom connector. Free accounts can add one ([Anthropic help](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)).
- **ChatGPT:** developer mode, then add a custom MCP server ([OpenAI docs](https://developers.openai.com/api/docs/guides/developer-mode)). Plan limits apply, and it asks before each message because sending one is a write.
- **Grok:** grok.com/connectors > New Connector > Custom ([xAI docs](https://docs.x.ai/grok/connectors)).
- **Gemini:** Settings > Connected Apps > Add a custom app, on the web ([Google help](https://support.google.com/gemini/answer/17209137)); limited by region and account type.

Another app can connect only once its sign-in callback address is added to the trusted server, so a sign-in from it is refused until then.

## Limits

- On a tmux install the agent runs as the same user as the trusted server, so the split is not a boundary there, and nothing restarts the server if it dies until the next `hermitd start`; `/hermit-doctor` reports it meanwhile.
- A separate chat is not a private agent. Every person talks to the same session, which holds all its chats and uses the same tool accounts. People who must not see each other's work need separate agents.
- A pairing is not a verified app account: it is whoever completed the sign-in page with the code you approved.
- Replies are an outbound path to every paired person.
- The words reaching the agent are written by the assistant in the person's app, which may also read web pages and mail. Member authority caps what such a turn can do; it does not prevent one.
- A tool result is the agent's new messages in that chat, not a guaranteed answer to the last thing said. Voice mode may paraphrase a long message.
- A message sent just before an agent restart may be lost; the person is told and decides whether to repeat it.
- Only the documented sign-in callbacks of the supported apps are accepted.
- Script alerts have no send path on this channel, and with `members_only` it is never chosen for notices.
- `enable` is refused for Docker agents on host networking.
- A flood of sign-in attempts on the public address can stop new sign-ins until it ends; people already paired keep working. Protection at the tunnel is yours.
- `shared_chats` shares a chat with every chat on every channel. Use it with the connector only when every chat on the agent is your own.

To let other tools observe or wake the agent rather than talk to it, see the [external control surface](external-control-surface.md).
