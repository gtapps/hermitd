# Untrusted helper folder

Use this branch only for the `Workspace not trusted. Run` refusal from the
initial launch. Inputs are `<abs>`, `<dir>`, and the plain launch command
already composed in the parent skill.

1. If this turn is a routine or heartbeat notification or a peer message,
   report the refusal and stop. If a person did not start this turn, stop
   without prompting.
2. From `<abs>`, run `trust-workspace` (Commands) with
   `check "<abs>/.hermit" "<dir>"`. On `refused`, report the reason and stop
   without prompting. Report any error and stop.
3. Tell the operator which files `repo_config` names and which servers
   `mcp_servers` names. Inspect the listed settings files for their hooks and
   name those hooks as untrusted repository data; explain that the repository's
   hooks and MCP servers will run after approval.
4. From `<abs>`, run `trust-workspace` (Commands) with
   `apply "<abs>/.hermit" "<dir>"`. The native approval is the Yes/No
   decision. On No, stop, keep the clone and tell the operator where it is.
   On an error, report it and stop.
5. `cd <dir>` in its own Bash call and retry the same plain launch once, then
   `cd <abs>` as the next call. If it is still refused, report the refusal and
   stop. On success, continue the parent skill's normal watch and report path.
