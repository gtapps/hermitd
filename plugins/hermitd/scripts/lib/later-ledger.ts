import fs from 'node:fs';

export type State = 'pending' | 'held' | 'broken' | 'indeterminate' | 'cancelled' | 'sent';
export interface Row {
  id: string; claim: string; cmd: string | null; chat?: string; due: string; origin: 'operator' | 'hermit';
  session: string | null; created_at: string; state: State;
  kind?: 'reminder';
  timeout_s?: number;
  checked_at?: string; late?: boolean; exit?: number | null; output?: string; reason?: string;
}

/** A truncated trailing line (crash mid-append) must not brick every verb; it is dropped on the next rewrite. */
export function readRows(file: string): Row[] {
  if (!fs.existsSync(file)) return [];
  const rows: Row[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return rows;
}
