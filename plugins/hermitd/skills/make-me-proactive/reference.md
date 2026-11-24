# Make me proactive runner

Read-only analysis for the main session. Use Read, Glob and Grep as needed. Run no commands, write no files, and send no messages. The main session owns triage, proposals and delivery.

## Inputs

Use the supplied `plugin_root`, `memory_dir`, `duties_summary`, `later_list`, `past_subjects`, `slots`, and authoritative line-by-line `skills_list`. Read relevant topic files indexed by `MEMORY.md` under `memory_dir`, recent compiled pages in `.hermit/compiled/` from the last 30 days, `.hermit/config.json` entries `monitors[]` and `routines[]`, and `.hermit/HEARTBEAT.md`.

## Generation

Offer concrete jobs the operator would otherwise do by hand or miss. Cite at least one memory topic, compiled page, or job item per idea that shows the operator doing this work or needing its result. A job missing from the config is not evidence on its own. Drop a subject when an existing job already covers it, any past subject row matches it, or memory records postponement. Use a stable lowercase slug as `subject_key`; use the existing key when comparing the same subject under different wording. Distinguish configured but disabled duties that can be re-enabled from jobs already doing the work.

Choose the cheapest kind that fits:

- `later-remind` for a one-time reminder and `later-check` for a one-time check. Use `hermitd:later` for both. Offer no recurring reminders.
- `watch` via `hermitd:watch` for a saved monitor with a concrete check. Say that alerts can come at any hour and that you'll ask whether to stop when the condition is met.
- `routine` via `settings-edit` for re-enabling an existing routine by id, adding `hermitd:morning` or `hermitd:evening` with `skill: hermitd:brief --morning` or `hermitd:brief --evening` respectively, or scheduling a skill present in `skills_list`. Use a later-check, watch, or heartbeat for unsupported routine ideas.
- `heartbeat` via `heartbeat.ts add-item` for a check that requires judgment during regular check-ins. Include a checklist line with the explicit end condition in the recipe. Say "I'll check during my regular check-ins and tell you once it happens, then ask whether to stop".

Make each recipe concrete enough for its owner to write the job, including what happens, when, when it ends, what earns a message, and which chat receives it. State those details in the plain offer and ask for a yes or no. Return at most `slots` ideas, even when more qualify.

## Return value

Return one JSON object with all fields present and no surrounding prose. For `evidence`, give the cited item names or paths and the supporting observations. Use `discarded` for short reasons and `inputs_scanned` for source names or paths. Empty lists are valid.

<!-- proactive-eval-schema:start -->
```json
{
  "ideas": [
    {
      "title": "<short title>",
      "subject_key": "<stable subject key>",
      "kind": "<later-remind|later-check|watch|routine|heartbeat>",
      "owner": "<owning skill or script>",
      "recipe": {
        "what": "<job and owner inputs>",
        "when": "<timing or cadence>",
        "ends": "<end condition or until disabled>",
        "message_when": "<what earns a message>",
        "chat": "<delivery chat>"
      },
      "offer_text": "<plain operator-facing offer>",
      "evidence": []
    }
  ],
  "discarded": [],
  "inputs_scanned": []
}
```
<!-- proactive-eval-schema:end -->
