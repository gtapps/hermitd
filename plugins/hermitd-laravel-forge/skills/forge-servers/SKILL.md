---
name: forge-servers
description: List, inspect, and reboot Laravel Forge servers. Reboot always goes through surface-then-approve (preview-reboot → native approval → server-reboot). Triggers on "list servers", "show server", "reboot server", "server status".
---

# Forge Servers

List and inspect servers in the Forge estate, or reboot a server with approval.

## List all servers

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php servers
```

Output: `{"servers":[...]}`, each entry with `id`, `name`, and `ip_address`.

## Show server detail

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php server <server>
```

`<server>` can be a server name, IP address, or numeric ID. An unmatched or ambiguous name returns `status` `no_match` or `ambiguous` with `choices` to pick from.

## Reboot a server (surface-then-approve)

**Step 1 — Preview (read-only, no action taken):**

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php preview-reboot <server>
```

Resolves `<server>` to the canonical record and prints `{"server":{"id","name","ip_address"}}`. No mutation.

**Step 2: Relay to operator.** Show the canonical target.

**Step 3: Execute.**

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php server-reboot <server>
```

A wrong reboot causes an outage. Never auto-confirm. Never skip the preview step.

## Monitors

Monitors have no curated command — they use the generic write path, which is how every SDK write other than `deploy` and `server-reboot` works.

List what exists:

```bash
echo '[<server-id>]' | php ${CLAUDE_PLUGIN_ROOT}/php/forge.php call monitors
```

**Step 1 — Preview.** Captures the exact HTTP request without sending it and stores it as a single-use plan:

```bash
echo '[<server-id>, {"type":"cpu_load","operator":"gte","threshold":90,"notify":"ops@example.com"}]' \
  | php ${CLAUDE_PLUGIN_ROOT}/php/forge.php preview createMonitor
```

Prints `plan_id`, `expires_at`, `verb` and `path` (`POST /orgs/<org>/servers/<id>/monitors`), the `body` payload, and the canonical `server`. A `status` of `denied` means policy blocks the method: relay its `reason` and `lift` entries to the operator, who alone can edit `.env`.

**Step 2: Relay.** Show the canonical server and payload.

**Step 3: Execute.**

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php execute <plan-id>
```

It prints `{"result": ...}`, or `OK` when the write returns nothing. Plans are single use and expire 15 minutes after the preview. If approval arrives later, the plan is gone and `execute` returns `{"status":"refused","reason":"missing"}` (or `expired`, `mismatch`): re-run the preview and relay the new one. Do not treat that as an error to work around: it is the mechanism refusing to fire something the operator did not just look at.

Payload fields, for reference only — there is no client-side validation, so a bad payload comes back as a Forge 422 with per-field errors: `type` is one of `cpu_load`, `disk`, `free_memory`, `used_memory`; `operator` is `gte` or `lte`; `threshold` is a number; `minutes` is optional; `notify` is an email address.

## Changing what's reachable

Every SDK method is reachable through `call` (reads) and `preview`/`execute` (writes), minus two shipped deny tiers: **`secrets`** (anything returning credential material) and **`destructive`** (anything whose captured HTTP verb is `DELETE`). To see the effective state:

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php policy
```

It prints `reachable` (installed endpoint methods), each shipped tier's `state` (`denied` or `lifted`), the `.env` lifts in `env_lifts`, `project_deny`, and any `warnings`.

Only the operator can widen this, by editing `.env` — which the agent cannot do:

- `FORGE_POLICY_ALLOW_TIERS=destructive` lifts a whole tier
- `FORGE_POLICY_ALLOW=deleteMonitor` lifts named methods only

A project may also list denials in `.hermit/forge-policy.json` (`{"deny": ["firewallRule*"]}`). Honour them — but never describe them to the operator as a security boundary, because this hermit is allowed to edit that file. It is a note, not a wall.

## Notes

- `${CLAUDE_PLUGIN_ROOT}` is substituted in installed mode. In `--plugin-dir` dev mode, use the absolute path.
- For server logs, use `/hermitd-laravel-forge:forge-logs`.
- For site-level work, use `/hermitd-laravel-forge:forge-sites`.
