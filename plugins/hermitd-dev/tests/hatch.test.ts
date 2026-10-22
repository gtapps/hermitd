// Structural checks for hatch and its shared core protocol.
import fs from 'node:fs';
import path from 'node:path';
import { makeReporter } from '../../../tests/lib/skill-lint';

const PLUGIN_ROOT = path.join(import.meta.dir, '..');
const { ok, summary } = makeReporter();
const HATCH_SKILL = path.join(PLUGIN_ROOT, 'skills', 'hatch', 'SKILL.md');
ok('hatch exists', fs.existsSync(HATCH_SKILL));
if (fs.existsSync(HATCH_SKILL)) {
  const text = fs.readFileSync(HATCH_SKILL, 'utf-8');

  console.log('\nskills/hatch/SKILL.md shared domain-hatch protocol:');

  // Target resolution, install-scope detection, and the hatch-options stamp
  // schema all moved into core's `domain-hatch.ts`. What the dev hatch owes the
  // protocol is: call preflight with its own plugin id, and restate none
  // of the resolution rules it no longer owns.

  ok('runs preflight through core, keyed to its own plugin id',
    text.includes('domain-hatch preflight hermitd-dev'));
  ok('reaches core via bin/hermitd-run, not a relative path',
    text.includes('.hermit/bin/hermitd-run domain-hatch')
    && !text.includes('../hermitd/scripts'));
  ok('branches on every preflight `action` value',
    ['upgrade_core_package', 'upgrade_core_applied', '`verify`', '`full`'].every(a => text.includes(a)));

  // The hatch-options stamp is owned by core's domain-hatch.ts; reading it
  // directly would bypass the centralised protocol.
  ok('does not read hatch-options.json directly', !text.includes('hatch-options.json'));

  // Regression: the version gate used to say "extract the stamped version from
  // the existing block", but no template or renderer ever wrote a version into
  // the block, so the gate degenerated to marker-present-only. The stamp lives
  // in config.json (Step 4 writes it every run), so the gate must read from there.
  ok('reads the stamped version from _hermit_versions in config.json',
    /_hermit_versions\["hermitd-dev"\]/.test(text));
}

process.exit(summary() === 0 ? 0 : 1);
