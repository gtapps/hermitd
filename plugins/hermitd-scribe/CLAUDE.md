# hermit-scribe

A maintainer utility skill that files GitHub issues and comments through a configured GitHub App bot identity. No server, no build, Node stdlib APIs only, run with Bun. A Claude Code plugin, not a standalone project: install from the marketplace (README) into a project where core is already hatched.

## Structure

- `skills/hermit-scribe/SKILL.md`: the skill (`/hermitd-scribe:hermit-scribe`): prepare content, run the sanitizer, show the final content, get operator approval, then publish. A clean sanitizer pass never authorizes posting on its own.
- `agents/issue-sanitizer.md`: strips anything personal or specific to the operator's machine and project unless it is clearly part of an upstream hermit plugin. It has no tools: pass it the draft text itself, never a path or an identifier.
- `skills/hermit-scribe/file-issue.ts`: signs the App JWT, gets an installation token, and files or comments. Filing is `--publish <title-file> <body-file> [label...]`; the `hermit-filed` label is always present and extra labels append to it. Also `--check <proposal-id>` (dedup lookup), `--comment <issue-number> <body-file>`, `--templates` (issue-template filenames from the target repo via the API), and `classify <category> <title-file> <body-file>` (Conventional-Commits `{type, scope, labels, title_line}`, scope resolved against `_hermit_versions` in `.hermit/config.json`). Exports `{ buildLabels, deriveType, resolveScope, deriveLabels, buildTitleLine }` for unit tests. Title and body are read from files; nothing is interpolated into a shell command.
- `skills/hatch/SKILL.md`: version-gated setup/refresh: appends or replaces the marked Issue Filing block from `state-templates/CLAUDE-APPEND.md`, stamps `_hermit_versions["hermitd-scribe"]` in `config.json`.

## Configuration

`HERMIT_GH_APP_ID`, `HERMIT_GH_APP_INSTALL_ID`, `HERMIT_GH_APP_KEY_FILE`, and the optional `HERMIT_GH_REPO` override (default `gtapps/hermitd`) are described in `README.md` § Env vars; they come from the project `.env` (Docker `env_file:`) or the `env` block of `.claude/settings.local.json`. The private key lives at `.claude.local/hermit-scribe-key.pem` (gitignored), outside the plugin tree. The script targets the configured repo with the bot identity, never the maintainer's ambient `gh` login.

## Development

- No npm dependencies, ever: only the Node stdlib APIs Bun provides (`node:crypto`, `node:fs`) and the global `fetch` (which honours `HTTPS_PROXY`/`NO_PROXY`; `node:https` does not). No `package.json`, no `node_modules`.
- Tests: `bash tests/run-all.sh` from this directory. Manual smoke checks: `README.md` § Development.
- Local run against a target project: from the repo root, `bun run dev <target-project>`, hatch core, then `/hermitd-scribe:hatch`.

Keep the `--publish` and `--comment` verbs aligned with the rules in `state-templates/native-permissions.json`, installed into project settings by `scripts/native-permissions.ts`.
