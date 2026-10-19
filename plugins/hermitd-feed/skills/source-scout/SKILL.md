---
name: source-scout
description: >-
  Gap-driven discovery of new RSS/web sources for feed-sources.md. Interactive runs
  WebFetch-verify candidates and auto-add them; --scheduled runs queue unverified
  candidates for operator review (no WebFetch, per the domain-allowlist rule).
  Complements source-health (removal) with discovery (addition). Invoke with
  /hermitd-feed:source-scout.
---

# Source Scout

Proactively discover and add new RSS/web sources to `feed-sources.md`. Complements `source-health`
(removal) with discovery (addition). Runs as the `source-scout` routine with `hermitd-feed:source-scout --scheduled`.

## Flags

- `--scheduled`: invoked by its routine (non-interactive, no operator present). The security
  rule restricting automated WebFetch to domains already in `feed-sources.md` means the step-3 verification
  fetch cannot run — candidates are queued **unverified** for operator review instead of being auto-added.
- No flag (default): interactive/on-demand (operator ran `/source-scout`). Full behavior — verify and
  auto-add — since the operator's live presence satisfies the security rule's intent.

## Steps

1. **Read current state** (in parallel):
   - `feed-sources.md` — extract active source names, URLs, categories. Count sources per category.
   - `feed-categories.md` — all P1/P2 categories and their priorities.
   - Glob `.hermit/compiled/story-arcs-*.md`, read the most recent. Extract Watch-clause keywords from each active arc under `## Active`.

2. **Identify gaps:**
   - Any P1 or P2 category with fewer than 3 active sources is a **gap category**.
   - Active story arcs with Watch keywords that no current source covers by name/domain are **arc gaps**.
   - No gaps → pipe `source-scout: no gaps found` into `.hermit/bin/hermitd-run task note .hermit <id>` only inside an open record's turn (otherwise skip the note) and stop.

3. **Discover candidates** (up to 3 total across all gaps). Use WebSearch to find RSS feeds — for a
   category gap, search for RSS feeds / newsletters covering that category; for an arc gap, search for
   feeds covering the arc's Watch keywords.

   **No flag (interactive):** for each candidate, verify the feed URL with WebFetch (valid RSS/Atom XML). Discard any that 404 or return non-feed content.

   **`--scheduled`:** do NOT WebFetch candidate URLs — they are not yet in `feed-sources.md`, so an automated
   fetch would violate the domain-allowlist rule. Collect candidates from WebSearch results as-is
   (name, URL, gap addressed, why it surfaced), explicitly marked unverified. Skip to step 4.

4. **Filter against existing sources:**
   - Skip any candidate whose domain already appears in `feed-sources.md`.
   - Skip any candidate previously removed (check the source registry and operator policy for removal decisions).
   - Cap at 3 net-new candidates total.

5. **Add / queue — branch on invocation context:**

   **No flag (interactive):** source additions are free (no operator approval needed). For each verified candidate:
   - Append a row to the `## Active Sources` table in `feed-sources.md`.
   - Assign type (`rss` for RSS/Atom feeds, `web` for scraped pages).
   - Write a brief Notes value describing what the source covers.

   **`--scheduled`:** do NOT touch `feed-sources.md` — these candidates are unverified.

   In both modes, write `.hermit/compiled/source-candidates-<YYYY-MM-DD>.md` with frontmatter
   (`title`, `type: source-candidates`, `created`, `tags: [source-scout]`) listing each candidate's name,
   URL, the gap it addresses, and a one-line "why this looked promising" note.

   **`--scheduled` only:** notify the operator per the Operator Notification protocol with a one-line summary
   ("N unverified source candidate(s) found — see .hermit/compiled/source-candidates-<date>.md"). Don't queue a
   micro-approval: verification requires an interactive WebFetch only the operator can trigger. The operator
   reviews the file and, for any candidate they want, runs `/source-scout` interactively (or edits
   `feed-sources.md` manually) so verification happens with them present.

6. **Log and report:**
   - **No flag:** only inside an open record's turn, pipe the following into `.hermit/bin/hermitd-run task note .hermit <id>` (otherwise skip the note): `source-scout: added N source(s): [name1, name2, ...]` (or `source-scout: 0 viable candidates found` if none survived). Additions are mentioned in the next brief.
   - **`--scheduled`:** only inside an open record's turn, pipe the following into `.hermit/bin/hermitd-run task note .hermit <id>` (otherwise skip the note): `source-scout (scheduled): queued N unverified candidate(s) for operator review` (or `source-scout (scheduled): 0 candidates found`).

## Notes

- Do NOT add sources that require Chrome (type `reddit`, `chrome`, `x`) — higher runtime cost; add those manually.
- Do NOT add paid newsletters or sources behind login walls.
- Prefer RSS/Atom feeds over web scraping when both are available for the same source.
- If WebSearch is unavailable, skip the run and log `source-scout: skipped (WebSearch unavailable)`.
