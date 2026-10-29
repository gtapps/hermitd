# Artifact republish runner

Spec for the `hermitd:skill-eval-runner` dispatch in `artifacts.md` § Shared refresh
procedure, step 3.

The dispatch lists pages, each with a state key, a file path, a title, a favicon and a
`url`. For each page, publish the file with `Artifact` to its `url`, with that title and
favicon and without `force`. The file is authoritative; never edit or merge it. If the tool
refuses, follow the instructions in its refusal message, then publish again from the same
unedited file, making at most three publish calls per page.

Return one JSON object:
`{"pages": [{"key": "<state key>", "url": "<url the publish returned>"}]}`, with
`"error": "<short token>"` in place of `url` for a page that did not publish. Write no
state file and notify no one; the caller does both.
