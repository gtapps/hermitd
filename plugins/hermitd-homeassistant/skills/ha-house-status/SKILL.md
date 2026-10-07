---
name: ha-house-status
description: Get a quick live status of the house via MCP. Shows lights, covers, climate, presence, and notable states. Use when the operator asks about house state.
allowed-tools:
  - Bash
  - Read
  - mcp__homeassistant__GetLiveContext
  - mcp__homeassistant__homeassistant__GetLiveContext
  - mcp__homeassistant__GetDateTime
  - mcp__homeassistant__llm__GetDateTime
---

# HA House Status

## Steps

1. Call `GetDateTime` for current time and date.
2. Call `GetLiveContext` for the live house snapshot.
3. Use the stored language from OPERATOR.md (`## HA hermit` section) for all output.
4. Check `.hermit/raw/snapshot-ha-normalized-latest.json` modification time. If older than 24 hours or missing, append a warning to the status output:
   > "Context snapshot is stale — run `/hermitd-homeassistant:ha-refresh-context` for accurate entity data."
5. Present a human-readable summary in the stored locale, organized by:
   - **Presence**: who is home / away
   - **Lights**: which are on
   - **Covers/Blinds**: positions
   - **Climate**: temperatures, HVAC state
   - **Media**: what's playing
   - **Security**: alarm state (read-only, never actuate)
   - **Notable**: anything unusual (devices unavailable, unexpected states)

## Format

Keep the summary concise. Use bullet points. Group by area if the house has distinct areas. Highlight anything that looks unusual or worth investigating.
