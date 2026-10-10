import path from 'node:path';
import { emit, flagValue, readJson } from './lib/cli';
import { defaultConfigDir } from './lib/setup-token';
import { EFFORT, HELPER_MODEL } from './lib/settings/enums';

const [bgId, ...args] = process.argv.slice(2);
const refuse = (reason: string): never => emit(JSON.stringify({ verdict: 'refuse', reason }));
const model = flagValue(args, '--model');
const effort = flagValue(args, '--effort');
if (!model && !effort) refuse('Provide --model or --effort.');
if (args.includes('--model') && (!model || !HELPER_MODEL.test(model))) refuse('Invalid model.');
if (args.includes('--effort') && !EFFORT.includes(effort as typeof EFFORT[number])) refuse('Invalid effort.');
if (!bgId || !/^[A-Za-z0-9-]+$/.test(bgId)) refuse('Invalid background id.');
const state = readJson(path.join(defaultConfigDir(), 'jobs', bgId, 'state.json'));
if (!state) refuse('Job state is missing or unreadable.');
if (!Array.isArray(state.respawnFlags) || !state.respawnFlags.every((flag: unknown) => typeof flag === 'string')) {
  refuse('Job state has no valid respawnFlags array.');
}
const saved: string[] = state.respawnFlags;
const name = flagValue(saved, '--name');
if (!name || name.startsWith('--')) refuse('Job state has no --name value.');
if (typeof state.resumeSessionId !== 'string' || !state.resumeSessionId) refuse('Job state has no resumeSessionId.');
const cwd = state.worktreePath ?? state.cwd;
if (typeof cwd !== 'string' || !cwd) refuse('Job state has no working folder.');
const flags: string[] = [];
for (let i = 0; i < saved.length; i++) {
  if (saved[i] === '--worktree') { i++; continue; }
  flags.push(saved[i]);
}
for (const [flag, value] of [['--model', model], ['--effort', effort]] as const) {
  if (value === undefined) continue;
  const index = flags.indexOf(flag);
  if (index === -1) flags.push(flag, value);
  else flags[index + 1] = value;
}
emit(JSON.stringify({
  verdict: 'ok', sid: state.resumeSessionId, name, cwd,
  flags: flags.map(token => `'${token.replaceAll("'", `'\\''`)}'`).join(' '),
}));
