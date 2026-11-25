# Review instructions

## What Important means here

Reserve Important for:

- A real bug: wrong behavior an operator or a running agent would hit.
- A broken hook or exit-code contract: a hook that no longer fails open on transient errors, no longer reads stdin to completion, or changes its documented denial behavior; a helper script that exits 1 for an expected outcome or breaks its JSON output shape.
- A permission or credential leak: a weakened deny rule or allow-list, a script path that escapes `scripts/`, or a secret, token, Claude Code session link, or session content written to a tracked file, log, or published surface.
- A change that must reach existing agents' installed state (a changed default for an existing `config.json` key, new `routines[]` entries, renamed or removed state files, new deny or ask rules in the agent's settings file) with no matching step under `### Upgrade Instructions` in that plugin's `CHANGELOG.md`. `hermit-evolve` already adds new config keys from the template and refreshes unmodified state templates and `bin/` wrappers, so those need no step; neither do plugin-side-only changes, which ship with the release.

Everything else is a Nit at most.

## Cap the nits

Report at most five Nits per review.

## Do not report

- Lockfiles (`bun.lock`), anything under `graphify-out/`, and test fixtures (any `fixtures/` or `_fixtures/` folder).
- What CI already enforces: `bunx tsc` type errors and test failures.

## Always check

- A change to shipped plugin behavior adds a bullet under `[Unreleased]` in that plugin's `CHANGELOG.md`, in the terse style: `### Added / Changed / Fixed`, plain sentence-case bullets with no leading verb or component prefix. Docs-only, test-only and root-scope changes get no bullet.
- PRs never release: no `version` bump in `plugin.json` or `marketplace.json`, no promotion of `[Unreleased]` to a version header, no tag. The exception is a release branch opened by `/release`.
- When the diff touches `README.md` at the root or `plugins/hermitd/README.md`, the same content change appears in the other, with links adjusted for the folder.
- No em dash characters (U+2014), `PROP-NNN` proposal ids, or Claude Code session or share links in added text or the PR description.
- Text an operator reads (notices, chat replies, skill output shown to the operator, CHANGELOG operator notes and `**Operator action required:**` lines) says "agent", never "hermit". Identifiers such as `hermit-evolve`, `.hermit/` and plugin slugs, and model-facing skill prose, are exempt.
- Shipped plugin code imports only the standard library and Bun built-ins (`Bun.*`, `bun:*`, `node:*`); `node_modules` imports are allowed only in `*.test.ts`. Type-only imports from the Claude Code mod host (`claude-code`) under `plugins/hermitd/mod/` are exempt.
- Core (`plugins/hermitd/`) never imports a sibling plugin, hardcodes a sibling slug in logic, or branches on one being installed. Naming a sibling as an example in a comment or doc is fine.
