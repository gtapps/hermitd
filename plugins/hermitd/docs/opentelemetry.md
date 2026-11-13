# OpenTelemetry

Claude Code can export each prompt, model request, and tool call through [OpenTelemetry](https://code.claude.com/docs/en/monitoring-usage). Hermit does not record that trail itself. You point the resident at a collector you run. Event names, attributes, exporter settings, and example collectors are on that page. This page covers how a resident is launched, and how the export sits next to hermit's own logs.

Anthropic's operational telemetry is a separate switch. See [Data usage](https://code.claude.com/docs/en/data-usage).

## What hermit already records

| Record | What it is for |
| --- | --- |
| [`telemetry_export`](config-reference.md#telemetry_export) | A periodic health and cost bundle posted to a webhook you choose. Counts and statuses. Off until you enable it. |
| Cost log and [`state/cost-index.json`](config-reference.md#budget) | Spend for budgets and reports. |
| [`state/channel-log.sqlite`](security.md) | Channel messages, kept on the machine. |
| [Task records](task-records.md) | The work you and the agent agreed to do. |

Those records stay on the machine. `telemetry_export` is the exception: it sends the health bundle to your webhook. OpenTelemetry is the per-step export to a collector. The session transcript stays on disk with Claude Code either way.

## Turn it on

Add the variables to `env` in `.hermit/config.json`, then restart with `hermitd stop` and `hermitd start`. Claude Code reads them at startup, so a running resident keeps the old values until then.

```json
"env": {
  "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
  "OTEL_METRICS_EXPORTER": "otlp",
  "OTEL_LOGS_EXPORTER": "otlp",
  "OTEL_EXPORTER_OTLP_PROTOCOL": "http/protobuf",
  "OTEL_EXPORTER_OTLP_ENDPOINT": "https://collector.example.com:4318"
}
```

`CLAUDE_CODE_ENABLE_TELEMETRY=1` is required. Set an exporter to `otlp` for each signal you want. For an `http://` or `https://` endpoint the protocol defaults to `http/protobuf`. For a gRPC endpoint such as `http://localhost:4317`, set `OTEL_EXPORTER_OTLP_PROTOCOL` to `grpc`. The full variable list, including per-signal endpoints and headers, is in the [monitoring configuration table](https://code.claude.com/docs/en/monitoring-usage#common-configuration-variables).

Beta traces add one span per interaction, model request, tool call, and hook. Set both of these as well:

```json
"CLAUDE_CODE_ENHANCED_TELEMETRY_BETA": "1",
"OTEL_TRACES_EXPORTER": "otlp"
```

Span names and attributes are under [Traces (beta)](https://code.claude.com/docs/en/monitoring-usage#traces-beta). A resident is an interactive session, so it does not adopt a `TRACEPARENT` value inherited from the container.

### Where the values have to live

`hermitd-start` starts Claude Code inside tmux, and that shell does not inherit the parent environment. It forwards the names listed in `config.env`. A variable set only on the Docker Compose `environment` list, or only in the project `.env`, never reaches the resident.

When the same name is already set in the environment that runs `hermitd-start`, that value wins over `config.json`. Use that for the collector credential. Put the name in `config.env` and the secret in the project `.env` (Docker applies `env_file: .env` to the container) or in the shell you use to run `hermitd start`.

```json
"OTEL_EXPORTER_OTLP_HEADERS": ""
```

```
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer your-token
```

The value that wins is copied into `.hermit/state/claude-settings.overlay.json`, the `--settings` file the resident launches with. Keep that file with the rest of `.hermit/state` when you [back up](backup.md).

Claude Code ignores these exporter variables in a repository's `.claude/settings.json` and `.claude/settings.local.json`, so those files cannot turn the export on. The paths that work are the process environment and a `--settings` file, which is what the launch overlay is. See [Administrator configuration](https://code.claude.com/docs/en/monitoring-usage#administrator-configuration).

Claude Code does not pass `OTEL_*` variables on to the Bash tool, hooks, or MCP servers. The resident process still exports.

### Docker networking

The resident dials the endpoint from inside the container. The host's `localhost` is a different address. With [LAN containment](docker-security.md) on, connections to private addresses are dropped unless you add a carve-out for the collector. A public endpoint needs no carve-out.

## What leaves the box

| Signal | Turn on with | What you get |
| --- | --- | --- |
| Metrics | `OTEL_METRICS_EXPORTER` | Counters for tokens, cost, sessions, and tool decisions. |
| Log events | `OTEL_LOGS_EXPORTER` | One record per prompt, API request, API error, and tool result. |
| Traces (beta) | `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` and `OTEL_TRACES_EXPORTER` | Spans that tie a prompt to the model requests and tool calls it caused. |

Prompt text, assistant text, tool arguments, and tool output stay out until you set the matching variable. A default export shows that a step happened, plus lengths and counters.

| Variable | Set to `1` to include |
| --- | --- |
| `OTEL_LOG_USER_PROMPTS` | Prompt text. |
| `OTEL_LOG_ASSISTANT_RESPONSES` | Assistant response text. When this is unset, the prompt switch applies to responses too. Set it to `0` to keep responses redacted while prompts are logged. |
| `OTEL_LOG_TOOL_DETAILS` | Tool arguments, including Bash commands and file paths. |
| `OTEL_LOG_TOOL_CONTENT` | Tool output on trace spans. Requires traces. |
| `OTEL_LOG_RAW_API_BODIES` | The full API request and response, including the conversation so far. |

The other gates are in [Security and privacy](https://code.claude.com/docs/en/monitoring-usage#security-and-privacy) and the [configuration table](https://code.claude.com/docs/en/monitoring-usage#common-configuration-variables). The export goes to the endpoint you configured.

## See that it arrived

After the restart, the collector should show the `claude_code.session.count` metric. A logs-only setup shows a `claude_code.user_prompt` event after the next prompt. When nothing arrives, use the checks in the [quick start](https://code.claude.com/docs/en/monitoring-usage#quick-start).

## Collectors

Point `OTEL_EXPORTER_OTLP_ENDPOINT` at a collector you already run. Claude Code documents a [quick start](https://code.claude.com/docs/en/monitoring-usage#quick-start), a console exporter for a one-off check, and a [SIEM example](https://code.claude.com/docs/en/monitoring-usage#send-events-to-a-siem).
