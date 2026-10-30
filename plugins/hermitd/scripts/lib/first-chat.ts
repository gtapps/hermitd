import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './cli';
import { writeFileAtomic } from './md-write';
export interface FirstChat { armed_at: string; attempts: number }
export function firstChatPath(dir: string): string { return path.join(dir, 'state/first-chat.json'); }
export function armFirstChat(dir: string): void {
  fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  writeFileAtomic(firstChatPath(dir), JSON.stringify({ armed_at: new Date().toISOString(), attempts: 0 }) + '\n');
}
export function clearFirstChat(dir: string): void { fs.rmSync(firstChatPath(dir), { force: true }); }
export function readFirstChat(dir: string): FirstChat | null {
  return readJson(firstChatPath(dir));
}
export function deliveredFirstChat(dir: string): void {
  const marker = readFirstChat(dir);
  if (!marker) return;
  marker.attempts += 1;
  if (marker.attempts >= 3) clearFirstChat(dir);
  else writeFileAtomic(firstChatPath(dir), JSON.stringify(marker) + '\n');
}
