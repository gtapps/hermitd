<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-orange.svg" alt="Claude Code Plugin" /></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.1.8-green.svg" alt="Version 0.1.8" /></a>
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome" />
</p>

# hermitd-scribe

Files GitHub issues via a configured GitHub App so they're attributed to a bot identity rather than a personal account. Pure Node stdlib APIs run with Bun; no dependencies, no build step. Maintainer tool.

## Install

Requires `hermitd` ≥1.2.34. Before installing or running hermit-scribe 0.1.1, upgrade core with `/hermitd:hermit-evolve`.

```bash
claude plugin marketplace add gtapps/hermitd
claude plugin install hermitd-scribe@hermitd --scope local
```

## GitHub App setup

The plugin requires a GitHub App with `Issues: Read & write` permission installed on the target repo.

1. **GitHub Settings → Developer settings → GitHub Apps → New GitHub App.**
2. Name the App (this name becomes the bot identity on filed issues). Set Homepage URL to anything; disable Webhook.
3. **Permissions → Repository permissions → Issues**: `Read & write`.
4. **Create GitHub App.** Note the **App ID** on the settings page.
5. **Private keys → Generate a private key.** Save the `.pem`.
6. **Install App**, choose account/org, select target repo(s).
7. The installation URL is `github.com/settings/installations/{INSTALL_ID}`. Note the ID.

Store the key in a gitignored location:

```bash
mv ~/Downloads/<your-app>.*.pem .claude.local/hermit-scribe-key.pem
```

## Env vars

| Var | Description |
|-----|-------------|
| `HERMIT_GH_APP_ID` | App ID from the App's settings page |
| `HERMIT_GH_APP_INSTALL_ID` | Install ID from the installation URL |
| `HERMIT_GH_APP_KEY_FILE` | Absolute path to the `.pem` private key |
| `HERMIT_GH_REPO` | Optional. Target `owner/repo`. Default: `gtapps/hermitd` |

Set them in your project `.env` (loaded by Docker hermit via `env_file:`) or in `.claude/settings.local.json` `env` block for interactive sessions.

## Setup

Run `/hermitd-scribe:hatch` after configuring the env vars above. It appends or version-refreshes the Issue Filing block in your `CLAUDE.md`/`CLAUDE.local.md` and stamps `_hermit_versions["hermitd-scribe"]` in `.hermit/config.json`. Re-run hatch after an upgrade to refresh the block.

## Usage

Trigger phrases:

- `file PROP-007 as a GH issue`
- `open an issue for PROP-012`
- `report this to the tracker`
- `file a GH issue for [description]`

For proposal-backed issues: the skill globs `.hermit/proposals/PROP-NNN-*.md`, reads frontmatter (`id`, `title`, `category`, `session`) and the `## Context` / `## Problem` / `## Proposed Solution` / `## Impact` body sections, then builds a Conventional Commits title (`<type>(<scope>): <title>`, e.g. `feat(homeassistant): integrate HA History API`). Type is derived from `category` (`bug` → `fix`, `infrastructure`/`investigation` → `chore`, otherwise → `feat`); the recognized scope vocabulary is derived from the keys of `_hermit_versions` in `.hermit/config.json`, scanned against explicit mentions in the proposal text first (`plugins/<slug>/` paths or whole-word slug occurrences), falling back to the lone activated fleet hermit when no explicit target appears, with the `hermitd-` prefix stripped. Scope is omitted when signals are absent or ambiguous. The body is translated to English at the GitHub boundary (technical identifiers, code, and frontmatter are preserved verbatim); a `Filed via hermit-scribe · proposal={id} · session={session}` footer is appended after sanitization.

For ad-hoc issues: supply title and body directly. The operator's title is passed through verbatim (no CC enforcement); translation and sanitization still apply.

All issues get the `hermit-filed` label. Proposal-backed issues also receive a type label derived from `category` (`bug` → `bug`; `infrastructure`/`investigation` → `chore`; otherwise `enhancement`) and, when a single plugin scope was resolved, a scope label matching the stripped slug (e.g. `homeassistant`). These labels must already exist on the target repo — unknown ones are silently dropped or auto-created by GitHub, so filing never errors on a missing label.

### Dedup

Before filing, the skill runs `--check {id}` automatically. If a matching issue already exists (matched by `proposal={id}` in the footer), the skill shows the existing URL and asks whether to skip or proceed. Re-filing after overriding writes the new URL into the proposal's `gh_issue:` field (latest wins). The footer is appended once sanitization is done, since the sanitizer would otherwise redact the proposal id as operator-project detail and break this match.

