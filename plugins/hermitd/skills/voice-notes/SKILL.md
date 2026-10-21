---
name: voice-notes
description: Handle a voice note or audio attachment the hermit cannot read, and set up transcription when the operator wants it. Activates when a channel message carries an audio attachment (Telegram voice message, Discord voice-message.ogg), or on "can you understand voice notes", "transcribe my voice message", "set up voice notes".
---
# Voice Notes

The channel plugin downloads the audio; the model cannot read it. Transcription is an operator choice, not a shipped default. The recipe lives in `${CLAUDE_PLUGIN_ROOT}/docs/voice-notes.md`; route to it, do not repeat it.

## Step 0 — Channel reply

If this skill was invoked from a channel-arrived message (the inbound prompt contains a `<channel source="...">` tag), reply via that channel's reply tool. Otherwise emit to conversation. On a channel-tagged turn, step 1's bounded ask also queues a durable micro-proposal entry via `proposal.ts queue-micro` (see `channel-responder` § Channel-safe ask bridge), so the answer re-enters this skill in a later turn instead of stranding the setup half-done.

## An audio attachment arrives

With no standing role covering it, reply: you received a voice note, you cannot listen to it yet, and you can set that up if they want. Do not guess at the content or ask them to retype it unless they decline setup.

## The operator asks to set it up

Read `.hermit/config.json`: no channel with `enabled !== false` means no audio ever arrives (the Claude app transcribes before sending), so say so and stop.

Otherwise walk them through the doc from chat:

1. Settle one thing: should the audio stay on this machine, or is uploading it to a transcription provider acceptable? Self-hosted is the default. Then read only the matching doc section, self-hosted or hosted, plus its step 2.

   **Channel-tagged turn:** send the question via the reply tool, queue the bridge entry below, and stop. The answer comes back as a `--answer self-hosted` / `--answer hosted` re-entry, which skips the ask and resumes here.
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts queue-micro .hermit <<'HERMIT_MP'
   {"tier":1,"question":"Voice notes: should the audio stay on this machine, or is sending it to a transcription provider acceptable?","options":["self-hosted","hosted"],"on_resolve":"/hermitd:voice-notes setup --answer {answer}","chat":"<sourceKey>:<chat_id>"}
   HERMIT_MP
   ```
2. Install: read `runtime_mode` from `.hermit/state/runtime.json`. On `docker`, delegate to `/hermitd:docker-customize` with the tool the doc names; otherwise name the host install for the operator rather than running it yourself. A hosted provider needs its key in `.env`, never in the role text or `config.json`.
3. Role: save the standing role from the doc through the ordinary "remember" path, substituting the command they ended up with. Offer "for this channel" if they only want it in one chat.
4. Verify: have them send a voice note and confirm the reply addresses what they said.

On a prompting permission mode, mention the doc's allow rules after the first run raises an approval.
