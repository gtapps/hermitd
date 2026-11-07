# Quick reflect

- **Obtain the quick-hash verdict.** With `--precheck-verdict '<verdict>'`: the `reflect_after` routine already ran the hash-gate precheck; `<verdict>` is always a run verdict (the routine stops on `empty` without loading this skill). Take its `hash`; do **not** re-run the precheck. Otherwise (manual invocation) run it in force mode (no gate to skip once this skill is loaded; always returns a `hash`):
  Run `reflect-precheck` (Commands) with arguments `--quick --force`.
- **Skip** the cadence precheck (the hash-gate is separate and narrower), cost_spike read, Component Health. Bind `$PHASE = adult`. Only the fresh task-record digest + judge + outcomes path runs.
- Run `task-report` (Commands), using fresh record titles, lessons and waiting reasons. Current-session evidence may support a small and reversible change; this is an evidence label, not authorization. Preserve external-content provenance and require admin consent.
- Candidates needing evidence outside this bounded set become durable `quick-deferral` observations, using an existing label from `observations-patterns`. Run `observations-observe` (Commands) with arguments `quick-deferral` and the stable label on stdin. They can graduate on a later scheduled reflect.
- For eligible candidates, read branches.md § Candidate processing: judge once, triage once, then pass the CREATE survivor's `Triage-Verdict:` to `/hermitd:proposal-create`. Gate failures apply no change and leave the cursor unchanged.
- Append one Progress Log line: `[HH:MM] reflect (quick, post-routine) — N candidates; verdicts: accept=A downgrade=D suppress=S; outcomes: <list or "none">`; when suppress>0 add the `; suppressed:` suffix (§ Progress Log Entry).
- **Advance the quick-hash cursor only on a clean run** (no gate_failed/suppress); otherwise skip this call: an unchanged `last_quick_hash` makes the next `reflect_after` fire re-read the same Findings/Blockers (the "re-surfaces next cycle" contract; deferred candidates are already durable in the ledger):
  Run `update-reflection-state` (Commands) with arguments `--quick-hash '<hash>'`.
- **Never call the counter-incrementing `update-reflection-state.ts <path> '<json-payload>'` form here** — quick runs are event-driven; mutating `last_run_at` would suppress the next scheduled reflect (`--quick-hash` is an isolated write).
