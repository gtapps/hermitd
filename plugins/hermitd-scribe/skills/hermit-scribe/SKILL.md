---
name: hermit-scribe
description: File a GitHub issue or post a comment on an existing issue via a GitHub App bot identity. Use when the operator says "file as a GH issue", "open an issue for PROP-NNN", "report this to the tracker", "add a comment to issue #NNN", "comment on #NNN", "reply to issue #NNN", or similar. Requires HERMIT_GH_APP_ID, HERMIT_GH_APP_INSTALL_ID, HERMIT_GH_APP_KEY_FILE in env.
---

# hermit-scribe

Files a GitHub issue or posts a comment on an existing issue via a configured GitHub App bot identity.

## When to activate (filing)

Activate when the operator says:
- "file PROP-NNN as a GH issue"
- "open an issue for this"
- "report this to the tracker"
- "file a GH issue for [description]"

## When to activate (commenting)

Activate when the operator says:
- "add a comment to issue #NNN"
- "comment on #NNN: [text]"
- "reply to issue #NNN"

## How to file

**Step 1: resolve content.**

If the operator named a proposal (`PROP-NNN`):
1. Glob `.hermit/proposals/PROP-NNN-*.md` to find the file.
2. Read frontmatter: `id`, `title`, `category`, `session`.
3. Read body sections: `## Context`, `## Problem`, `## Proposed Solution`, `## Impact`.
4. Derive the Conventional-Commits type, scope, and labels. Write the **raw** (pre-translation) frontmatter `title` and proposal body to temp files, then run:

   ```bash
   bun "${CLAUDE_SKILL_DIR}/file-issue.ts" classify {category} {title-file} {body-file}
   ```

   It emits JSON `{type, scope, labels, title_line}` — `title_line` is `<type>(<scope>): <title>` (scope omitted when unresolved). Review it, then use `title_line` as the draft title and hold `labels` for Step 6. (Scope resolution reads `_hermit_versions` from `.hermit/config.json`; `hermit-filed` is added by the script — it is not in `labels`.)

5. Construct draft body with the four body sections. The provenance footer (see Step 3) is NOT part of the draft — appending it here would expose `proposal={id}` to the sanitizer, which would redact it as operator-project detail and break dedup.

For ad-hoc issues (no proposal): use the title and body the operator provides verbatim — no CC type/scope construction.

Then, for both proposal-backed and ad-hoc issues:

**Step 1b: language normalization.**

If the title or body is not already in English, translate to English. Preserve verbatim:
- Technical identifiers (entity IDs, API names, file paths, function names, package names, plugin slugs, repo names)
- Code blocks and command lines
- Frontmatter field names and values
- Proper nouns

Translate prose, headings, and bullet text. Keep the structure (Context / Problem / Proposed Solution / Impact) and section ordering identical to the source.

The proposal file under `.hermit/proposals/` is NOT modified — translation applies only to what is sent to GitHub.

**Step 1c: issue-template detection.** (both proposal-backed and ad-hoc issues)

Run:
```bash
bun "${CLAUDE_SKILL_DIR}/file-issue.ts" --templates
```

- Exit 0 + filenames printed → hold the filenames for Step 4's preview. This checks the target repo (`HERMIT_GH_REPO`) directly via the GitHub API, not the local checkout, and only the modern `.github/ISSUE_TEMPLATE/` directory form — the legacy single-file `.github/ISSUE_TEMPLATE.md` is intentionally out of scope.
- Exit 2 → hold nothing; Step 4's preview gets no template note.

These filenames are never passed to the Step 3 sanitizer and are never part of the draft or cleaned body — they reach the operator only through Step 4's preview.

**Step 2: dedup check.** (proposal-backed only — skip for ad-hoc issues)

Run:
```bash
bun "${CLAUDE_SKILL_DIR}/file-issue.ts" --check {id}
```

- Exit 0 + URL printed → an issue already exists for this proposal. Show the URL to the operator and ask whether to skip filing or proceed anyway.
- Exit 2 → no existing issue. Continue.

**Step 3: sanitize.**

Pass the draft title and body to the `hermitd-scribe:issue-sanitizer` subagent:

```
DRAFT_TITLE: {draft title}
DRAFT_BODY:
{draft body}
```

Parse the response: split on the `<<<HERMIT_SCRIBE_BODY>>>` line. Everything before it (after stripping `TITLE: `) is the cleaned title; everything after is the cleaned body.

For proposal-backed issues, append the footer to the cleaned body now — after sanitization, never before it, since the footer is skill-generated protocol that `--check` matches on, not operator content:
```
---
*Filed via hermit-scribe · proposal={id} · session={session}*
```

**Step 4: operator preview.**

