// Where a non-technical operator is sent when something has to be done outside
// their chat: their provider's maintainer chat when one exists, else the Claude
// app when Remote Control can reach the session. Technical installs, and any
// install the Claude app cannot reach, keep the default wording (null).
import { resolveMaintainerTarget } from '../resolve-outbound-channel';
import { safe } from './sanitize';

type Json = any;

/** The startup-context line for this install, or null when the default wording applies.
 *  `claudeAppReachable` runs only when no maintainer chat decides the answer first. */
export function actSurfaceLine(config: Json, claudeAppReachable: () => boolean): string | null {
  if (config?.operator_profile !== 'non-technical') return null;
  const maintainer = resolveMaintainerTarget(config.channels);
  if (maintainer) {
    // One line, so a capped compaction capsule keeps or drops the rule whole.
    return `act_surface: provider (maintainer chat ${safe(maintainer.id)}:${safe(maintainer.chat_id)}). `
      + 'Elsewhere, any "terminal or the Claude app" step is the provider\'s: say so, and send the detail, '
      + 'updates and repairs included, as a maintainer-only notice.';
  }
  if (!claudeAppReachable()) return null;
  return 'act_surface: claude_app. '
    + 'For any "terminal or the Claude app" step, name only the Claude app; a step that names only a terminal keeps it.';
}
