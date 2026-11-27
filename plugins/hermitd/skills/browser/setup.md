# Phone sign-in setup

Run only when the operator wants phone takeover. Takeover is inactive until setup; public anonymous browser tasks need none of this. Use the settings route for every config write, with its native permission prompt. Never edit config directly or bypass a declined prompt.

1. Collect the short list of browser admins in the current conversation. Ask for each person's exact Tailscale login and their mention or id for every channel where login requests may appear. The shape is `[{"login":"person@example.com","mentions":{"channel-name":"handle or id"}}]`; channel names are arbitrary. Confirm who will be allowed to drive the shared signed-in browser, then run:

   ```bash
   .hermit/bin/hermitd-run settings-edit .hermit/config.json set browser.admins '<admins JSON>'
   ```

2. Explain that each admin installs Tailscale on their phone once and joins the same tailnet. A tagged phone has no user identity and is refused. The viewer is tailnet-only through Serve, never Funnel. The agent, host processes reaching loopback, and containers reaching port 6080 on the same Docker network can forge the identity header; this is not a boundary against them.
3. After the step 1 write succeeds, print one host command once in this setup conversation, to run from this project's root on the host. Ask for it even if it ran before: a run without admins sets up only the display.

   ```bash
   hermitd run browser-host
   ```

   It needs the host Tailscale CLI for takeover. On Docker it also needs Docker server 28.0.0 or newer and a rebuilt managed-browser image; it adds only the viewer mapping and recreates without rebuilding. On Linux/WSL2 tmux it installs missing packages, Chrome libraries and the AppArmor profile with terminal sudo prompts, then starts the display; see [host-setup.md](host-setup.md). It refuses takeover on a macOS host outside Docker and on interactive hermits. Both paths save `browser.port` and `browser.host`, preserve other Serve routes, and verify that a direct request without an identity header is refused. After that check passes, it registers the `browser-handback` stream monitor (`.hermit/bin/hermitd-run browser events`), preserving every other monitor. It prints a sudo command if Serve denies access. Do not run it inside the hermit container. Ask for its result in this conversation; on failure explain the reported blocker instead of declaring setup complete or repeatedly printing the host command.
4. Verify the host command reported ready and that `browser.port` and `browser.host` are set in config. Build login links only from those fields; never record a second address in knowledge or guess a tailnet host. Confirm with `/hermitd:watch status` that the `browser-handback` monitor is enabled and running; if it is not, report that setup is incomplete. Confirm the admin can open that address on their phone and is admitted. The live phone login gate remains required before rollout. Tell the operator setup is ready only after these checks; future logins use Take over and Hand back from the same conversation, with no recurring terminal command.
