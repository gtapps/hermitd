# Setup assist

Offer help for console steps that create or change something on an account. A request to act on a page the person named already authorizes the requested page work and needs no setup offer. When another skill gives the console steps with its own browser offer, such as the channel setup wizard's credential stage, follow that skill instead.

## Choose the route

Offer console work only in the running agent's own session with `browser.enabled` on and a browser that can sign in there. Follow `browser.default`: the agent's browser needs Linux/WSL2 tmux or the agent container and configured phone sign-in (`browser.port`, `browser.host`, and a browser admin who can receive the link). Claude in Chrome needs its session tools and either Chrome as the default or the person's explicit request to use Chrome. If no route qualifies, or the person chooses to do the steps by hand, the reply opens with the first manual step and gives the complete manual steps, with the credential destination from the next section. The person asked for the setup, not the agent's tooling, so it never mentions a browser, a route, or why the agent is not doing the steps.

## Agree on the work

Name the goal, the changes you will make, the expected account and workspace, and where any credential will go. Recommend an account that belongs to the agent. Ask for one yes in the conversation before opening the console or making changes. With `approvals: "team"`, accept that yes only from a typed turn or a team approver. Route a member's yes to an admin for a decision and wait. Open a task record with `task.ts open` for the browser work if the request has none, using the requester, title and done condition.

A secret read by a plugin inside the agent goes to that plugin's `.env` under `.claude.local/`. Establish the variable name and the file the plugin actually reads. If it uses a destination outside that directory, have the person supply the credential privately. For an API key the agent only sends to one service, have the person put it in the credential proxy from the host terminal (`hermitd credproxy set <name>` for the mapped secret) when enabled. Otherwise have the person store it. Keep credentials out of the conversation.

## Work in the console

Use the browser skill's claim and sign-in flow. In a terminal or app conversation, send the takeover link there without a mention. Once sign-in is complete, state the account and workspace you verified. Continue on a match without asking for another yes. On a mismatch, stop and ask how to proceed. Stop for CAPTCHA, consent screens, payments, deletions, grants to third parties, or anything outside the agreed list.

## Hand off the secret

- **Agent's browser with a private env destination.** Stop one step before reveal. Run `browser-store-copied` (Commands) and wait for `armed` before sending the takeover link. Block the task for this secret handoff. Have the person take over, reveal the secret, press the site's Copy button and hand back.
- **On that hand back.** Clear the exact task wait and re-claim if needed as in the browser skill. The first wrapper command must repeat `browser-store-copied` with the same name and file. Skip the ordinary hand-back snapshot and all browser inspection until the store finishes. `saved` confirms the write. If it also reports `cleanup: failed`, report that and resolve the browser cleanup before inspecting the page. `armed` here means preparation was lost. Request another takeover and copy. For `nothing_copied`, `multiline`, or `bad_value`, tell the person what happened and offer another attempt or private terminal entry. `store_failed` means nothing was saved: report it and offer the same choices. For a released, expired, or lost takeover, clear the exact wait, re-claim if needed, cancel with `browser-store-copied-cancel` (Commands), and tell the person.
- **Person's Chrome.** Stop reading the page before reveal. The person copies the secret into the private file or uses the agreed credential route. Resume after they say the secret is no longer shown.
- **Proxy or other manual credential route.** Leave the reveal and storage to the person. Resume after they confirm they stored the credential and the secret is no longer visible.

Use the service's own validation where available. Say if the service or agent needs a restart to load the value.

## Finish

Sign out of the console unless the person requested that the session stay signed in. With team approvals, honor that request only from an admin. Reopen the console for sign-out if the store left a blank tab. Release the claim. Record the account, each change, and the variable name and file (or the agreed credential destination) in the task result. Omit the secret value.
