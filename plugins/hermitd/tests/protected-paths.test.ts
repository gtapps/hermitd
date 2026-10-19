import { describe, expect, test } from 'bun:test';
import { PROTECTED_PATHS, askPathRegex } from '../scripts/lib/settings/protected-paths';
import { AUTOMODE_SOFT_DENY_ENTRY } from '../scripts/lib/settings/automode-entries';

const EXPECTED_PATHS = [
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

describe('protected settings paths', () => {
  test('the protected surface stays complete', () => {
    expect(PROTECTED_PATHS).toEqual(EXPECTED_PATHS);
  });
  test('every path is gated and named by the classifier', () => {
    for (const path of PROTECTED_PATHS) {
      expect(askPathRegex().test(path.replace('<name>', 'discord').replace('<n>', '0'))).toBe(true);
      expect(AUTOMODE_SOFT_DENY_ENTRY).toContain(path.split('.').at(-1)!);
    }
    for (const path of ['model', 'heartbeat.every']) {
      expect(askPathRegex().test(path)).toBe(false);
      expect(AUTOMODE_SOFT_DENY_ENTRY).not.toContain(path);
    }
  });
});
