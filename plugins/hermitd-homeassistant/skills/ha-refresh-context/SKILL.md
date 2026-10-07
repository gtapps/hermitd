---
name: ha-refresh-context
description: Fetch and normalize the full Home Assistant state into durable artifacts. Use before drafting automations or when context is stale.
allowed-tools:
  - Bash
  - Read
  - Write
  - mcp__homeassistant__GetLiveContext
  - mcp__homeassistant__homeassistant__GetLiveContext
---

# HA Refresh Context

## Steps

1. Run `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha refresh-context`.
2. Read the output JSON — note entity count and base_url_source.
3. Read `.hermit/raw/snapshot-ha-normalized-latest.json` to understand what's in the house.
4. Compare with the previous entity count (check your auto memory for a stored house profile).
5. If new entities, areas, or domains appeared, update your auto memory with the house profile changes.
6. If entities disappeared or became unavailable, note it in your auto memory.

## Output

- `.hermit/raw/snapshot-ha-context-<date>.json` + `snapshot-ha-context-latest.json` — raw HA API snapshot
- `.hermit/raw/snapshot-ha-normalized-latest.json` — processed entity/service index (fixed name)
- `.hermit/raw/audit-ha-context-refresh-<date>.md` + `audit-ha-context-refresh-latest.md` — audit entry

**House profile (first run or when profile changes):** if new areas, domains, or significant entity changes are observed in step 5, write a durable house profile summary to `.hermit/compiled/context-house-profile-<YYYY-MM-DD>.md` with frontmatter `type: context`, `title: "House Profile: <date>"`, `created: <ISO8601>`, `task: <T-... for the open record in this turn; omit this field otherwise>`, `tags: [ha-context, house-profile, foundational]`, `injection_stub: "House profile: <N> areas, <M> entities, <K> automations. Read compiled/context-house-profile-<date>.md for detail."` (fill in the real counts). Inside an open record's turn, pipe `[[compiled/context-house-profile-<date>]]` into `.hermit/bin/hermitd-run task note .hermit <id>`. Otherwise skip the note.

## When to Use

- Session start (via ha-boot) when context is stale
- Before building any automation
- After the operator reports changes to their HA setup
- Periodically to detect drift
