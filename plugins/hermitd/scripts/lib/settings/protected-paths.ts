/** Settings requiring native permission or classifier review. */
export const PROTECTED_PATHS: readonly string[] = [
  'permission_mode',
  'operator_profile',
  'env',
  'monitors',
  'boot_skill',
  'shutdown_skill',
  'backup',
  'remote',
  'chrome',
  'auth_mode',
  'voice.prose',
  'channels.primary',
  'channels.<name>.allowed_users',
  'channels.<name>.default_chat_id',
  'channels.<name>.maintainer_channel_id',
  'channels.<name>.isolate_chats',
  'channels.<name>.shared_chats',
  'channels.<name>.operators',
  'channels.<name>.passive_chats',
  'channels.<name>.instructions',
  'channels.<name>.state_dir',
  'channels.<name>.marketplace',
  'channels.<name>.enabled',
  'channels.<name>.plugin',
  'channels.<name>.send_script',
  'channels.<name>.attributes',
  'telemetry_export.enabled',
  'telemetry_export.destination',
  'telemetry_export.redact_operator_text',
  'artifacts.publish_authorized',
  'artifacts.backend',
  'docker.packages',
  'docker.recommended_plugins',
  'docker.fleet_mesh',
  'routines.<n>.precheck',
  'routines.<n>.precheck_timeout_s',
];

/** Channel selection and routine leaves match exactly; other entries protect subtrees. */
export function askPathRegex(): RegExp {
  return new RegExp(PROTECTED_PATHS.map(path => {
    const pattern = path.split('.').map(segment => {
      if (segment === '<name>') return '[^.]+';
      if (segment === '<n>') return '\\d+';
      return segment;
    }).join('\\.');
    const exact = path === 'channels.primary' || path.startsWith('routines.');
    return `^${pattern}${exact ? '' : '(\\..+)?'}$`;
  }).join('|'));
}

export function askListSentence(): string {
  return PROTECTED_PATHS.join(', ');
}
