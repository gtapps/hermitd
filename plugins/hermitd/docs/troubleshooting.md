# Troubleshooting

## `hermit` runs a different tool

Use `~/.local/bin/hermit` or adjust PATH so `~/.local/bin` comes before the other tool. The installer reports both paths and never overwrites a foreign `~/.local/bin/hermit`.

---

## Channels Not Responding

- **Not set up yet (local/tmux)?** Type `/hermitd:channel-setup` in a terminal or the Claude app — it installs the plugin, writes the token, and guides pairing. Requires [Bun](https://bun.sh).
- Verify Claude Code was started with `--channels`. Check boot script output for `[hermit] Channels: discord`. If hermitd-start printed a bun or token warning, that channel was skipped.
- Check bot token and bot online status.
- **Stale token in settings.local.json:** If `.claude/settings.local.json` has `DISCORD_BOT_TOKEN` or `TELEGRAM_BOT_TOKEN` in its `env` key, it overrides the token file at `.claude.local/channels/<plugin>/.env`. Remove the token from settings.local.json — it should only live in the channel's `.env` file. `hermitd-start` cleans these automatically on boot, but if the token was added manually or by a previous channel plugin setup, it may persist.
- Verify tmux session: `tmux ls`
- If Docker `--network=none`, channels can't work.
- Telegram has no message history — messages sent while your hermit was down are lost.

## Channel Sends Not Working

Hermit uses proactive channel sends for heartbeat alerts, morning briefs, and idle transition notifications. If messages aren't arriving:

- **Check `channels.<name>.default_chat_id`, then `dm_channel_id`:** Outbound notifications require the channel-side chat ID, not the operator's user ID. Both are learned automatically from the first inbound message. Proactive sends resolve `default_chat_id` first and fall back to `dm_channel_id`; a channel with neither is not eligible and the resolver will skip it. If both are `null`, send any message to the bot to populate them. If sends are landing in the *wrong* chat, `default_chat_id` is the pin — messaging from another chat will never move it; re-point it with `/hermit-settings channels` → `edit <name>` → `briefing_chat` at the terminal.
- **Check `channels.<name>.allowed_users`:** A channel with `allowed_users: []` (explicit empty array) is treated as disabled for proactive sends and skipped by the resolver. Omitting the field, or listing one or more user IDs, both make the channel eligible. Edit via `/hermit-settings channels`.
- **Check `channels.<name>.enabled`:** `enabled: false` skips the channel. Default (omitted) is treated as enabled.
- **Verify resolver output:** run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/resolve-outbound-channel.ts .hermit`. On success it prints `{"id":"<channel>","chat_id":"<id>"}` (exit 0). On miss it prints `{"error":"no_reachable_channel"}` (exit 1). When `channels.primary` is unset the resolver returns the first eligible entry in `channels` (operator's config order); set `channels.primary: "<name>"` in `config.json` to pin a preferred channel.
- **Verify the `reply` tool is available:** Channels must be started with `--channels` for the plugin's `reply` tool to be accessible. Check boot output.
- **`channel-send-unavailable` alert:** If sends are failing, heartbeat records this as a deduped alert. Check the channel alert and retry the send once delivery is available.
- **Always-on vs interactive:** In interactive mode, channel plugins may not be running. Proactive sends only work when Claude Code is launched with `--channels`.
- **Channel unreachable or skipped?** Enable `push_notifications` in `config.json` (`true`) to receive a desktop notification (plus mobile push if Remote Control is connected) on proactive alerts. Fires when no channel is enabled (channels block absent, empty, or all entries `enabled: false`) OR when a configured channel is unreachable (missing `dm_channel_id`, empty `allowed_users`). Also fires as a last-resort signal if a successful resolve's reply call fails (e.g. token expired). In always-on Docker or headless tmux only the Remote Control mobile push will be visible. Push is one-way — operator→hermit replies (micro-proposals, session recovery prompts) still require a channel. Toggle via `/hermitd:hermit-settings push-notifications`.

---

## Scheduled Checks Not Running

Periodic plugin checks are ordinary routines. For example, a weekly check uses `schedule: "5 9 * * 1"` and `skill: "hermitd:reflect --check-id my-check --check my-plugin:my-audit-skill"`.

- **Check `routines` in config.json:** the routine must be enabled and registered with `/hermitd:hermit-routines load`. Inspect its schedule and any waiting or budget gate.
- **Check the pre-wake gate:** `skipped-precheck` means the gate found no work and consumed the fire without waking. A gate failure records `precheck-error` and lets the routine wake normally.
- **Check skill availability and the Progress Log:** single-check reflection reports `unavailable`, `error`, `empty`, `actionable`, or `contextual`. Quiet results produce no proposal. Future invocations follow the routine's cron schedule; multiple due routines can all run.
- **For task-completion checks:** `scheduled_checks` entries must have `trigger: "session"` and `enabled: true`. Manage them with `/hermit-settings scheduled-checks`. Their successful runs update the per-check `last_run` cursor in `state/reflection-state.json`.

---

## `$CLAUDE_PLUGIN_ROOT` Empty in Skill Bash Calls

`$CLAUDE_PLUGIN_ROOT` is injected by Claude Code's harness in hook invocations but is not forwarded to the tmux shell environment in always-on mode. This means Bash tool calls inside skills that use `${CLAUDE_PLUGIN_ROOT}` may fail in cron-triggered sessions.

**Fixed in hermitd-start.ts** (v1.0.16+): the env file written before launching the tmux session now derives and exports `CLAUDE_PLUGIN_ROOT` from hermitd-start.ts's own location. Upgrade hermit to get the fix; no operator action needed.

**If still occurring after upgrade:** verify the always-on session was restarted (Docker: `hermitd stop && hermitd start`; tmux: stop the running `hermitd start` session and relaunch). The env file is only written at launch.

---

## Hooks Not Firing

- Check the `Hook profile:` line in the hermit's launch output — it names the resolved profile and where it came from (ambient / config / default). The profile is **process-scoped**: it rides the tmux env file or the Docker compose environment block, and is deliberately never written to `.claude/settings.local.json`, so a hand-launched `claude` in the same folder does not inherit it. Core hooks need `standard` or `strict`; hermit hooks (e.g. git-push-guard) need `strict`. A managed launch defaults to `strict`; set `AGENT_HOOK_PROFILE` in `config.json` `env` (via `/hermit-settings env`) to override.
- Validate hooks.json: `cat hooks/hooks.json | python3 -m json.tool`
- Test manually: `echo '{}' | bun scripts/cost-tracker.ts`
- Hooks may not fire for subagent tool calls — see [Architecture](architecture.md).

## Resident Startup Hangs

- **Workspace trust:** Run `claude` interactively once first and accept the trust prompt. Then restart headless.
- **Interrupted work:** inspect open task records and the execution observation with `/hermitd:task`. Restart through `hermitd-start` when process metadata needs recovery; do not delete records.
- **Auth expired:** Check with `claude --version`. Run `claude /login` if needed.

## Costs Unexpectedly High

- Check `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` in `config.json` `env` (default 65). Adjust with `/hermit-settings env`.
- Check heartbeat interval — 5m with Opus is expensive. Default is 30m; widen to `2h`+ if you want slower pickup of pending proposals and budget alerts.
- Check if watches are running with short intervals (`/hermitd:watch stop`).
- Review context-hygiene settings and the task cost breakdown for repeated work.
- Use `/cost` to check current session spend.

## No Auto-Proposals Appearing

- Reflection runs at task boundaries, on the `reflect` schedule, and at end of day. If you're closing sessions before finishing work, reflection may not trigger.
- Check the `reflect` routine is enabled (`/hermitd:hermit-settings routines`).
- If you just started using Hermit, give it a few sessions to build up memory. Proposals come from patterns, and patterns take repetition.
- Check proposals exist: `ls .hermit/proposals/PROP-*.md`

## Agent Ignoring OPERATOR.md

- Verify location: `.hermit/OPERATOR.md`
- **50-line rule:** The SessionStart hook reads only the first 50 lines. Critical context must be at the top.
- Verify the SessionStart hook is registered in `hooks/hooks.json`.

## Interrupted Work on Every Start

`resident-start` reports interrupted execution alongside open task records. An open commitment is not evidence that the process is still busy. Inspect `state/execution.json` and process health; check system stability, rate limits and disk space if crashes recur. Boot recovery never confirms or cancels work for you.

## Stuck "shutting down" / orphaned process

If `hermitd-stop` reports survivors or exits non-zero, a claude process outlived the stop — the process tree was verified and did not fully exit (`last_error: orphaned_process`). Find it with `pgrep -af "claude --channels"` and `kill` the reported PID.

After a survivor-blocked stop the shutdown gate keeps the channel silent, because `shutdown_requested_at` stays set (never paired with a `shutdown_completed_at`) and every inbound message gets a deterministic "shutting down" reply. To un-stick without killing anything, either boot again — a fresh `hermitd-start` / `hermitd-docker up` clears the shutdown stamps for the same project — or manually null `shutdown_requested_at` in `.hermit/state/runtime.json`.

## Routines Not Firing

- Check the `routines` array in config.json — each routine must have `enabled: true`.
- Verify state: `/hermitd:hermit-routines status`. Monitor mode shows the monitor's liveness + interval and the anchor's CronList entry; fallback mode lists one CronCreate per enabled routine, prefixed with `[hermit-routine:<id>]`.
- If `status` shows nothing loaded: confirm `always_on: true` in config.json (only always-on hermits auto-register on launch). Manual fix: run `/hermitd:hermit-routines load`.
- Inspect fire history: `tail .hermit/state/routine-metrics.jsonl` — a `started` (or `fired`) event means the routine ran; `skipped-paused` means the hermit was paused; `skipped-late` means the occurrence was past `routine_max_lateness_minutes` when the monitor reached it. The `delivery` field is `monitor` or `cron-create`.
- A `failed-artifact-missing` / `failed-artifact-unchanged` / `failed-verification-error` event means the routine declared an `expect_artifact` contract and its run did not satisfy it: the file was never written, was left byte-identical to what was there before the fire, or could not be checked. The routine ran — this is not a scheduling problem. Check the skill that was supposed to write the file, and confirm the declared path still matches what it produces (`expect_artifact` in `config.json`).
- **Monitor mode** defers only while an operator turn is genuinely open, indicated by a `state/operator-turn-open.json` marker written on operator prompts and cleared at Stop (60-min TTL backstop against an orphaned marker). An open task record does not starve routines. Time an occurrence spends deferred by an open turn does not count toward lateness, so it fires at the first poll after the turn clears; an occurrence already past the limit when the turn opens, or one whose deferral was interrupted by downtime, still records `skipped-late`. After downtime, only the latest missed occurrence is eligible, and only within `routine_max_lateness_minutes` (default 60). Older occurrences within the 24-hour scan window record `skipped-late`; occurrences outside that window are abandoned without a skip row. The routine waits for its next scheduled run. Set the limit to `1440` to retain the previous 24-hour catch-up window; CronCreate fallback does not enforce this limit.
- **CronCreate fallback/anchor mode** is idle-gated by the harness. If Claude was mid-task when the cron time hit, the fire is **deferred until idle, not dropped**. Long mid-task spans push fires later but never lose them. CronCreate auto-expires after 7 days — the daily `heartbeat-restart` routine (4am) re-runs `load` to reset the clock; if you've disabled it, fallback-mode routines will silently stop firing after a week.

## Routine Monitor Not Ticking

- Run `/hermitd:hermit-doctor` and check the `routine-monitor` line. `croncreate-fallback mode` means routines use CronCreate because native monitors were unavailable or activation produced no liveness proof.
- `/hermitd:hermit-routines load` invokes the activation skill to start native plugin monitors. It accepts a live supervisor PID or a liveness tick; it no longer registers a Monitor tool task. Check `state/routine-monitor-liveness.json` for `pid` and `last_peek_at`.
- An exited inner poller is respawned by its supervisor. A dead supervisor causes the watchdog to restart the resident when lifecycle guards pass and execution is idle; active or unknown execution defers the restart.
- `RESTART_REQUIRED|command-drift` (or `SKIP|restart-required:<legs>` from the daily anchor) means the live supervisor still uses the old plugin path. The watchdog restarts an always-on resident at an idle boundary once evolve has finished and the lifecycle guards pass. Check `upgrade-restart` / `upgrade-restart-deferred` events in `state/watchdog-events.jsonl` for the restart or deferral reason. For sessions without a watchdog, restart the resident with `hermitd restart` to pick up the new path; invoking activation again cannot replace an already-armed native monitor in the same session.

## Queued Task Not Picked Up

- Ask for open resident tasks. A runnable record must have `owner: resident`, no result and no `waiting_on` value.
- Close/cancel returns the next runnable record immediately. For unattended pickup, check heartbeat liveness and `tasks.queue_nudge_minutes` (default 60).
- Conservative escalation notifies the requester; balanced and autonomous escalation continue work in that turn.
- A notice already acknowledged for the current record state does not repeat. Changing the result revision changes its acknowledgement token.

## Morning Brief Not Sending

- See "Routines Not Firing" above — the morning brief is a routine (`hermitd:brief --morning`).
- Verify channels work first — send `!status` manually from your phone.

## Hermit Keeps Suggesting Dismissed Proposals

Reflect checks dismissed and deferred proposals before creating new ones. If you're still seeing re-suggestions:

- Run `/hermitd:hermit-evolve` to ensure the latest reflect skill is active.
- If significantly more evidence has accumulated since the dismissal, Hermit may intentionally revisit — this is by design.

## Context Keeps Growing

Check `context_hygiene.clear.enabled` and the watchdog tick. A standalone clear waits for the token floor, matching idle execution identity, at least 60 seconds idle, no running task worker, an idle/shell registry entry and an unchanged pane across two ticks. Unknown or busy observations deliberately defer it. Inspect `state/watchdog-events.jsonl` for `clear:<reason>` fires.

Open tasks do not need closing to permit a safe clear. Their progress and lessons survive in their records. Compaction remains a separate summarizing mechanism.

## Docker Build Fails

Common causes:

- **UID mismatch:** The Dockerfile matches your host UID. If you're not UID 1000, rebuild after checking `id -u`. The generated Dockerfile should handle this, but manual edits may break it.
- **Network issues during build:** `apt-get` or `npm install` fails. Check your network, proxy settings, and Docker DNS config.
- **npm permission errors:** Claude Code installs globally. The Dockerfile sets `NPM_CONFIG_PREFIX` for the `claude` user — if you modified the Dockerfile, ensure this is preserved.
- **Ubuntu 26.04 default user conflict:** UID 1000 is taken by the default `ubuntu` user. The generated Dockerfile runs `userdel -r ubuntu` first — don't remove this line.
- **Rebuild after config changes:** setting `docker.packages` in config.json installs nothing on its own — the list is read only when the Docker templates are rendered. Add the package inside the operator block of `Dockerfile.hermit`, then rebuild: `hermitd restart --build` (it needs the container running; from stopped, `hermitd start --build`). See [Customizing the container](always-on.md#customizing-the-container).

## Upgrade Says Nothing to Update

- Check plugin version: `cat .claude-plugin/plugin.json | grep version` (or check the installed plugin path).
- Check config version: `cat .hermit/config.json | grep _hermit_versions`.
- If both match, there's genuinely nothing to upgrade. New features may have landed as skill changes (no config migration needed).
- If the plugin was updated but the marketplace cache is stale: `claude plugin marketplace update hermitd` to refresh the catalog, then `claude plugin update hermitd@hermitd --scope <local|project|user>`. `hermitd-docker update` / `hermitd-update` refresh the catalog automatically before moving pins, so this manual step is mainly for driving `plugin update` by hand.

## Docker Container Keeps Restarting

Check logs first:

```bash
hermitd docker logs
```

Common causes:

- **Auth expired:** `hermitd-docker login` to re-authenticate, then `hermitd-docker restart`. On a hermit using a long-lived login token, use `hermitd-docker setup-token` instead — see below.
- **Workspace trust not accepted:** Attach once (`hermitd-docker attach`), accept the trust prompt, then detach (`Ctrl+B, D`).
- **Missing `.env`:** If using API key auth, ensure `.env` exists with `ANTHROPIC_API_KEY` set.

## Hermit Went Dark / Authentication Errors

If the hermit stops responding and the logs show `401` or `Invalid authentication credentials`, its login has lapsed. You should hear about it: the watchdog reads the error off the session's own screen and messages you on your channel.

**If the hermit authenticates from its environment** rather than from a stored login — an `ANTHROPIC_API_KEY`, an `ANTHROPIC_AUTH_TOKEN`, or Bedrock/Vertex/Foundry — a 401 is not a lapsed login, so you get a different message: one that names the credential instead of telling you to sign in. Check the key itself: revoked, rotated, out of credit, or wrong region.

In that case the hermit also stops supervising the session rather than restarting it, and that is deliberate. The credential lives in the environment that started it, which the watchdog cannot see and cannot pass on; a restart would bring the session back with no credential at all and then restart it again on the next escalation. It waits for you instead, repeating the notice once a day until the key works.

**On a hermit with a working channel, you shouldn't need to do anything from a terminal — in either auth mode.** Within a few minutes the watchdog messages you on your channel saying it's down and asking you to reply `reauth`. Do that when you're at a browser; it sends a one-time sign-in link, takes the code back, and restarts itself. Nothing is minted until you reply, so a link never expires unused.

What the pane runs behind that differs by mode: `claude setup-token` in token mode, and `CLAUDE_CONFIG_DIR=<config-dir>/.hermit-login-staging claude auth login --claudeai` in login mode. In login mode the new credential is staged rather than installed — `state/pending-credential.json` points at it, and the watchdog moves it into place during the restart, so the sign-in only takes effect once the hermit comes back. `setup-token-mint status` reports `pending: true` while that is outstanding.

**If the hermit has no channel, or the send fails**, that automation cannot run: the relay stamps `state/relay-unreachable.json`, you get one push notification, and it stays quiet for 24 hours instead of retrying every tick. Sign in on the box (`hermitd-docker login` under Docker; otherwise run `claude` in the project folder and type `/login`), then restart it. The session stays up in the meantime, so nothing is lost, and the watchdog will not restart or nudge a session it knows can't authenticate.

To check or drive it yourself:

```bash
# What auth is this hermit on, and when does it expire?
hermitd docker bash -c \
  '.hermit/bin/hermitd-run setup-token-mint status'

# Renew from the terminal instead of over chat
hermitd docker setup-token
```

Notes:

- **Never run `/logout` inside the container.** It wipes the stored credentials *and* resets first-launch state, after which the interactive wizard demands a login and refuses the token — turning a two-minute renewal into a rebuild. Renewal never needs it.
- If the relay never messages you, the hermit has no reachable channel. It stops rather than minting a link it can't deliver; renew from the terminal with `hermitd-docker setup-token`.
- `hermitd-docker login` on a running token-mode hermit switches it to a claude.ai sign-in through the staged relay (see [Remote Endpoint](remote-endpoint.md)); a container with no session yet still opens the interactive REPL. To stay on the token, use `hermitd-docker setup-token` instead.
- The original login's `.credentials.json` is parked to `.credentials.json.pre-token.bak` when the token installs (and at boot). This matters: an interactive session prefers a stored `/login` credential over the token, so a hermit that kept the file would 401 once that stored login lapsed (~8h), even with a valid year-long token. If you converted before this behavior shipped and the hermit is dark, park it by hand (`mv .../.credentials.json .../.credentials.json.pre-token.bak`) and restart.

## Permission Denied Inside Container

Usually a UID mismatch between the host and the container user. The generated Dockerfile creates a `claude` user matching your host UID. If you changed your system user or are running on a different machine:

1. Check your host UID: `id -u`
2. Rebuild the image: `docker compose -f docker-compose.hermit.yml build --no-cache`

## Channel Messages Not Arriving

**Docker:**
- Pair or re-pair from the host with `/hermitd:channel-setup`. docker-setup pairs during first run; afterwards use channel-setup. A channel or token added later needs `hermitd-docker restart` first (the bot is offline until then). Inside the container, `/<channel>:access pair <code>` (save access.json to `<state_dir>/` not `~/.claude`) and `/<channel>:access policy allowlist` in the attached REPL.
- Verify the channel plugin is installed inside the container: `hermitd-docker attach`, then check with `claude plugin list`.
- Check bot pairing: send a test message to the bot and watch the logs (`hermitd-docker logs`).
- For Discord: ensure `channels.discord.state_dir` is set in `config.json` (e.g. `.claude.local/channels/discord`) and the directory is bind-mounted in `docker-compose.hermit.yml`. `hermitd-start` resolves relative paths and derives `DISCORD_STATE_DIR` at boot.
- For Telegram: ensure `channels.telegram.state_dir` is set and the bot token is in the state directory's `.env` file.

**Local/tmux:**
- Type `/hermitd:channel-setup` in a terminal or the Claude app to verify and repair the full setup (bun, plugin, token, pairing, access.json location).
- Check `hermitd-start` output for bun or token warnings — the channel is skipped if either is missing.
