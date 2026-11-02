import { pinStateDirOrExit } from './lib/cc-compat';
import { failJson, printJson } from './lib/cli';
import { briefDigest } from './lib/brief-digest';

try {
  const [dirArg, mode, ...extra] = process.argv.slice(2);
  if (!dirArg || !mode || extra.length) throw new Error('invalid_arguments');
  if (mode !== 'morning' && mode !== 'evening' && mode !== 'daily') throw new Error(`invalid_mode:${mode}`);
  printJson(briefDigest(pinStateDirOrExit(dirArg), mode));
} catch (error) { failJson(error); }
