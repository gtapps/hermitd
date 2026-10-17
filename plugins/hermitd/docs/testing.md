# Testing

## Running Tests

```bash
bun test
```

This runs all test suites — hook tests, contract tests, and frontmatter validation.

For a focused feedback loop, pass a test file and optionally `-t 'test name'`.
Bun 1.4 also supports isolated file workers and per-file timing reports:

```bash
bun test tests/lockfile.test.ts
bun test --parallel=2 --timings=/tmp/hermit-core-test-timings.json --update-timings
```

The timing file records file durations and lets subsequent runs schedule slow
files first. Keep worker counts bounded when other suites are running: each
worker can also run concurrent subprocess tests. From the repository root,
`bun run test` handles the combined plugin run and shared root guards.

Keep process-boundary assertions in subprocesses. Independent subprocess work
should use asynchronous spawning and drain stdout/stderr while awaiting exit.
For contention tests, release holders after all contenders report instead of
sleeping for an assumed scheduling window.

---

## Test Structure

Tests live in `tests/`:

- `bun test` from the plugin dir runs every `tests/*.test.ts` suite
- `fixtures/` — input files for hook tests

### Fixture Files

| File                   | Used by                                     | Format                                                                            |
| ---------------------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| `stop-hook-input.json` | cost-tracker | JSON with `session_id`, `model`, `input_tokens`, `output_tokens` |

---

## Running Hooks Manually

Each hook can be tested in isolation. Stop hooks expect JSON on stdin:

```bash
# cost-tracker (Stop hook — always runs)
cat tests/fixtures/stop-hook-input.json | bun scripts/cost-tracker.ts

# check-upgrade (run by the SessionStart hook) — three outcomes, driven by the stamp in
# .hermit/config.json vs the plugin.json at the root you pass:
#   stamp older  -> {"status":"upgrade_available",...}     (run hermit-evolve)
#   stamp equal  -> OK
#   stamp newer  -> {"status":"stale_plugin_runtime",...}  (a stale install copy is
#                                                           loaded; evolve cannot fix it)
# An unparseable version on either side prints OK.
bash scripts/check-upgrade.sh .
```

For record fixtures, use `tests/helpers/tasks.ts`.

---

## Writing New Tests

When adding or modifying a hook:

1. **Happy-path test** — add a fixture input and assert exit 0 in `hooks.contract.test.ts`
2. **Empty-stdin test** — verify `echo '' | bun scripts/your-hook.ts` exits 0 without crashing
3. **Output validation** — if the hook writes files, assert they exist and contain valid data

### Hook Contract

All hooks follow this contract:

| Property           | Rule                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **Stdin**          | Stop hooks receive JSON. SessionStart hooks receive no stdin.                                                        |
| **Exit code**      | Always 0 on error. Non-zero only for genuine assertion failures.                                                     |
| **Profile gating** | Check `AGENT_HOOK_PROFILE` internally. Valid profiles: `minimal`, `standard`, `strict`. |
| **File paths**     | Resolved relative to cwd (the target project root).                                                                  |

### Test Framework

Hook contract tests live in `tests/hooks.contract.test.ts` and run with `bun test` (no extra dependencies — `bun:test` is built in). All other suites are also `bun test` — no shell harnesses, no Python, no Jest, no Vitest. See [Contributing](../../../CONTRIBUTING.md).

---

## Contract Tests (tests/contracts.test.ts + tests/hermitd-start.test.ts)

```bash
bun test tests/contracts.test.ts tests/hermitd-start.test.ts
```

Runs 20+ contract tests that verify:

- Plugin manifest integrity (`plugin.json` fields, skill/hook references)
- Hook script exit codes and stdin contracts
- State file ownership constraints
- Profile-gating correctness

These are stricter than `hooks.contract.test.ts` — they test the plugin's behavioral contracts, not just exit codes.

### Fixture: cron-test-corpus.json

`tests/cron-test-corpus.json` is a shared fixture used by contract tests that validate cron expression parsing. It contains time/schedule pairs with expected fire/skip decisions. Add entries when fixing schedule edge cases.
