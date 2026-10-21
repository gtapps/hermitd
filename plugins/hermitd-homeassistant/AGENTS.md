# Home Assistant Hermit

Domain skills use the Home Assistant MCP server for live operations and `bin/ha-agent-lab` for bulk analysis, YAML, and structural operations. The TypeScript CLI and hooks share `src/policy.ts`.

## Safety boundaries

- Preserve `ha_safety_mode`: an absent key in valid config means ask; unreadable or malformed config stays strict. Sensitive actuation and structural mutations are blocked under strict; ask mode requests native approval. Unresolvable or malformed targeting stays blocked in both modes. Blocked work becomes a proposal.
- Keep the MCP server name `homeassistant`; `hooks/hooks.json` matches the entire `mcp__homeassistant__.*` namespace and the gate explicitly allows read-only tools. Internal gate errors must fail closed.
- `Hass*` intent tools have a deliberate opt-in: `ha_assist_control_enabled` delegates opaque target resolution to HA's expose-to-Assist boundary. Preserve the exact carve-out in `hooks/mcp-safety-gate.ts` rather than treating every unresolved call as equivalent.
- `gateServiceCall` is per entity/service; `gateStructuralMutation` governs structural writes. Do not replace either with the other. Non-sensitive maintenance calls remain usable.
- `update.*` has its own gate: `ha_update_auto_apply` plus per-call native approval, without bypassing sensitive-entity checks. The higher-level Core/OS/Supervisor approval rule lives in `skills/ha-apply-update/SKILL.md`.
- Use `bin/ha-agent-lab boot status` to check credential state. Never dump HA tokens, URLs, or a real device inventory into repository fixtures or diagnostics.
- Use the hermit's `language` for replies. Write automation `alias` and `description` in that language unless an AGENTS file instruction names another. Auto-memory holds Claude-derived house knowledge.

Read [SAFETY.md](SAFETY.md) before changing these gates. `src/cli.ts` and `bin/ha-agent-lab --help` own the command surface; [the CLI reference](docs/cli-reference.md) gives usage examples. Preserve raw-text response handling through `postText()`/`getText()` in `src/ha-api.ts` and the push/read-back/reload distinction in `src/apply.ts`.

## Verification

The plugin suite needs full Git history and Python with `python-dotenv` and `PyYAML` for test fixtures, although shipped code is TypeScript. Set `GATE_PARITY_PYTHON` when that interpreter is outside PATH. Install both packages for `python3` itself: the suite's `uv` fallback cannot run inside an executor sandbox when `uv` is a snap (`snap-confine` needs privileges the sandbox drops), which shows up as "No Python with python-dotenv + PyYAML found". The setup is recorded in the repository's `.github/workflows/test-ha.yml`.

Changes to `src/policy.ts` or `hooks/mcp-safety-gate.ts` must preserve the corpus/golden behavior in `tests/gate-corpus.test.ts` and the fail-closed properties in `tests/gate-fuzz.test.ts`. Keep YAML parity and apply-result verification intact; a successful tool call alone is not proof that the intended automation was installed.

When using `tmpPath()` from `tests/helpers.ts`, register `afterAll(cleanupTmp)`. Cleanup after each test can delete fixtures still used by concurrent tests. Keep independent corpus and fuzz subprocess work asynchronous.
