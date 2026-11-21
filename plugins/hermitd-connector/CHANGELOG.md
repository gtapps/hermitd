# Changelog

## [0.0.3] - 2026-11-21

### Changed
- Improved setup: the README is a runbook an agent can follow end to end, with a new `docs/setup.md` guide for pairing and for several agents on one host

### Upgrade Instructions

Run `/hermitd:hermit-evolve`. The evolve skill handles:

1. **Confirm the connector is at 0.0.3** — no files to migrate.

No `config.json` changes required.

## [0.0.2] - 2026-11-20

### Changed
- Channel instructions name the person's AI app instead of the Claude app

### Upgrade Instructions

Run `/hermitd:hermit-evolve`. The evolve skill handles:

1. **Confirm the connector is at 0.0.2** — no files to migrate.

**Operator action required:** `.hermit/bin/hermitd-docker restart` (or `hermitd-stop && hermitd-start`).

No `config.json` changes required.

## [0.0.1] - 2026-11-18

### Added
- Channel that delivers messages from paired people in their Claude app to the agent, with a `reply` tool back to them
