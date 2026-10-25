# External control surface (MCP stdio)

Adapter so an orchestrator (OpenClaw, another hermit, a script) can
discover, observe, wake, and hand jobs to hermits on this box without reading
`.hermit/` internals. Those files stay internal. This MCP server is
the only supported integration point.

Contract v2 speaks only MCP `2026-07-28`, including its tasks extension.
Clients that speak only earlier revisions no longer connect.

## Spawn

The server is consumer-spawned over stdio. It never listens on a port. Stdout
is JSON-RPC frames only; logs go to stderr. Task writes use the locked task
writer; polling and observation tools are read-only.

Inventory is explicit. There is no auto-discovery of hosts or of hermit folders
on disk. Pass every project root you want visible:

```bash
.hermit/bin/hermitd-run mcp-server --roots /path/to/project,/path/to/other
```

`--roots` wins over `HERMIT_MCP_ROOTS` (comma-separated). Each root is
canonicalized (`realpath`) and must contain `.hermit/`. Duplicates
are rejected at startup. Tool `root` arguments must match an inventory entry;
arbitrary paths come back as a tool error (`isError: true` in the result), not
a protocol error.

### Local

```bash
.hermit/bin/hermitd-run mcp-server --roots /home/you/project
```

### OpenClaw

OpenClaw’s default runtime likely speaks only earlier protocol revisions.
Check its runtime support before using this configuration.

```bash
openclaw mcp set hermit '{"command":"/home/you/project/.hermit/bin/hermitd-run","args":["mcp-server","--roots","/home/you/project"]}'
```

### Cross-host

ssh does not forward `HERMIT_MCP_ROOTS`. Pass `--roots` on the remote command:

```bash
ssh box /home/you/project/.hermit/bin/hermitd-run mcp-server --roots /home/you/project
```

### Container

```bash
docker exec -i <container> .hermit/bin/hermitd-run mcp-server --roots /workspace
```

Use the path the process inside the container sees. Cross-host auth is out of
scope; ssh keys are the boundary.

## Fleet split

One server is the per-box primitive. It reports only the roots it was given.
Aggregating many boxes, many hermits, or many hosts is the orchestrator's job.

## Discovery and request metadata

Newline-delimited JSON-RPC 2.0 over stdin/stdout, protocol `2026-07-28` only.
There is no initialization handshake or ping. `initialize` and unsupported
versions return `-32022` with `data: {supported: ["2026-07-28"], requested}`.
Every request with an id supplies `params._meta`:

```json
{
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {
    "extensions": {"io.modelcontextprotocol/tasks": {}}
  },
  "io.modelcontextprotocol/clientInfo": {"name": "my-client", "version": "1"}
}
```

Missing protocol version or client capabilities returns `-32602`.
Notifications are ignored. `server/discover` returns `resultType: "complete"`,
`supportedVersions: ["2026-07-28"]`, `capabilities: {tools: {}, extensions:
{"io.modelcontextprotocol/tasks": {}}}`, and `_meta` with
`io.modelcontextprotocol/serverInfo: {name: "hermitd", version}`. The version
comes from `.claude-plugin/plugin.json`. Discovery and `tools/list` both return
`ttlMs: 0` and `cacheScope: "private"`; `tools/list` also carries
`resultType: "complete"` and the tools array. Every successful result carries
`resultType`.

## Tools

Observation and wake tool results have `resultType: "complete"` and carry `structuredContent` (the JSON object)
plus `content: [{type:"text", text}]` as a JSON-string mirror of the same
object. Tool-originated errors use `isError: true` inside the result.

### `list_hermits`

No arguments. Returns the configured inventory only.

| Field | Meaning |
| --- | --- |
| `hermits[].root` | Canonical project root |
| `hermits[].name` | `config.agent_name`, or `null` |
| `hermits[].runtime_mode` | From `runtime.json`; `unknown` when missing. No docker probe. |
| `hermits[].liveness_age_secs` | Age of the freshest shared liveness file, or `null` |
| `hermits[].paused` | Binding pause flag |

### `get_status`

