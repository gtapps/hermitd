// The closed value sets for config.json's enum-valued keys.
//
// One definition, imported by everything that needs it: `validate-config.ts`
// (the PostToolUse hook that rejects a bad write) and `lib/settings/registry.ts`
// (which drives `/hermit-settings`' rendering and its argument table). Neither
// imports from the other — the validator covers keys the settings UI never
// exposes (`routines[].model`, `budget.action`, `telemetry_export`), and the
// settings UI covers presentation the validator has no business knowing about,
// so making either the owner would drag one module's concerns into the other.

export const ESCALATION = ['conservative', 'balanced', 'autonomous'] as const;
export const QUALITY_GATE_TIER = ['budget', 'balanced', 'quality'] as const;
export const ROUTINE_MODEL = ['opus', 'sonnet', 'haiku'] as const;
// The Agent tool's per-call `effort` values.
export const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const HELPER_MODEL = /^[A-Za-z0-9._\[\]-]{1,64}$/;
export const OPERATOR_PROFILE = ['technical', 'non-technical'] as const;
export const BUDGET_ACTION = ['alert', 'pause'] as const;
// `voice.style`. Deliberately narrower than Claude Code's built-in set: the other
// built-ins are coding-tool styles (Explanatory and Learning inject "Insights" and
// TODO(human) markers into what a hermit sends to a chat; Proactive is autonomy
// guidance, which belongs behind permission_mode's tier, not a tone dial). An
// operator who wants one still picks it in /config — the hermit reports it and
// never reclaims the key. `custom` means: render voice.prose into the voice file.
// "default" is lowercase on purpose: Claude Code's picker displays "Default" but
// persists the lowercase key (read off the shipped binary — the docs never state it).
export const VOICE_STYLE = ['default', 'Concise', 'custom'] as const;
export const TELEMETRY_DEST = ['webhook'] as const;
export const BACKUP_MODE = ['workspace', 'mirror'] as const;
export const BACKUP_INCLUDE = ['transcripts'] as const;
// `auth_mode`. Only the two an operator can choose: `external` (an env credential
// outranks both files) is derived by resolveAuthMode, never declared in config.
export const AUTH_MODE = ['login', 'token'] as const;

// Not validated by validate-config.ts: Claude Code owns the permission-mode set
// and adds to it independently of this plugin, so the hook stays permissive and
// only `/hermit-settings` offers the list. Kept here so the two places that do
// present it (the skill table and `show`) cannot drift apart.
export const PERMISSION_MODE = [
  'auto', 'acceptEdits', 'default', 'plan', 'dontAsk', 'bypassPermissions',
] as const;
