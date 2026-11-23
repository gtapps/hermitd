# Voice Notes

Voice-note transcription is enabled by default. The agent downloads audio attachments with the channel's tool and transcribes them when an engine is available. On success, it echoes `🎙️ "…"` in the same chat by default and replies to the content as the sender's message. The transcript is added to the original inbound log row, preserving the sender and making the spoken words searchable when channel logging is enabled. Echoes do not ping everyone, here or roles; user mentions remain enabled.

Use `/hermitd:hermit-settings transcription` to turn transcription off. Disabled transcription downloads no engine or models and uploads no audio; the agent acknowledges the note without exposing a file path. Use `/hermitd:hermit-settings transcription-echo` to turn the echo off independently. Both changes apply to the next voice note; Docker package changes take effect after the next `hermitd update`.

## Local transcription

The agent uses NeMo-Speech v0.3.0 with the Nemotron 3.5 ASR model and automatic language detection. Tmux and Docker deployments prepare the engine and model in the background at boot. Hatch starts the same preparation for interactive installs. A voice note can also trigger preparation if needed.

Automatic installation supports Linux glibc x64 and arm64 and Apple Silicon macOS. A `nemo-speech` executable on PATH takes priority. Intel Mac users supply `nemo-speech` on PATH. The automatic install lives under `.claude.local/nemo-speech/<platform>-<arch>/<version>/`, and the model uses about 742 MB of disk per agent under `.claude.local/nemo-speech/models/`. Peak transcription memory measured at two CPUs was about 1 GiB. Engine archives come from GitHub and the engine pulls the model from Hugging Face with `curl` from PATH. Both are checked against pinned SHA-256 hashes.

FFmpeg on PATH takes priority. Linux hosts download a pinned FFmpeg when it is missing. Docker images include FFmpeg by default through the `HERMIT_TRANSCRIPTION` build argument. Local transcription in Docker requires FFmpeg from the image or an existing installation. On macOS, install FFmpeg when it is missing:

```bash
brew install ffmpeg
```

`/hermitd:hermit-doctor` checks readiness without installing anything. A failed engine install records its error privately. To retry preparation, run `.hermit/bin/hermitd-run transcribe --prepare`.

A run has one 540-second deadline. A silent clip produces a request to resend or type the message; an unavailable engine produces a neutral acknowledgement that transcription failed, without setup instructions or paths in the chat. Spoken replies and streaming transcription are not included.

## Hosted fallback

When local transcription is unavailable, a present `GROQ_API_KEY` enables an audio upload to Groq with `whisper-large-v3-turbo`; `OPENAI_API_KEY` enables the OpenAI `gpt-transcribe` fallback. Groq takes priority. Keep keys in ignored environment files, never in config or chat. Without either key, audio remains local. Cloud requests have a maximum 60-second timeout within the shared deadline, and files over 25 MB are not uploaded. An available FFmpeg converts `.caf` attachments to WAV before upload. Other attachments are uploaded in their original format. Providers receive a language hint only when a language is configured. Silence detected locally does not trigger an upload.

While transcription is enabled, the netguard allowlist includes `huggingface.co`, `hf.co`, `api.groq.com` and `api.openai.com`. Existing Docker agents receive the allowlist at their next `hermitd restart` and the ffmpeg layer at their next `hermitd update`. See [security](security.md#script-argument-trust) for download and attachment trust boundaries.

## Other engines

A separately managed hosted transcription service can be integrated through an operator-authored workflow. It must handle credentials and audio disclosure explicitly; the built-in fallback supports only Groq and OpenAI.

For GPU hosts, the Python `openai-whisper` package is an alternative runtime. Install it in a virtual environment alongside ffmpeg and manage its models and GPU dependencies yourself. Use its `whisper` command in an operator-authored workflow.
