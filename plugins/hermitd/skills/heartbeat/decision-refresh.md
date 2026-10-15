# Decision Refresh

Instruction spec for re-checking pending decisions before the hermit asks the operator about them again. The heartbeat and brief dispatches name this file next to their own spec.

Each item is either a question the hermit queued earlier (`micro-proposal-pending:<MP-id>`) or a proposal awaiting review (`proposal-pending:<PROP-id>`). Its `text` is the wording from when it was queued, and work may have landed since. Your job is to make the line the operator reads true today. Check at most five items, in the order given, and return any beyond that as `open`.

## Steps

1. **Read what each item asks.** A micro item: its entry in `.hermit/state/micro-proposals.json`, by id. A proposal: `.hermit/proposals/<PROP-id>-*.md`.
2. **Look for local evidence that the asked-for change already exists.**
   - The project files the question names, such as whether the line it asks to add is present.
   - `git log` in the project: commit subjects, or `git log -S<text>` and `git log -- <path>`.
   - The installed plugin version and `CHANGELOG.md` under the `plugin_root` you were given.
   - `.hermit/tasks/` records and other proposals that settled the same thing.

   Use local sources only: no `gh`, no web, no network. Read only: write nothing and run nothing that changes state. A few checks per item is enough.
3. **Classify each item.**
   - `done`: the change it asks for is in place. Cite the evidence: a file and line, a commit, a version.
   - `partial`: part of it landed, and what remains is still the operator's call.
   - `open`: nothing changed, the evidence is inconclusive, or a source is unavailable (no git repository, a missing or unreadable file). This is the default.

   A question that asks the operator to judge, such as "close it as resolved?" or "which option?", never becomes `done` on your own judgment. At most it is `partial`, carrying the facts that bear on the choice.

## Wording

`text` is what the operator reads in chat, often on a phone. Use plain language, put the evidence in the sentence ("declared in the knowledge schema since Oct 10"), and leave out internal ids (`PROP-`, `MP-`, task ids) and file paths unless the item is about a file.

- `done`: say what is already in place. The caller groups done items under one "Looks already done" line, so don't ask anything.
- `partial`: say what landed and what didn't, then end with the choice that remains ("close it, or keep it?").

## Return

Add this key to the same JSON object as the other spec's keys:

`"refresh": [{"key": "<item key, verbatim>", "status": "open|done|partial", "text": "<channel-voice line>"}]`

Return one entry per item you were given, with keys copied exactly. `text` is required for `done` and `partial`. Never drop or invent a key.
