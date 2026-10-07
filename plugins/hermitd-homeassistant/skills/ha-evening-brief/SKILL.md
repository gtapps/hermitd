---
name: ha-evening-brief
description: Evening house brief — end-of-day security check, device status, and energy snapshot. Runs as a daily routine at 22:30 or on demand.
allowed-tools:
  - Bash
  - Read
  - Glob
  - Grep
  - Write
  - mcp__homeassistant__GetLiveContext
  - mcp__homeassistant__homeassistant__GetLiveContext
  - mcp__homeassistant__GetDateTime
  - mcp__homeassistant__llm__GetDateTime
---

# HA Evening Brief

An end-of-day house check that confirms the house is secure before night. Designed to run as the `evening-brief` routine at 22:30.

When both `hermitd` and `hermitd-homeassistant` are installed and `evening-brief` is enabled, this skill subsumes `/hermitd:brief --evening` — operators should disable the core `evening` routine to avoid duplicate ~22:30 notifications. For hermits without HA, `/hermitd:brief --evening` remains the standalone path.

## Steps

1. **Time & context** — Call `GetDateTime` for current time. Read `.hermit/OPERATOR.md` for language preferences.

2. **Live house snapshot** — Call `GetLiveContext`. Extract and organize:
   - Security: alarm state, lock states, open covers/blinds
   - Devices: robovac status (completed / docked / running / error), lights still on
   - Any devices unavailable or in error state

3. **Anomalous sensors** — From the live snapshot, identify currently unavailable, stuck, or unexpected-state sensors. Report only what is currently wrong — no baseline diff required.

3a. **Pending updates**: Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha updates --digest` and capture stdout. Branch on its content (the command always exits 0 — never branch on exit code):
   - Contains `(skipped:`: pipe one line into `.hermit/bin/hermitd-run task note .hermit <id>` only inside an open record's turn (otherwise skip the note) (`updates fetch failed: <detail after "skipped:">`) and omit the `Updates:` section entirely.
   - Contains `(no updates pending)` — omit the `Updates:` section entirely.
   - Otherwise — render the digest lines as the `Updates:` section, translating tier labels into the operator's language. No proposal-id lookup here (unlike the morning brief).

4. **Energy snapshot** — From the live context, pull current power draw and day's energy consumption if HA energy entities exist. Omit this section if no energy sensors are available.

5. **Compose brief** — Write a concise evening brief in the operator's language (from OPERATOR.md). Use the format below.

6. **Write to `compiled/`** — Write the composed brief to `.hermit/compiled/brief-evening-<YYYY-MM-DD>.md` with frontmatter:
   ```yaml
   title: "Evening Brief — <YYYY-MM-DD>"
   type: brief
   created: <ISO8601>
   task: <T-... for the open record in this turn; omit this field otherwise>
   tags: [evening-brief, ha]
   ```
   Inside an open record's turn, pipe `[[compiled/brief-evening-<YYYY-MM-DD>]]` into
   `.hermit/bin/hermitd-run task note .hermit <id>`. Otherwise skip the note.

## Output Format

```
Good evening! Home - [date]

Security:
- [alarm state, lock states, open covers — or "All secure"]

Devices:
- [robovac status, lights left on — or "All clear"]

Sensors:
- [currently unavailable or anomalous — or "None"]

Updates:
- [tier] Title: installed → latest
- [N HACS updates pending]
- [Omit section entirely when none pending or the fetch was skipped.]

Energy:
- [day's consumption, current draw — omit section when unavailable]
```

Keep the entire brief under 14 lines (10 when the `Updates:` section is absent — no updates pending or the fetch was skipped). Adapt the greeting and section headers to the operator's configured language.

## Delivery

- If invoked as a routine, or `config.always_on` is `true` in `.hermit/config.json`: deliver the composed brief via the Operator Notification protocol in CLAUDE.md (core resolves the channel and falls back to push when no channel is reachable). The terminal is unmonitored in always-on mode. For the push-fallback branch, condense to a single line (per § Operator Notification push format): lead with the security verdict (open doors, unlocked, open windows) or `secure`, then any anomaly. Example: `House secure, garage door still open: open CC to view`.
- Otherwise (invoked on demand in an interactive session): output to terminal.
- Never include secrets, tokens, or internal file paths in the brief.