### Privacy sanitization

Before showing the preview, the skill passes the draft through the `issue-sanitizer` subagent. It strips anything personal or specific to the operator's machine and project unless it's clearly part of an upstream hermit plugin (`hermitd`, `hermitd-dev`, `hermitd-homeassistant`, `hermitd-fitness`, `hermitd-scribe`) or the hermit state tree (`.hermit/...`). Secrets, `.env` content, connection strings, internal hostnames/IPs, and non-public URLs are always stripped even when they look technical. Stripped content is replaced with `<redacted>`.

The operator can un-redact specific items during the preview step if a particular value is load-bearing for the issue.

### Operator preview

The cleaned title and body are shown to the operator before filing as a single message (body fully inlined, confirmation prompt last). The operator can confirm, edit (iterative — re-previews until satisfied), or cancel. If the target repo defines issue templates under `.github/ISSUE_TEMPLATE/`, the preview adds an informational note naming them — the body doesn't conform to them automatically; use `edit` if that matters for the target repo.

## Errors

| Error | Cause |
|-------|-------|
| `HERMIT_GH_APP_KEY_FILE='...' does not exist` | Key file path wrong or missing — check `.env` |
| `GH 401: Bad credentials` | Wrong App ID, install ID, or key file |
| `GH 404` | App not installed on target repo, or repo name typo |
| `GH 422` | Empty title or GitHub validation error |
| `HERMIT_GH_REPO must be "owner/repo"` | Malformed repo path (more than one `/`) |

## Safety

- `*.pem` is gitignored. Private key never committed.
- Key is read at runtime; never appears in session files, proposals, or memory.
- Missing env vars produce a clear error and non-zero exit. No silent no-ops.
- **Sandbox**: `file-issue.ts` makes two HTTPS calls to `api.github.com`. The hermit's standard sandbox profile has unrestricted network; custom profiles that restrict outbound HTTPS need to allow `api.github.com`. The script honours `HTTPS_PROXY` and `NO_PROXY`, so it also works on hosts whose only egress is a proxy.

## Architecture

```
hermitd-scribe/
  ├── agents/
  │     └── issue-sanitizer.md  redacts non-hermit content from draft body
  ├── scripts/
  ├── skills/hatch/
  │     └── SKILL.md            version-gated setup/refresh: block + version stamp
  └── skills/hermit-scribe/
        ├── SKILL.md            trigger phrases + filing flow
        └── file-issue.ts       stdlib: JWT → install token → POST /issues; --check flag
```

`file-issue.ts` is a single-shot script run with Bun: signs an RS256 JWT from the App private key, exchanges it for an installation access token at `POST /app/installations/{id}/access_tokens`, then `POST /repos/{owner}/{repo}/issues` with the derived label set (`hermit-filed` always, plus any extra labels passed as trailing positional args). Two HTTPS round-trips per invocation. Bun is required (Claude Code already provides it).

## Development

Manual smoke checks (no network needed; both should fail cleanly on the missing key, not crash):

```bash
# Missing key file: exits non-zero with a clear error
HERMIT_GH_APP_ID=1 HERMIT_GH_APP_INSTALL_ID=2 HERMIT_GH_APP_KEY_FILE=/nonexistent \
  bun "$CLAUDE_PLUGIN_ROOT/skills/hermit-scribe/file-issue.ts" --publish /dev/null /dev/null

# Extra label args parse cleanly and reach token acquisition
TMP_DIR="$(mktemp -d)" && (
  trap 'rm -r "$TMP_DIR"' EXIT
  printf 't\n' > "$TMP_DIR/t" && printf 'b\n' > "$TMP_DIR/b.md" && \
  HERMIT_GH_APP_ID=1 HERMIT_GH_APP_INSTALL_ID=2 HERMIT_GH_APP_KEY_FILE=/nonexistent \
    bun "$CLAUDE_PLUGIN_ROOT/skills/hermit-scribe/file-issue.ts" --publish \
    "$TMP_DIR/t" "$TMP_DIR/b.md" enhancement homeassistant-hermit
)
```

The script takes two positional file paths: title file (single line, trimmed) and body file (markdown). Both are read directly; nothing is interpolated into shell commands. Unit tests: `bash tests/run-all.sh` from the plugin directory.

## License

[MIT](LICENSE)
