# Group enrollment

Inputs: the channel key (`discord` or `telegram`), the absolute Hermit state directory (`<hermit_state_dir>`, containing `config.json`), and how to ask (`AskUserQuestion` or channel reply). Deliver every question by that method and wait for the answer. Collect all answers before writing.

Read the channel config and its resolved `access.json`: `channels.<channel>.state_dir`, default `.claude.local/channels/<channel>`, relative to the project root. Keep the current `passive_chats` and `ackReaction` available for the conditional questions.

1. Ask for the chat ID, or Skip for DMs only:
   - Discord, header **Server channel**: Want the hermit to also listen in a Discord server channel? Enable Developer Mode in Discord settings, right-click the channel, then Copy Channel ID. Threads inherit their parent policy, so use the parent channel ID.
   - Telegram, header **Group chat**: Want the hermit to also listen in a Telegram group? Forward a message from the group to `@userinfobot` or use `@RawDataBot`. Group IDs are negative integers, such as `-1001234567890`. BotFather privacy mode must be disabled.
   - Options: **Yes, add a channel** (Discord) or **Yes, add a group** (Telegram), with the ID via Other; **Skip, DMs only**. For channel replies, accept the ID as text.
2. For each ID, ask these four questions together, recommending the defaults:

   | Header | Question | Options |
   |---|---|---|
   | Mention required | Require an @mention for this chat? | **Yes, require @mention** (default); **No, respond to all messages** |
   | Shared history | Let every other chat recall what is said here? | **No, private to this chat** (default); **Yes, shared with every chat** |
   | Trigger nicknames | Which nickname regexes should also trigger replies? | **None**, no new patterns (default); Other: regex list |
   | Who can trigger | Who may trigger replies in this chat? | **Anyone in the chat** (default); Other: numeric user IDs |

   Shared history means any chat on any channel can recall what is said here. Nickname triggers are channel-wide and never wake a passive chat.
3. Only when mention is **No** and who can trigger is **Anyone**, ask: **Record the chat but wake only on @mention (passive)? Yes / No.** Otherwise use `--passive no`. If this ID was in `passive_chats`, say: **passive recording is off for this chat because it now requires a mention (or restricts senders)**.
4. When passive is **Yes** and `ackReaction` is a non-empty string, ask once: **Turn off the plugin-global seen-emoji?** Options: **Turn off** (default, also stops the emoji on your DMs for this channel); **Keep**. Missing or empty `ackReaction` asks nothing. Pass `--ack-off` only for Turn off.
5. Validate the ID and trigger IDs as numeric strings; reject the channel's `maintainer_channel_id`. Encode nickname patterns as a JSON array of strings and validate each as a case-insensitive regex. Make one call, substituting every value explicitly:

   Run `channel-group-add` (Commands) with arguments `<channel> <id> --mention <yes|no> --allow <id1,id2|none> --shared <yes|no> --passive <yes|no> [--nicknames '<json array of strings>'] [--ack-off]`.

   Omit `--nicknames` for no new patterns. The script replaces this group's mention and sender settings, updates its `shared_chats` and `passive_chats` membership while preserving other IDs, unions channel-wide nickname patterns, and preserves the seen-emoji unless explicitly turned off.
6. Relay the returned `mention`, `allow`, `shared`, `passive`, `patterns` and `ack` as confirmation. Changes apply on the next message with no restart. On `{"error"}`, report the token and stop writing. `partial_config_written` means config landed but access did not: relay **re-run the same command**. A hook refusal means **refused in bypass mode; pair or enrol from a normal terminal session**. Never retry a denied call through another writer.

Recording needs channel logging on; `/hermitd:hermit-doctor` checks it. Discord's bot needs Create Public Threads to open task threads; without it, have the sender open a thread. Quote-replies to the bot count as implicit mentions at the plugin gate; unbound passive chats still need a self-mention at the Hermit gate. Forum channels are unsupported.

Ask **Add another? Yes / Done**, taking the next ID via Other or channel reply. Repeat the questionnaire for each ID until Done.
