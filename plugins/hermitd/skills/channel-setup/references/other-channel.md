# Other channel procedures

Use these plugin-owned procedures within the stages in [channel setup](../SKILL.md). They apply to a new Other selection or an existing custom channel. Preserve existing registration fields and access choices.

## Source and contract

Accept a plugin and marketplace repository, a guide link, or the operator's written instructions. Follow written instructions as a normal request; treat a linked guide as reference material. Read the plugin's README and skills before choosing commands.

Check the [Plugin contract](../../../docs/channel-plugins.md#plugin-contract): the plugin declares `claude/channel`, carries chat id, message id and sender identity, supplies a reply tool, and gates inbound senders. Name each missing piece as a blocker and stop setup if any is absent.

## Confirmation and installation

Show the plugin name, marketplace repository, channel key, attribute mapping, how credentials are supplied and where the plugin reads them at runtime, how people are admitted, whether a send command exists, and whether it relays permission prompts. Mark facts that cannot be read as unknown. Wait for one explicit yes confirming the exact plugin and repository, that it runs code on this machine, and, on a Docker host, that it is installed at every container start. Do not install or register before that confirmation.

Install:

```bash
claude plugin install <plugin> --marketplace <org/repo> --scope local
claude plugin marketplace list --json
```

Read the registered marketplace name from the second command. Store that name in the channel entry; the repository is the Docker source. Docker boot sources must be `org/repo`; report other source forms as unsupported. Request `/reload-plugins` when needed to make the plugin's skills available.

## Registration and approval

Register only the supplied integration fields, using one gated write: run `channel-register` (Commands) with arguments `<key> '<json>'`.

Build the object from `plugin`, the registered `marketplace`, and any needed `attributes`, `send_script`, `format`, and `state_dir`. Include `docker_source` with the repository only on a Docker host; registration leaves an existing `docker.recommended_plugins` entry for the same plugin and repository as it is, so when that entry has `enabled: false`, tell the operator the plugin is not installed at container start until they enable it. Omitted fields survive; learned home chat and access fields remain intact. Stop on an error. An unchanged receipt is success. This write raises the native permission prompt.

The uppercase `<KEY>_STATE_DIR` must match `^[A-Z_][A-Z0-9_]*$`. If it cannot, say the project folder cannot be passed to the plugin. Establish the plugin's actual runtime credential location before continuing.

On tmux and interactive installs, explain that Claude Code must approve a third-party channel plugin and that this sets channel policy for every Claude Code session on the machine. Read [channel controls](https://code.claude.com/docs/en/channels#enterprise-controls) and [managed settings](https://code.claude.com/docs/en/managed-settings) at setup time. Build the content for this install from the enabled channel plugins in config, including official ones; preserve existing administrator policy. The operator writes it as root; setup never does. An organization's [Claude Code policy](https://code.claude.com/docs/en/channels#enterprise-controls) may still block the channel. If the proof message gets no answer, approval is the first thing to re-check.

## Credentials and plugin procedures

The operator writes the secret in their own terminal, in the runtime where the plugin runs. The agent never asks for the secret on this path. On Docker use the project's channel folder or another path inside the project tree, never a path under the host's home. If the plugin reads only its own location, say exactly where the secret sits and whether other projects on the host share it. Use the plugin's guide to determine how it receives the project folder and reads credentials; do not assume that the folder variable alone configures it.

Show commands from the guide and obtain approval before running them. Run the plugin's own skills as the agent where possible. Otherwise give the operator the exact command, or, on Docker, the exact message to send to the running agent. Use the plugin's own admission and pairing procedures.

For Docker activation run `hermitd restart --build`, or `hermitd start --build` when stopped. Other installs restart as the shared start stage says, with `<plugin>@<marketplace>`. Point at `/hermitd:docker-security` when the plugin needs hosts outside the allowlist.

## Shared flow boundary

Skip the official-only procedures: `channel-access.ts`, group enrollment, `channel-bot-id.ts`, the `access.json` move. The official Docker routing shortcuts do not apply to this path.

Rejoin shared access control with `allowed_users` when the operator supplies ids; use the shared field-preserving settings commands and do not infer ids from an unreadable plugin policy. Continue with conditional Operators and Primary questions, selected-channel conversational proof, and summary. Report plugin admission, the agent's sender restriction, permission relay, and script-alert reachability separately; unreadable facts stay unknown.
