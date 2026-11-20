---
name: channel-access
description: Manage chat access. Let someone talk in a chat, remove them, see who can talk here, open a chat to everyone, turn a chat off, or remove someone who is no longer an approver.
---

# Channel access

## Commands
- `channel-show`: `bun "${CLAUDE_PLUGIN_ROOT}/scripts/channel-access.ts" "<hermit_state_dir>" show`
- `channel-group-allow`: `bun "${CLAUDE_PLUGIN_ROOT}/scripts/channel-access.ts" "<hermit_state_dir>" group-allow`
- `channel-group-remove`: `bun "${CLAUDE_PLUGIN_ROOT}/scripts/channel-access.ts" "<hermit_state_dir>" group-remove`
- `channel-unpair`: `bun "${CLAUDE_PLUGIN_ROOT}/scripts/channel-access.ts" "<hermit_state_dir>" unpair`
- `settings-edit`: `.hermit/bin/hermitd-run settings-edit "<hermit_state_dir>/config.json"`

## Step 0 — Channel reply

When the turn starts with a `<channel source="...">` envelope, use that channel's reply tool for questions and results. Never call AskUserQuestion on a channel turn.

## Handle the request

1. Resolve the configured channel key and chat ID. Use the current chat unless the requester names another. Resolve people and chat names to known IDs from the request or channel context. Ask through the reply tool if a name is ambiguous. Quote IDs as literal shell arguments. For a request to enrol a new chat, invoke `/hermitd:hermit-settings` with `channels` and use its group enrolment questionnaire.
2. Run `channel-show` with `<channel> [chat]` to see the approvers and enrolments. Include the chat for sender changes or removal. Use the returned `chat_id` for the parent when a Discord thread resolves to its parent. Reply with the relevant access for read-only requests.
3. For a change, run one of these commands in a single Bash call. A Bash description uses the names and action in plain words, for example “Let Joana talk in #geral (asked by Hugo)”. Use the requester's display name from the message when available. The native approval decides whether the command runs.
   - Change senders with `channel-group-allow <channel> <chat> --add <id1,id2>`, `--remove <id1,id2>`, or `--open`.
   - Stop listening in a chat with `channel-group-remove <channel> <chat>`.
   - Remove a paired approver with `channel-unpair <channel> <sender>`. Pairing a new approver belongs at the terminal.
   - For an addition, read `channels.<channel>.allowed_users` with `settings-edit get`. If it exists and lacks a requested sender, explain before the approval that this list grants control commands across the whole channel and that the first entry is primary when `operators` is absent. Add only the missing IDs by chaining `&& settings-edit append channels.<channel>.allowed_users '<JSON string ID>'` for each with the same Bash call. An empty list makes the first appended entry primary without `operators`. When the chat is already open and only the agent list blocks the sender, use just the append commands. Preserve the list on chat removal, sender removal, open, and unpair.
4. Relay the result in channel voice. If team policy refuses the step for the requesting member, follow the tool's instructions to send one approval question to the admin chat. A DM-paired approver's reply there starts the native approval. Respect a denial and leave the files alone.

With `last_sender`, offer to open the chat to everyone or turn the chat off. With `passive_chat` or `chat_open`, explain the current sender policy. With `last_approver`, say that channel approvals stop until someone pairs at the terminal. With `primary_operator`, say that unpairing leaves their operator role intact.

If the access file is missing (`no_access_file`) or incompatible (`access_format_unsupported`), make only the applicable append-only `allowed_users` change through its approval. Read the installed channel plugin's README and skills for its access procedure, and tell the requester which step to run and where. Always use the commands above for writes. Never Edit or Write a channel file.
