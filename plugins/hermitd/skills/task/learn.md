# Close-time skill learning

Input: a closed task with `skill_review: "pending"`, its notes, and the reusable procedure behind its verified result. Review autonomously; do not ask the operator to approve learning. A pending review survives interruption; resume it before marking it complete.

Read the worker's `.hermit/helper-reports/<id>.procedure.md` when present (the report id comes from its WORKER completion), otherwise make a bounded read of the `## Progress` notes and result in `.hermit/tasks/<id>.md`, which hold any helper `Procedure:` note and the resident's own steps. Choose `nothing` only after reading them. Use bounded reads of relevant existing skills, their names and descriptions. A lesson alone is not a procedure. If nothing reusable emerged, finish with disposition `nothing`; if an existing skill already covers it, use `covered`.

Use this ladder in order:

1. Patch a learned skill that owns the procedure.
2. Patch an umbrella learned skill that covers the capability.
3. Add a `references/` file to that learned skill, linking it from SKILL.md.
4. Create a new capability-named skill only when those options do not fit.

Autonomous patches touch learned skills only: a skill is learned only if the `skill-ledger.jsonl` contains its `create` action. Operator and shipped skills keep their existing edit path. Inspect `.hermit/bin/hermitd-run skills status --skill <name>` when ownership is unclear. A procedure needing a routine or an agent goes to `/hermitd:proposal-create` with `## Config` plus `## Skill Draft` for a routine, or `## Agent Draft` for an agent; do not widen authority through learned content. Cite the procedure file as its `source_artifact`: the worker's `.hermit/helper-reports/<id>.procedure.md`, or for a procedure taken from the record, first write that procedure to `.hermit/helper-reports/<task-id>.procedure.md`.

Author per skill-creator's Skill Writing Guide when that plugin is installed; otherwise use [Anthropic's skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices). Keep SKILL.md focused on reusable inputs, workflow and result; move conditional detail into references. No incident logs, scripts, permission-bearing frontmatter or inline shell blocks.

Before a create, dispatch `hermitd:skill-eval-runner` with `model: sonnet`, the absolute path of `skill-gate-reference.md` beside this file, the draft, and existing skill names and descriptions. Turn a `duplicate` verdict into a patch to `duplicate_of` when it is learned; otherwise mark `covered` or propose the required operator-skill edit through the existing path. Resolve quality findings before writing a `new` draft.

Use native Write/Edit under `.claude/skills/<name>/`: the classifier reviews each write, the guard saves a revision, and lint reports errors and warnings after writing. Fix lint errors with Write/Edit and inspect warnings. Do not use shell writes or add allow rules. Learning needs `permission_mode` `auto` or `bypassPermissions`; a denied write is not permission to route around the gate. Leave review pending if the write cannot be completed.

Pin a skill the operator asked for with `.hermit/bin/hermitd-run skills pin <name> --origin operator`. For the close reply follow settled `skills.notify`: `off` adds no learning line; `on` adds one line saying what was saved, covered, or found unnecessary; `verbose` adds that line plus a short change preview. Keep channel wording free of internal paths and ids.

Finish by running `task-learn` (Commands) with `<id> --disposition saved|covered|nothing`, selecting one disposition. `saved` means the create or patch passed lint. Check the returned digest before claiming completion.
