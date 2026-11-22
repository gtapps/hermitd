### list

Show configured routines from `config.json` (not the live view — that's `status`).

1. Read `config.routines`. If empty: "No routines configured."
2. Display table:
```
Routines (config.json):
  #  ID                 Schedule      Skill                                    RDW    RA     Model   Status
  1. reflect            0 9 * * *     hermitd:reflect                false  false  -       enabled
  2. weekly-review      0 23 * * 0    hermitd:weekly-review         false  false  -       disabled
```
`RA` is `true` when `reflect_after: true`. `Model` is the `model` value if set, otherwise `-`.

### status

1. Read `state/routine-monitor.runtime.json` for the registration and count enabled routines in `config.routines`.
   - **Monitor mode:** report `mode`, `started_at`, `interval`, the scheduled count and the `last_peek_at` from `state/routine-monitor-liveness.json`. If `CronList` shows any `[hermit-routine:*]` entries, report them and suggest `load --reset` to clean them up.
   - **Fallback mode:** `CronList` filtered to `[hermit-routine:`, displayed as:
     ```
     Active routine CronCreates:
       ID                 CRON-ID    SCHEDULE
       hermitd:heartbeat-restart  4e007cf4   0 4 * * *
     ```
     (Extract id from the `[hermit-routine:<id>]` prefix.) If none: "No active routine CronCreates. Run `load` to register."
   - **Absent runtime file:** "Not yet loaded. Run `/hermitd:hermit-routines load`."

### stop

**Monitor mode:**
- `stop` or `stop --all` (no id, or `--all`): `TaskStop` the monitor task and clear `state/routine-monitor.runtime.json`.
- `stop <id>`: routines share one subprocess. To stop one routine, set `enabled: false` on its entry in `config.json` and run `load`.

**Fallback mode:**
- `stop <id>`: `CronList`, find the `[hermit-routine:<id>]` entry, `CronDelete` it (or "not active").
- `stop` (no id): `CronList` filtered to `[hermit-routine:*]` — 0 active: report; 1 active: stop without asking; 2+: list and ask (or `--all`).
- `stop --all`: `CronDelete` every `[hermit-routine:*]` entry.

## Notes

- **Ledger.** The monitor stamps `dispatched` at emit. The session still owns `started` and `fired`.
- **Monitor mode defers only while an operator turn is open** (a Stop-cleared marker, 60-min TTL backstop), coarser than CronCreate's turn-level idle gate. A routine wake can still interject mid-conversation (same trade the heartbeat monitor accepts) — CronCreate never fires mid-task. Routines fire while a session is `in_progress` as long as no operator turn is open.
- **Routine ids** must match `^[A-Za-z0-9._:-]{1,64}$` (enforced by `validate-config.ts`) — ids travel through bracket markers, `--ids` CSVs, and JSONL rows.
- **Changes take effect immediately.** `hermit-settings routines` invokes `load` after writing config; hand-edited `config.json` needs a manual `load`.
- **Interactive mode does not auto-register routines.** `hermitd-start.ts` calls `load` only on always-on launches.
- **`model` (optional)** runs a routine's skill in an isolated-context subagent at the named model (`opus`/`sonnet`/`haiku`) — returns only a one-line status, so skip it on routines whose value is the rich chat output. **`effort` (optional, `low`/`medium`/`high`/`xhigh`/`max`)** sets that subagent's effort and has no effect without `model`. Both validated by `scripts/validate-config.ts`.
- **`chat` (optional)** names the chat that owns the routine, as `<channel>:<chat_id>`. Its client notices go there instead of the home chat; maintainer detail stays home, and failed delivery is reported to the operator. A Discord public thread (type 10 or 11) rejected with code 10003, 50083 or 160005 before any chunk is accepted falls back to its text or announcement parent (type 0 or 5), with "(the original thread is no longer reachable)" before the client text. Disabled channels, private threads, forum parents, missing metadata and transient or partial failures never fall back. A parent success still records `chat-undelivered`; other failures keep the text in Findings and send a maintainer notice. Any configured channel can own a routine; reply-tool skills can reach it, and model-composed notices relay through its reply tool when the channel has no direct sender or `send_script`. `hermit-settings` sets it when a routine is added from a chat.
- **Converting a costly broad-skill routine into a scoped one?** See [Routine Authoring](../../docs/routine-authoring.md).

### CronCreate fallback details

Fallback applies when the native routine monitor fails to report its first tick. Use `load --reset` to retry native monitoring during this boot.

- **Timezone.** CronCreate flow shifts each cron from `config.timezone` to machine-local (CronCreate only knows machine time) at minute granularity — half-hour/45-minute zones (Kolkata, Adelaide, Kathmandu) work. Null `config.timezone` passes through unchanged. Monitor mode needs no shift — `routines.ts due` evaluates directly in `config.timezone`.
- **DST.** Each `load` recalculates shifted schedules. The daily fallback anchor detects offset changes within 24 hours. On the transition day, one fire may land at the wrong hour. Schedules that cannot be expressed after shifting pass through with a warning.
- **`durable: false`.** CronCreates die with the session; re-registered on every always-on launch.
- **Renewal.** Recurring CronCreate tasks expire 30 days after creation. With scheduled routines, the built-in 04:00 anchor checks daily and replaces only changed registrations or those older than 25 days.
- **`state/cron-registry.json`** is a derived mirror, never hand-edited — `--reset`, a missing/corrupt mirror, or a `.boot-id` mismatch all fall back to treating every enabled routine as needing registration.
