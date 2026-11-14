import { expect, test } from 'bun:test';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { walkFiles } from '../../plugins/hermitd/tests/helpers/run';

// Hooks run as `bun --no-install`, so a package import in shipped code fails at run time
// instead of downloading: the hook exits non-zero and a fail-closed gate fails open.
// Shipped code imports only Bun and Node built-ins and its own relative files.
const PLUGINS = path.resolve(import.meta.dir, '../../plugins');
const SKIP_DIRS = new Set(['tests', 'evals', 'node_modules', 'graphify-out']);
const SPECIFIER = /(?:^|[\s;])(?:import(?!\s+type\b)[^'"`;]*?\bfrom\s*|import\s*\(\s*|import\s+|export[^'"`;]*?\bfrom\s*|require\s*\(\s*)(['"])([^'"]+)\1/gm;

const isShippedSource = (name: string) => /\.(?:[cm]?[jt]s|tsx)$/.test(name) && !/\.test\.[jt]s$/.test(name);

const allowed = (spec: string) =>
  spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || spec.startsWith('bun:')
  || spec === 'bun' || builtinModules.includes(spec);

test('shipped plugin code imports no packages', () => {
  const files = walkFiles(PLUGINS, isShippedSource, SKIP_DIRS);
  const offenders = files.flatMap((file) =>
    [...fs.readFileSync(file, 'utf8').matchAll(SPECIFIER)]
      .map((m) => m[2])
      .filter((spec) => !allowed(spec))
      .map((spec) => `${path.relative(PLUGINS, file)}: ${spec}`));
  expect(offenders).toEqual([]);
  // Path-resolution guard: an empty scan means the walk is broken, not that all is well.
  expect(files.length).toBeGreaterThan(100);
});
