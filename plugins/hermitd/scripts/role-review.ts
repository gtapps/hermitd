import { pinStateDirOrExit } from './lib/cc-compat';
import { exitError, failJson, printJson, readStdin } from './lib/cli';
import { checkKey } from './lib/conversation-key';
import { snapshot, commit, get, resolve } from './lib/role-review';

async function main(): Promise<void> {
  const [argvDir, verb, ...args] = process.argv.slice(2);
  if (!argvDir || !verb) exitError();
  const dir = pinStateDirOrExit(argvDir);
  if (verb === 'snapshot' && args.length === 2 && args[0] === '--routine' && args[1]) {
    printJson(await snapshot(dir, args[1]));
  } else if (verb === 'commit' && args.length === 4 && args[0] === '--routine' && args[2] === '--upper' && /^\d+$/.test(args[3])) {
    printJson(await commit(dir, args[1], Number(args[3]), JSON.parse(await readStdin())));
  } else if (verb === 'get' && args.length === 2 && args[0] === '--chat') {
    checkKey(args[1]);
    printJson(await get(dir, args[1]));
  } else if (verb === 'resolve' && args.length === 2) {
    printJson(resolve(dir, args[0], args[1]));
  } else exitError('invalid_options');
}
if (import.meta.main) main().catch(error => failJson(error));
