#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { hermitDir, resolvedMemoryDir } from './lib/cc-compat';
import { readHookInput, OVERSIZE } from './lib/hook-input';

function deny(reason: string): void {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
}
// Resolve existing ancestors too: Write may create a file or a parent directory.
function canonical(file: string): string {
  try { return fs.realpathSync(file); }
  catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    // A dangling symlink is not an absent directory a Write may create.
    try { if (fs.lstatSync(file).isSymbolicLink()) throw new Error('dangling_symlink'); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    return path.join(canonical(parent), path.basename(file));
  }
}
function inside(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return !!relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
async function main(): Promise<void> {
  const payload = await readHookInput();
  if (!payload || payload === OVERSIZE || typeof payload !== 'object') { deny('Cannot inspect dream write payload'); return; }
  if (typeof payload.agent_type !== 'string' || !payload.agent_type.startsWith('hermitd:dream-')) return;
  if (!['Write', 'Edit'].includes(payload.tool_name) || typeof payload.tool_input?.file_path !== 'string') { deny('Cannot inspect dream write target'); return; }
  const raw = payload.tool_input.file_path;
  if (raw.split(/[\\/]/).includes('..')) { deny('Traversal outside dream fence'); return; }
  const dir = hermitDir();
  const file = path.resolve(payload.cwd || path.dirname(dir), raw);
  if (path.basename(file).startsWith('feedback_role_')) { deny('Standing roles are outside dream writes'); return; }
  const real = canonical(file), memory = resolvedMemoryDir(dir);
  if (memory && inside(file, memory) && inside(real, canonical(memory))) return;
  const compiled = path.join(dir, 'compiled');
  if (path.dirname(file) === compiled && /^topic-[^/]+\.md$/.test(path.basename(file))
    && path.dirname(real) === path.join(canonical(dir), 'compiled') && path.basename(real) === path.basename(file)) return;
  deny('Write outside dream fence');
}
if (import.meta.main) main().catch(() => deny('Cannot resolve dream write target')).finally(() => process.exit(0));
