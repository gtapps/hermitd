---
name: spawn-session
description: Spawns a background Claude Code helper in the project or another folder with the configured Remote Control and the boot-written helper system prompt that a hand-built `claude --bg` omits, watches it until idle, and relays its report to the operator. Use when the operator says "spawn a helper", "spawn a new session", "run this in a background session", asks for a new session with `--model` or `--effort`, or names `/spawn-session`.
---

# Spawn Session

Launch a background Claude Code session in a folder, subscribe to its idle
notice, and relay the report through `/hermitd:watch`.

## Usage

```
/hermitd:spawn-session <prompt-or-/skill> [--cwd <abs-dir>] [--worktree] [--name <n>] [--model <m>] [--effort <e>] [--background <abs-file>] [--proposal <PROP-id>] [--strict-mcp-config]
```

From `<dir>`, the launch folder (`<abs>`, the hermit project root, unless
`--cwd` names another), that composes:

```
claude --bg --name <n> [--worktree <n>] [--permission-mode <p>] [--remote-control <n>] [--model <m>] [--effort <e>] [--mcp-config <dir>/.mcp.json] [--strict-mcp-config] --append-system-prompt-file <abs>/.hermit/state/helper-system-prompt.md '<prompt>'
```

`--worktree <n>` is present only when the operator passed `--worktree`, and
gives the helper its own worktree of `<dir>` from the start.
`--remote-control <n>` is present when `config.json`'s `remote` is `true` and
absent otherwise; `--model` and `--effort` only when the operator passed them.
`--mcp-config <dir>/.mcp.json` and `--strict-mcp-config` only when the operator
passed `--strict-mcp-config`: both flags when `<dir>/.mcp.json` exists, and
`--strict-mcp-config` alone when it does not. Strict mode drops plugin and
user-scope MCP servers from the helper. A background session cannot answer
the project-server approval dialog, and a folder named by `--cwd` brings its
own `.mcp.json` to that dialog.
A helper report counts only when its sender's session name equals the `target` of a live `peer-idle` registry entry; the epoch-suffixed helper name is what distinguishes one spawn from a reused name. The helper never writes `tasks/` or `proposals/`; the resident records progress and results after that sender check.

Six limits sit on that command:

