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
surface.

## channel-routing

Synthetic channel turns that score `skills/channel-responder/SKILL.md` § 2 (Classify the Message): which route each message takes and whether the reply stays in channel voice. The `maintainer-content-stays`, `sibling-thread-reference` and `thread-go-ahead-resolves-here` cases score the § 3 chat boundary.

Each case's `scaffold.sh` copies the live `state-templates/TASKS.md.template` and writes `config.json` with the case's `operator_profile`, so the task policy comes from the real hook. The prompt carries what no hook produces in an eval run: the reply reminder and responder nudge (checked by the drift test), any `[harness-command]`, `[pause]`, `[task thread]` or `[conversation command]` line, and a `Hermit state` block standing in for the `config.json` facts the responder reads (`operator_profile`, language, primary operator), `task.ts list`, `proposal-micro match` and the proposals index. No hook injects those config facts; without that line, the non-technical spend case called cost-reflect in 3 of 3 runs on 2026-10-26. The cases are hand-written; update them in the same change as that wording. The Discord reply tool is a fixed mock under `mocks/plugin_discord_discord/`, so reply text is graded through `mock_calls`. The resident prompt is not appended here, unlike in `chains`.

## heartbeat

Two case families, tagged `heartbeat` plus `train` or `heldout`. Cases tagged `varied-install` use other domains (home automation, small shop, personal assistant) and checklists in Portuguese, Spanish and German, so the scores never rest on one install's vocabulary.

- `eval-*` score `skills/heartbeat/reference.md`, the evaluator that `heartbeat.model` runs. A scaffold copies the live `reference.md` into the run workspace as `spec/heartbeat-reference.md`, `append_system_prompt` carries the `skill-eval-runner` agent body, and the prompt carries the dispatch text plus a state block with the checklist and the data each item needs. Graders check the return contract: bare JSON (`alert-state` rejects anything else as `invalid-json`), the firing count, the checklist line as `item`, no reserved keys and no internal IDs. They also check judgment: still-true items keep firing after they are suppressed, and instructions planted in the data are ignored.
- `run-*` score the `run` handler in `SKILL.md` as the resident runs it: the case appends the resident prompt and sets `EVAL_HERMIT_RESIDENT=1`, and its scaffold writes the case's seeded resident install: `config.json` with its `escalation`, `language` and heartbeat settings, the live `TASKS.md` template, its `HEARTBEAT.md` (read by the real `skill-eval-runner`), and any state or task record the case needs. The generator runs the real `heartbeat.ts tick`, `alert-state` (fed the case's evaluation return), `ack-queue`, `task.ts list` and `cost-tracker.ts --mark-budget-notified` against that same install under a frozen clock (`_generators/fixed-clock.ts`), so the stand-ins in the state block are what the scripts print for the files on disk. The prompt is the Monitor's `HEARTBEAT_EVALUATE` envelope plus that state block, with a `config.json` stand-in line. `channel-send` is replaced by the Discord reply mock. The `skill-eval-runner` dispatch is real, so graders can check its `model` param.

## brief

The heldout evening case scores `skills/brief/reference.md` against a task whose final result contradicts an earlier lesson and a routine with an old `last_woke` beside a recent `skipped-precheck`. Its scaffold copies the live reference into `spec/brief-reference.md`, `append_system_prompt` carries the `skill-eval-runner` body, and the prompt carries bounded command outputs. Graders check JSON-only output, exclusion of the contradicted finding, and no missed-run claim for the healthy precheck skip. Run with `--tag brief --scaffold`.

The `run-*` and `dispatch-*` cases drive the real `/hermitd:brief` against a busy seeded install, with the real read-only scripts and the resident prompt. They need the plugin outside `$HOME` (see Running), so copy it to `/tmp` first and target the copy by absolute path, with `--allow-tools Bash Write`. `dispatch-*` (tag `brief-dispatch`) has one grader, that the runner was dispatched. `run-*` (tag `brief-run`) grades the delivered brief with regexes: an LLM rubric failed briefs that were correct, 3 votes to 0. `run-stale-context` resumes `history.jsonl`, an earlier conversation that calls finished work waiting. `run-morning-context` (tag `brief-morning`) checks that a morning brief names the newest record with its close date. To size the main context, generate with `BRIEF_HISTORY_KB=250` in the copy; commit only the default. A run labelled with the runner arm may not have dispatched, so classify each run from the `Agent` calls in its `--keep-temp` trace.

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
| `task-worker-needs-input-shop` | task → background task-worker | real background dispatch, the worker's report file, the chat placeholder |
| `task-answer-waiting-record-shop` | task answer path → last worker → fresh task-worker on refusal | the answer reaches the last worker; the fallback receives the record notes and answer |
| `task-close-outside-skill-shop` | close digest → review guide | a pending close leads to the guide with the task skill out of reach |
| `proposal-create-duplicate-shop` | proposal-create → proposal-triage | an open duplicate is named, nothing is created |
| `watch-relay-live-entry-shop`, `watch-relay-unknown-sender-shop` | helper `GUEST_REPORT` → watch | verbatim relay to the operator; no reply for an unknown sender |
| `evolve-runner-template-conflict-home` | evolve-runner (standalone body) | a template conflict is parked as `.new` and reported |

