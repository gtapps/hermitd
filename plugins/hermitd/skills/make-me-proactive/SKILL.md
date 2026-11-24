---
name: make-me-proactive
description: 'Offer standing jobs when asked "make me proactive", "what could you be doing for me?", or "what could you check or remind me about?"'
---

# Make me proactive

For `apply [<id>]`, read [apply.md](apply.md) and follow it immediately. Skip the offer flow.

## Commands

- `add-item`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/heartbeat.ts add-item .hermit`
- `task-note`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts note .hermit <id>`
- `task-block`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts block .hermit <id>`
- `task-check`: `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task-check.ts <id>`

## 1. Gather existing jobs and past offers

Run `bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts anchor .hermit` first. It refreshes the proposal digest and returns `root` and `memory_dir`. Stop if it fails.

Then run:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts list .hermit --all --dedupe-prefix proactive: --json --limit 1000 | jq -c '[.rows[] | {dedupe_key, title, closed_by}]'
```

Count rows with `closed_by: null` as open. Free slots are 3 minus that count, floored at zero. At zero, stop silently on the routine or tell the operator in one line that three offers are already waiting. Stop on an inventory error.

Run `.hermit/bin/hermitd-run duties summary .hermit` and `.hermit/bin/hermitd-run later list .hermit` in the main session. An inventory read failure ends the run.

## 2. Dispatch the eval runner

Dispatch `hermitd:skill-eval-runner` once with the absolute path to [reference.md](reference.md) and these inputs:

- `plugin_root` and `memory_dir` as resolved absolute paths
- `duties_summary` and `later_list` as the script outputs
- `past_subjects` as the projected task list, including open and closed rows
- `slots` as the free slot count
- `skills_list` as the harness available-skills list, one skill per line

Treat malformed output as zero ideas. Accept at most `slots` ideas. Skip ideas with `proactive:<subject_key>` in any past row, and keep only one idea per subject in this batch.

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

## 3. Triage and create

If ideas remain, dispatch `hermitd:proposal-triage` once for the batch. Start with `Anchor: root=<root> memory_dir=<memory_dir>`. Give each idea's title, `Evidence Source: make-me-proactive`, and a summary of the cited evidence and what the operator would miss or need to do by hand.

For each returned verdict, invoke `/hermitd:proposal-create --no-artifacts` with the matched `Triage-Verdict:` line and these headers:

```text
Title: <idea title>
Evidence Source: make-me-proactive
Source: <auto-detected on the routine, operator-request on demand>
Category: improvement
Tags: ["make-me-proactive"]
Dedupe-Key: proactive:<subject_key>
Resume: /hermitd:make-me-proactive apply
```

Use `## Context` for the reason in one line, `## Proposed Solution` for the kind, owner and full recipe, `## References` for the cited items, and `## Verification` for the kind's receipt check in [apply.md](apply.md). In Proposed Solution include "Apply with `/hermitd:make-me-proactive apply <this task's id>`". If the create call allocated the id after writing the body, resolve the placeholder to the current task id at intake. Only a new CREATE receipt becomes an offer.

## 4. Deliver offers

Send each new proposal as its own `bun ${CLAUDE_PLUGIN_ROOT}/scripts/channel-send.ts .hermit --notice` with `{"client":"<offer_text>","decision":{"task":"<id>","generation":1}}` on stdin. Keep one decision per message. Follow [Operator Notification](../../prompts/resident.md#operator-notification) when no channel is enabled. On demand, answer the asking turn in one line or list the offers in the terminal. With zero new offers, stay silent on the routine or say nothing new fits on demand.
