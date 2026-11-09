# Dream evals

Regenerate the cases after prompt changes with `bun plugins/hermitd/evals/_generators/dream.ts`. Agent cases append the live dream agent body and pin Haiku. The cookbook lead case invokes `/hermitd:dream` on Sonnet and dispatches the workers at their frontmatter models.

The corpus in `_fixtures/transcripts/` is the cookbook's eleven-file synthetic example set, copied unchanged with its MIT notice. The lead case checks retention across the whole set. Targeted cases check duplicate retirement, explicit corrections, unresolved conflicts, injection, secret redaction, audience boundaries and foundational preservation.

As with the other file-writing suites, use `--scaffold --allow-tools Write Edit Bash` to create the fixtures and authorize real file edits. Script outputs alone are stand-ins in the lead case; worker dispatch and file edits are real. A maintainer invocation is:

```bash
claude plugin eval plugins/hermitd --tag dream --scaffold --allow-tools Write Edit Bash --ablation none --no-publish
```

The original bare verification command omits fixture setup and tool grants, so it cannot pass file-based graders. Use the invocation above; add `--runs 1` while iterating. Evals need the host's Claude authentication, plugin trust and eval access. Unit fixtures separately exercise export, finish, restore and undo with real scripts.
