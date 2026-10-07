### list

Show configured routines from `config.json` (not the live view — that's `status`).

1. Read `config.routines`. If empty: "No routines configured."
2. Display table:
```
Routines (config.json):
  #  ID                 Schedule      Skill                                    RDW    RA     Model   Status
  1. heartbeat-restart  0 4 * * *     hermitd:hermit-routines load  true   false  -       enabled
  2. weekly-review      0 23 * * 0    hermitd:weekly-review         false  false  -       disabled
```
`RA` is `true` when `reflect_after: true`. `Model` is the `model` value if set, otherwise `-`.

### status

1. Read `state/routine-monitor.runtime.json`. The scheduled-routine count comes from `config.routines` (enabled, minus the anchor), not from the runtime file — the runtime file records the registration, and config is what it should match.
   - **Monitor mode:** report `mode`, `started_at`, `interval`, the scheduled count, and `state/routine-monitor-liveness.json`'s `last_peek_at`. Call `CronList` filtered to `[hermit-routine:` — in steady state only `[hermit-routine:heartbeat-restart]` should appear; more means "legacy CronCreates still active — run `load` to clean up."
   - **Fallback mode:** `CronList` filtered to `[hermit-routine:`, displayed as:
     ```
     Active routine CronCreates:
       ID                 CRON-ID    SCHEDULE
       heartbeat-restart  4e007cf4   0 4 * * *
     ```
     (Extract id from the `[hermit-routine:<id>]` prefix.) If none: "No active routine CronCreates. Run `load` to register."
   - **Absent runtime file:** "Not yet loaded. Run `/hermitd:hermit-routines load`."

### stop

**Monitor mode:**
- `stop` or `stop --all` (no id, or `--all`): `TaskStop` the monitor task, clear `state/routine-monitor.runtime.json`, `CronDelete` the anchor. Log: "Stopped routine monitor and anchor."
- `stop <id>` (id ≠ `heartbeat-restart`): routines share one subprocess — do not stop it. Reply: "Routines share one monitor subprocess — to stop just `<id>`, set `enabled: false` on that entry in config.json and run `load`."
- `stop heartbeat-restart`: `CronDelete` the anchor alone (the monitor, if any, keeps running).

**Fallback mode:**
- `stop <id>`: `CronList`, find the `[hermit-routine:<id>]` entry, `CronDelete` it (or "not active").
- `stop` (no id): `CronList` filtered to `[hermit-routine:*]` — 0 active: report; 1 active: stop without asking; 2+: list and ask (or `--all`).
- `stop --all`: `CronDelete` every `[hermit-routine:*]` entry.

## Notes

- **Ledger.** The monitor stamps `dispatched` at emit. The session still owns `started` and `fired`.
- **Monitor mode defers only while an operator turn is open** (a Stop-cleared marker, 60-min TTL backstop), coarser than CronCreate's turn-level idle gate. A routine wake can still interject mid-conversation (same trade the heartbeat monitor accepts) — CronCreate never fires mid-task. Routines fire while a session is `in_progress` as long as no operator turn is open.
- **Routine ids** must match `^[A-Za-z0-9._-]{1,64}$` (enforced by `validate-config.ts`) — ids travel through bracket markers, `--ids` CSVs, and JSONL rows.
- **Changes take effect immediately.** `hermit-settings routines` invokes `load` after writing config; hand-edited `config.json` needs a manual `load`.
- **Interactive mode does not auto-register routines.** `hermitd-start.ts` calls `load` only on always-on launches.
- **`model` (optional)** runs a routine's skill in an isolated-context subagent at the named model (`opus`/`sonnet`/`haiku`) — returns only a one-line status, so skip it on routines whose value is the rich chat output. Ignored on `heartbeat-restart` (re-arm must run in the session). **`effort` (optional, `low`/`medium`/`high`/`xhigh`/`max`)** sets that subagent's effort and has no effect without `model`. Both validated by `scripts/validate-config.ts`.
- **Converting a costly broad-skill routine into a scoped one?** See [Routine Authoring](../../docs/routine-authoring.md).

### CronCreate fallback details

Besides the Monitor-unavailable hosts named in `SKILL.md`, the fallback applies when the monitor subprocess never produced a liveness tick.

- **Timezone.** CronCreate flow shifts each cron from `config.timezone` to machine-local (CronCreate only knows machine time) at minute granularity — half-hour/45-minute zones (Kolkata, Adelaide, Kathmandu) work. Null `config.timezone` passes through unchanged. Monitor mode needs no shift — `routines.ts due` evaluates directly in `config.timezone`.
- **DST.** Recomputed every `load`; `heartbeat-restart`'s daily reload self-corrects within 24h. On the transition day, one fallback-mode fire may land at the wrong hour. Inexpressible-after-shift schedules pass through unchanged with a `WARN:` line.
- **`durable: false`.** CronCreates die with the session; re-registered on every always-on launch.
- **7-day auto-expiry depends on `heartbeat-restart`.** CC's recurring-task expiry is a hard 7-day cliff, reset only by re-creating. The diff planner re-registers any routine whose age crosses a conservative threshold even with unchanged config; `heartbeat-restart`'s daily `load` is what crosses it. Disable it in fallback mode and routine CronCreates expire after 7 days.
- **`state/cron-registry.json`** is a derived mirror, never hand-edited — `--reset`, a missing/corrupt mirror, or a `.boot-id` mismatch all fall back to treating every enabled routine as needing registration.
