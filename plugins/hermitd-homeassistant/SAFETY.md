# Safety Policy

This plugin controls real home devices. The safety model is layered — the agent's instructions keep it cautious, and a hook enforces the rules even if the agent tries to bypass them.

## How Actuation Is Gated

Every MCP call matching `mcp__homeassistant__.*` is pre-screened by `hooks/mcp-safety-gate.ts` (importing the policy from `src/policy.ts` directly) before it reaches Home Assistant. The matcher covers the **whole** `homeassistant` server namespace — a default-deny chokepoint — so script-derived and any other non-`Hass`-prefixed actuation tools cannot bypass the gate. The hook fails closed — if the policy check errors, the input can't be parsed, or the target can't be resolved to a concrete entity, the call is blocked (exit 2).

A small explicit allowlist of **read-only** tools (`GetLiveContext`, `GetDateTime`, and their HA 2026.9+ prefixed forms `homeassistant__GetLiveContext`, `llm__GetDateTime`; see `READ_ONLY_TOOLS` in `src/policy.ts`) is short-circuited to allow before entity resolution, since they carry no `entity_id` and would otherwise fail closed. The allowlist is an explicit name set, not a pattern, so a future mutating tool cannot be granted by accident.

## What's Blocked by Default

- **Sensitive domains**: `lock`, `alarm_control_panel`
- **Extra sensitive domains**: any domain listed in `HA_EXTRA_SENSITIVE_DOMAINS` (see [Policy Overrides](#policy-overrides))
- **Unresolvable targets**: any call carrying an `area_id`/`floor_id`/`label_id`/`device_id` selector that does not resolve to a concrete, well-formed `entity_id` — blocked even when a safe concrete `entity_id` is also present (the selector fans out server-side to entities the gate cannot enumerate). Domain matching is case-insensitive (`LOCK.front_door` is treated as `lock`); malformed ids with an empty domain (e.g. `.lock`) are rejected as unresolvable.
- **Opaque (script-derived) tools**: a call that carries no `entity_id` and no targeting selector — the canonical case is an exposed HA script, which has no classifiable target. Blocked under `strict` (becomes a proposal); under `ask`, the operator is prompted. (An unnamed/garbage call with no `tool_name` always hard-blocks. A `Hass*` intent tool that targets by `name`/`area` hard-blocks unless `ha_assist_control_enabled: true` is set — see [Assist Control](#assist-control) below.)
- **Anything explicitly listed** in `HA_EXTRA_SENSITIVE_DOMAINS` (block)

Blocked operations do not silently fail — they become proposals for human review.

## Safety Mode

The safety gate has a two-tier configurable mode stored in `.hermit/config.json` under `ha_safety_mode`. Set during `/hermitd-homeassistant:hatch` and adjustable afterwards.

| Mode | Behaviour |
|------|-----------|
| `strict` | Always blocked, no agent-drafted automation or MCP call can actuate sensitive domains. Blocked work becomes a proposal. |
| `ask` (default) | Sensitive actuation requires native approval. YAML and CLI workflows show a preview before execution. |

Claude Code requests native approval before guarded commands run. Direct CLI execution outside Claude Code has no confirmation-only checkpoint. CLI validation and policy denials still apply.

The mode dial does **not** relax the hard fail-closed branch: an unresolvable `area_id`/`floor_id`/`label_id`/`device_id` fan-out, a malformed `entity_id`, or an unnamed/garbage call all still block regardless of mode. `Hass*` intent tools that target by `name`/`area` also hard-block unless `ha_assist_control_enabled: true` is set (see below). The one mode-dependent case is an **opaque named script tool** (a bare-`object_id` call with no concrete target and no fan-out selector): `strict` blocks it, `ask` prompts the operator — same as it does for a concrete sensitive entity. The `HA_SAFE_ENTITIES` per-entity allowlist still takes precedence over both modes — a listed entity is always allowed.

### Channel actuation

In always-on and channel sessions, runtime device control goes through HA Assist intent tools (`HassTurnOn`, `HassLightSet`, etc.) via MCP — requires `ha_assist_control_enabled: true` and each device exposed in HA (Settings → Voice assistants → Expose). The safety gate passes these through when the opt-in is set; HA's own exposure list is the control boundary.

Native approval is handled by Claude Code and its configured permission relay. If no approval surface is available, do not execute through another route. Explicit project ask rules and hook asks supply the checkpoint; permission mode alone does not.

Change the mode by editing `ha_safety_mode` in `.hermit/config.json` or re-running `/hermitd-homeassistant:hatch`.

## Assist Control

By default HA Assist intent tools (`Hass*` — `HassTurnOn`, `HassLightSet`, `HassSetPosition`, `HassFanSetSpeed`, etc.) are hard-blocked: they carry a `name`/`area` target that the gate cannot enumerate, so the gate cannot guarantee the fan-out set is safe.

When you set `ha_assist_control_enabled: true` in `.hermit/config.json` (via `/hermitd-homeassistant:hatch` Step 7.55), the gate defers to HA's own **expose-to-Assist** boundary instead of blocking. HA only routes intent calls to entities the operator has explicitly exposed in Settings → Voice assistants → Expose — locks and alarms you haven't exposed are unreachable by these tools regardless of plugin safety mode.

**Prerequisites before enabling:**
- HA MCP Server integration must have control tools enabled (not just read-only mode).
- Each device you want the agent to control must be exposed in HA.

**Trade-off accepted:** the fail-closed *enumeration* guarantee is traded for trust in the HA exposure list. The per-entity `HA_SAFE_ENTITIES` / `HA_EXTRA_SENSITIVE_DOMAINS` overrides still apply to concrete `entity_id`-based calls (those resolve and are checked normally); Assist intent calls bypass enumeration entirely and rely on HA's exposure gate.

## Update Installation

`ha call-service update.install` is not gated by `ha_safety_mode` at all — it has its own carve-out in `gateServiceCall`, deliberately decoupled from the mode dial:

- **`ha_update_auto_apply` unset or `false` (default)**: any `update.*` call with no other sensitive entity riding along is **blocked outright**, in both `strict` and `ask`. Surface it as a proposal (this is what `/hermitd-homeassistant:ha-update-check` does daily).
- **`ha_update_auto_apply: true`**: eligible updates request native approval on every invocation, independent of `ha_safety_mode`.
- A call that also references a genuinely sensitive entity (`lock`, `alarm_control_panel`) is unaffected by this carve-out and still hard-blocks under `strict` via the normal path.

**Tier rule, enforced by `/hermitd-homeassistant:ha-apply-update`, not by the policy layer:** even with the flag on, add-on and HACS updates may auto-apply (HA backs them up first); Core, OS, and Supervisor updates require a preview followed by native operator approval, because a bad Core update can cut off dashboard access with no software undo, a backup alone isn't a sufficient safety net for that failure mode.

## Policy Overrides

Configured via environment variables in `.env`:

| Variable                      | Effect                                                     |
| ----------------------------- | ---------------------------------------------------------- |
| `HA_SAFE_ENTITIES`            | Per-entity allow-list. Exact IDs only, no wildcards.       |
| `HA_EXTRA_SENSITIVE_DOMAINS`  | Block additional domains entirely.                         |

Example:

```
HA_SAFE_ENTITIES=cover.garage_door,switch.coffee_machine
HA_EXTRA_SENSITIVE_DOMAINS=vacuum,media_player
```

## Checking a Target

Before wiring anything to the policy, you can ask what it would decide:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha policy-check <entity_id_or_yaml>
```

## Reviewing Live Automations

The `ha-safety-audit` routine runs weekly and re-audits every live automation against the current policy. Findings surface as proposals.

Run on demand:

```
/hermitd-homeassistant:ha-safety-audit
```

## Changing the Policy

Policy source of truth is `src/policy.ts`, enforced at the harness level by `hooks/mcp-safety-gate.ts`. Changes to either file are considered sensitive — review carefully and run the test suite before shipping:

```bash
bun test
```

`tests/gate-corpus.test.ts` replays the retired Python gates (from git history) side by side with the TS hooks and asserts byte-identical verdicts; `tests/gate-fuzz.test.ts` property-tests the fail-closed guarantee on arbitrary garbage input. Both must stay green for any hook or policy change.

When in doubt the hook fails closed. You can always relax the policy, but you have to do it deliberately.

## Hook Profile Gating

`hooks/mcp-safety-gate.ts` runs on **all profiles** by design — actuation gating is non-optional and must hold even in `lite` and `default` profiles where the operator may have loosened other controls.

`hooks/curl-host-gate.ts` (convenience auto-approver for curl/wget to the HA instance) is gated to `standard,strict` profiles. In `lite` profile it does not run, so HA URL calls go through the normal permission flow instead of being auto-approved.
