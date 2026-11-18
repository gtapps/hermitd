# hermitd-connector

The in-agent half of the hermitd connector. People the operator pairs add the agent's address as a custom connector in their own Claude app, then talk to the agent typed or by voice mode. Each message reaches the agent as a channel event from a plain member, and the agent's replies go back to that person.

This plugin holds no state and does no sign-in. Core's trusted server does both, outside the agent's reach; this channel only dials the socket core names in `HERMIT_CONNECTOR_SOCKET`.

## Install

```
claude plugin install hermitd-connector@hermitd
```

Then enable the trusted server on the host with `hermitd connector enable --port <n> --public-url <https url>`, pair people with `hermitd connector pair <code>`, and enrol the channel with `members_only: true`. Requires core `hermitd` 1.4.36 or newer.

## What the agent sees

One `<channel source="connector">` event per message, with `chat_id` (one per paired person), `message_id`, `user_id`, `user` (the pairing label), `ts` and `via`. The agent answers with the `reply` tool, which returns `sent` when the person is waiting and `queued` otherwise.
