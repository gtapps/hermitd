import { pinStateDirOrExit } from './lib/cc-compat';
import { failJson, printJson } from './lib/cli';
import { briefDigest, briefContext, type BriefSelector } from './lib/brief-digest';

try {
  const [dirArg, mode, ...extra] = process.argv.slice(2);
  if (!dirArg || !mode || (extra.length !== 0 && extra.length !== 2)) throw new Error('invalid_arguments');
  const selector: BriefSelector = {};
  if (extra.length) {
    if (extra[0] === '--routine' && extra[1]) selector.routine = extra[1];
    else if (extra[0] === '--chat' && extra[1]) selector.chat = extra[1];
    else throw new Error('invalid_arguments');
  }
  if (mode !== 'morning' && mode !== 'evening' && mode !== 'daily' && mode !== 'context') throw new Error(`invalid_mode:${mode}`);
  const dir = pinStateDirOrExit(dirArg);
  printJson(mode === 'context' ? await briefContext(dir, selector) : await briefDigest(dir, mode, new Date(), selector));
} catch (error) { failJson(error); }
