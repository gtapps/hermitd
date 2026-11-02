# Phone sign-in setup

Run only when the operator wants phone takeover. Takeover is inactive until setup; public anonymous browser tasks need none of this. Use the settings route for every config write, with its native permission prompt. Never edit config directly or bypass a declined prompt.

1. Collect the short list of browser admins in the current conversation. Ask for each person's exact Tailscale login and their mention or id for every channel where login requests may appear. The shape is `[{"login":"person@example.com","mentions":{"channel-name":"handle or id"}}]`; channel names are arbitrary. Confirm who will be allowed to drive the shared signed-in browser, then run:

   ```bash
   .hermit/bin/hermitd-run settings-edit .hermit/config.json set docker.browser_admins '<admins JSON>'
   ```

2. Explain that each admin installs Tailscale on their phone once and joins the same tailnet. A tagged phone has no user identity and is refused. The viewer is tailnet-only through Serve, never Funnel. The agent, host processes reaching loopback, and containers reaching port 6080 on the same Docker network can forge the identity header; this is not a boundary against them.
3. Print one host command once in this setup conversation, to run from this project's root on the host:

   ```bash
   hermitd run browser-host
   ```

   It needs Docker server 28.0.0 or newer and a host Tailscale CLI. It saves a free loopback port, re-renders and recreates the container without rebuilding the image, sets up a Serve route while leaving other routes alone, and verifies that the viewer refuses a direct request with no identity header. It prints a sudo command if Serve denies access. Do not run it inside the hermit container. Ask for its result in this conversation; on failure explain the reported blocker instead of declaring setup complete or repeatedly printing the host command.
4. Verify the host command reported ready and that `docker.browser_port` is set. Record the exact `https://<host>:<port>/` address it printed in the project's operator-authored knowledge through the normal knowledge workflow; use it for login links, never guess a tailnet host. Confirm the admin can open that address on their phone and is admitted. The live phone login gate remains required before rollout.
5. Read the existing `monitors` array. Preserve every other entry and install exactly one entry with id `browser-handback` (replace that id if already present), description `Browser control handed back`, class `stream`, enabled `true`, command `.hermit/bin/hermitd-run browser events`. Run the native-prompt settings command with the merged array:

   ```bash
   .hermit/bin/hermitd-run settings-edit .hermit/config.json set monitors '<merged monitors JSON>'
   ```

   Do not use `experimental.monitors`, an ad-hoc Monitor, or a direct config edit. The existing watch monitor reloads declared entries live. If the prompt is declined, setup is incomplete.
6. Confirm the declared monitor is enabled and running via `/hermitd:watch status`. It is silent when idle and emits one JSON line per return of control. Tell the operator setup is ready only after these checks; future logins use Take over and Hand back from the same conversation, with no recurring terminal command.
