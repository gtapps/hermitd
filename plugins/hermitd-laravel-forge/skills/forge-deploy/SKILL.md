---
name: forge-deploy
description: Deploy a site on Laravel Forge. Always surface-then-approve (preview-deploy first, then deploy with native approval). Watches via the hermit /watch registry and writes a deploy-incident on failure. Triggers on "deploy", "trigger deployment", "deploy site", "run deployment", "check deployment status".
---

# Forge Deploy

Trigger a deployment on a Forge site. **Always preview before deploying.** A wrong deploy targets the wrong site — preview eliminates that risk.

---

## Surface-then-approve flow

### Step 1 — Preview (read-only, never mutates)

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php preview-deploy <server> <site>
```

Resolves `<server>` and `<site>` to their canonical SDK records and prints:

```json
{"server":{"id":12345,"name":"prod-web-01","ip_address":"1.2.3.4"},"site":{"id":67890,"name":"myapp.com"}}
```

No network write. A `status` of `no_match` or `ambiguous` instead lists `choices`: ask the operator which one they meant.

### Step 2 — Relay canonical target to operator

Show the canonical server name, IP, site name, and IDs.

### Step 3: Deploy

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php deploy <server> <site>
```

This triggers the deployment and returns immediately (no blocking wait):

```json
{"deploy_id":991,"server_id":12345,"site_id":67890,"deploy_status":"queued"}
```

Capture `deploy_id`, `server_id`, and `site_id`: Step 4 needs them.

### Step 4 — Watch via the hermit watch registry (non-blocking)

Do **not** poll in a foreground Bash call: a real deploy can outlast the Bash tool timeout, which would kill the wait and skip the incident. Arm a hermit watch instead: it runs detached, notifies you on each status change and on the terminal state at zero token cost while quiet, and is tracked in `monitors.runtime.json` (visible via `/hermitd:watch status`, cancellable via `/hermitd:watch stop`, and cleaned up when the watch finishes or is stopped).

**Requires a running resident.** If the resident is unavailable, run `deploy-status <server-id> <site-id> <deploy-id>` manually; it prints `{"deploy_status":"..."}`.

Resolve `${CLAUDE_PLUGIN_ROOT}` to its **absolute path now** (at skill-execution time): the variable is NOT available inside the watch subprocess. Then arm the watch by invoking `/hermitd:watch` with this command (substitute the absolute path and the three IDs):

```bash
php /ABS/php/forge.php deploy-watch <server-id> <site-id> <deploy-id>
```

The `TERMINAL` line carries only numeric IDs (never display names) — Forge server names can contain spaces, which would break the space-delimited fields.

`/hermitd:watch` registers this as an ad-hoc watch (`persistent: true`, so the tool's own timeout is ignored). The loop therefore self-caps after ~15 min (180 × 5 s) and emits a `timeout` terminal line — it never becomes an unbounded watch. It is otherwise quiet, emitting only on status change. On any `TERMINAL` line the command exits and core clears the registry entry automatically; that line carries everything Step 5 needs.

### Step 5 — On the terminal watch event

When the `TERMINAL …` notification arrives:

- **`status=finished`** → tell the operator the deploy succeeded, via the **Operator Notification protocol** (core resolves the channel; falls back to a push). No artifact.
- **`status=failed` / `failed-build` / `cancelled`** → (1) fetch the log with `deploy-log <server-id> <site-id> <deploy-id>` using the numeric IDs from the `TERMINAL` line, **scrub it**, and write a `deploy-incident` artifact (template below); (2) notify the operator of the failure via the **Operator Notification protocol**, including the incident path.
- **`status=timeout`** → the watch hit its ~15 min cap without reaching a terminal state. Notify the operator (via the **Operator Notification protocol**) that the deploy is still unresolved and point them at `deploy-history` / `deploy-status` to follow up. No incident — a timeout is not a confirmed failure.

Scrubbing happens here, in this step — never in the watch command. The watcher only emits metadata, so no raw log line is ever written by the unattended subprocess.

---

## Deployment history

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php deploy-history <server> <site>
```

Prints `{"deployments":[...]}`, each entry with `id`, `status`, and `commit` (the message, truncated).

## Fetch a specific deployment log

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php deploy-log <server> <site> <deploy-id>
```

---

## deploy-incident artifact (written in Step 5 on a failed terminal status)

**File**: `compiled/deploy-incident-<site-name>-<YYYY-MM-DD>.md`

**Content template**:
```
---
title: Deploy incident — <site-name> <YYYY-MM-DD>
created: <ISO timestamp>
type: deploy-incident
tags: [deploy, failure, <site-name>]
---

## Incident

- Site: <site-name> (ID: <site-id>)
- Server: <server-name> (ID: <server-id>, IP: <ip>)
- Deployment ID: <deploy-id>
- Status: <failed|failed-build|cancelled>
- Detected: <timestamp>

## Commit

<commit message, if available>

## Log tail (scrubbed)

<last ~50 lines of the deployment log, **scrubbed of any credentials, env vars, or secrets**>

## Resolution

(fill in after incident is resolved)
```

**Secret hygiene (critical):** deployment logs frequently contain env dumps, DB connection strings, and API keys. **Never paste raw log content** — always scrub before writing. Fetch the log with `deploy-log`, review it, then excerpt only the error-relevant lines with any credential values redacted (`[REDACTED]`).

---

## Notes

- `<server>` and `<site>` accept name, hostname, URL hostname, or numeric ID. An unmatched or ambiguous name returns `status` `no_match` or `ambiguous` with `choices`, and nothing runs.
- Claude Code requests native approval before deploy and reboot execution.
- For reading logs without a deploy action, use `/hermitd-laravel-forge:forge-logs`.