- The helper starts in `<dir>`. In a repository's main checkout, Claude Code
  refuses its Edit and Write until it calls `EnterWorktree`: the
  `worktree.bgIsolation` setting, `"worktree"` by default
  (https://code.claude.com/docs/en/settings-reference#worktree-bgisolation).
  `"none"` in that project's settings lets helpers edit the checkout directly,
  on whatever branch the resident has checked out; this skill never sets it.
  A linked worktree is edited in place under either value, and Bash git
  commands are not fenced by the setting. Outside a git repository the block
  still applies, so a non-git `<dir>` leaves the helper read-only.
- Any file the helper must Read is passed as an absolute path in the prompt,
  spelled as an `@<abs-path>` mention so Claude Code injects it at launch; a
  worktree does not carry the hermit's untracked state.
- `<abs>/.hermit/state/helper-system-prompt.md` is written at boot
  and gated like `RESIDENT.md`. Pass it as `--append-system-prompt-file` (a
  system-prompt file is not expanded, so `@<abs-path>` mentions still belong
  in the prompt). The appended text reaches the helper's main conversation
  and forks, not its non-fork subagents.
- `--permission-mode <p>` from `config.json`'s `permission_mode` keeps the
  helper in this session's permission class, which is what lets its idle
  notice reach here rather than being held for an operator who is not
  watching. `config.json` accepts one value the CLI has no
  choice for, `default`, so it and `null` and an absent key all mean: leave the
  flag off entirely and let the helper take the box default.
  `scripts/hermitd-start.ts` resolves `default` and `null` the same way;
  match that rather than inventing a second answer. It does not agree on an
  absent key, which it reads as `auto` rather than as no flag.
  `bypassPermissions` is the one value that does not pass through: it
  becomes `--permission-mode auto` because a helper has no approval
  surface of its own, and `auto` is the only mode that stays unattended
  behind a gate.
- The prompt is one single-quoted argument. An apostrophe in it ends the quote,
  so replace every `'` with `'\''` before composing. Anything after the closing
  quote is a second command the operator never asked for.
- The launch is not pre-approved, and what the operator sees depends on the
  mode they run in. On `auto`, the shipped default, the classifier decides and
  no prompt reaches them on any channel. On `acceptEdits` or `manual` the native
  approval is relayed to their DM and is allow-once, so every spawn asks again.
  On `bypassPermissions` there is none. Say what is about to be spawned before
  running it either way: it is the only thing that makes the launch legible
  when an approval does arrive, and the only record when none does.

Use only the launch options documented here. Never add bypass flags, tool
preapprovals, or settings overrides to widen the helper's permissions. If launch
or execution is blocked, report the blocker; do not retry through a script,
alternate invocation, or weaker permission mode.

## Plan

1. Parse `--cwd`, `--worktree`, `--name`, `--model`, `--effort`, `--background`, `--proposal`, and `--strict-mcp-config` from the invocation. `--cwd` must be an absolute path to an existing directory. `--background` must name an existing absolute file; append it to the prompt as an `@<abs-path>` mention. `--proposal <PROP-id>` is resolved in step 2 before any launch.
   Remaining text is the prompt. Empty prompt: stop with a one-line ask for
   the work to run.

   - When `--name` is omitted, derive `<n>` from the prompt: drop a leading `/`
     and any `<plugin>:` namespace, lowercase, replace every non-`[a-z0-9]` run
     with `-`, keep the first five nonempty tokens joined by `-`, cap the slug
     at 40 characters, trim any leading or trailing `-`, then append `-` plus
     the full epoch (`date +%s`). The trim is what keeps a prompt like
     `#220 fix the parser` from producing a name the launch command reads as a
     flag. The epoch is not truncated because the watch registry keys on the
     full name. With `--worktree` it also matters because `claude --worktree
     <n>` silently reuses an existing `.claude/worktrees/<n>`, its branch and
     uncommitted state included, so a repeated name is a wrong-branch start
     with no error. If no token survives the slug is `session`, which is what
     makes the fallback `session-<epoch>`.
     Example: `/tackle-issue PROP #220` becomes
     `tackle-issue-prop-220-1788889689`.
   - `<m>` / `<e>` are omitted when the operator does not name them, so the
     helper takes the box defaults.

2. Resolve `<abs>` with `git rev-parse --show-toplevel` rather than reading the
   Bash tool's working directory, which persists across calls and can sit in a
   subdirectory. `<dir>` is `--cwd` when given, else `<abs>`. No further
   check on `<dir>`: a folder the CLI refuses is reported with the CLI's own
   message. With `--worktree`, run
   `git -C <dir> rev-parse --verify HEAD`; on failure, refuse with one line
   before composing any launch: `<dir>` is not a git repository or has no
   commits; make an initial commit, then retry. An unborn HEAD makes the background launch report
   success and then crash-loop on worktree creation. When `--proposal` was passed, resolve it
   now through `proposal.ts resolve-id` (proposal-act § Resolving a Proposal ID)
   against `<abs>/.hermit`:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts resolve-id <abs>/.hermit "<PROP-id>"
   ```
   Anything but `MATCH|<filename>` refuses before any launch, with the resolver's
   reason. On MATCH, append the absolute proposal path
   `<abs>/.hermit/proposals/<filename>` to the prompt as an
   `@<abs-path>` mention, the same way `--background` is. Read `<p>` from `<abs>/.hermit/config.json`
   (`permission_mode`), dropping the flag for `default`, `null` or an absent
   key, mapping `bypassPermissions` to `auto` (Six limits), and passing
   every other value through unchanged. Read `remote` from the same config
   and include `--remote-control <n>` only when the key is present and
   `true`; `false`, `null` and an absent key all leave the flag off, which
   is the resident session's own answer for that config. When the operator
   passed `--strict-mcp-config`, include `--mcp-config <dir>/.mcp.json
   --strict-mcp-config` if `<dir>/.mcp.json` exists, and `--strict-mcp-config`
   alone if it does not. Check that
   `<abs>/.hermit/state/helper-system-prompt.md` exists; boot
   writes it. If it is missing, refuse with one line: restart with hermitd-start
   so boot writes the helper system-prompt file.

3. `cd <dir>` as its own Bash call, then run the command in Usage as the next
   one, so the launch stands alone in the transcript and in any approval that
   does reach the operator. With `--cwd`, then `cd <abs>` as the next call
   whatever the launch returned: the `task.ts` and `proposal.ts` calls below
   resolve the relative `.hermit` against the Bash tool's
   persisted directory. Print the returned bg id and `claude logs <id>`,
   `claude attach <id>`, `claude stop <id>` hints. If the spawn is declined or
   fails, stop; do not watch, open a record, or patch a Decision.
   After every successful launch, read the full session id `<sid>` once:
   ```bash
   claude agents --json | jq -r --arg id <bg-id> '.[] | select(.id==$id) | .sessionId'
   ```
   The printed bg id is only the first 8 characters of `<sid>` and is not a
   resume handle. An empty result means no `<sid>`: say so, write the lines
   below without `(<sid>)`,
   and continue to step 4. Without `--proposal`, inside an open record's turn,
   append `Handed to helper <n> (<sid>).` as a progress note by piping it into
   `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts note .hermit <T-id>`,
   where `<T-id>` is that open record's id, not the bg id (the note is
   timestamped for you).
   After the handoff note, bind the record with
   `bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts note .hermit <T-id> --owner helper:<n>`.
   On `invalid-owner` (a custom name outside `[A-Za-z0-9._-]{1,64}`) or
   `owner-busy`, leave it resident-owned and tell the operator why.
   With `--proposal`, open the record (title names
   the helper work; requester is the current operator or channel identity). The
   key is `helper:PROP-NNN`, not `proposal:PROP-NNN`: that second key belongs to
   the proposal's implementation record, and reusing it would hang the helper's
   result on work the helper did not do. A second spawn on the same proposal
   reuses this record rather than duplicating it:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/task.ts open .hermit \
       --title "Helper work on PROP-NNN" --requester <requester> \
       --done "helper report recorded on the proposal" --dedupe-key "helper:PROP-NNN"
   ```
   Then append one handoff line with no `--set`:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/scripts/proposal.ts patch .hermit <filename> --stdin <<'HERMIT_PATCH'
   Decision: Handed to helper <n> (<sid>) on @now; record <T-id>.
   HERMIT_PATCH
   ```

4. Invoke `/hermitd:watch session <n> "<first 40 chars of the operator prompt>" --id <bg-id>`.
   When the watch reports the helper blocked on its `waitingFor`, give the operator
   `claude attach <id>` to answer it (in Docker,
   `docker exec -it <container> claude attach <id>`).
   Whenever step 3 bound or opened a record, also pass `--record <T-id>`.
   With `--proposal`, also pass `--proposal <PROP-id>`.
   That skill owns the subscription (`watch/session-watch.md` § Starting a session watch)
   and the idle-notice relay (`watch/notices.md` § Handling idle notices); do not re-implement either.
   When it declines the subscription, pass on the reason it gives rather than
   asserting one: the helper may still be running, or it may have finished its
   first turn before the subscription landed. Either way, give the
   `claude logs <id>` id as the way to check on it. When the decline is
   `No session named <n> is reachable from here` and the launch printed a bg
   id, run `claude logs <id>` and show the operator the last few
   ANSI-stripped lines; name the state those lines show (a boot dialog it
   cannot answer, a crash, a finished turn) rather than one they do not. A
   declined subscription writes no registry entry, so no report can ever
   reach the record opened in step 3: cancel it with the decline reason
   (`task.ts cancel .hermit <T-id> --actor <requester> --reason-stdin`)
   and say whether the tail leaves the helper running unwatched or stuck,
   rather than leaving a commitment waiting on a report that cannot arrive.

## Stuck helper

`claude logs <id>`, `claude stop <id>`, and the watch expiry notice. Never tmux.
Idle is not stuck: watch's idle-notice relay leaves an idle helper running.
A boot dialog in `claude logs <id>` is handled as in this terminal: relaunch
with the option that makes the dialog moot when one exists, otherwise give
the operator `claude attach <id>` (for a hermit in Docker,
`docker exec -it <container> claude attach <id>`), because Remote Control is
not connected before boot.
