---
name: voice-notes
description: Transcribe and respond to voice notes. Activates when any channel message carries an audio attachment, or when asked to transcribe an inbound voice message.
---
# Voice Notes

Voice-note transcription and transcript echoes are on by default. Handle the audio as the sender's message, and reply through the same channel's reply tool. Never include local file paths or shell commands in channel replies.

1. Download the attachment with that channel's own download tool. Keep it under that enabled channel's state directory.
2. Run the command below using the inbound tag's channel key, chat id and message id. Use Bash `timeout: 600000` and quote all argument values as shell arguments.

   ```bash
   .hermit/bin/hermitd-run transcribe --file '<downloaded audio>' --channel '<channel key>' --chat '<chat id>' --message-id '<message id>'
   ```

3. Read the single JSON result and reply through that channel's reply tool:

   - `ok`: act on `transcript` as that sender's message. Quote it first only if `echo` is `failed` or `unsupported`; otherwise the script already echoed it or the operator turned echoes off.
   - `empty`: do not guess. Ask the sender to resend or type the message.
   - `unavailable`: give one neutral line saying you could not transcribe the voice message, with no setup advice.
   - `disabled`: acknowledge the voice note without guessing its content.

If argument validation returns an error, correct the invocation using the attachment and the inbound tag. Keep diagnostic paths and commands out of the chat.
