<!-- hermitd-laravel-forge: Forge Workflow -->

## Laravel Forge

Direct CLI execution outside Claude Code has no confirmation-only checkpoint; validation and policy denials still apply.

### Write previews

Preview and relay the canonical target and request before every write. For a deploy or reboot, run `forge.php preview-deploy <server> <site>` (or `preview-reboot`), relay the canonical target to the operator, then run the write command for native approval.

A wrong reboot causes an outage. A wrong deploy targets the wrong site.

### Tools

Skills self-advertise through their own `SKILL.md` descriptions — they are not catalogued here. The curated `forge.php` commands cover the hot paths; run `forge.php --help` for the full catalog. Any other SDK call goes through generic dispatch: `call <method>` reads; writes need `preview <method>` then `execute <plan-id>`, a single-use hash-checked plan the operator approves. Secrets and DELETE are denied — `forge.php policy` shows the boundary. Args are a JSON array on stdin, with IDs as bare numbers (SDK params are typed ints; `strict_types` rejects `"123"`). Never pass the org slug — it is prepended automatically, except for global methods like `organizations`:

```bash
echo '[123]' | forge.php call databases
```

The `forge-failed-deploys` routine routes estate findings through reflection gates into the proposal pipeline.

### Notifications

Anything operator-facing (deploy success/failure, escalations) is relayed via the **Operator Notification protocol in CLAUDE.md** — do not build a separate notification path.

### Credentials

- **Never `cat`, `echo`, `grep`, or Read `.env`** to check the token — run `forge.php check` instead. It prints one JSON object with `status` of `missing`, `invalid`, `unreachable`, or `ok`, without revealing the value.

### Secret hygiene

Deployment and server logs may contain env dumps, database credentials, and API keys. This rule applies to **channel relay AND persistence**:

- Never paste raw log output into a channel message.
- Never write raw log content to `compiled/` or `raw/`.
- Always scrub credential-pattern lines to `[REDACTED]` before sharing or persisting.

### Proposal categories

`[reliability]` — a recurring failure pattern across the estate.

<!-- /hermitd-laravel-forge: Forge Workflow -->
