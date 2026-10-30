# Channel connection stages

Inputs: channel key, configured plugin and marketplace, resolved state directory, absolute project Hermit directory, runtime owner, whether a channel entry or token is new this run, and question method. Use `AskUserQuestion` in an attended terminal; ask by reply on a channel turn. Wait for answers. Hatch runs credentials and check before starting your agent, then access after start. Channel setup runs all stages in order. Docker setup runs credentials and check on the host before its build/start stages and access afterwards.

## Credentials

For third-party plugins, follow their own setup instructions. Do not assume a bot token or Hermit pairing protocol. For iMessage on macOS, there is no bot token or Hermit pairing: follow the plugin's macOS permissions steps, including Messages access, Automation and Full Disk Access where requested. On another OS stop with `macos_required`.

For Telegram, guide the operator to BotFather: create a bot with `/newbot` and copy its token. For Discord, use the Developer Portal Bot tab: enable Message Content intent and turn Public Bot off unless anyone may add the bot. Link the [official channel guide](https://code.claude.com/docs/en/channels).

Resolve the channel's state directory from config, default `.claude.local/channels/<channel>`, relative to the project root. Do not display the contents of `.env`. Check whether the token key exists without printing its value. If present, keep it unless the operator requests replacement.

When a token is needed, offer **Private terminal (recommended)** first, **Paste here** second, and **Later**. Private terminal keeps the token out of the conversation. Print both commands as literal, substituted commands to run in a separate project terminal:

```bash
hermitd run channel-token-set <channel>
.hermit/bin/hermitd-run channel-token-set <channel>
```

Docker setup prints the second form because the host CLI is installed later. Never use `!` shell mode for token entry. A no-TTY result writes nothing; have the operator run the command in a real terminal. Wait until they confirm it finished before checking. For Paste here, first explain that the token will remain in session history. If they still choose it, preserve every other line in the channel `.env`, replace only `<CHANNEL>_BOT_TOKEN`, set mode 600, and never echo the token. Later stops this channel with `no_token` and `/hermitd:channel-setup` as the recovery path. Ensure `.claude.local/` is ignored by git.

## Check

`channel-preflight` (Commands)

Read the one JSON object. `action_needed` stops this channel: name `reason`, explain its `fix`, and point to `/hermitd:channel-setup`. Missing token means enter it; rejected token means replace it; network/API failure means retry the check. Discord `message_content_intent_off` means enable Message Content intent in the Bot tab. Show Discord's returned invite link and ask the operator to use it if the bot has no server; describe `bot_public` and `no_guilds` warnings explicitly. `not_checked` means the plugin has no probe, not that it passed; follow its own setup. Do not print a token or tokenized URL.

For Telegram and Discord capture mention identity, best-effort:

`channel-bot-id-write` (Commands)

A skip here does not override the preflight verdict.

## Restart

Determine resident liveness from the project status/runtime, not from the setup session's tools. A new channel entry or new token needs a restart when your agent is live. Offer `hermitd restart` only from a non-resident host session (`HERMIT_RESIDENT` is not `1`, not in a container). If accepted, run it and stop on failure with its named reason. From the resident or a container, explain that a separate host terminal must restart your agent; do not attempt self-restart. If your agent is not live, use `hermitd start` from the host. Hatch starts it itself and skips this offer. Never decide a restart is unnecessary because this setup session has a reply tool.

## Access

Only Telegram and Discord use this pairing protocol. Once your agent is up, ask the operator to DM the bot, then supply the six-character code, or choose Already paired / Later. Messages sent before the bot is up may need to be sent again. Only DM-pair people who may approve tool use: every paired DM can receive native permission prompts; `allowed_users` narrows who may wake your agent, not who may approve. Other people should join through group enrollment.

For a new code run one command, substituting the code, channel and absolute project Hermit directory:

`channel-pair-restrict` (Commands)

The approval states that access is restricted. This consumes the code, sets policy `allowlist`, unions the paired id into `allowed_users`, and seeds the home chat if unset. Never copy the id into another config command. Preserve existing users. On an error, report its named cause and stop; a config-write failure is not a completed setup. An expired or unknown code needs a new DM and code. Already paired proceeds to access-location verification without repeating pairing. Later points to `/hermitd:channel-setup` and stops this channel.

Verify the channel's state-directory access file. A `file: home` result may require moving the home access file to the state directory if that directory has none, using `CLAUDE_CONFIG_DIR` when set. Never overwrite an existing state file. Preserve approvals. Finish the caller's optional access/group settings before two-way proof.

## Two-way proof

Run `channel-preflight` (Commands) again. Only `two_way: proven` confirms that an eligible inbound message received a reply in the home chat. A sent test message alone proves only outbound reachability. For `not_proven`, ask the operator directly to send a message and confirm your agent replied; wait for their answer, then rerun the check. For plugins without a probe, report `not_checked` and use their setup instructions and the operator's direct confirmation. Never describe an unchecked or unproven channel as verified. If no reply arrives, name the preflight cause when available; otherwise point to `hermitd docker logs --tail=60` for Docker or `/hermitd:hermit-doctor` on the host and keep setup incomplete.
