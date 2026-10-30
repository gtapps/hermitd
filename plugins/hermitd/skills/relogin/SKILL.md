---
name: relogin
description: "Renew the hermit's Claude credential (token or claude.ai sign-in, per `auth_mode`) over the channel, before it expires. Relays a one-time sign-in link to the operator, takes the code back, installs the new token, and restarts. Activates on messages like 'relogin', 'renew my login', 'reauth', 'the login is expiring', or when doctor's credential-expiry check flags the Claude credential."
---

# Relogin

Renews this hermit's Claude credential (token or claude.ai sign-in, per `auth_mode`) without anyone touching the box. The operator opens a link, signs in, sends back a code; you install the token and restart.

Use this when doctor warns that the credential is expiring, or the operator asks to renew. If the hermit is *already* dead from an expired token, this skill is not the path — the watchdog runs the same flow deterministically without a model (`setup-token-mint.ts relay`), because a dead hermit can't run a skill.

**Never run `/logout`.** Renewal never needs it, and `/logout` resets first-launch state, after which the interactive wizard demands a login and refuses the env token.

## Step 0 — Preflight

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/setup-token-mint.ts status
```

- `auth_mode: external` → an API key or cloud provider owns this hermit's credential. Nothing here can renew that; say so plainly and stop.
- `pending: true` → a sign-in is already staged and applies at the next restart. Don't start a second one; offer to restart now instead.
- `in_progress` non-null → a renewal is already running. Don't start a second one.
- Otherwise report the current `expires_at` in plain language and continue. Say which cadence this hermit is on when it's relevant: `auth_mode: login` renews about every 30 days, `token` about yearly.

## Step 1 — Mint and relay the link

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/setup-token-mint.ts start
bun ${CLAUDE_PLUGIN_ROOT}/scripts/setup-token-mint.ts await-url
```

Send the operator the `url` from the second command, in your own voice — one line, the link, and what you need back. Something like: "Time to renew your Claude sign-in. Open this and send me the code it gives you: `<url>`".

**If a `maintainer_channel_id` is configured for the active channel** (`channels.<platform>.maintainer_channel_id` in `config.json`), send that message via the maintainer channel instead of the client chat, so the sign-in link never reaches an end-user's chat. Send `{"maintainer":"<message>","sensitive":true}` as JSON on stdin:

```
.hermit/bin/hermitd-run channel-send .hermit --notice
```

Continue to Step 2 only if the result has `"status":"delivered"`. For any other result, run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/setup-token-mint.ts abort`, tell the operator in the current chat that the link reached nobody, nothing changed, and the maintainer chat needs the bot present and permitted, then stop.

The operator still pastes the code back through the primary chat (Step 2 is unchanged). When no maintainer channel is configured, keep the current in-chat/terminal path above; that remains the documented owner-recipient contract.

The link is one-time and short-lived. Don't mint it before the operator is ready to use it.

## Step 2 — Take the code back

When the operator replies with the code:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/setup-token-mint.ts submit-code "<code>"
bun ${CLAUDE_PLUGIN_ROOT}/scripts/setup-token-mint.ts await-token-and-install
```

The install prints `{ok, expires_at}` and nothing else — the token itself never reaches you, by design. It goes from the mint pane straight into a 0600 file on the config volume.

If either step fails, run `abort`, tell the operator plainly that nothing changed, and offer to try again.

## Step 3 — Confirm, then restart (order matters)

The new token only takes effect when the claude process restarts — and that restart kills the session running this skill. So:

1. **First**, send the confirmation: "You're signed back in, nothing else needed. Next renewal is due `<expires_at>`, and I'll ask you then."
2. **Then**, as the final act of the skill:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/setup-token-mint.ts finish
```

It fires the restart detached and returns immediately. Anything you write after it will never run — send the message first, every time.

## Notes

- The one-time link and the login code cross the channel; the credential never does.
- **In `login` mode nothing is installed by this skill.** The sign-in is written to a staging config dir and `await-token-and-install` only records a pointer to it; the watchdog moves it into place inside the restart in Step 3, where no session is refreshing the file underneath the write. So "signed in" and "in effect" are one restart apart, which is why the confirmation says nothing else is needed.
- Where expiry lives differs by mode: a token's is hermit-tracked in `state/setup-token.json` (the CLI exposes no expiry surface for those), a login's is `refreshTokenExpiresAt` inside `.credentials.json` — the one field a silent refresh does not move. Doctor's `credential-expiry` check reads whichever applies and warns 3 days out.
- Switching modes is an intent, not an action: setting `auth_mode` records which credential the hermit *should* use, and nothing changes until this skill (or `hermitd-docker login` / `setup-token`) actually signs in with it.
- Renewal is container-internal on purpose: the token lives on the persistent config volume, not in `.env`, so nothing on the host has to be recreated.
