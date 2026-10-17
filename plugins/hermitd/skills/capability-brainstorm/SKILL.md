---
name: capability-brainstorm
description: Monthly routine plus on-demand hermit-voice brainstorm — synthesizes memory, capabilities, recent artifacts, and codebase shape into at most 2 capability ideas, each gated by proposal-triage before becoming a PROP. Runs on the capability-brainstorm routine and when the operator asks to brainstorm capabilities or ideate, e.g. "brainstorm capabilities", "what could you be doing for me?", "any capability ideas?".
---

Record notes only inside an open record's turn, using `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts note .hermit <id>` with the note on stdin. Otherwise skip record notes. Never edit a task file directly.

# Capability Brainstorm

## Kill criteria (read before running)

After ≥8 invocations, run:

```
bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts metrics .hermit --source=capability-brainstorm
```

`status: "kill"` (survival < 25% or acceptance < 30%) → cut this skill rather than tune it; the signal-to-noise ratio isn't there. `insufficient_data` means under 8 triage verdicts so far; wait and re-check.

## 1. Gather capability signals (harness-context — read before dispatch)

These three sources require the main session's harness context and cannot be delegated:

- *Skills:* use the harness available-skills list loaded in your context — that is authoritative.
- *MCPs:* call `ListMcpResourcesTool` to enumerate currently online MCP tools.
- *Channels:* read `config.json` → `channels` keys.

## 2. Dispatch the eval runner

Pass the capability signals from Step 1 in the dispatch prompt. Dispatch `hermitd:skill-eval-runner` pointed at `${CLAUDE_PLUGIN_ROOT}/skills/capability-brainstorm/reference.md`. Include in the dispatch prompt:
- `plugin_root`: `${CLAUDE_PLUGIN_ROOT}` (resolved absolute path — the runner needs it for the sibling-scan, since `${CLAUDE_PLUGIN_ROOT}` is not substituted in `reference.md` content)
- `skills_list`: the harness available-skills list (one skill per line)
- `mcp_tools`: the `ListMcpResourcesTool` output
- `channels_keys`: the `channels` key list from config.json

The runner reads memory topic files, compiled artifacts, and codebase shape in an isolated context, generates ≤2 ideas (applying the friction + grounding constraints), and returns the structured result.

**Eval runner return schema** — the runner's return value is a JSON object conforming to this block. The schema is byte-identical in `reference.md` (producer) and here (consumer); a contract test asserts this.

<!-- brainstorm-eval-schema:start -->
```json
{
  "ideas": [
    {
      "title": "<short idea title>",
      "description": "<one-line description>",
      "friction": "<one-sentence operator pain>",
      "grounding": ["<item 1>", "<item 2>"],
      "effort": "hours|days",
      "evidence_summary": "<one-paragraph friction + grounding for proposal-create>"
    }
  ],
  "discarded": ["<one-line discarded idea>"],
  "inputs_scanned": ["<title or path of each source scanned>"]
}
```
<!-- brainstorm-eval-schema:end -->

**Failure policy:** if the runner returns null or malformed JSON, treat as a zero-ideas result — proceed to Steps 3–5 with `ideas: []`, `discarded: []`, `inputs_scanned: []`, and note the failure in the batch message as `0 ideas emitted (analysis-runner failed)`.

## 3. Create proposals (single-pass via `/hermitd:proposal-create`)

For each generated idea, invoke `/hermitd:proposal-create` once with:

```
Title: <short idea title>
Evidence Source: capability-brainstorm
Evidence: <one-paragraph summary: friction + grounding items>
```

Set the PROP frontmatter:
- `source: auto-detected`
- `category: capability`
- `tags: [capability-brainstorm, ideation]`

`/hermitd:proposal-create` invokes `proposal-triage` internally. Parse its outcome:
- `CREATE: <title>` — PROP file written, note the assigned PROP-NNN.
- `SUPPRESS: <title> — <code>` — record the suppression code. Don't retry.
- `DUPLICATE: <title> — <PROP-ID>` — record the existing PROP-ID. Don't create.

Do NOT invoke `proposal-triage` directly in this skill — `/hermitd:proposal-create` already does it.

## 4. Emit batch message

Send one message per `CLAUDE-APPEND.md` § Operator Notification (`channel-send.ts --notice`; it asks for decisions, so it needs a `client` leg):

```
🧠 Capability brainstorm (<N> idea(s))

1. **<short title>** — <one-line description>
   _Grounding: <item 1>, <item 2>_
   _Friction: <one-sentence pain>_
   _Estimated effort: <hours|days>_
   PROP-NNN created  ·  (or: suppressed — <code>  ·  or: duplicate of PROP-NNN)

2. **<short title>** — ...

📎 <proposals page URL>
```

The `📎` line is a single slot for the whole batch, not one per idea — omit it entirely when the proposals-page refresh returned no URL.

If zero ideas were generated or all were suppressed/duplicated, the message is:
```
🧠 Capability brainstorm — 0 ideas emitted (<reason: thin context | all suppressed | all duplicates>)
```

## 5. Write compiled artifact (non-empty runs only)

If ≥1 PROP was created (not suppressed/duplicate), write:

`.hermit/compiled/capability-brainstorm-YYYY-MM-DD-HHMM.md`

Frontmatter:
```yaml
---
title: Capability brainstorm — <ISO timestamp>
type: capability-brainstorm
created: <ISO timestamp with timezone>
tags: [capability-brainstorm, ideation]
source: <interactive when the operator asked; routine when the capability-brainstorm routine fired>
proposals_created: [PROP-NNN, ...]
---
```

Body (cover the substance, no filler sections):
- Ideas that passed generation and triage — one paragraph each.
- Discarded ideas — one line each (no grounding, no concrete friction).
- Triage verdicts for each emitted idea (CREATE / SUPPRESS — code / DUPLICATE:ID).
- Inputs scanned — titles/paths only, no content.

Do not tag `foundational` — this is a time-bounded ideation snapshot.

**Zero-emit runs:** skip the artifact entirely. Log one line to open record notes:
`capability-brainstorm: 0 ideas emitted (<reason>)`
