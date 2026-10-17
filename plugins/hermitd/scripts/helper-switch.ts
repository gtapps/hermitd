import path from 'node:path';
import { emitJson, flagValue, readJson } from './lib/cli';
import { defaultConfigDir } from './lib/setup-token';
import { EFFORT, HELPER_MODEL } from './lib/settings/enums';

const [bgId, ...args] = process.argv.slice(2);
const refuse = (reason: string): never => emitJson({ status: 'refused', reason });
const model = flagValue(args, '--model');
const effort = flagValue(args, '--effort');
if (!model && !effort) refuse('missing_model_or_effort');
if (args.includes('--model') && (!model || !HELPER_MODEL.test(model))) refuse('invalid_model');
if (args.includes('--effort') && !EFFORT.includes(effort as typeof EFFORT[number])) refuse('invalid_effort');
if (!bgId || !/^[A-Za-z0-9-]+$/.test(bgId)) refuse('invalid_background_id');
const state = readJson(path.join(defaultConfigDir(), 'jobs', bgId, 'state.json'));
if (!state) refuse('job_state_unreadable');
if (!Array.isArray(state.respawnFlags) || !state.respawnFlags.every((flag: unknown) => typeof flag === 'string')) {
  refuse('invalid_respawn_flags');
}
const saved: string[] = state.respawnFlags;
const name = flagValue(saved, '--name');
if (!name || name.startsWith('--')) refuse('missing_name');
if (typeof state.resumeSessionId !== 'string' || !state.resumeSessionId) refuse('missing_resume_session_id');
const cwd = state.worktreePath ?? state.cwd;
if (typeof cwd !== 'string' || !cwd) refuse('missing_cwd');
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
emitJson({
  sid: state.resumeSessionId, name, cwd,
  flags: flags.map(token => `'${token.replaceAll("'", `'\\''`)}'`).join(' '),
});
