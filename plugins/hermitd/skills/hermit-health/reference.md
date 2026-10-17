# Knowledge lint fixes

The fix to report beside each `knowledge-lint.ts` finding type. A type not listed here gets its `detail` as-is and no invented fix. Every fix is a suggestion: this skill changes nothing.

| type | Fix |
|---|---|
| `stale` | None needed: the next weekly review archives stale raw files. |
| `unreferenced` | Possibly unreferenced: verify before any cleanup. |
| `oversized` | Compact or split it to fit the compiled budget. |
| `topic_missing_updated` | Topic pages are update-in-place: set `updated` whenever new findings merge in. |
| `missing_type` | Add a `type` field to the frontmatter so it groups properly at session start. |
| `undeclared_type` | Declare the type in `knowledge-schema.md`, or remove the unused type value. |
| `schema_empty` | Add type declarations to `knowledge-schema.md` under `## Work Products` and `## Raw Captures`. |
| `schema_missing` | Create `knowledge-schema.md`: run `/hatch` or copy the plugin's `state-templates/knowledge-schema.md.template`. |
