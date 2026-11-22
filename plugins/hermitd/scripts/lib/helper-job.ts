import path from 'node:path';
import { readJson } from './cli';
import { defaultConfigDir } from './setup-token';

export function isHelperBackgroundId(bgId: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(bgId);
}

export function readHelperJob(bgId: string) {
  if (!isHelperBackgroundId(bgId)) return null;
  return readJson(path.join(defaultConfigDir(), 'jobs', bgId, 'state.json'));
}
