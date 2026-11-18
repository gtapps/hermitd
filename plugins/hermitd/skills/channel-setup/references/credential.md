# Channel credential

Built-in channel plugins follow this stage.
For other plugins, follow [Credentials and plugin procedures](other-channel.md#credentials-and-plugin-procedures) for credentials, then return to the calling wizard for activation.

Use the absolute project `.hermit` directory as `<hermit_state_dir>`. On Docker, skip host channel plugin installation and use the host-visible `.claude.local/channels/<channel>` where `<channel>` is the configured key: the bind mount uses that folder regardless of `state_dir`. On a host, use `channels.<channel>.state_dir` from config, defaulting to the same folder. Resolve relative paths against the project root. Never look up a bot token in the host's Claude home directory.

iMessage has no bot token and is macOS-only. Skip it on Docker and continue with the other enabled channels.

Before the token question, read the plugin's README and skills from the installed copy or the marketplace source. Explain its platform steps in the operator's configured `language`, using the plugin's guide as the source. Keep the official guide link below.

Read `chrome`, `browser.enabled` and `browser.default` and check the session's available tools to determine browser availability, without preferring one browser. Drive the agent's own browser through `/hermitd:browser`; use Claude in Chrome through its tools when the session has them, following [its requirements](https://code.claude.com/docs/en/chrome). When a browser is available, offer once per run to open the page named in the plugin's guide and walk the steps up to, but not including, creating or revealing the secret. When none is active, suggest the browser options this install can use; continue with guide links if declined. The operator signs in, solves CAPTCHAs, creates and copies the secret. Stop browser inspection before the secret step and do not inspect the page again until the operator says the secret is no longer shown.

Token env var names: `discord` → `DISCORD_BOT_TOKEN`, `telegram` → `TELEGRAM_BOT_TOKEN`.

Check for a nonempty token in `<state_dir>/.env` without printing its contents. If already configured, say where and run the validation below. Otherwise show the [official setup guide](https://code.claude.com/docs/en/channels) and ask:

```
questions: [
  {
    header: "Bot token",
    question: "How do you want to supply the bot token?",
    options: [
      { label: "Private file", description: "Write <state_dir>/.env in my own terminal" },
      { label: "Paste here", description: "Supply the token through Other" }
    ]
  }
]
```

A pasted value enters the conversation and its history. The private file is the first choice. If Paste here is chosen, the operator supplies it through Other. If the answer carries no token, ask for it in a plain reply.

**Private file:** print these commands for the operator to run in their own terminal:

```bash
umask 077
mkdir -p "<state_dir>"
touch "<state_dir>/.env" && chmod 600 "<state_dir>/.env"
${EDITOR:-vi} "<state_dir>/.env"
```

Tell the operator to enter `<TOKEN_VAR>=` followed by the secret. Wait for confirmation and check for a nonempty token without printing it. If deferred, return to the calling wizard with the credential skipped.

**Paste here:** create the state directory, write `<TOKEN_VAR>=<pasted-token>` to `<state_dir>/.env` (overwrite if it exists), and set mode `600`. Ensure `.claude.local/` is in `.gitignore`, appending it if missing.

## Validate the saved credential

If `state_dir` is unset, run `channel-config-merge` (Commands) with `{"channels":{"<channel>":{}}}` on stdin to fill the conventional path while preserving existing fields, including `enabled`. Stop on a nonzero exit. Use the command for config writes.

Run `channel-env-check` (Commands) with the uppercase channel key and the absolute channel folder. It validates the state directory without writing settings. Tell the operator it takes effect at the next start.

Run `channel-bot-id` (Commands) to record the bot's identity for mention handling. On Docker, set `<CHANNEL_UPPERCASE>_STATE_DIR` to the absolute host-visible channel folder for this call. Report a `skip` reason and continue. For `http_401` or `http_403` on Docker, tell the operator the platform rejected the token and to fix it before restarting. Return to the calling wizard with the credential outcome.
