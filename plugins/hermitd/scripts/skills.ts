import fs from 'node:fs';
import { hermitDir } from './lib/cc-compat';
import { failJson, printJson } from './lib/cli';
import { LearnedSkills } from './lib/learned-skills';

export function main(args = process.argv.slice(2), dir = hermitDir()): void {
  const [verb, ...rest] = args;
  const lib = new LearnedSkills(dir);
  const refuse = (reason: string) => printJson({ status: 'refused', reason });
  if (verb === 'status') {
    if (rest.length && (rest.length !== 2 || rest[0] !== '--skill')) throw new Error('usage');
    const skill = rest[1];
    if (skill) lib.skillDir(skill);
    const ledger = lib.ledger().filter(row => !skill || row.skill === skill);
    const learned = new Set(ledger.filter(row => row.action === 'create').map(row => row.skill));
    const pins = lib.pins();
    printJson({ learned: learned.size, pinned: [...learned].filter(name => pins.has(name)).length,
      active: [...learned].filter(name => fs.existsSync(lib.skillDir(name))).length,
      archived_once: [...lib.archivedOnce()].filter(name => !skill || name === skill).length,
      recent: ledger.slice(-10), ...(skill ? { skill, is_learned: lib.isLearned(skill), is_pinned: pins.has(skill) } : {}) });
    return;
  }
  if (!['restore', 'archive', 'pin', 'unpin', 'rollback'].includes(verb)) throw new Error('usage');
  const [skill, ...options] = rest;
  if (!skill || (options.length && (verb !== 'pin' || options.length !== 2 || options[0] !== '--origin' || !options[1]))) throw new Error('usage');
  lib.skillDir(skill);
  if (!lib.isLearned(skill)) { refuse('not_learned'); return; }
  if (verb === 'pin' || verb === 'unpin') {
    if (lib.pins().has(skill) !== (verb === 'pin')) lib.record(skill, verb, options.length ? { origin: options[1] } : {});
  } else {
    let changed: boolean;
    if (verb === 'restore') changed = lib.restore(skill);
    else if (verb === 'archive') changed = lib.archive(skill);
    else changed = lib.restoreRevision(skill);
    if (!changed) { refuse(verb === 'rollback' ? 'no_revision' : 'not_available'); return; }
  }
  console.log('OK');
}
if (import.meta.main) { try { main(); } catch (error) { failJson(error); } }
