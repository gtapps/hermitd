# ha-agent-lab CLI reference

Core commands for `${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab`; run `ha-agent-lab --help` for the complete, current surface (`src/cli.ts` is the source of truth; the plugin `CLAUDE.md` carries the full catalog). Structural writes (helpers/areas/registries) are gated by `ha_safety_mode` (strict → proposal, ask → native approval).

```
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha refresh-context [--incremental]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha simulate <artifact>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha validate-apply <artifact> [--reload automation|script|scene]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha policy-check <entity_id_or_yaml>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha audit-automations
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha audit-scripts
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-automations
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-scripts
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha delete-automation <id>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha delete-script <id>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha get-automation-config <id>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha get-script-config <id>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha integration-health
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha fetch-history [--window-days N] [--entities <glob> …] [--include-transitions]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha probe <path>
# WebSocket structural commands (helpers/areas/registries); writes gated by ha_safety_mode (strict→proposal, ask→native approval)
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-helpers [--type <helper_type>]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha create-helper <type> <json>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha delete-helper <type> <id>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-areas
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha create-area <name>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha delete-area <id>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-entities --registry
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha rename-entity <entity_id> --name <name>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha set-entity-area <entity_id> --area <area_id>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha set-entity-enabled <entity_id> --enabled true|false
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha list-devices
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha set-device-area <device_id> --area <area_id>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab ha rename-device <device_id> --name <name>
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot status [--probe]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot store --language <locale> --url <url> [--token <token>]
${CLAUDE_PLUGIN_ROOT}/bin/ha-agent-lab boot mcp-config   # hatch: write the homeassistant entry into .mcp.json from .env
```

The full current surface (dashboards, backups, blueprints, energy prefs, floors/labels, call-service, etc.) is larger — see `src/cli.ts` or `ha-agent-lab --help`.
