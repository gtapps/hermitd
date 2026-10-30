import { hermitDir } from './lib/cc-compat';
import { armFirstChat, clearFirstChat } from './lib/first-chat';
if (import.meta.main) {
  try {
    const verb = process.argv[2];
    if (verb === 'arm') armFirstChat(hermitDir());
    else if (verb === 'clear') clearFirstChat(hermitDir());
    else throw new Error('invalid_verb');
    console.log('OK');
  } catch { console.log(JSON.stringify({ error: 'first_chat_failed' })); process.exitCode = 1; }
}
