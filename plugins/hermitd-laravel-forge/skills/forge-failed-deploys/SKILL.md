---
name: forge-failed-deploys
description: "Routine check: scans the Forge estate for sites whose latest deployment is in a failure state. Runs daily via its own routine; findings are routed through the proposal pipeline as Evidence Source: scheduled-check/forge-failed-deploys."
---

# Forge Failed Deploys

Routine skill: scans the org-wide site list and flags any sites whose latest deployment status is `failed`, `failed-build`, or `cancelled`.

**Contract:** idempotent, read-only, no self-scheduling, short-running. Returns findings or silence — never creates proposals itself.

---

## Steps

1. **Run the estate scan.**

   ```bash
   php ${CLAUDE_PLUGIN_ROOT}/php/forge.php failed-deploys --json
   ```

   This pages through the org-wide site list via `organizationSites()->lazy()` and fetches the `deployment_status` field on each site. For sites in a failure state it fetches the latest `deployments()` detail. Rate limiting (429) is handled internally with conservative pacing.

2. **Parse the JSON output.** It prints `{"failures":[...]}`; on `{"error":...}`, report `Scan skipped: <error>` in place of `No actionable findings.`. Each entry has: `site_id`, `site_name`, `server_id`, `status`, optionally `deploy_id`, `deploy_status`, `commit`. An entry whose detail fetch was rate-limited instead carries an `error` key (and no `deploy_id`/`commit`): treat those as "failure, detail unavailable" and omit the commit line. Never assume all keys are present.

3. **Output the findings block.** Always output to stdout, regardless of outcome. `reflect --check-id forge-failed-deploys --check hermitd-laravel-forge:forge-failed-deploys` classifies the result.

   **Failures found:**
   ```
   forge-failed-deploys findings — <YYYY-MM-DD>
   Failed deployments: <N>
   - [deploy-failure] <site_name> (server: <server_id>): status <status><commit line if available>
   ```
   One bullet per failed site.

   **No failures:**
   ```
   forge-failed-deploys findings — <YYYY-MM-DD>
   No actionable findings.
   ```

4. **Do not fetch deployment logs.** This scan surfaces sites with failures; the `forge-logs` or `forge-deploy` skills handle remediation. Fetching logs per failure during the scan would hit rate limits on large estates.

---

## Notes

- **This skill writes no artifact.** Findings are returned for `reflect --check-id forge-failed-deploys --check hermitd-laravel-forge:forge-failed-deploys` to classify and route. Routine execution owns scheduling state.
- **Registered by `/hermitd-laravel-forge:hatch`** as the `forge-failed-deploys` routine. Its schedule lives in `config.routines`.
- **No channel notifications** — this is analysis-only. Findings surface as `[reliability]` proposals via the normal pipeline.
- **scope**: if `organizationSites()` does not carry `deployment_status` in your Forge plan/API version, the scan will report zero findings (not an error). Scope to `watched_sites` in `.hermit/config.json` if org-wide scan is unavailable.
- **Rate limit**: Forge allows ~60 req/min. The scan paces conservatively; a 429 on the site listing ends the scan with `{"error":"rate_limited:..."}`, and the check retries on the next scheduled run.
