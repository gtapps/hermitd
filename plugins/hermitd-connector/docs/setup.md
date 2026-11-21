# Set up the connector

Check the [requirements](../README.md#requirements) before you start. To have an assistant follow this guide, use the [setup prompt](../README.md#set-up).

Run these steps on the host. Substitute the agent's folder, registered name, and public host name in the commands. For a Docker agent, you can also ask the running agent from chat to hand you the host commands, then run those commands on the host yourself.

1. **Inspect without making changes.** Use `hermitd list` to resolve the name and folder, and `hermitd status <name>` to check whether it runs under tmux or Docker. Capture the connector status, channel entry, Docker boot plugins, installed plugins, and registered marketplace name (usually `hermitd`).

   ```bash
   hermitd list
   hermitd connector <name> status
   cd "<agent folder>" && .hermit/bin/hermitd-run settings-edit .hermit/config.json get channels.connector
   cd "<agent folder>" && .hermit/bin/hermitd-run settings-edit .hermit/config.json get docker.recommended_plugins
   cd "<agent folder>" && claude plugin list --json
   cd "<agent folder>" && claude plugin marketplace list --json
   ls "<managed settings folder>"  # see step 5
   ```

   For Funnel, run `tailscale status --json`, `tailscale serve status --json` and `tailscale funnel status --json`. For Cloudflare, run `cloudflared tunnel list` and inspect the chosen tunnel's public host names in its local config or Cloudflare dashboard. Reuse existing matching settings, installations, and routes. If the connector entry is explicitly disabled (`enabled: false`), report it to the operator and stop. If core is missing, follow the [core setup instructions](../../../README.md#quick-start) after inspecting what is available, then repeat these checks. Update an existing agent that needs a newer core with `hermitd update <name>`.

2. **Enable the server and configure its route.** Use the existing public URL if it belongs to this agent. Otherwise choose an unused HTTPS host name on port 443, with the connector at the root. Core reuses the saved loopback port or chooses a free one on first setup.

   ```bash
   hermitd connector <name> enable --public-url https://agent.example.com
   ```

   If the installed core answers `invalid_port` without `--port`, check current connector port assignments and loopback listeners (for example with `ss -ltn` on Linux), then pass an unused `--port` explicitly. If the address or port is refused, see [Recovery](#recovery). Point the tunnel at `http://127.0.0.1:<port>` using the returned port. Keep any existing route intact. If a route already points at this exact service, reuse it.

   - **Tailscale Funnel.** Use the node's `https://<machine>.<tailnet>.ts.net` address. If the node is signed out, have the operator sign in, then rerun `tailscale status --json` and confirm the node's DNS name. If its public root route is free, run `tailscale funnel --bg --https=443 <port>`. For first-time Funnel enablement, hand the operator the approval URL Tailscale prints and retry after they approve. Check `tailscale funnel status --json` for the expected route. [Tailscale Funnel](https://tailscale.com/kb/1223/funnel)
   - **Cloudflare Tunnel.** If `cloudflared tunnel list` needs authorization, have the operator complete the browser sign-in from `cloudflared tunnel login`, then rerun the list. Use an existing named tunnel or create one with `cloudflared tunnel create <tunnel>`. For a locally managed tunnel, add a hostname ingress rule for `agent.example.com` with service `http://127.0.0.1:<port>` before the catch-all, validate with `cloudflared tunnel ingress validate`, and check the match with `cloudflared tunnel ingress rule https://agent.example.com`. Run `cloudflared tunnel route dns <tunnel> agent.example.com` for the new host name, then start or reload the named tunnel through its service manager (or run `cloudflared tunnel run <tunnel>` for a new setup). Keep the named tunnel running to retain its public address. For a dashboard-managed tunnel, add the same public host name and service there. If only the operator has dashboard access, hand them those values and verify the resulting public address after restart. [Cloudflare ingress configuration](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/) · [Cloudflare DNS routing](https://developers.cloudflare.com/tunnel/concepts/routing/#dns-records)

3. **Restart as soon as the connector is enabled.** Run `hermitd restart <name>` to start the trusted server before installing or registering the channel. Check `hermitd connector <name> status` for `server: running`. If you had to pause for tunnel sign-in or approval, restart and check the local server while waiting, then resume the route setup.

4. **Install and register the channel.** On tmux, add the `gtapps/hermitd` marketplace with `claude plugin marketplace add gtapps/hermitd` if it is missing. Install the channel in the target folder if it is missing, or update the installed plugin if needed.

   ```bash
   cd "<agent folder>" && claude plugin install "hermitd-connector@<registered marketplace>" --scope local
   ```

   Docker installs the channel at boot. Reread `channels.connector` before writing. If it already has the required settings and, on Docker, the boot entry matches, skip the write. If it is disabled, report it and stop. Otherwise register once, with `members_only: true` in the same write as `plugin` and `marketplace`. Replace the marketplace placeholder with its registered name. On Docker, add `"docker_source":"gtapps/hermitd"` to the same JSON object so the write also registers the boot plugin.

   ```bash
   cd "<agent folder>" && .hermit/bin/hermitd-run settings-edit .hermit/config.json channel-register connector '{"plugin":"hermitd-connector","marketplace":"<registered marketplace>","members_only":true}'
   ```

   A session started in the target agent folder with hermitd enabled loads the native settings approval hook. Use its prompt. In any other session, show the exact command and get the operator's explicit yes before running it. After approval and execution, reread `channels.connector` and, for Docker, `docker.recommended_plugins` with the commands from step 1. If an existing boot entry is disabled, report it to the operator.

5. **Approve the channel in Claude Code.** Docker generates its local channel allowlist at build time. For tmux, read the effective managed policy and prepare the exact merged contents of `hermitd-channels.json` in the managed settings folder for the operator to review. The folder is `/etc/claude-code/managed-settings.d` on Linux and WSL2, and `/Library/Application Support/ClaudeCode/managed-settings.d` on macOS. Set `channelsEnabled: true` and include `hermitd-connector` from the registered marketplace in `allowedChannelPlugins`. Preserve existing settings and list every channel the operator wants available, including official plugins, since the explicit list replaces the default. For example, a host with the official Discord channel and the connector would include these entries.

   ```json
   {
     "channelsEnabled": true,
     "allowedChannelPlugins": [
       { "marketplace": "claude-plugins-official", "plugin": "discord" },
       { "marketplace": "hermitd", "plugin": "hermitd-connector" }
     ]
   }
   ```

   Save the reviewed JSON to a local file and give the operator one command to install it. After they run it, read back the drop-in and check the channel's startup notice after restart. [Claude Code managed settings](https://code.claude.com/docs/en/managed-settings)

   ```bash
   sudo mkdir -p "<managed settings folder>" && sudo install -m 0644 "<reviewed file>" "<managed settings folder>/hermitd-channels.json"
   ```

   On Team and Enterprise plans, an Owner enables channels in **Organization settings > Claude Code > Channels**. After the Owner confirms, check the next startup notice for organization policy or allowlist refusals. [Claude Code channel controls](https://code.claude.com/docs/en/channels#enterprise-controls)

6. **Activate the channel.** Run `hermitd restart <name>` on tmux or `hermitd restart <name> --build` on Docker. If a Docker build stops at the approval gate, hand the operator `hermitd approve <name>` in their terminal so they can review the changes. After they approve, retry the build and verify the server and channel. Ask the operator for the agent's startup notice if you cannot read it.

## Verify setup

Report each checkpoint separately so the next run can pick up where this one stopped.

- **Configured.** `hermitd connector <name> status` shows `enabled: true` with the expected public URL.
- **Server running.** The same command shows `server: running`.
- **Channel polling.** The same command shows `channel: polling`.
- **Public address responding.** `curl --fail --silent --show-error https://agent.example.com/.well-known/oauth-protected-resource` returns JSON naming the expected `resource` (`https://agent.example.com/mcp`) and authorization server.
- **Paired.** Follow [Pair someone](../README.md#pair-someone) to approve a pairing code on the host. Check the expected grant with `hermitd connector <name> list`.
- **Replies flowing.** If the operator wants to send a test message, check that their app got an answer and that `unanswered` is `0` afterward. Otherwise leave this checkpoint pending until a reply has been observed.

## Several agents on one host

Give each agent its own public host name and local port. Funnel provides one public host name per node. For several agents on the same node, a Cloudflare tunnel can serve several host names with one ingress rule and DNS route per host name. For a locally managed tunnel, run `cloudflared tunnel route dns <tunnel> <host>` once for each new host name. Keep each connector at the root of its own host name so OAuth discovery works. [Cloudflare DNS routing](https://developers.cloudflare.com/tunnel/concepts/routing/#dns-records)

## Recovery

`status` shows the bound `port` when the server answers, `channel` as `polling` or `absent`, the number of paired `grants`, and `unanswered` messages dispatched to the channel. `oldest_unanswered_at` is the earliest known dispatch time for those messages, or `null`. Doctor warns when the channel is absent or a message has gone unanswered for more than 10 minutes.

- **Occupied port.** Check the listener and sibling connector assignments. If two stores already share a port, run `hermitd connector <name> enable --port <free port>` on one agent, then update its own tunnel route and restart that agent. An existing store keeps its saved port unless you pass `--port`, so omitting the flag still refuses the collision.
- **Tunnel login or coordination fails.** Recheck the account and current routes with step 1. Hand browser sign-in or Funnel enablement to the operator, then recheck the tunnel state. If the host name belongs to another service or agent, choose a new host name and enable with that URL.
- **Configured server is down.** Run `hermitd restart <name>` and check status again. If it still fails, inspect the host startup output or the Docker connector service log for the listener error.
- **Running server shows `channel: absent`.** Verify that the channel entry has `plugin` and `marketplace`, the channel plugin is installed, and the agent restarted with the channel. Check the startup notice and the channel policy in step 5.
- **Public address responds but sign-in fails.** Check that protected-resource and authorization-server discovery name the same public origin and point to the expected agent. Check that the app uses the `/mcp` URL, then request a fresh pairing code and have the operator approve it. Verify the grant with `hermitd connector <name> list`.
- **Messages stay unanswered.** Check `unanswered` and `oldest_unanswered_at`, then run `hermitd doctor <name>`. The time is measured from dispatch. If the channel polls but messages stay unanswered, check the startup notice for `allowedChannelPlugins`, `channelsEnabled` or organization policy, then check whether the agent is stuck.

Once the server is running, the channel is polling, and the public address responds, [pair yourself or someone else](../README.md#pair-someone).
