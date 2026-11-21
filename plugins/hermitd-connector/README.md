# hermitd-connector

Talk to your agent from **Claude, ChatGPT, Grok or Gemini**, typed or by voice where the app has it, and let people you pair do the same. Each person adds the agent as a custom connector in their own AI app. The app passes on what they say, then shows or speaks the agent's answer.

The agent works in its usual session, with its memory and tools. Everyone who comes in through the connector is a **plain member**, you included: they can ask for work, but they can't pause, steer or reconfigure the agent.

For your own typed work, [Remote Control](https://code.claude.com/docs/en/remote-control) gives you the full session; use the connector for voice and for other people.

## How it works

```
AI app, typed or voice
  -> your public HTTPS address (your tunnel)
  -> connector server on the agent's machine: sign-in, pairing, hourly cap, message record
  -> this channel -> the agent, as a member
  <- the agent's reply, shown or spoken in the app
```

The connector server ships with core `hermitd` and starts and stops with the agent. On Docker it runs as its own service, outside the agent's reach: the agent can't read the sign-ins or the message record. On a plain tmux install both run as the same user, so there it is not a boundary. This plugin is only the channel inside the agent that carries messages both ways.

## Requirements

- Core `hermitd` 1.4.36 or newer, set up and running.
- A **public HTTPS address on port 443**, for example `https://agent.example.com`. Every supported app reaches it there, and Claude does not connect to a connector URL with any other port ([Anthropic help](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)). If another service already holds 443 on that host name, use another host name.
- A **tunnel** (or reverse proxy) from that address to a local port on the agent's machine, such as Tailscale Funnel or Cloudflare Tunnel (commands below). The connector server listens on `127.0.0.1` only.
- On Docker, an agent that does not use host networking.
- An account on a supported app for each person. Who may add custom connectors is up to each vendor: Claude Free accounts can add one, while ChatGPT, Grok and Gemini limit them by plan, region or account type.

## Set up

<details><summary>Prefer a coding assistant? Send it a prompt</summary>

Open Claude Code, Codex or another coding assistant anywhere on the machine and send:

```text
Set up the hermitd connector by following Set up, Several agents on one host, and Recovery at https://github.com/gtapps/hermitd/blob/main/plugins/hermitd-connector/README.md. First ask me which agent (folder or registered name) and which tunnel to use. Inspect before making changes and resume from what is already set up. Install or update core hermitd and the connector plugin as needed. Run each step you can and hand me each Claude Code command I have to type myself. Stop and tell me when a step needs my login, approval or sudo. Let the tools ask their own setup questions.
```

</details>

Run these steps on the host. Substitute the agent's folder, registered name, and public host name in the commands. For a Docker agent, you can also ask the running agent from chat to hand you the host commands, then run those commands on the host yourself.

1. **Inspect without making changes.** Use `hermitd list` to resolve the name and folder, and `hermitd status <name>` to check whether it runs under tmux or Docker. Capture the connector status, channel entry, Docker boot plugins, installed plugins, and registered marketplace name (usually `hermitd`).

   ```bash
   hermitd list
   hermitd connector <name> status
   cd "<agent folder>" && .hermit/bin/hermitd-run settings-edit .hermit/config.json get channels.connector
   cd "<agent folder>" && .hermit/bin/hermitd-run settings-edit .hermit/config.json get docker.recommended_plugins
   cd "<agent folder>" && claude plugin list --json
   cd "<agent folder>" && claude plugin marketplace list --json
   ls /etc/claude-code/managed-settings.d/
   ```

   For Funnel, run `tailscale status --json`, `tailscale serve status --json` and `tailscale funnel status --json`. For Cloudflare, run `cloudflared tunnel list` and inspect the chosen tunnel's public host names in its local config or Cloudflare dashboard. Reuse existing matching settings, installations, and routes. If the connector entry is explicitly disabled (`enabled: false`), report it to the operator and stop. If core is missing, follow the [core setup instructions](../../README.md#quick-start) after inspecting what is available, then repeat these checks. Update an existing agent that needs a newer core with `hermitd update <name>`.

2. **Enable the server and configure its route.** Use the existing public URL if it belongs to this agent. Otherwise choose an unused HTTPS host name on port 443, with the connector at the root. Core chooses a loopback port and returns it as `port`.

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

5. **Approve the channel in Claude Code.** Docker generates its local channel allowlist at build time. For tmux on Linux, read the effective managed policy and prepare the exact merged contents of `/etc/claude-code/managed-settings.d/hermitd-channels.json` for the operator to review. Set `channelsEnabled: true` and include `hermitd-connector` from the registered marketplace in `allowedChannelPlugins`. Preserve existing settings and list every channel the operator wants available, including official plugins, since the explicit list replaces the default. For example, a host with the official Discord channel and the connector would include these entries.

   ```json
   {
     "channelsEnabled": true,
     "allowedChannelPlugins": [
       { "marketplace": "claude-plugins-official", "plugin": "discord" },
       { "marketplace": "hermitd", "plugin": "hermitd-connector" }
     ]
   }
   ```

   Save the reviewed JSON to a local file and give the operator one command to install it. After they run it, read back the drop-in and check the channel's startup notice after restart. Use the platform's managed settings path on other systems. [Claude Code managed settings](https://code.claude.com/docs/en/managed-settings)

   ```bash
   sudo install -D -m 0644 "<reviewed file>" /etc/claude-code/managed-settings.d/hermitd-channels.json
   ```

   On Team and Enterprise plans, an Owner enables channels in **Organization settings > Claude Code > Channels**. After the Owner confirms, check the next startup notice for organization policy or allowlist refusals. [Claude Code channel controls](https://code.claude.com/docs/en/channels#enterprise-controls)

6. **Activate the channel.** Run `hermitd restart <name>` on tmux or `hermitd restart <name> --build` on Docker. If a Docker build stops at the approval gate, hand the operator `hermitd approve <name>` in their terminal so they can review the changes. After they approve, retry the build and verify the server and channel. Ask the operator for the agent's startup notice if you cannot read it.

Report each checkpoint separately so the next run can pick up where this one stopped.

- **Configured.** `hermitd connector <name> status` shows `enabled: true` with the expected public URL.
- **Server running.** The same command shows `server: running`.
- **Channel polling.** The same command shows `channel: polling`.
- **Public address responding.** `curl --fail --silent --show-error https://agent.example.com/.well-known/oauth-protected-resource` returns JSON naming the expected `resource` (`https://agent.example.com/mcp`) and authorization server.
- **Paired.** The operator obtains and approves the pairing code on the host as in [Pair someone](#pair-someone), using `hermitd connector <name> pair <code> --name <label>`. After approval, check the expected grant with `hermitd connector <name> list`.
- **Replies flowing.** If the operator wants to send a test message, check that their app got an answer and that `unanswered` is `0` afterward. Otherwise leave this checkpoint pending until a reply has been observed.

## Several agents on one host

Give each agent its own public host name and local port. Funnel provides one public host name per node. For several agents on the same node, a Cloudflare tunnel can serve several host names with one ingress rule and DNS route per host name. For a locally managed tunnel, run `cloudflared tunnel route dns <tunnel> <host>` once for each new host name. Keep each connector at the root of its own host name so OAuth discovery works. [Cloudflare DNS routing](https://developers.cloudflare.com/tunnel/concepts/routing/#dns-records)

## Recovery

- **Occupied port.** Check the listener and sibling connector assignments. If two stores already share a port, run `hermitd connector <name> enable --port <free port>` on one agent, then update its own tunnel route and restart that agent. An existing store keeps its saved port unless you pass `--port`, so omitting the flag still refuses the collision.
- **Tunnel login or coordination fails.** Recheck the account and current routes with step 1. Hand browser sign-in or Funnel enablement to the operator, then recheck the tunnel state. If the host name belongs to another service or agent, choose a new host name and enable with that URL.
- **Configured server is down.** Run `hermitd restart <name>` and check status again. If it still fails, inspect the host startup output or the Docker connector service log for the listener error.
- **Running server shows `channel: absent`.** Verify that the channel entry has `plugin` and `marketplace`, the channel plugin is installed, and the agent restarted with the channel. Check the startup notice and the channel policy in step 5.
- **Public address responds but sign-in fails.** Check that protected-resource and authorization-server discovery name the same public origin and point to the expected agent. Check that the app uses the `/mcp` URL, then request a fresh pairing code and have the operator approve it. Verify the grant with `hermitd connector <name> list`.
- **Messages stay unanswered.** Check `unanswered` and `oldest_unanswered_at`, then run `hermitd doctor <name>`. The time is measured from dispatch. If the channel polls but messages stay unanswered, check the startup notice for `allowedChannelPlugins`, `channelsEnabled` or organization policy, then check whether the agent is stuck.

## Pair someone

1. In their app they add a custom connector named after the agent, with your address and `/mcp` at the end, for example `https://agent.example.com/mcp`. In Claude: **Customize > Connectors > + Add > Add custom connector**. In ChatGPT: developer mode, then add a custom MCP server. In Grok: **grok.com/connectors > New Connector > Custom**. In Gemini: **Settings > Connected Apps > Add a custom app**, on the web. [Connector docs](../hermitd/docs/connector.md#how-people-connect) has the details.
2. They sign in. The page shows an 8-character pairing code, valid for 10 minutes.
3. They send you the code however you already talk, and you run:

   ```bash
   hermitd connector pair <code> --name Ana
   ```

   Their page completes and they're connected. Pair yourself the same way to use it yourself.

A pairing is not a verified app account: it is whoever completed the sign-in page with the code you approved, so only approve codes you got from the person directly.

On Team and Enterprise plans, an Owner adds the custom connector once under **Organization settings > Connectors**. Each member then clicks **Connect** under **Customize > Connectors** and is paired the same way.

## Use it

In a chat, turn the connector on (the **+** button, then **Connectors**) and ask Claude to pass something to the agent by name:

- **Typed:** "Ask Atlas whether last night's backup finished."
- **Voice mode:** say the same thing. Claude sends it, waits for the answer and reads it out.

If the agent needs longer, Claude says nothing has arrived yet; ask "anything from Atlas?" and it checks again. If the agent is offline, the message is held until it's back. Voice mode may shorten a long answer.

Each person has their own chat with the agent, but it is still one agent: everyone talks to the same session, with the same tools and accounts. People who must not see each other's work need separate agents.

## Manage it

```bash
hermitd connector <name> status         # server and channel state
hermitd connector <name> list           # who is paired
hermitd connector <name> revoke <id>    # remove one person
hermitd connector <name> disable        # stop at the next restart, pairings kept
```

`status` shows the bound `port` when the server answers, `channel` as `polling` or `absent`, the number of paired `grants`, and `unanswered` messages dispatched to the channel. `oldest_unanswered_at` is the earliest known dispatch time for those messages, or `null`. Doctor warns when the channel is absent or a message has gone unanswered for more than 10 minutes.

`enable` also takes `--wait-seconds` (how long a call waits for the agent, default 25, at most 200) and `--rate-per-hour` (per person, default 60). Run it again and restart the agent to change either.

Limits and the security model: [connector guide](../hermitd/docs/connector.md). On Docker the server runs as its own service: [Docker security](../hermitd/docs/docker-security.md#connector).

## What the agent sees

One `<channel source="connector">` event per message, with `chat_id` (one per paired person), `message_id`, `user_id`, `user` (the pairing name), `ts` and `via`. The agent answers with the `reply` tool, which returns `sent` when the person is waiting and `queued` otherwise. Admission is the pairing on the host; there is no credential to set up in the agent.
