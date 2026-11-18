// Where a non-technical operator is sent when something has to be done outside
// their chat: their provider's maintainer chat when one exists, else the Claude
// app when Remote Control can reach the session. Technical installs, and any
// install the Claude app cannot reach, keep the default wording (null).
import { resolveMaintainerTarget } from '../resolve-outbound-channel';
import { safe } from './sanitize';
import type { AuthMode } from './setup-token';

type Json = any;

/** The startup-context line for this install, or null when the default wording applies. */
export function actSurfaceLine(config: Json, authMode: () => AuthMode): string | null {
  if (config?.operator_profile !== 'non-technical') return null;
  const maintainer = resolveMaintainerTarget(config.channels);
  if (maintainer) {
    return `act_surface: provider (maintainer chat ${safe(maintainer.id)}:${safe(maintainer.chat_id)})\n`
      + 'Outside that chat, never send the operator to a terminal or the Claude app: say their provider handles it, '
      + 'and send the detail, including any available update or repair, as a maintainer-only notice.';
  }
  // Remote Control connects only on a claude.ai sign-in, and only when `remote` is on.
  if (config.remote === false || authMode() !== 'login') return null;
  return 'act_surface: claude_app\n'
    + 'When the operator has to act outside chat, name the Claude app, never a terminal, unless the step needs the machine itself.';
}
