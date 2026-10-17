---
name: forge-logs
description: Read site deployment logs, server logs, site application/nginx logs, background process logs, and specific deployment logs from Laravel Forge. Includes a triage mode that bundles recent logs with deployment history for rapid incident analysis. Triggers on "show logs", "read logs", "deployment log", "server log", "what happened to the deployment", "triage failing site".
---

# Forge Logs

Read deployment and server logs from Forge. Every log command prints `{"log":"..."}`, or `{"status":"none","reason":...}` when there is nothing to read (`no_deployments`, `no_log`, `no_process`).

---

## Latest deployment log for a site

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php logs <server> <site>
```

Fetches the most recent deployment and returns its full log.

## Specific deployment log

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php deploy-log <server> <site> <deploy-id>
```

Use `deploy-history` first to find the deployment ID.

## Server log

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php server-log <server> <key>
```

Common keys: `php`, `mysql`, `cron`, `daemon`, `nginx-error`, `nginx-access`. Nginx keys are hyphenated; `nginx_error` (underscored) returns a 404. The PHP-FPM log key is dot-version notation matching the server's installed PHP (`php-8.3`, not `php`); passing the literal `php` key auto-resolves it against the server's `php_version`. `mysql`/`cron`/`daemon` may 404 outright on servers with a custom, non-Forge-provisioned install of that service (no Forge-tracked log path), so a 404 there isn't necessarily a wrong key. A 404 prints `no_log` with the resolved key as `log_name`. Key list depends on the server's installed services.

## Site logs

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php site-log <server> <site> <type>
```

`<type>` is one of `application` (the Laravel app log), `nginx-access`, `nginx-error`. Application and access logs leak PII and tokens more readily than deploy logs — the Secret hygiene rules below apply with extra force.

## Background process log

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php background-process-log <server> <process-id>
```

The log path for apps that run as a Forge Background Process instead of PHP-FPM (Node apps, queue workers, custom daemons). `server-log` does not cover these. Find the process ID first:

```bash
echo '[<server-id>]' | php ${CLAUDE_PLUGIN_ROOT}/php/forge.php call backgroundProcesses
```

---

## Triage mode

When the operator says something like "what's wrong with myapp.com" or "triage the failing site", bundle context automatically:

1. `php ${CLAUDE_PLUGIN_ROOT}/php/forge.php site <server> <site>` — confirm the site is reachable and check status fields.
2. `php ${CLAUDE_PLUGIN_ROOT}/php/forge.php deploy-history <server> <site>` — surface the last few deployments and their statuses.
3. `php ${CLAUDE_PLUGIN_ROOT}/php/forge.php logs <server> <site>` — fetch the latest deployment log.
4. Synthesize: identify the failure type (build error, composer error, migration error, timeout), highlight the relevant log section, and suggest a remedy.

---

## Secret hygiene

**Deployment and server logs may contain env dumps, database credentials, and API keys.** Apply these rules to every log-reading flow:

- **Never paste raw log output into the channel.** Always summarize or excerpt.
- **Never write raw log content to `compiled/` or `raw/`** — scrub any credential values to `[REDACTED]` before persistence.
- If asked to share a log, review it first and redact any secret-pattern lines.

---

## Notes

- `<server>` and `<site>` accept name, hostname, or numeric ID.
- For a failed deployment you triggered via `forge-deploy`, the `deploy-incident` artifact (written by `forge-deploy` when its watch Monitor sees a failed terminal status) already contains the scrubbed log tail — check `compiled/deploy-incident-<site>-<date>.md` before re-fetching.
- Other output reads (`commandOutput`, `scheduledJobOutput`, `siteScheduledJobOutput`, `serverEventOutput`) are reachable via `call <method>` with JSON args on stdin; their content comes back under `result`.
