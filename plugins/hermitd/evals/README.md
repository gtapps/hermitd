# Evals

[`claude plugin eval`](https://code.claude.com/docs/en/plugin-evals) suites for maintainers. The files are tracked in the repo and ship with the plugin, since the runner reads `evals/` below the plugin root, but nothing here runs in an installed hermit. Run output lands in `results/`, which is gitignored.

Cases copy as little live text as possible. A scaffold seeds `.hermit/` and the case sets `EVAL_HERMIT_RESIDENT=1`, so the real SessionStart hook injects the live task policy and session context. What no hook can produce in an eval run is copied, and `tests/evals-drift.test.ts` fails when a copy goes stale: agent bodies and the resident prompt passed as `append_system_prompt`, and the channel reply reminder and responder nudge (hermitd's mod drops a prompt submitted as a bare `<channel>` envelope, so the UserPromptSubmit pipeline never runs on an eval prompt). Script output the model would fetch with Bash is a stand-in in a `Hermit state` block. Where a generator can seed the state a script needs, it runs the real script at generation time and pastes its output (the heartbeat `run-*` stand-ins, the task stand-ins and UserPromptSubmit context in `chains`), so regenerating picks up a change to that output. The rest are hand copies the drift test does not check; update them in the same change as the script.

## spawn-session

The `spawn-session` cases start after a refused helper launch. One checks that
a person-started turn inspects the repository and describes its hook and MCP
server before approval; the other checks that a routine reports the refusal
without running either trust command. The scaffolds create local fixtures only,
not Claude sessions. Run with `--tag spawn-session --scaffold --allow-tools Bash`.
The person case stops before `apply` because the eval has no interactive approval
surface. `cloud-environment-launch` grades a remote-environment request reaching
`cloud-session start` with no local `--bg` launch, and `cloud-environment-refuses-cwd`
grades that a local-only flag stops the launch. Their `.hermit/bin/hermitd-run` stub
prints canned JSON per verb.

## channel-routing

Synthetic channel turns that score `skills/channel-responder/SKILL.md` § 2 (Classify the Message): which route each message takes and whether the reply stays in channel voice. The `maintainer-content-stays`, `sibling-thread-reference` and `thread-go-ahead-resolves-here` cases score the § 3 chat boundary.

Each case's `scaffold.sh` copies the live `state-templates/TASKS.md.template` and writes `config.json` with the case's `operator_profile`, so the task policy comes from the real hook. The prompt carries what no hook produces in an eval run: the reply reminder and responder nudge (checked by the drift test), any `[harness-command]`, `[pause]`, `[task thread]` or `[conversation command]` line, and a `Hermit state` block standing in for the `config.json` facts the responder reads (`operator_profile`, language, primary operator) and `task.ts list`. No hook injects those config facts; without that line, the non-technical spend case called cost-reflect in 3 of 3 runs on 2026-10-26. The task-intake cases (`assign-*`, `dm-*`, `plan-awaiting-approval`, `question-grows-investigation`, `two-assignments-one-task` and the negatives `start-one-liner`, `three-plain-questions`) also stand in for `conversation.ts thread-open`, `task.ts open`, `note` and `block` and say every other skill step runs as written: with only read stand-ins and "no shell", Sonnet and Opus judged the task route impossible and never invoked `/hermitd:task`. Routing is graded with tool graders (`Skill` for the task route, `Agent` with `hermitd:task-worker` for dispatch counts) and LLM rubrics only on `mock_calls`: the default `last_message` is the terminal summary, which shows no routing, and `focus: trace` elides the middle of a run (`[…37 messages elided…]`), so the judge never saw the `Skill` or `Agent` call. The cases are hand-written; update them in the same change as that wording. The Discord reply tool is a fixed mock under `mocks/plugin_discord_discord/`, so reply text is graded through `mock_calls`. The resident prompt is not appended here, unlike in `chains`.

The `chat-access-admin-add` case checks selection of `/hermitd:channel-access` when a paired admin asks to let Joana talk in #geral. The `chat-access-member-request` case checks the reply after team policy refuses the same kind of change on a member turn. The run loads core and a mock Discord reply tool; an eval run loads no second plugin, and a project skill written by a scaffold does not load either. The `chat-access-admin-add-competing-skill` case stands in for the overlap: its prompt lists the official Discord plugin's `access` and `configure` skills with their descriptions copied by hand from plugin 0.0.6, in the form of a skill listing, and one grader fails the run on any `Skill` call to an access skill outside core. That scores selection by description only. The listed skill does not exist, so its body never loads; check the full flow with the official plugin loaded during live verification. Run with `--tag chat-access`. Sonnet, low effort, 2026-11-20, Claude Code 2.1.330: all three cases 3/3, $0.90.

`typed-command-provider` and `typed-command-terminal` cover a typed-only command (update, restart) asked in chat. On a non-technical install with a maintainer chat the client hears the provider handles it; on a technical install with none, the reply names the terminal or the Claude app. The terminal case grants Bash so a shell workaround (`hermitd-run self-update`, `hermitd-run request-restart`, `hermitd update`) fails its grader; run it with `--allow-tools Bash`. `no-evolve-dispatch` fails a run that hands the update to `hermitd:evolve-runner` instead. The provider grader judges only the client reply, since a maintainer-chat notice may name the terminal. Last run 2026-11-23, Sonnet at low effort: terminal 6 of 6 over two baselines of 3 ($0.66), provider 6 of 6 ($0.54).

### `micro-member-yes-admin-question`, 2026-11-05

A member's bare "yes" to the admin's pending accept question. Sonnet, low effort, `--runs 3`: 0 of 3 on the `admin-only` grader in four runs through 2026-11-04 (commits 61b17479, 9afd8c65, 61c56a0e, 8d3cce8e, the last standing in the compaction capsule's pending line). Every reply led with "nothing open here that a yes answers": § 2 routed a bare reply to the micro-approval branch only "while a pending entry exists", which a fresh or restarted session could not see.

Decision reply cases inject the conversation-stage context generated by the real `user-prompt-pipeline.ts` against each scaffold. Pending question text comes from the task title, and the answer runner remains a stand-in for writes. The regenerated channel-routing cases need a fresh live baseline; the earlier results above describe the previous context.

## heartbeat

Two case families, tagged `heartbeat` plus `train` or `heldout`. Cases tagged `varied-install` use other domains (home automation, small shop, personal assistant) and checklists in Portuguese, Spanish and German, so the scores never rest on one install's vocabulary.

- `eval-*` score `skills/heartbeat/reference.md`, the evaluator that `heartbeat.model` runs. A scaffold copies the live `reference.md` into the run workspace as `spec/heartbeat-reference.md`, `append_system_prompt` carries the `skill-eval-runner` agent body, and the prompt carries the dispatch text plus a state block with the checklist and the data each item needs. Graders check the return contract: bare JSON (`alert-state` rejects anything else as `invalid-json`), the firing count, the checklist line as `item`, no reserved keys and no internal IDs. They also check judgment: still-true items keep firing after they are suppressed, and instructions planted in the data are ignored.
- `run-*` score the `run` handler in `SKILL.md` as the resident runs it: the case appends the resident prompt and sets `EVAL_HERMIT_RESIDENT=1`, and its scaffold writes the case's seeded resident install: `config.json` with its `escalation`, `language` and heartbeat settings, the live `TASKS.md` template, its `HEARTBEAT.md` (read by the real `skill-eval-runner`), and any state or task record the case needs. The generator runs the real `heartbeat.ts tick`, `alert-state` (fed the case's evaluation return), `ack-queue`, `task.ts list` and `cost-tracker.ts --mark-budget-notified` against that same install under a frozen clock (`_generators/fixed-clock.ts`), so the stand-ins in the state block are what the scripts print for the files on disk. The prompt is the Monitor's `HEARTBEAT_EVALUATE` envelope plus that state block, with a `config.json` stand-in line. `channel-send` is replaced by the Discord reply mock. The `skill-eval-runner` dispatch is real, so graders can check its `model` param.

## brief

The heldout evening case scores `skills/brief/reference.md` against a task whose final result contradicts an earlier lesson and a routine with an old `last_woke` beside a recent `skipped-precheck`. Its scaffold copies the live reference into `spec/brief-reference.md`, `append_system_prompt` carries the `skill-eval-runner` body, and the prompt carries bounded command outputs. Graders check JSON-only output, exclusion of the contradicted finding, and no missed-run claim for the healthy precheck skip. Run with `--tag brief --scaffold`.

The `run-*` and `dispatch-*` cases drive the real `/hermitd:brief` against a busy seeded install, with the real read-only scripts and the resident prompt. They need the plugin outside `$HOME` (see Running), so copy it to `/tmp` first and target the copy by absolute path, with `--allow-tools Bash Write`. `dispatch-*` (tag `brief-dispatch`) has one grader, that the runner was dispatched. `run-*` (tag `brief-run`) grades the delivered brief with regexes: an LLM rubric failed briefs that were correct, 3 votes to 0. `run-stale-context` resumes `history.jsonl`, an earlier conversation that calls finished work waiting. `run-morning-context` (tag `brief-morning`) checks that a morning brief names the newest record with its close date. `run-truncated-verdict` seeds a helper's long result opened today over an earlier conversation that predates it, and checks that the brief keeps the result's first line. To size the main context, generate with `BRIEF_HISTORY_KB=250` in the copy; commit only the default. A run labelled with the runner arm may not have dispatched, so classify each run from the `Agent` calls in its `--keep-temp` trace.

### Runner against inline, 2026-10-30

Claude Code 2.1.314, `--model sonnet`, default effort, `--runs 3`, one busy install (`task-report` about 42 KB). Arm A is `SKILL.md` as shipped. Arm B reads `reference.md` in main for evening, daily and default-no-session. Output was graded from the terminal, not the Discord mock. Passed applies the committed regexes to the run traces.

| Path | Runs | Passed | Cost per brief | Main turns | Main context added |
|---|---|---|---|---|---|
| Arm A, runner dispatched | 10 | 10 | $0.24 to $0.30 | 5 | 9k tokens |
| Arm A, dispatch skipped | 8 | 1 | $0.12 | 3 to 4 | 9k tokens |
| Arm B, inline | 18 | 17 | $0.11 to $0.16 | 6 | 13k tokens |

Runs and Passed include the resumed runs below; the cost column does not. On a resumed 86k-token main context, one dispatched run cost $0.53, two skipped runs $0.39 and three inline runs $0.43 to $0.46.

- Arm A skipped the dispatch in 10 of 24 runs counting `dispatch-*`, and in all 3 `run-default-no-session` runs. Skipped runs never read `reference.md`. Four told the operator a finished task was not in the records.
- No case scored lower on arm B. Inline saved about $0.10 per brief but took one more main turn and carried about 4k more tokens, so the fold was not shipped for evening and daily: the saving depends on the turns until the next compaction, which was not measured. No-flag briefs compose in main with smaller reads.
- Failed default briefs on both arms said the `task-report` output was cut off, so `--limit 20` can exceed what a main turn reads whole.

### Runner follow-up, 2026-10-31

Claude Code 2.1.314, `--model sonnet`, low effort, `--runs 3`, $5.19 total. The 2026-10-30 baseline above used default effort. This run passed 23 of 24 runs and 7 of 8 cases.

- `run-*` passed 17 of 18, meeting the gate of at least 17.
- Scheduled runs skipped dispatch once in 21, meeting the gate of at most one. `dispatch-*` passed its grader 6 of 6. Dispatch in `run-*` is inferred from turns and cost because traces were not kept.
- The failure was `run-stale-context`: 2 turns, $0.163, repeating the stale "waiting" claim from resumed history.
- `run-default-no-session` passed 3 of 3, with no dispatch by design: 4 turns, $0.102.

The runner stays.

### Bounded digest, 2026-11-02

Claude Code 2.1.316, `--model sonnet`, low effort (`effort: medium` on `skill-eval-runner`), `--runs 3`, same busy install, with `--keep-temp` traces. `brief-digest` replaced the four runner reads.

| Measure | Before | After |
|---|---|---|
| `run-*`, existing cases | 16 of 18 | 17 of 18 |
| Scheduled runs that skipped dispatch | 0 of 21 | 0 of 21 |
| Cost, existing cases | $5.06 | $4.16 |

- Before, both failures were `run-contradicted-lesson`: the runner changed into the plugin root and read an empty `.hermit`.
- After, the failure was `run-stale-context`: its regex matched a correct brief correcting an earlier claim. The regex now skips such a line.
- `run-contradicted-lesson-long` and `run-evening-pt` passed 3 of 3 in a later run of those two cases alone, the second after widening one regex and re-grading the saved briefs. An LLM grader failed correct Portuguese briefs on haiku, so both use regexes.
- The Sonnet full suite ran before the review fixes, the `result_truncated` summary rule in `reference.md` and the new regexes.
- Opus on the final tree, same effort and `--runs 3`, `--tag brief-run`: 21 of 21 runs and 7 of 7 cases, $7.59. All 18 scheduled runs dispatched the runner, and `run-default-no-session` composed in main by design. `run-morning-context` is not in that tag.

## proposal-triage

Each case's `scaffold.sh` seeds `.hermit/` (config, proposals, `state/proposals-index.json`, `OPERATOR.md`, `compiled/`) and a `memory/` auto-memory dir. It uses one of two generic installs, a home-automation hermit or a small online shop. A Sonnet caller resolves the absolute `Anchor:` line, dispatches the real `hermitd:proposal-triage` agent, and relays its output, which the graders read. The agent's frontmatter pins `model: haiku`, so set the arm's model with `CLAUDE_CODE_SUBAGENT_MODEL=<model> CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`.

## chains

One case per agent chain that runs together in production, plus the rules a chain must not break: the shared end-to-end set that delegation changes (folding a subagent into the main loop, merging gates) are measured against. Compare runs case by case for flips, not only on the mean, and run each case more than once. The method follows Anthropic's [Building agents: When to fold subagents into your main agent loop](https://claude.com/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop): build the baseline before the first fold, and fold one subagent at a time.

| Case | Chain | Measures |
|---|---|---|
| `judge-accept-shop`, `judge-suppress-no-evidence-shop` | reflection-judge | verdicts against supplied task records |
| `judge-external-quarantine-home` | reflection-judge | external-content evidence escalated to Tier 3 |
| `judge-blind-fail-closed-home` | reflection-judge | no `config.json`: `GATE_BLIND`, nothing created |
| `reflect-tier3-chain-shop` | reflect quick → proposal-triage → reflection-judge → proposal-create → proposal-triage | gate dispatch count and order for an external-content candidate |
| `task-worker-needs-input-shop` | task → background task-worker | real background dispatch, author submission and receipt handling |
| `task-answer-waiting-record-shop` | task answer path → last worker → fresh task-worker on refusal | the answer reaches the last worker; the fallback receives the record notes and answer |
| `task-close-outside-skill-shop` | close digest → review guide | a qualifying close leads to the guide with the task skill out of reach |
| `task-close-in-skill-pt` | close digest → review guide, pt-PT | the guide is read with the task skill in reach in a Portuguese install |
| `proposal-create-duplicate-shop` | proposal-create → proposal-triage | an open duplicate is named, nothing is created |
| `helper-report-author-shop`, `helper-resume-report-shop`, `helper-operator-question-shop` | helper turn → report | one reviewed submission and a matching final message when requested; direct questions stay in the helper |
| `helper-report-*-shop`, `watch-relay-live-entry-shop`, `watch-unchanged-baseline-shop` | native idle notice → watch | report receipt handling for each delivery, including an unchanged dispatch baseline |
| `watch-already-claimed-shop`, `watch-followup-retry-shop` | native idle notice → watch | no second receipt for a report already claimed; the one follow-up retry runs before any receipt |
| `helper-report-files-shop`, `helper-report-files-nofiles-shop`, `helper-report-files-no-channel-shop` | native idle notice → watch | attachment handoff through a reply tool with files, a reply tool with no file parameter, and a resident session without a channel |
| `watch-relay-unknown-sender-shop` | unmatched idle notice → watch | no reply or record |
| `worker-report-*-shop`, `task-full-report-shop` | worker receipt or report request → task | bounded report-back and verbatim full report on request |
| `helper-terminal-*-shop`, `task-route-idle-helper-shop` | spawn or task intake | auto-close for decision-free terminal helper work and routing to an idle helper |
| `helper-steer-offline-local-shop`, `helper-steer-offline-remote-shop` | operator steer → task → bound helper | a local helper with no `claude agents --json` row is resumed in place, not messaged; an offline helper on another machine gets an offer of a new helper, not "queued". SendMessage and ListAgents are stood in, since no sandbox produces an offline row |
| `evolve-runner-template-conflict-home` | evolve-runner (standalone body) | a template conflict is parked as `.new` and reported |

Resident cases append the resident prompt hermitd-start launches with and set `EVAL_HERMIT_RESIDENT=1`. Cases that write files are tagged `chains-write` and need `--allow-tools Write SendMessage Bash` (`task-answer-waiting-record-shop` grades a `SendMessage` to the last worker, `two-concurrent-dm-tasks` grades its close through a `.hermit/bin/hermitd-run` stub that returns the real `task.ts` output per verb and record id, and an ungranted tool is withheld), which applies to the whole run, so run that tag on its own; `--tag train` also selects them. Known gaps on a host where Bash cannot run in eval runs: the worker reaching `done`, the helper launch, and a real `evolve-runner` dispatch (its first steps run `claude --version` and `bun --version`), so `evolve-runner-template-conflict-home` runs the agent body directly. `task-worker-needs-input-shop` ends `needs-input` because the worker cannot run `task.ts`; it changes meaning once Bash works. Hand copies in the stand-ins: the `proposal-gate` verdict mapping, `conversation.ts thread-open` (it calls the Discord API), the watch registry and the task-report rows. `task.ts list`, `task.ts open`, the task cases' UserPromptSubmit context and the resident prompt are produced by the real code at generation time.

The attachment cases supply a Portuguese report and a receipt row with two mock absolute copy paths. Graders check that the file-capable reply carries both paths in one call, that the other cases describe the files, that reply text contains no rooted paths, and that the resident leaves the stored report body unread. The no-file reply mock uses the connector’s argument shape.

`_generators/` holds the Bun scripts that write the heartbeat, proposal-triage, chains and brief run suites (`bun evals/_generators/gen-<suite>.ts` from the plugin root, with `<suite>` one of `heartbeat`, `triage`, `chains`, `brief`, `proactive`); `lib.ts` holds the helpers they share with each other and with the drift test, and `gen-chains.ts` reuses the triage fixtures from `gen-triage.ts`. Edit a generator and regenerate rather than hand-editing many `case.yaml` files, then check that `git diff evals/` shows only the change you meant.

## watch

Generated by `_generators/gen-watch.ts`. Each case is one resident channel turn asking for a watch, with the resident prompt appended. Graders check the route: a `WATCH_EVENT` turn has no inbound chat, so `met-watch-asks-stop` grades its report as a `channel-send --notice --watch <id>` Bash call instead of the Discord reply tool. A requested watch is saved through `settings-edit … append monitors` with a `watch-poll` command (English, Portuguese, "from now on" with no task skill, and a standing watch inside a task thread), a watch that is a step of the thread's task reaches `/hermitd:watch` without a `monitors` write, and a non-primary member's watch is saved with `"enabled":false` plus a `proposal queue-micro`. `.hermit/bin/hermitd-run` is a stub that prints `OK`. `cloud-report-stored` and `cloud-report-failed` start from the `CLOUD_REPORT_STORED` and `CLOUD_REPORT_FAILED` peer messages: the stored case's stub returns a hand-copied `task receipt` claim, also stood in the state block, and both grade that no Read or Bash touches `.hermit/helper-reports/`. `report-stored-local` starts from the `REPORT_STORED` notice a local helper's `task report` posts for every stored result or question; its claim is stood in the state block, and it grades that the verdict reaches the reply with the body unread. `report-stored-already-claimed` stands in an `already` claim and grades that no report-back follows. `report-stored-retry-deferred` stands in a `watched` claim whose verdict qualifies for the follow-up retry and grades no `--report` claim, no resume and no report-back. Run with `--tag watch --allow-tools Bash --scaffold`: an ungranted tool is withheld, so no call is traced. `Monitor` is never available in an eval, so the temporary route is not graded on the Monitor call itself.

## proactive

Generated by `_generators/gen-proactive.ts`. Routine cases use `ROUTINE_DUE [hermit-routine:<id>]` and grade the `hermit-routines` wrapper (precheck, the routine skill, `routines.ts finish`). `later-retry-recovery-command-pt` starts with the command recovery queues, `/hermitd:hermit-routines run <id> --retry <mark> --delivery monitor`, and grades the retry flags passed to precheck. Its stand-in is available only after a failed call. The make-me-proactive suite also includes resident channel turns for explicit reminders and consent replies. Graders check tool calls and their inputs. Notices use `channel-send … --notice`. For the ambiguous bare yes, a rubric on the mock calls checks that the reply asks which offer the operator meant, in any channel, wording or language.

| Case | Rule graded |
|---|---|
| `later-two-verdicts-one-notice` | `skills/later/SKILL.md`: one notice after all checks, one verdict per claim |
| `later-chat-bound-deliver-only` | a chat-bound claim goes through `later deliver` and its verdict, no notice |
| `later-retry-already-sent-pt` | `skills/hermit-routines/SKILL.md` retry: verdicts recorded, the notice in `already_sent` is not repeated |
| `later-retry-recovery-command-pt` | the same retry entered through the recovery command: `--retry` and `--delivery` reach precheck, the notice is not repeated |
| `reflect-no-candidates-silent` | `skills/reflect/SKILL.md` silent by default: runner dispatched, `ran_with_candidates:false`, no notice |
| `doctor-new-warn-one-notice` | `skills/hermit-doctor/SKILL.md`: one new warning, one notice, one `--mark-notified` |
| `doctor-ledger-unpersisted-silent` | an unpersisted escalation ledger sends nothing and marks nothing |
| `weekly-one-notice-pt` | `skills/weekly-review/SKILL.md`: runner dispatched, one notice, no dollar figure in the client leg |
| `make-me-proactive-grounded-offer` | one grounded proposal and decision notice, with no job write |
| `make-me-proactive-covered-watch` | an enabled saved watch suppresses the offer |
| `make-me-proactive-cancelled-subject` | a declined subject is never offered again |
| `make-me-proactive-open-subject` | a pending offer is never offered again |
| `make-me-proactive-confirmed-subject` | an accepted subject stays suppressed after its watch is gone |
| `make-me-proactive-separate-notices` | two created proposals get two separate decision notices |
| `make-me-proactive-yes-applies-once` | one consent answer, one owner write, and a check-based close |
| `make-me-proactive-explicit-reminder-routes-to-later` | a direct reminder uses `later` without invoking make-me-proactive |
| `make-me-proactive-named-yes-one-of-three` | titled ambiguity leads to an answer for the named offer and one owner write |
| `make-me-proactive-bare-yes-three-pending` | ask which offer, with no answer transition or job write |
| `make-me-proactive-no-dismisses-without-writing` | one decline and no owner write or task check |
| `make-me-proactive-heartbeat-stop-once` (`heartbeat`) | one new unbound stop question and no duplicate for the previously answered item |

Use `--allow-tools Bash --scaffold` for the make-me-proactive cases. Script output stand-ins cover consent and its titled ambiguity, owner writes, and the heartbeat evaluator and stop-key lookups. Local unit tests cover the script transitions. A stand-in printed inline lets Sonnet skip the call it stands for, so the id-less answer, the stop-question list lookups and the proposal anchor sit in scaffold files under `eval-stand-ins/` that the prompt says to read only after the attempt. Count unwanted offers in the four covered or previously offered cases and any make-me-proactive invocation in the explicit reminder case.

The state block answers only the reads a routine needs. It says, in `BASH_FAILURE` from `lib.ts` (shared with the watch suite and `two-concurrent-dm-tasks`), that Bash may fail before running (`apply-seccomp`) or report a spurious `Exit code 1`, that writes and sends count as succeeded, and that each write, send and dispatch must still be called. The wording works whether or not eval Bash runs on the host; listing write results made Sonnet narrate the routine with no Bash calls at all. The doctor routine is seeded without `model` and the cases set `model: haiku`: a haiku `Agent` dispatch would see only its dispatch prompt, never the state block. Hand copies in the stand-ins: the `doctor-check.ts` report (typed `DoctorEscalation`), the retry `retry` object (typed `ReturnType<typeof retryContext>`), the reflect precheck object, the `later deliver` result, `observations.ts graduate`, `routines.ts health`, `proposal.ts anchor`, `memory-dir.ts` and `archive-compiled.ts`. Later checks, task records and lists, `task-report.ts`, `observations.ts patterns`, `weekly-review.ts`, `channel-log.ts prune` and `archive-raw.ts` come from the real scripts at generation time.

Run from the repo root:

```bash
CLAUDE_CODE_EFFORT_LEVEL=low claude plugin eval plugins/hermitd --tag proactive --allow-tools Bash --ablation none \
  --model sonnet --runs 3 -j 3 --scaffold --keep-temp --no-publish --max-cost-usd 10 --json out.json
```

Baseline, 2026-11-14, Claude Code 2.1.325, effort low (per-run scores):

| Case | Sonnet, 3 runs | Opus, 1 run |
|---|---|---|
| `doctor-ledger-unpersisted-silent` | 1, 1, 0.5 | 1 |
| `doctor-new-warn-one-notice` | 1, 1, 1 | 1 |
| `later-chat-bound-deliver-only` | 0.8, 0.8, 0.6 | 1 |
| `later-retry-already-sent-pt` | 1, 0.8, 1 | 1 |
| `later-retry-recovery-command-pt` | 1, 1, 1 | not run |
| `later-two-verdicts-one-notice` | 0.8, 0.8, 0.8 | 1 |
| `reflect-no-candidates-silent` | 1, 0.8, 1 | 1 |
| `weekly-one-notice-pt` | 0.6, 1, 1 | 1 |

Sonnet cost $3.36, Opus $2.50. `later-retry-recovery-command-pt` was added later (2026-11-14, Sonnet, $0.45 for 3 runs). Sonnet's misses are mostly `finished-routine` (it invokes the routine skill directly instead of through `hermit-routines`, so `finish` never runs) and a skipped `later deliver` for the chat-bound claim. Mutation checks on Opus: one notice per verdict in `skills/later/SKILL.md` fails `later-two-verdicts-one-notice` on `notice-count`; deleting reflect's "Silent by default" line leaves `reflect-no-candidates-silent` passing, since a run with no candidates has nothing to send and the skill still names the rule elsewhere.

## browser

Hand-written trigger cases for the `skills/browser/SKILL.md` description: which requests move the resident from web fetch to its browser, plus a bot-check case and a `browser.enabled: false` case. Failed fetches are stood in the prompt with WebFetch withheld, so no run reaches a live site except `public-lookup-native-first` below; `browser-off` also stands in the config facts and the wrapper's `disabled` result because Bash is withheld, so it grades only the reply. Update the cases with the description. Run with `--tag browser --ablation none --scaffold`.

The `setup-assist` cases cover the initial offer (`setup-offer`), account match and mismatch (`setup-account-match`), a member reply under team approvals (`setup-team-member`), proxy routing (`setup-api-key`), manual fallback (`setup-no-browser`), the two store calls around a simulated hand back (`setup-secret`), and direct use of a named page (`setup-direct-use`). The offer and secret cases allow Bash and account for hosts where the eval sandbox prevents commands from running. Run with `--tag setup-assist --allow-tools Bash --ablation none --scaffold`.

The `saved-login` and `saved-login-team-paste` cases check that the agent issues the origin-bound login command before requesting takeover and routes a team member to the host-terminal command without writing to the vault in chat. Run with `--tag saved-logins --allow-tools Bash --ablation none --scaffold`.

The `sign-in` cases cover the plain sign-in handoff with no saved login (`login-handoff`: the task blocks on the admin before the takeover link, which uses `browser.host` and the admin's stored mention), a handback event refused as `stale_wait` (`handback-stale`: no page read, no reply), and an `expired` handback (`handback-expired`: snapshot after the exact clear, no success claim). Their scaffolds pass `mention` to `setup-seed.sh` where the admin needs a Discord mention. Run with `--tag sign-in --allow-tools Bash --ablation none --scaffold`.

`operator-account-chrome` and `no-switch-after-failure` seed `chrome: true`. The runner cannot stand in Claude in Chrome (a mock named `claude-in-chrome` is dropped from the child's MCP servers), so both grade the `ToolSearch` for its tools: the first requires one for the operator's own account; the second, after a failed agent browser, allows none and no WebFetch or WebSearch call. `public-lookup-native-first` is the one browser case that makes live web calls: it grants WebSearch and WebFetch and grades only that one of them runs and the browser skill does not. Run these with `--allow-tools WebFetch WebSearch` added to the `browser` command above; `--tag live-web` selects the live case alone.

Last run of the `sign-in` cases and the three above 2026-11-23, Claude Code 2.1.331, Sonnet at low effort, $1.88: every case 3/3.

## knowledge

Five hand-written cases score how the resident uses its knowledge store: `recall-for-past-work` (a past-decision question goes through `/hermitd:recall`, never a grep of `sessions/` or a Read of it before the search), `raw-filing-shape` (an input to keep is written flat as `raw/<type>-<slug>-<date>.md` or a `compiled/` page, with `title`, `type`, `created` and `tags` and no subfolder; Sonnet files a supplier price list as a living `compiled/topic-<slug>.md`, which the schema prefers for a subject the agent will touch again), `audience-scoped-recall` (a member asks in a non-home chat; recall passes `--chat`, and a compiled page whose `audience` is another chat is never read or disclosed), `compiled-first-answer` (a question that matches a catalogued topic page is answered from a Read of that page, graded on the Read and the page's number in the answer) and `topic-update-in-place` (a new finding on that subject edits the existing `compiled/topic-<slug>.md`, with no dated copy and no parallel topic page; a related page on another subject is fine). Each case appends the resident prompt, which carries the filing and recall rules. `seed.sh` writes a small-shop install with one session report and that private page. The scoped search stand-in is the real `search.ts` output for the seed: a home chat on a technical install reads unscoped, so the asking chat is deliberately not the home chat. The two topic-page cases add `seed-lead-times.sh`, one shared page with a shop-specific supplier lead time no model prior can supply; it stays out of `seed.sh` so the other cases' injected catalog does not change. Run with `--tag knowledge --allow-tools Bash Write Edit --ablation none --scaffold`.

Last run 2026-11-23, Claude Code 2.1.331, Sonnet at low effort, $1.03: every case 3/3. That run predates `compiled-first-answer` and `topic-update-in-place`, which have no baseline yet.

## voice-notes

Four cases score `skills/voice-notes/SKILL.md` on a Discord voice note: `voice-ok-acts` (the transcript is answered, not re-quoted after an echo), `voice-empty` (ask to resend or type, no guess), `voice-unavailable` (one neutral line, no setup advice) and `voice-member-yes-admin-question` (a member's spoken yes is refused for an admin-only decision; its scaffold reuses the `channel-routing` case of the same shape). The envelope carries the official Discord plugin's `attachment_count` and `attachments` attributes, and the suite's Discord mock answers `download_attachment` with a fixed inbox path. `seed.sh` stubs `.hermit/bin/hermitd-run` so `transcribe` prints the case's result. Run with `--tag voice-notes --allow-tools Bash --ablation none --scaffold`.

Last run 2026-11-23, Claude Code 2.1.331, Sonnet at low effort, $1.59: every case 3/3.

## approvals

Three hand-written cases cover team approvals: a Portuguese member request refused into one console-bound pending question, an unattended refusal producing one notice and no task, and an approver's yes recorded with `task answer` before the exact refused command runs once. Origins are narrated without channel envelopes, because the core mod drops a typed prompt that opens with one; for the same reason the approval case cannot pass `task answer`'s sender check, so its prompt stands in the script's `match` result for that refusal. Where the host's Bash failure hides `task open`'s output, the chat case supplies a stand-in task id. Refusal reasons are pinned to the live builder by `tests/evals-drift.test.ts`; all three carry `BASH_FAILURE`. Graders check tool actions and trace, without requiring particular wording, language, or a channel tool. `tool_used` patterns match the JSON-encoded input, so a quoted script path appears as `\"`.

Model runs, from the repo root:

```bash
claude plugin eval plugins/hermitd --tag approvals --allow-tools Bash --ablation none --model sonnet --runs 3 --scaffold --max-cost-usd 6 --no-publish
claude plugin eval plugins/hermitd --tag approvals --allow-tools Bash --ablation none --model opus --runs 1 --scaffold --max-cost-usd 6 --no-publish
```

Expected: each case passes 3 of 3 Sonnet runs and once on Opus. Last run 2026-11-15: all three cases 3/3 on Sonnet ($0.71) and 1/1 on Opus ($0.45). The host Bash failure described below remains a verification limit.

## Channel setup

Seven `channel-setup` cases cover confirmation, credentials, access reporting and the activation branches. They stand in for interactive stages and live channel delivery; graders check ordering, commands and claims.

- Every prompt starts with `/hermitd:channel-setup`: the skill sets `disable-model-invocation`, so only a leading slash command loads it (see § proactive). The rest of the prompt becomes the skill's `$ARGUMENTS`, where a `start` argument selects always-on host start.
- Eval transcripts carry no human origin, so `settings-gate.ts` refuses every `request-restart.ts` call. The managed-session prompt says to read the refusals as `resident` and accepted, so that case does not test the `--check` branch; `tool_used` counts the refused call.
- `input_match` runs on the JSON-encoded tool input, `description` included, so Bash patterns anchor on the `"command"` value and cannot end on `(?:\s|$)` after a command. The trace judge's elided middle (§ channel-routing) hides Restart now's commands, so that case uses `tool_used` and `tool_order`.

From the repo root:

```bash
claude plugin eval plugins/hermitd --tag channel-setup --allow-tools Bash --ablation none --model sonnet --runs 3 --scaffold --max-cost-usd 6 --no-publish
```

Last run 2026-11-19, Claude Code 2.1.328, Sonnet, $2.73: every case 3/3. An earlier run on the same prompts scored credential-manual-without-chrome, docker-new-entry-operator-restarts and managed-session-final-restart 2/3: a split judge vote on a correct reply, a Docker run that told the operator to rerun the wizard for access, and a managed run that omitted that the restart resumes the conversation.

## Running

From the repo root:

```bash
CLAUDE_CODE_EFFORT_LEVEL=low claude plugin eval plugins/hermitd --tag channel-routing --ablation none \
  --model sonnet --runs 3 -j 3 --scaffold --max-cost-usd 14 --no-publish
claude plugin eval plugins/hermitd --tag decision-replies --allow-tools Bash --ablation none \
  --model sonnet --runs 3 -j 3 --scaffold --max-cost-usd 6 --no-publish
claude plugin eval plugins/hermitd --tag chains-write --allow-tools Write SendMessage Bash --ablation none \
  --model sonnet --runs 3 --scaffold --max-cost-usd 5 --no-publish
```

- `decision-replies` cases call `task answer` through Bash, and a grant covers the whole run, so run that tag on its own with `--allow-tools Bash`. The `channel-routing` run above fails every one of them.
- `--ablation none`: a no-plugin arm has no routing rules to compare, and the default two-arm mode drops `tool_used: Skill` graders from the score.
- Measured on 2026-10-01, one run per case over all 33 cases: sonnet about $3.70, opus about $7.40.
- Hillclimb on sonnet with both tags; confirm the kept wording on opus before merging. Always-on agents do not run on haiku.
- `--tag` matches any listed tag, so `--tag train` spans every suite. Select one suite by its tag (`--tag heartbeat`) and read the splits from the JSON. Repeating `--case` keeps only the last glob.
- Every suite needs `--scaffold`. Pick an effort level with `CLAUDE_CODE_EFFORT_LEVEL`, which reaches the child; a case's `env` accepts only `EVAL_*` keys, and `HERMIT_RESIDENT` from the shell does not reach a run.
- Bash inside eval runs depends on the host sandbox when granted (`--allow-tools Bash`). On Claude Code 2.1.314 calls ran, including inside subagents, and each reported `Exit code 1` and a read-only `cwd` file error beside its real stdout. On 2.1.325 (2026-11-14) the maintainer host fails every call before it runs with `apply-seccomp`, and a model told only about the spurious exit code stops at the first failure. Cases that grant Bash describe it with `BASH_FAILURE` from `_generators/lib.ts`, which covers both. `$HOME` is unreadable, so `${CLAUDE_PLUGIN_ROOT}/scripts` resolves only for a plugin copied outside it. Bash writes under `.hermit/state/` fail while the Write tool works, so stand in for mutating scripts. Older suites still stand in for all script output and describe the host as having no shell; their known gaps in chains date from when it had none.
- Measured on 2026-10-02 with `--runs 3`, mean cost per run: heartbeat evaluator sonnet $0.055, haiku $0.030; heartbeat handler sonnet $0.110, haiku $0.068; proposal-triage (Sonnet caller) about $0.085. Measured on 2026-10-07 (Sonnet 5.5, Haiku 5.5): heartbeat evaluator sonnet $0.055, haiku $0.0034; proposal-triage with a Sonnet caller, agent on sonnet $0.087, on haiku $0.049. Low effort costs the same as default effort, because the cached system and plugin context dominates every run.

## Baseline, 2026-10-26

Claude Code 2.1.310, `--model sonnet`, `CLAUDE_CODE_EFFORT_LEVEL=low` (main loop; agents keep their frontmatter effort), `--runs 3`, `--ablation none`. Scores are per run.

Not re-measured after the last stand-in fix: the channel-routing numbers, and the chains-write numbers for `task-worker-needs-input-shop` and `task-answer-waiting-record-shop`, predate it. That fix replaced stand-ins in a format the current scripts no longer print. In every channel-routing case it was the pipe-format `proposal-micro match` line. In those two chains cases it was the thread key, the `task.ts open` output and the `[task thread]`/`[waiting task]` lines, which now come from the real scripts and prompt pipeline. Re-measure them before comparing new runs against these numbers.

chains: 0.862 overall for $2.34; chains-write: 0.908 for $1.55.

| Case | Runs |
|---|---|
| `judge-accept-shop` | 1, 1, 1 |
| `judge-blind-fail-closed-home` | 1, 1, 1 |
| `judge-external-quarantine-home` | 1, 1, 1 |
| `judge-suppress-no-evidence-shop` | 1, 1, 1 |
| `proposal-create-duplicate-shop` | 1, 1, 1 |
| `reflect-tier3-chain-shop` | 0, 0.2, 0 |
| `watch-relay-live-entry-shop` | 1, 1, 0.5 |
| `watch-relay-unknown-sender-shop` | 1, 1, 1 |
| `evolve-runner-template-conflict-home` | 0.8, 1, 1 |
| `task-answer-waiting-record-shop` | 1, 1, 1 |
| `task-worker-needs-input-shop` | 0.38, 1, 1 |

The generators then switched fixture JSON to plain `JSON.stringify`: compact for script output, indented for the state files and `config.json` the scripts write indented, and non-ASCII written as itself. The rerun scored chains 0.875 ($2.24) and chains-write 0.836 ($1.55). No case flipped beyond one-run variance: `reflect-tier3-chain-shop` 0, 0, 0; `watch-relay-live-entry-shop` 1, 1, 1; `task-answer-waiting-record-shop` 0.6, 1, 1 (one rubric miss on the chat messages); `task-worker-needs-input-shop` 1, 1, 0.13 (one run never dispatched the worker); every other case unchanged.

heartbeat, first per-case baseline on the same settings: 0.908 for $6.98. Every `eval-*` case scores 1 on every run except two single `json-only` misses (`eval-assistant-injection`, `eval-injected-data`). Before the `run-*` rebuild described below, the cases that pass through alert-state failed the same graders on every run:

| Case | Runs | Fails |
|---|---|---|
| `run-new-finding-notify`, `run-new-finding-pt` | 0.25, 0.25, 0.25 | final token, the notice reply |
| `run-two-notices-shop` | 0.25, 1, 0.25 | final token, both notices |
| `run-self-eval-proposal` | 0.5, 0.5, 0.5 | `proposal-create` never invoked |
| `run-repeat-finding-silent` | 0.71, 0.71, 0.71 | final token |
| `run-evaluate-dispatch-haiku` | 0.83, 0.83, 0.83 | final token |
| `run-budget-evaluate` | 0.86, 0.86, 1 | final token |

The handler dispatched the evaluator and then stopped before piping its return to alert-state. Running these cases with the earlier fixture spelling gave the same failures, so they predate the JSON change. The cases had three defects: they carried a drifted hand copy of `prompts/resident.md` instead of the resident prompt, their tick and alert-state stand-ins used an old output shape (`verdict`, upper-case `heartbeat_result`), and they scaffolded no install, so the real evaluation subagent found no `HEARTBEAT.md`. Rebuilt as resident ticks they scored 0.981 for $4.57. With their stand-ins then generated by the real scripts against each case's seeded install (see § heartbeat), they score 0.996 for $4.56: every case 1, 1, 1 except `run-injection-alert` 1, 1, 0.82. Generating them exposed two fictions in the hand copies: a `task.ts show` verb that does not exist (the record read is `task.ts list --id`), and an `alert` result for an already-reported finding, which the script reports as `ok` with no notification. The `eval-*` numbers above are unchanged by the rebuild.

`reflect-tier3-chain-shop` scores low because the quick-mode path rarely sends a current-session external-content candidate through both gates, and once dispatched the judge before triage. The task cases show a fresh worker redoing finished work instead of resuming from the record notes, and the resident sometimes retyping a report instead of acting on its delivery receipt.

channel-routing moved from hand-copied session context to the real SessionStart hook. Before: 0.925, 25/33 cases at 1.0 ($10.12). After: 0.889, 23/33 ($9.87). Flips (before → after):

| Case | Before | After |
|---|---|---|
| `bare-yes-two-open-tasks` | 0.5, 0.5, 1 | 1, 1, 1 |
| `assign-two-in-one` | 1, 0.33, 0.33 | 1, 1, 1 |
| `settings-model-change` | 1, 1, 1 | 0.33, 0.33, 0.33 |
| `assign-next-task-watch-shaped` | 0.33, 1, 1 | 0.33, 0.33, 0.33 |
| `assign-next-task-routines` | 1, 1, 1 | 1, 0.33, 0.33 |
| `assign-question-shaped`, `assign-release-note`, `proposal-no-two-open`, `settings-cadence-not-role`, `standing-role-save` | within one run | within one run |

`settings-model-change` asks for sonnet while the run model is sonnet; as a resident the model answers that it is already on sonnet instead of routing to hermit-settings. The request should name a model other than the run model.

### Bare replies and external lessons, 2026-11-03

Claude Code 2.1.316, `--model sonnet`, low effort, `--runs 3` over three rounds, `--keep-temp` traces. Before is two trees from 2026-11-02 at five rounds; after is the fix.

| Measure | Before | After |
|---|---|---|
| `proposal-act` skipped, three single-open cases | 13 of 54 | 0 of 27 |
| `names-both-numbers`, `proposal-no-two-open` | 4 of 15 | 5 of 9 |
| `names-both-numbers`, `proposal-later-two-open` | 14 of 15 | 9 of 9 |
| `reflect-tier3-chain-shop` | 0 on every run | 0.8 on 8 of 9 runs, 0 on 1 |

- A skipped `proposal-act` run asked whether the bare reply meant the one open suggestion, through the channel, instead of applying it. None acknowledged an approval and dropped it. The responder line now says to apply it "even with no question open". A shorter "unasked" skipped 6 of 27 again, so that phrase carries the fix; the line sits at the retention budget.
- The two-open misses named the suggestions by title only. The line now says "by number, not title".
- The old reflect fixture was a newsletter instruction with no `[origin: external]` marker and no consequence, so quick reflect dropped it before the gates. It now uses the `Channel pattern: … [origin: external]` lesson the responder writes, with the full-price order as own-work consequence. Quick mode states that this candidate meets recurrence on the Tier-1 `current-session` path.
- The 0.8 runs miss one grader: `proposal-create` did not re-run triage on a candidate reflect had just triaged. The 0 run was a triage suppression.
- `branches.md` then gained the same carve-out: a `current-session` candidate that is Tier 3 only through the external-origin override keeps the Tier-1 recurrence path. Over 9 runs, 7 reached both gates (five 0.8, two 0.4 where the rubric failed a narrower "ask before applying" proposal 2 to 1), and 2 declined in main, calling a customer's instruction unfit for a standing rule. `judge-external-quarantine-home` and `judge-suppress-no-evidence-shop` stayed at 1.
- Current-session candidates then cited the record's task ID instead of `Sessions: current`, which matched no `task-report` row the judge is handed. Reflect scored 0.8 on 3 of 3, every run judged against `T-20261020-090000`; `judge-accept-shop` and `judge-external-quarantine-home` stayed at 1.
- Neighbor bare-reply cases scored 1, 3 runs each. Opus on the five proposal cases: 14 of 15, one `names-both-numbers` miss.

### Task-intake repair, 2026-11-04

Claude Code 2.1.318, `--model sonnet`, low effort, `--runs 3`, $7.47 for the targeted cases on the branch with the intake stand-ins and `focus: trace` rubrics. Before is the gated run on the pre-tag merge.

| Case | Before | After |
|---|---|---|
| `question-grows-investigation`, `three-plain-questions`, `harness-model-unrecorded` | 0.75 each run | 1, 1, 1 |
| `start-one-liner` | 1, 1, 0.75 | 1, 1, 1 |
| `approval-rules-approver` | 6-turn cap on 2 of 3 | 1, 1, 1 |
| `dm-follow-up` | 0.75, 0.75, 0.75 | 1, 1, 1 |
| `dm-unrelated-work`, `plan-awaiting-approval` | 0.75 each run | 0.75 each run |
| `two-assignments-one-task` | 0.75, 0.75, 0.75 | 0.75, 0.75, 0.25 |
| `assign-multi-for-today` | 0.25 each run | 0.25, 0.75, 0.25 |
| `assign-next-task-routines`, `assign-next-task-watch-shaped` | 0.33 each run | 0.33 each run |
| `assign-question-shaped` | 0.77 mean, 6-turn cap twice | 0.33, 1, 0.33 |
| `assign-release-note` | 0.33 each run | 0.33, 1, 1 |
| chains-write `task-answer-waiting-record-shop` | 0.63, 0.63, 0.25 | 0.63, 1, 1 |
| watch `met-watch-asks-stop` | 0.83 each run | 1, 1, 1 |
| watch `step-in-task-thread-temporary` | 0.67, 0.67, 1 | 1, 1, 1 |

- The remaining routing-rubric failures were the elided trace, not routing: those runs passed `task-skill`. The rubrics were then replaced as described in § channel-routing.
- `assign-next-task-*` answered as Standing work on Sonnet 6 of 6 and Opus 1 of 1. Questions that name routines or watches are Standing work, and intake has no trigger words, so the cases now expect that answer with no task.
- `assign-multi-for-today` and the other assign misses asked the requester for details without opening a task. The responder now counts that as a longer exchange and names `/hermitd:task` in the assignment branch.
- After those changes, same settings, partial run (cut short by the account limit): `two-assignments-one-task`, `dm-unrelated-work` and `plan-awaiting-approval` 3 of 3; `assign-multi-for-today` 2 of 3 and `assign-two-in-one` 1 of 3, both missing `/hermitd:task`; `assign-next-task-routines` 0 of 3 only on a `reference.md` read grader. That grader was dropped: § Standing work gathers through scripts and state files the case neither stands in for nor allows. Then, at the commit rewording `assign-two-in-one` so its disk part needs investigation ($2.88): `assign-two-in-one`, `assign-next-task-routines`, `assign-next-task-watch-shaped`, `assign-question-shaped`, `proposal-no-two-open` and `dm-follow-up` 3 of 3; `assign-release-note` 2 of 3 (one run skipped `/hermitd:task`); `standing-role-save` 0 of 3, every run on the `reference.md` read grader, even with that Read moved first in the branch.
- `standing-role-save` grants no Write and forbids state reads, so the save cannot happen there and the save procedure in `reference.md` is never needed. Its read grader became a `mock_calls` rubric on the reply: 3 of 3 ($0.34), one run also hitting the 6-turn cap after its reply.

## Changing routing wording

Change one rule at a time and keep it only when both `train` and `heldout` improve; revert when only `train` rises (overfitting) or either drops. A new misroute seen in the field becomes a `heldout` case first.

## first-chat

Three cases grade the agent's behaviour given the first-chat text: the requested result comes before the introduction, a history-seeded second turn does not repeat the time check, and a non-English first message leads to a supplied-value language call after the reply. The generator reads `prompts/first-chat.md` verbatim for first-turn prompts and the second-turn history. Graders check ordering and actions, without requiring a particular greeting or channel. These cases do not verify the hook, admission or marker consumption; the prompt-stage and pipeline tests own those contracts. Generate with `bun evals/_generators/gen-first-chat.ts`. Running the suite uses model spend and remains an operator choice.
