---
name: weekly-digest
description: >-
  Synthesizes the past 7 days of archived briefs into a weekly digest — top
  stories, emerging vs faded themes, category activity, and per-source performance
  built from archive frontmatter. Delivers to the operator's configured channel and
  archives a weekly note. Designed as a weekly routine. Invoke with
  /hermitd-feed:weekly-digest.
---

# Weekly Digest

Produce a weekly synthesis from the archived brief notes. All data comes from
`.hermit/briefs/` — no re-fetching of sources. Cheap to run.

## Steps

1. **Read the week's briefs.** Glob `.hermit/briefs/*.md` (exclude the `weekly/`
   subdirectory), then filter to files whose filename date prefix falls within the past 7 days
   (today minus 6 days through today). Read each matching file (frontmatter + body).
   - Directory absent or empty → deliver "No briefs archived this week." and stop.
   - Fewer than 3 briefs → note the gap, produce the digest from whatever is available.
   - Track the actual count of files read — this is `brief_count` for the archive.

2. **Synthesize content.** From the brief bodies:
   - **Top stories** — items appearing across multiple briefs or escalating in coverage. Cite which day(s) they appeared.
   - **Emerging themes** — topics absent early in the week that dominated late in the week.
   - **Faded stories** — topics in ≥2 consecutive early-week briefs that appear in no late-week brief. Surface at most 2; omit the section if none meet the threshold.
   - **Category activity** — count items per category directly from brief bodies across all briefs. Do NOT use `top_categories` frontmatter for this tally — it is pre-truncated to top 5 per brief and undercounts categories that consistently rank below the cutoff.

3. **Source performance.** Read `feed-sources.md` for the full source list, then from frontmatter across the week:
   - **Reliable sources** — appeared in `sources_used` in ≥5 briefs.
   - **Unreliable sources** — appeared in `sources_skipped` more often than `sources_used`. Include the skip count (e.g. "Source X (skipped 8/12 briefs)").
   - **Silent sources** — in `feed-sources.md` but in neither `sources_used` nor `sources_skipped` across any brief this week (may never have been attempted).
   Keep to 3–5 bullets, actionable framing.
   - **`sources_skipped` (fetch failures) is the reliability signal. `sources_quiet` (0 items on a quiet day) is NOT** — never count quiet days against a source's reliability.

4. **Write the digest.** Format:

   ```
   📅 Week of [Mon DD] – [Sun DD, YYYY]
   [N] briefs | [total items across week]

   **This week's story**
   [1–2 sentences on the dominant narrative of the week]

   **Top stories**
   - [Story] — [days] — [one line on why it matters]

   **Themes**
   - Emerging: [theme]
   - Faded: [topic]   ← omit if none met the threshold

   **Categories this week**
   [Cat A: 18 items · Cat B: 11 · Cat C: 7 · ...]

   **Source notes**
   - Reliable: [source], [source]
   - Skipped often: [source] (N/14 briefs) — consider removing or fixing
   - Silent: [source] — never fetched, check if still relevant
   ```

   Tone: slightly more reflective than an evening brief. One paragraph of narrative before the lists is fine.

5. **Deliver** via the Operator Notification protocol (core resolves
   the channel and falls back to push when no channel is reachable). `text` is the digest from step 4.
   - For the push-fallback branch, condense to a single line (per § Operator Notification push format): lead with the week's
     dominant theme, then the brief count. Example: `Quiet week on AI infra, 12 briefs — open CC to read`.
   - On resolve miss or send failure, write the digest to `.hermit/compiled/pending-delivery.md` (frontmatter `title`, `type: pending-delivery`, `created`, `brief_path` pointing at the weekly archive path). Do not retry. This queue supersedes the protocol's logging fallback: don't also add a duplicate task note for the digest or record a `channel-send-unavailable` issue.

6. **Archive** to `.hermit/briefs/weekly/YYYY-WNN.md` (create the directory if absent).
   Use the ISO week number (e.g. `2026-W15`). Use actual counts from steps 1–3, not placeholders:
   ```yaml
   ---
   date: YYYY-MM-DD        # Sunday of the week
   week: YYYY-WNN
   title: "Weekly Digest — YYYY-WNN"
   created: YYYY-MM-DDTHH:MM:SS+HH:MM  # ISO 8601 with timezone
   tags: [brief]
   brief_count: N       # actual number of brief files read in step 1
   top_categories: [Cat A, Cat B, Cat C]   # top 3 from the full body tally in step 2
   sources_used: [Source A, Source B]      # union of all sources_used across the week
   sources_skipped: [Source C]             # union of all sources_skipped across the week
   ---
   ```

7. **Reaction-feedback aggregation.** Glob `.hermit/compiled/brief-feedback-*.md`.
   **If no such files exist, SKIP this step silently** — the reaction-feedback producer is a channel-layer
   concern not shipped with this plugin, so its absence is expected, not an error. When logs do exist:
   - Read the two most recent files (current + previous month if both exist).
   - Parse each line (format: `YYYY-MM-DD <slot> | <emoji> | source: <name> | topic: <topic>`).
   - Filter to entries within the past 7 days (the week window).
   - Count 👍 and 👎 per source. If any source has ≥3 reactions total in the window, add a brief note to the digest's **Source notes** section (e.g. "Source A — 5 👍 this week", "Source B — 3 👎 this week (consider deprioritizing)").
   - **Persistent negative signal:** if a source's 👎 count exceeds its 👍 by 3 or more over the month window (both files), create a proposal via `/hermitd:proposal-create` to deprioritize or remove that source (Evidence Source: scheduled-check/source-health).

## Notes

- Reads from the archive, never re-fetches. If a brief was skipped that day, it simply won't appear — note the gap rather than backfilling.