Present the post-translation, post-sanitization content to the operator as a **single message** containing, in order:
1. Proposed title
2. Complete issue body — everything that will be written to the issue, including the `---\n*Filed via hermit-scribe...*` footer
3. Labels that will be applied (informational — no operator editing): `Labels: hermit-filed (always); plus bug/enhancement/chore and optional homeassistant-hermit/hermit-scribe for proposal-backed issues`
4. If Step 1c found templates (informational — no operator editing): `Note: this repo defines issue templates under .github/ISSUE_TEMPLATE/ ({filenames}); this body does not follow them.` Omit this item entirely when Step 1c found nothing.

If the preview exceeds the channel message-size limit, split it into multiple messages and finish displaying all content before invoking publication.

If the operator requests edits, regenerate and show the complete preview before another publishing attempt.

**Step 5: write title and body to temp files.**

Run `mktemp -d` and capture the path it prints to stdout (something like `/tmp/tmp.AbCdEf`). Shell state does not persist between Bash tool calls, so record the exact path from the output before using the Write tool.

Use the Write tool to create two files inside that directory:
- `/tmp/tmp.AbCdEf/title` — the cleaned issue title (single line, no markdown formatting).
- `/tmp/tmp.AbCdEf/body.md` — the cleaned issue body markdown.

**Step 6: run the script.**

Substitute the same path from step 5 and append the `labels` from the Step 1 `classify` output as trailing arguments. Do NOT include `hermit-filed` — the script always adds it.

```bash
bun "${CLAUDE_SKILL_DIR}/file-issue.ts" --publish \
  /tmp/tmp.AbCdEf/title /tmp/tmp.AbCdEf/body.md <type-label> [<scope-label>]
```

For example, a `capability` proposal scoped to `homeassistant-hermit`:
```bash
bun "${CLAUDE_SKILL_DIR}/file-issue.ts" --publish \
  /tmp/tmp.AbCdEf/title /tmp/tmp.AbCdEf/body.md enhancement homeassistant-hermit
```

For an ad-hoc issue (no proposal), omit the label args entirely:
```bash
bun "${CLAUDE_SKILL_DIR}/file-issue.ts" --publish /tmp/tmp.AbCdEf/title /tmp/tmp.AbCdEf/body.md
```

Capture stdout: it is the issue URL on success. Stderr has any error message.

**Step 7: back-write and report.**

On success:
1. Use the Edit tool to insert `gh_issue: {url}` into the proposal's YAML frontmatter, on a new line directly after the `id:` field. Skip this step for ad-hoc issues (no proposal file).
2. Output `Filed: {url}`.

On error, surface the stderr. Common causes:
- `HERMIT_GH_APP_KEY_FILE='...' does not exist` → key file path is wrong or file is missing — check `.env`.
- `GH 401: Bad credentials` → wrong App ID, install ID, or key file.
- `GH 404` → App not installed on target repo, or repo name typo.
- `GH 422` → empty title or GH validation error.
- `GitHub returned no html_url (check HERMIT_GH_REPO)` → nothing was filed; `HERMIT_GH_REPO` likely names a renamed repository. Update it to the current `owner/repo`.

## How to comment

**Step 1: resolve content.**

Use the body the operator provides verbatim. No proposal lookup, no CC title construction, no frontmatter fields.

**Step 1b: language normalization.**

Same rules as filing — translate prose to English, preserve identifiers/code/paths/proper nouns unchanged.

**Step 2: sanitize.**

Pass the draft body to the `hermitd-scribe:issue-sanitizer` subagent with a placeholder title:

```
DRAFT_TITLE: (issue comment)
DRAFT_BODY:
{draft body}
```

Parse the response as usual (split on `<<<HERMIT_SCRIBE_BODY>>>`). Use only the cleaned body; discard the returned title.

**Step 3: operator preview.**

Present the post-sanitization content as a **single message** containing, in order:
1. Target: `Issue #NNN`
2. Complete comment body — everything that will be posted

If the preview exceeds the channel message-size limit, split it into multiple messages and finish displaying all content before invoking publication.

If the operator requests edits, regenerate and show the complete preview before another publishing attempt.

**Step 4: write body to temp file.**

Run `mktemp -d` and capture the path. Use the Write tool to create:
- `/tmp/tmp.AbCdEf/body.md` — the cleaned comment body.

**Step 5: run the script.**

```bash
bun "${CLAUDE_SKILL_DIR}/file-issue.ts" --comment {issue-number} /tmp/tmp.AbCdEf/body.md
```

Capture stdout: it is the comment URL on success. Stderr has any error message.

**Step 6: report.**

On success: output `Commented: {url}`. No back-write to any proposal frontmatter.

On error, surface the stderr (same causes as filing: missing key file, bad credentials, 404, 422, no html_url).

## Notes

- `HERMIT_GH_REPO` overrides the default target (`gtapps/hermitd`).
- If the operator overrides the dedup check and re-files the same proposal, `gh_issue` in the frontmatter is overwritten with the new URL (latest wins).
- Comments skip the dedup check by design — there is no uniqueness constraint on comments.
- The `issue-sanitizer` subagent strips anything personal or specific to the operator's machine and project unless it's clearly part of an upstream hermit plugin. It does not edit for style or clarity — only for privacy.
