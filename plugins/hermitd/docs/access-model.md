# Access model

Access is owned by the existing channel, native settings, and hermit configuration surfaces. There is no separate hermit access registry.

## Approvers

The channel plugin's DM-paired `allowFrom` list owns native permission-prompt delivery and approval. DM-pair only people who may approve tool use: every listed DM receives and can answer prompts. An empty list reaches nobody, so an unattended prompt waits. Removing a person from this list removes their DM approval relay; it does not remove their group membership or undo an earlier approval. The saved pairing list survives restart. See **Settings from chat** in [security](security.md#auto-mode-classifier).

## Participants

Groups own admission independently of the DM `allowFrom` list. Other participants should join through groups. Hermit `channels.<name>.allowed_users` narrows who can wake the hermit, never who can approve tool use: absent means accept all delivered senders, while `[]` accepts none. Removing an ID from an explicit list blocks that sender's wake eligibility; deleting the list restores accept-all. Group membership and saved allowlists survive restart. Any member of an enabled group can attempt a permission reply by guessing its code before a hermit hook sees it. See [channel configuration](config-reference.md#channels) and [known limitations](security.md#known-limitations).

**Recall scope.** Per-channel `isolate_chats` and `shared_chats` own channel-log visibility: own chat by default, the whole channel when isolation is false, plus listed shared chats from any configured channel. Removing a shared id removes that grant; removing `isolate_chats` restores isolation. The maintainer chat is always unscoped, and the home chat is unscoped only on a technical profile. A home chat pinned to a shared group therefore gives every member of it unscoped recall across every chat on every channel, the same standing exposure the control-command rule has — set `allowed_users` and keep the pin on a real DM to narrow it. An unknown channel sees only itself. Terminal search is unscoped. Compiled pages are scoped by frontmatter `audience` (`shared` or `<key>:<chat_id>`; absent means `shared`). Session reports and proposals are operator material, unavailable to scoped readers. The resident's own context is shared across chats for non-task turns.

**Operators.** `channels.<name>.operators` owns who may save, update, or forget hermit-wide standing roles. Removing it restores the first-allowed-user rule; without `allowed_users`, the maintainer chat or technical-profile home chat qualifies. Without any of these fields nobody is primary. Other admitted senders save roles pinned to their current chat and cannot change hermit-wide rules. This list does not own control commands or approvals, and never bypasses admission. Existing roles remain as saved.

## Control commands

The hermit's `isTrustedController` rule owns pause, resume, snooze, and full status authority. With `allowed_users` set, it checks the sender against that list. Without it, the rule trusts the pinned `default_chat_id`; without a matching home chat there is no trusted controller. A shared home matches every member, so use an explicit list to narrow control there. Removing a sender from a configured list removes their control authority, but removing the whole list restores the home-chat fallback. The saved list and home pin survive restart; a new inbound DM does not move the pin. This rule does not own native approval delivery. Separately, adding a listening chat through `hermit-settings channels` asks for native approval and is refused under bypass permissions. See [security limitations](security.md#known-limitations).

## Connections

Native settings own project MCP enrollment through `enabledMcpjsonServers`, `enableAllProjectMcpServers`, and `disabledMcpjsonServers`. Without approval, a project server stays pending without blocking boot. Remove approvals in every applicable native scope, including blanket approval, or explicitly disable the server to exclude it at restart. Removing enrollment does not delete its declaration or credentials. A temporary `/mcp` toggle does not remove the saved approval.

Native `disableClaudeAiConnectors` owns account connector loading. When unset, a login-authenticated hermit loads account connectors; setting it to `true` disables them for the project without deleting account connections. Removing the setting restores default loading at restart. Setup-token authentication fetches no account connectors. See [MCP servers](always-on.md#mcp-servers).

## Unattended settings writes

`channel-access.ts` owns pairing, policy, delivery defaults, and group enrolment from the setup wizards and chat. Channel plugins remain writers of `access.json` too. Group changes write `config.json` first through the shared config persister, then re-read and write access state. There is a brief window between files, without a lock, journal, or rollback. If the access write fails after config lands, the command reports `{"error":"partial_config_written"}` and asks the operator to re-run the same command; it does not report complete success.

The shipped `SEALED_SETTINGS_OPS` list owns the enumerated classifier exception, rendered into a per-session overlay at each boot. An absent op has no exception from this list. Removing an overlay entry by hand does not persist across restart: boot renders it again from the installed list. The exact constraints remain in [the sealed exception](security.md#auto-mode-classifier).

Boot separately owns local settings keys and terminal-only operations, including voice rendering and artifact revocation. These run outside a session; a chat decision records config rather than executing the revoke. Unset behavior depends on the key: language clears its local mirror, voice leaves the operator's pick alone, and artifact authorization leaves an existing grant alone. Removing a generated local value is not a durable opt-out when configured boot ownership still applies.

## Preferences

Hermit `model` and `effort` are launch flags only when set. Unset values pass no override and leave native defaults in charge. Removing either override stops reasserting it at restart without deleting native settings; a configured override returns at restart after a runtime change.

Hermit `language` is carried by the resident launch overlay when configured. Clearing it leaves native preferences in charge. The native `/config` Language picker writes user scope and survives restart.

Hermit `voice.style` owns the launch overlay `outputStyle` when configured. `voice.style: null` leaves the operator's pick alone, including an existing rendered value; clearing the config is not deletion of the style or custom style file. A configured style is reasserted at restart. See [configuration](config-reference.md).

## Upgrades

Installed plugin code owns shipped permission registries; hermit config and native settings retain their existing owners through upgrades. There is no new access key or enrollment conversion. An unset preference or enrollment remains subject to its surface's defaults, not a second access registry. Permission sync removes only named obsolete rules and preserves other operator entries. Removing a canonical grant by hand can be undone by permission sync; removing a boot-owned value can be undone at restart while its config still applies. Operator-authored state survives except for explicitly documented migrations. See [security](security.md#auto-mode-classifier) for the upgrade-triggered sealed exception.

## Revocation

An explicit `artifacts.publish_authorized: false` removes exactly `Artifact` from `permissions.allow` at the next boot, preserving all other entries and keys. It clears every settings file the plugin wrote the grant to: the local one, which the boot grant re-ensures, and the committed one when `state/hatch-options.json` stamps the hatch target `committed`. An install carrying no usable stamp is cleared locally only, because an unstamped entry's provenance is unknown. An absent entry is a no-op, and costs no subprocess. A `null` decision leaves an existing entry alone. Disabling pages or switching backend alone does not revoke an existing grant; `true` re-ensures it only when a page is enabled and the backend is the default Claude backend.

Removal takes effect through the next boot, not immediately in the current session. It removes this standing permission, not previously published pages, banked URLs, account sharing, or permissions in other scopes. The declined decision survives restart and continues to enforce removal. See [artifact authorization](config-reference.md#artifacts) and [security limitations](security.md#known-limitations).
