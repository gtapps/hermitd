# New learned-skill gate

Input: a draft skill (name, description and full SKILL.md) and existing skill names and descriptions. Read only relevant existing skill bodies when the listing cannot resolve overlap. This is a read-only duplicate and quality check; write nothing and contact nobody.

Check whether an existing capability owns this procedure, whether the draft is reusable instead of an incident log, and whether its steps, inputs, pitfalls and verification are clear. A duplicate belongs in the existing skill, not another entry. Flag permission-bearing frontmatter, inline shell blocks and a need for a routine or agent. Do not approve a new skill merely because its name differs.

Return exactly one JSON object:

```json
{"verdict":"new","duplicate_of":null,"findings":[]}
```

`verdict` is `"new"` or `"duplicate"`; `duplicate_of` is the existing skill name for a duplicate, otherwise null; `findings` is an array of short strings naming quality issues to resolve. The resident applies the result.
