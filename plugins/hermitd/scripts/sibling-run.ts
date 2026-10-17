import fs from 'node:fs';
import path from 'node:path';
import { exitError } from './lib/cli';
import { readCoreName, siblingPluginDirs } from './lib/plugin-siblings';

// A passthrough: the child's stdio and exit code are the caller's result. Only
// this script's own resolution errors print, as `{"error":"<token>"}` at exit 1.
const [pluginName, relativeScript, ...args] = process.argv.slice(2);
if (!relativeScript || path.isAbsolute(relativeScript) || relativeScript.includes('..') || !relativeScript.endsWith('.ts')) {
  exitError('invalid_script');
}

const coreRoot = path.resolve(import.meta.dir, '..');
const matches = siblingPluginDirs(coreRoot, readCoreName(coreRoot))
  .filter(dir => readCoreName(dir) === pluginName);
if (matches.length === 0) exitError(`no_sibling:${pluginName}`);
if (matches.length > 1) exitError(`ambiguous_sibling:${pluginName}`);

const script = path.join(matches[0], relativeScript);
if (!fs.existsSync(script)) exitError('missing_script');

const child = Bun.spawn([process.execPath, script, ...args], {
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});
process.exit(await child.exited);
