# Voice Notes

Voice notes work by default on every agent. When an audio attachment arrives from any channel, the agent downloads it with that channel's tool, transcribes it, echoes `🎙️ "…"` in the same chat, and replies to its content as the sender's message. The transcript is added to the original inbound log row, preserving the sender and making the spoken words searchable when channel logging is enabled. Echoes do not ping everyone, here or roles; user mentions remain enabled.

Use `/hermitd:hermit-settings transcription` to turn transcription off. Disabled transcription downloads no engine or models and uploads no audio; the agent acknowledges the note without exposing a file path. Use `/hermitd:hermit-settings transcription-echo` to turn the echo off independently. Both changes apply to the next voice note; Docker package changes take effect after the next `hermitd update`.

## Local transcription

The default engine is pinned whisper.cpp with the `base` model and Silero voice activity detection. On Linux glibc x64 and arm64, hatch starts binary preparation in the background for tmux and interactive deployments. Missing binaries can also install on the first note. The pinned libgomp library ships beside whisper-cli; a pinned ffmpeg is installed only when ffmpeg is absent from PATH. Docker images include ffmpeg by default, controlled by the `HERMIT_TRANSCRIPTION` build argument.

Tools already on PATH (`whisper-cli` and `ffmpeg`) take priority. Otherwise the engine lives under `.claude.local/whisper.cpp/<platform>-<arch>/<version>/` in the agent project. The first note downloads the base and Silero models into `.claude.local/whisper.cpp/models/`; hatch does not prefetch them. Downloads are checked against pinned SHA-256 hashes. There is no Python requirement, background transcription service or per-note local API charge.

On macOS, install the tools once:

```bash
brew install whisper-cpp ffmpeg
```

Automatic binary installation does not support musl Linux or other platforms. `/hermitd:hermit-doctor` checks readiness without installing anything. A failed install records its error privately and names `.hermit/bin/hermitd-run transcribe --prepare` as the retry command.

A run has one 540-second deadline. A silent clip produces a request to resend or type the message; an unavailable engine produces a neutral acknowledgement that transcription failed, without setup instructions or paths in the chat. Spoken replies and streaming transcription are not included.

## Hosted fallback

When local transcription is unavailable, a present `GROQ_API_KEY` enables an audio upload to Groq with `whisper-large-v3-turbo`; `OPENAI_API_KEY` enables the OpenAI `whisper-1` fallback. Groq takes priority. Keep keys in ignored environment files, never in config or chat. Without either key, audio remains local. Cloud requests have a maximum 60-second timeout within the shared deadline, and files over 25 MB are not uploaded. Silence detected locally does not trigger an upload.

Netguard templates allow `archive.ubuntu.com`, `ports.ubuntu.com`, `huggingface.co`, `hf.co`, `api.groq.com` and `api.openai.com`. Existing Docker agents need the refreshed security templates and a subsequent `hermitd update` to receive the allowlist and ffmpeg layer. See [security](security.md#script-argument-trust) for download and attachment trust boundaries.

## Other engines

A separately managed hosted transcription service can be integrated through an operator-authored workflow. It must handle credentials and audio disclosure explicitly; the built-in fallback supports only Groq and OpenAI.

For GPU hosts, the Python `openai-whisper` package is an alternative runtime. Install it in a virtual environment alongside ffmpeg and manage its models and GPU dependencies yourself. Its `whisper` command is separate from the built-in `whisper-cli` path and needs an operator-authored workflow. The built-in default remains whisper.cpp.