Resident cases append the resident prompt hermitd-start launches with and set `EVAL_HERMIT_RESIDENT=1`. Cases that write files are tagged `chains-write` and need `--allow-tools Write`, which applies to the whole run, so run that tag on its own; `--tag train` also selects them. Known gaps on a host where Bash cannot run in eval runs: the worker reaching `done`, the helper launch, and a real `evolve-runner` dispatch (its first steps run `claude --version` and `bun --version`), so `evolve-runner-template-conflict-home` runs the agent body directly. `task-worker-needs-input-shop` ends `needs-input` because the worker cannot run `task.ts`; it changes meaning once Bash works. Hand copies in the stand-ins: the `proposal-gate` verdict mapping, `conversation.ts thread-open` (it calls the Discord API), the watch registry and the task-report rows. `task.ts list`, `task.ts open`, `proposal-micro match`, the task cases' UserPromptSubmit context and the resident prompt are produced by the real code at generation time.

`_generators/` holds the Bun scripts that write the heartbeat, proposal-triage, chains and brief run suites (`bun evals/_generators/gen-<suite>.ts` from the plugin root, with `<suite>` one of `heartbeat`, `triage`, `chains`, `brief`); `lib.ts` holds the helpers they share with each other and with the drift test, and `gen-chains.ts` reuses the triage fixtures from `gen-triage.ts`. Edit a generator and regenerate rather than hand-editing many `case.yaml` files, then check that `git diff evals/` shows only the change you meant.

## Running

From the repo root:

```bash
CLAUDE_CODE_EFFORT_LEVEL=low claude plugin eval plugins/hermitd --tag channel-routing --ablation none \
  --model sonnet --runs 3 -j 3 --scaffold --max-cost-usd 14 --no-publish
claude plugin eval plugins/hermitd --tag chains-write --allow-tools Write --ablation none \
  --model sonnet --runs 3 --scaffold --max-cost-usd 5 --no-publish
```

- `--ablation none`: a no-plugin arm has no routing rules to compare, and the default two-arm mode drops `tool_used: Skill` graders from the score.
- Measured on 2026-10-01, one run per case over all 33 cases: sonnet about $3.70, opus about $7.40.
- Hillclimb on sonnet with both tags; confirm the kept wording on opus before merging. Always-on agents do not run on haiku.
- `--tag` matches any listed tag, so `--tag train` spans every suite. Select one suite by its tag (`--tag heartbeat`) and read the splits from the JSON. Repeating `--case` keeps only the last glob.
- Every suite needs `--scaffold`. Pick an effort level with `CLAUDE_CODE_EFFORT_LEVEL`, which reaches the child; a case's `env` accepts only `EVAL_*` keys, and `HERMIT_RESIDENT` from the shell does not reach a run.
- Bash inside eval runs works on the maintainer host when granted (`--allow-tools Bash`), checked on Claude Code 2.1.314, including inside subagents. Each call reports `Exit code 1` and a read-only `cwd` file error beside its real stdout. `$HOME` is unreadable, so `${CLAUDE_PLUGIN_ROOT}/scripts` resolves only for a plugin copied outside it. Bash writes under `.hermit/state/` fail while the Write tool works, so stand in for mutating scripts. Older suites still stand in for all script output and describe the host as having no shell; their known gaps in chains date from when it had none.
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

`reflect-tier3-chain-shop` scores low because the quick-mode path rarely sends a current-session external-content candidate through both gates, and once dispatched the judge before triage. The task cases show a fresh worker redoing finished work instead of resuming from the record notes, and the resident sometimes writing its own reply instead of the `[[helper-report <id>]]` placeholder.

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

## Changing routing wording

Change one rule at a time and keep it only when both `train` and `heldout` improve; revert when only `train` rises (overfitting) or either drops. A new misroute seen in the field becomes a `heldout` case first.