Argument: `root`. Runtime digest distinguishes `missing` vs `invalid` vs `ok`.
`status` is `{ execution, tasks, tasks_omitted }`: hook-observed execution
plus up to 20 normalized task records (newest first). `paused` and
`liveness_age_secs` as in `list_hermits`. `resident` is the validated
registry entry for `runtime.session_pid` looked up in the per-root stamped
`runtime.config_dir` (never the server's own default config dir); absent
enrichment is `null`, not an error.

### `get_health`

Argument: `root`. Two facets, no composite verdict.

**`availability.state`**

| Value | When |
| --- | --- |
| `alive` | Liveness fresher than 600s, or a validated resident registry entry |
| `reported_down` | `shutdown_completed_at` is set and liveness is stale. "Reported": the stamp has unverified writers. |
| `unknown` | Everything else |

Stale or missing liveness is never `down`. Fresh proves alive; stale proves
nothing. Evidencing timestamps travel with the facet
(`liveness_age_secs`, `liveness_fresh_secs`, `shutdown_completed_at`,
`resident`).

**`diagnostics`** is `state/doctor-report.json` as-is: `ts`, age, per-status
counts, failing check ids. `null` when the file is absent. The server does
not read `watchdog-events.jsonl`.

### `get_brief`

Argument: `root`. Returns `state/last-brief.json` when present, otherwise a task-record digest through `task-report.ts`.

The text/summary is capped at **16 KiB** with UTF-8-safe truncation and a
`truncated` flag. Never reads `state-summary.md`.

### `get_version`

Argument: `root`.

| Field | Source |
| --- | --- |
| `loaded` | This process's `.claude-plugin/plugin.json` version |
| `applied` | The hermit's `config._hermit_versions["hermitd"]`, or `null` |
| `required_bun_version` | `.claude-plugin/hermit-meta.json` |
| `min_claude_code_version` | `.claude-plugin/hermit-meta.json` |
| `contract_version` | `2` |

### `wake`

Argument: `root`. No `source` parameter; the payload is always
`HEARTBEAT_EVALUATE` posted to `runtime.json`'s stamped `inbox_socket`.

If the hermit is paused: `{delivery:"suppressed", reason:"paused"}` and no
socket write. Pause exists to prevent paid turns; wake does not bypass it.

Suppression is not transient, and this surface cannot lift it: resuming is
out of scope, so retrying only produces the same refusal. Only the
operator can resume, from their own chat or a terminal. An unattended
orchestrator should treat `suppressed` as "stop and surface to a human",
not as a retryable failure, and can confirm the state out of band via
`paused` on `get_status` or `list_hermits`.

Otherwise the response is
`{write_status:"flushed"|"unreachable", delivery:"unconfirmed"}`.
`flushed` means bytes reached the socket (or the docker relay exited 0).
`delivery` is always `unconfirmed` here: the receiving session can still drop,
hold, or ignore the turn. Never treat `flushed` as "the model ran".

`delivery` is the discriminator between the two shapes, and it is the only
field present in both. `write_status` is absent when suppressed: never read
its absence as a failed write. Wake does not echo pause state as its own
field — read `paused` from `get_status` or `list_hermits`.

When `runtime_mode` is `docker` and this process is not inside the container,
wake relays with
`docker compose -f docker-compose.hermit.yml exec -T hermit .hermit/bin/hermitd-run mcp-server --wake-local`
from the project root. Relay spawn failure, timeout, or nonzero exit is
`unreachable`. The in-container `--wake-local` path posts locally and does
not recurse.

### `submit_task`

Arguments: `root`, `title`, `brief` (required strings), and optional `done`
(defaults to the title). Requires MCP tasks in the client's capabilities,
with Claude Code 2.1.304 or later in a CLI or Agent SDK session. Missing tasks
support is a tool error and opens nothing. A root outside the inventory, a
paused hermit, or a Docker hermit reached from the host also opens nothing.
For writes to Docker hermits, spawn the server inside the container:

```bash
docker exec -i <container> .hermit/bin/hermitd-run mcp-server --roots <path inside the container>
```

A successful call opens a record requested by `mcp:client`, saves the client
name when supplied and the brief as a note, then posts `MCP_TASK <id>` to the
resident. It returns `resultType: "task"`, `taskId`, `status: "working"`,
`statusMessage: "accepted"` or `"queued: resident not reachable"`,
`createdAt`, `lastUpdatedAt`, `ttlMs: null`, and `pollIntervalMs: 5000`.
The task id is `<first 8 hex of sha256(realpath root)>.<record id>`.
There is no idempotency key: retrying a submission opens another record.
MCP task titles can appear in `!status`.

An unreachable resident leaves the record queued. Boot recovery picks it up
first; heartbeat's queue nudge is the fallback after `tasks.queue_nudge_minutes`
(default 60). The nudge is skipped while paused, outside active hours, and for
waiting or worker-owned records. MCP queue pickup runs at every autonomy level.

## Tasks

`tasks/get`, `tasks/update`, and `tasks/cancel` take `taskId`. Without the tasks
extension they return `-32021` with `requiredCapabilities.extensions` naming
`io.modelcontextprotocol/tasks`. Lookup checks the inventory-root hash, valid
record id, record existence and exact requester `mcp:client`; any miss returns
`-32602 "Failed to retrieve task: Task not found"`. Writer failures return
`-32603`. Update and cancel require the same in-container server for Docker
writes as submission.

`tasks/get` never writes. It returns `resultType: "complete"`, the task id,
`createdAt`, stable `lastUpdatedAt` (latest opened time, last progress timestamp,
waiting time, result time or closure time), `ttlMs: null`, and
`pollIntervalMs: 5000`. Status uses the first matching row:

| Record | Status and payload |
| --- | --- |
| Closed by cancellation | `cancelled`, closing reason as `statusMessage` |
| Closed by `result`, `check` or `confirmed` | `completed`, text result or closing reason in `result.content`, with `result.resultType: "complete"` |
| Open with a result | `working`, listing as `statusMessage` |
| Open without result, waiting on `mcp:client`, stall time equals waiting time | `input_required`, question in `inputRequests` |
| Otherwise | `working`, latest Progress bullet cut to 120 characters as `statusMessage` |

Each question has a unique key `q<epoch milliseconds of stall_at>` in
`inputRequests`. Its `elicitation/create` request uses `mode: "form"`, message
`<stall_status> Next: <stall_next>` and a required string field `answer` titled
`Answer`. `tasks/update` accepts `inputResponses` keyed by that question key.
An `accept` response with `content.answer` appends the answer as `mcp:client`,
clears waiting and posts `MCP_TASK <id> answered`. Stale keys and answers racing
a changed question are ignored. `decline` or `cancel` cancels with reason
`declined from MCP client` and posts `MCP_TASK <id> cancelled`.

`tasks/cancel` cancels any open state with reason `cancelled from MCP client`
and posts the cancellation; the resident stops its worker. Closed records get
no write. Updates and cancellation return `resultType: "complete"`.

The resident's result post closes an MCP-requested record with no check or
approver as `closed_by: result`. Records with a check or approver retain their
existing closure rules. Chat tasks retain their confirmation behavior.

## Out of scope

Pause/resume, config mutation, lifecycle ops, HTTP transport, cross-host auth,
automatic host discovery, fleet-wide aggregation.
