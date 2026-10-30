# Fixed-text resync

Inputs: the saved language and current timestamp. Run after a reply when called from first chat. Preserve operator-authored overrides.

Two kinds of fixed text are written by scripts, not the model: the Artifact pages' UI chrome (`.hermit/state/artifact-strings.json`, overlaid per key over the English defaults) and the script notices sent to the channel, such as watchdog, status, budget and login messages (`.hermit/state/messages.json`). A missing key or an absent file falls back to English, so model-authored content and these surfaces only match when both are translated.

Run **only** when the chosen `language` is set and is not `en`:

1. Emit the artifact scaffold: `artifact-strings-scaffold` (Commands). Translate every value inside its `strings` object, leave the `language` and `generated` fields as emitted, and write the result to `.hermit/state/artifact-strings.json`.
2. Emit the notice scaffold: `messages-scaffold` (Commands). Translate each `todo` entry's `en` text, using its `note` for context, and write `.hermit/state/messages-draft.json` as `{"language":"<language>","locale":"<BCP 47 tag, e.g. pt-PT>","strings":{"<key>":"<translation>"}}`. Then run `messages-apply` (Commands); translate again any key it lists under `rejected`.

In both, keep keys and `{placeholder}` tokens verbatim (word order may move around a token, but the token text must not change or be translated).

When `language` is `en`, delete `.hermit/state/artifact-strings.json` if present and run `messages-clear` (Commands). When unset, skip.

Custom wordings stay in the language they were authored in. When `messages-status` (Commands) lists `overrides`, ask whether to keep them or drop them with `messages-reset` (Commands).

