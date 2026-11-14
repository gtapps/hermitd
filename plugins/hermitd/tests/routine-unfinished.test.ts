import { afterAll, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { freshDirFactory } from './helpers/workdir';
import { markDispatched, markStarted, clearEntries, readUnfinished, stampInterrupted } from '../scripts/lib/routines/unfinished';
const { freshDir, cleanup } = freshDirFactory('routine-unfinished-');
afterAll(cleanup);
const entry = (id: string) => ({ routine_id: id, skill: 'test:run', mark: '2026-11-14T10:00:00Z', delivery: 'monitor' });

test('writers re-read and merge; empty stores are deleted', () => {
  const dir = freshDir();
  markDispatched(dir, entry('one'));
  markDispatched(dir, entry('two'));
  markStarted(dir, { ...entry('one'), session_id: 's' });
  stampInterrupted(dir, 'api', 's');
  expect(Object.values(readUnfinished(dir)).every(e => e.skill === 'test:run')).toBe(true);
  expect(Object.values(readUnfinished(dir)).map(e => e.state)).toEqual(['interrupted', 'dispatched']);
  clearEntries(dir, () => true);
  expect(fs.existsSync(path.join(dir, 'state/routine-unfinished.json'))).toBe(false);
});

test('two processes merge concurrent admissions', async () => {
  const dir = freshDir();
  const module = path.resolve(import.meta.dir, '../scripts/lib/routines/unfinished.ts');
  const writers = ['one', 'two'].map(id => Bun.spawn([process.execPath, '-e',
    `import { markDispatched } from ${JSON.stringify(module)}; for (let n=0;n<20;n++) markDispatched(${JSON.stringify(dir)}, {routine_id:${JSON.stringify(id)},skill:'test:run',mark:String(n),delivery:'monitor'});`,
  ], { stdout: 'pipe', stderr: 'pipe' }));
  expect(await Promise.all(writers.map(p => p.exited))).toEqual([0, 0]);
  expect(Object.keys(readUnfinished(dir))).toHaveLength(40);
});

test('a start drops the same routine\'s older never-started dispatches', () => {
  const dir = freshDir();
  markDispatched(dir, { ...entry('one'), mark: '2026-11-14T09:45:00Z' });
  markDispatched(dir, { ...entry('two'), mark: '2026-11-14T09:45:00Z' });
  markDispatched(dir, entry('one'));
  markStarted(dir, { ...entry('one'), session_id: 's' });
  expect(Object.keys(readUnfinished(dir)).sort()).toEqual(['one@2026-11-14T10:00:00Z', 'two@2026-11-14T09:45:00Z']);
});

test('unwritable state does not throw', () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'state'), 'not a directory');
  expect(() => markDispatched(dir, entry('one'))).not.toThrow();
  expect(() => stampInterrupted(dir, 'unclean')).not.toThrow();
  expect(() => clearEntries(dir, () => true)).not.toThrow();
});
