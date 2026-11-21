# Channel credential

This stage covers the channels named in the token env var names below.
For every other channel plugin, official or not, follow [Credentials and plugin procedures](other-channel.md#credentials-and-plugin-procedures) for credentials, then return to the calling wizard for activation.

Use the absolute project `.hermit` directory as `<hermit_state_dir>`. On Docker, skip host channel plugin installation and use the host-visible `.claude.local/channels/<channel>` where `<channel>` is the configured key: the bind mount uses that folder regardless of `state_dir`. On a host, use `channels.<channel>.state_dir` from config, defaulting to the same folder. Resolve relative paths against the project root. Never look up a bot token in the host's Claude home directory.

Before the token question, read the plugin's README and skills from the installed copy or the marketplace source. Explain its platform steps in the operator's configured `language`, using the plugin's guide as the source. Keep the official guide link below.

If this session has Claude in Chrome tools, call `mcp__claude-in-chrome__tabs_context_mcp` once without `createIfEmpty`. On success, offer the walk-through once per run with **Yes, walk me through (recommended)** first and **No, I'll do it** second. Name the changes and expected account. Record acceptance for the access stage. On an error or when the tools are absent, proceed with the manual steps and add this line once: "To have me walk these steps in your Chrome, turn on Claude in Chrome with /chrome."

In the walk-through, let the operator sign in or clear CAPTCHAs. Then use up to six `browser_batch` calls, each with three `computer` `wait` actions of 10 seconds followed by `get_page_text` or `find` for visible signed-in content. Continue only when the page clearly shows sign-in succeeded. On timeout, an error, a lost connection, or an ambiguous page, ask the operator to confirm.

Stop inspecting the page before the secret step. The operator creates and copies the secret. Resume page reads only after the operator says the secret is no longer shown.

If the calling wizard established that the agent is running and config has the browser on with phone sign-in set up (`browser.port`, `browser.host` and at least one browser admin), add one line telling the operator they can ask the agent to create and store the credential, then return here.

Token env var names: `discord` → `DISCORD_BOT_TOKEN`, `telegram` → `TELEGRAM_BOT_TOKEN`.

Check for a nonempty token in `<state_dir>/.env` without printing its contents. If already configured, say where and run the validation below. Otherwise show the [official setup guide](https://code.claude.com/docs/en/channels) and ask:

```
questions: [
  {
    header: "Bot token",
    question: "How do you want to supply the bot token?",
    options: [
      { label: "Private file", description: "Save the token with a hidden prompt in my own terminal" },
      { label: "Paste here", description: "Supply the token through Other" }
    ]
  }
]
```

A pasted value enters the conversation and its history. The private file is the first choice. If Paste here is chosen, the operator supplies it through Other. If the answer carries no token, ask for it in a plain reply.

**Private file:** give the operator this command with the actual channel and variable name. Tell them to run it from the project root in their host terminal.

```bash
hermitd run channel-token <channel> <TOKEN_VAR>
```

Append `--docker` on Docker. The command prompts with input hidden. Wait for the operator to confirm it reports `status: saved` and share the reported `file` path, then use its parent as the channel folder for validation below. If it reports an `error`, relay the error and offer Paste here instead. If deferred, return to the calling wizard with the credential skipped.

**Paste here:** prepare an empty private file in one Bash call:

```bash
umask 077
mkdir -p "<state_dir>"
touch "<state_dir>/.env" && chmod 600 "<state_dir>/.env" && : > "<state_dir>/.env"
```

Read the empty file, then Write `<TOKEN_VAR>=<pasted-token>` into it so the token stays out of shell commands. Ensure `.claude.local/` is in `.gitignore`, appending it if missing.

## Validate the saved credential

If `state_dir` is unset, run `channel-config-merge` (Commands) with `{"channels":{"<channel>":{}}}` on stdin to fill the conventional path while preserving existing fields, including `enabled`. Stop on a nonzero exit. Use the command for config writes.

Run `channel-bot-id` (Commands) to record the bot's identity for mention handling. Set `<CHANNEL_UPPERCASE>_STATE_DIR` to the parent of the reported file after Private file entry, or to the absolute host-visible channel folder on Docker for other paths. Report a `skip` reason and continue. For `http_401` or `http_403` on Docker, tell the operator the platform rejected the token and to fix it before restarting. Tell the operator the credential takes effect at the next start. Return to the calling wizard with the credential outcome.
