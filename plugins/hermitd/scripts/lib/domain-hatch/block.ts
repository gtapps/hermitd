// CLAUDE-APPEND block sync for domain hatches.
//
// Boundary detection, the closing-marker/`---` fallback, foreign-block fencing
// and the duplicate-marker refusal all come from evolve-plan.ts. Nothing here
// re-derives them: hermit-evolve and hatch write the same marked block, so a
// second parser would eventually disagree with the first about where a block
// ends and one of them would corrupt it.
//
// The write rule, unified across the five domain hatches:
//   marker absent            -> append the template
//   marker present           -> skip; version-driven refresh is hermit-evolve's
//   rendered input differs   -> replace (dev, whose block is rendered per mode
//                               from an input hermit-evolve cannot observe)
//   ambiguous                -> refuse, never append a third copy
//
// Before this, dev and HA also refreshed on a stale stamped version while
// fitness, feed and forge skipped — two owners for one block, with only one of
// them tracking evolve's bounds handling.

import fs from 'node:fs';
import path from 'node:path';
import { markerOnward, extractSiblingMarker, isAmbiguousBlock, requiresRendering } from '../../evolve-plan';
import { writeFileAtomic } from '../md-write';

export type BlockAction = 'append' | 'replace' | 'skip' | 'ambiguous' | 'no_template' | 'no_marker' | 'needs_rendering';

export interface BlockPlan {
  action: BlockAction;
  marker: string | null;
  targetFile: string;
  /** The block currently in the target, when one was found. */
  old_block?: string;
  /** What would be written. */
  new_block?: string;
}

/** Split duties from shared instructions while retaining plugin block bounds. */
export function splitResident(rendered: string): { shared: string; resident: string } {
  if (!rendered.includes('<!-- resident-only -->')) return { shared: rendered, resident: '' };
  const opening = rendered.match(/^<!-- ([^/][^:]*: .+) -->$/m)?.[0];
  if (!opening) return { shared: rendered, resident: '' };
  const closing = opening.replace('<!-- ', '<!-- /');
  const resident: string[] = [];
  const shared = rendered.replace(/<!-- resident-only -->([\s\S]*?)<!-- \/resident-only -->/g, (_match, body: string) => {
    resident.push(body);
    return '';
  });
  return { shared, resident: opening + '\n' + resident.join('\n') + '\n' + closing + '\n' };
}

export function templatePath(installPath: string): string {
  return path.join(installPath, 'state-templates', 'CLAUDE-APPEND.md');
}

function read(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// Other registered plugin names, so a block can never swallow a sibling's when
// it has no closing marker.
export function planBlock(
  installPath: string,
  pluginName: string,
  targetPath: string,
  foreignNames: string[],
  rendered?: string,
  replaceExisting = rendered !== undefined,
): BlockPlan {
  const tmplText = rendered ?? read(templatePath(installPath));
  if (tmplText === null) {
    return { action: 'no_template', marker: null, targetFile: targetPath };
  }

  const marker = extractSiblingMarker(tmplText, pluginName);
  if (marker === null) {
    return { action: 'no_marker', marker: null, targetFile: targetPath };
  }

  // A template carrying `mode:` markers is rendered by its own plugin before
  // install. Core cannot render it, so the raw
  // text is neither a valid comparison base nor a valid payload, the same
  // refusal evolve-plan makes. Without this, `sync-block <plugin>` with no
  // --rendered-stdin appends both mode regions and their fence comments
  // verbatim into the operator's CLAUDE.md.
  if (requiresRendering(tmplText)) {
    return { action: 'needs_rendering', marker, targetFile: targetPath };
  }

  const targetText = read(targetPath);
  if (targetText === null) {
    // Missing target file is the append case — the caller's Edit creates it.
    return { action: 'append', marker, targetFile: targetPath, new_block: tmplText };
  }

  const targetBlock = markerOnward(targetText, marker, foreignNames);
  if (targetBlock === null) {
    return { action: 'append', marker, targetFile: targetPath, new_block: tmplText };
  }

  if (isAmbiguousBlock(targetText, marker, targetBlock)) {
    return { action: 'ambiguous', marker, targetFile: targetPath, old_block: targetBlock };
  }

  // Only a caller that supplied rendered content can ask for a replace: a
  // static template that is already present is hermit-evolve's to refresh.
  if (!replaceExisting) {
    return { action: 'skip', marker, targetFile: targetPath, old_block: targetBlock };
  }

  const tmplBlock = markerOnward(tmplText, marker, foreignNames) ?? tmplText;
  if (norm(targetBlock) === norm(tmplBlock)) {
    return { action: 'skip', marker, targetFile: targetPath, old_block: targetBlock };
  }
  return { action: 'replace', marker, targetFile: targetPath, old_block: targetBlock, new_block: tmplBlock };
}

export function planResidentRemoval(
  source: BlockPlan,
  targetPath: string,
  foreignNames: string[],
): BlockPlan {
  const base = { marker: source.marker, targetFile: targetPath };
  const text = read(targetPath);
  const old = text && source.marker ? markerOnward(text, source.marker, foreignNames) : null;
  if (!old) return { ...base, action: 'skip' };
  if (isAmbiguousBlock(text!, source.marker!, old)) {
    return { ...base, action: 'ambiguous', old_block: old };
  }
  return { ...base, action: 'replace', old_block: old, new_block: '' };
}

function norm(s: string): string {
  return s.replace(/\s+$/, '');
}

export interface BlockResult extends BlockPlan {
  written: boolean;
}

// Writes only on append or replace; any other action comes back unchanged with `written: false`.
export function applyBlock(plan: BlockPlan): BlockResult {
  if (plan.action !== 'append' && plan.action !== 'replace') return { ...plan, written: false };

  const existing = read(plan.targetFile) ?? '';
  let next: string;
  if (plan.action === 'append') {
    const sep = existing === '' || existing.endsWith('\n') ? '' : '\n';
    next = existing + sep + plan.new_block;
  } else {
    // Function replacement: a plain string would let `$&`, `` $` ``, `$'` and
    // `$$` inside the block be expanded as substitution patterns.
    next = existing.replace(plan.old_block!, () => plan.new_block!);
  }
  writeFileAtomic(plan.targetFile, next.endsWith('\n') ? next : next + '\n');
  return { ...plan, written: true };
}

export type SyncResult =
  | { action: BlockAction; written: boolean; resident: BlockAction; marker: string | null; target_file: string }
  | { status: 'needs_rendering' }
  | { status: 'refused'; reason: 'ambiguous_marker'; file: string }
  | { error: 'no_template' | 'no_marker' };

/** Plan the shared and resident blocks, refuse before any write on an ambiguous marker in either, then apply both. */
export function syncBlocks(
  installPath: string,
  pluginName: string,
  targetPath: string,
  residentPath: string,
  foreignNames: string[],
  rendered?: string,
): SyncResult {
  const template = rendered ?? read(templatePath(installPath));
  if (template === null) return { error: 'no_template' };
  const replace = rendered !== undefined;
  const original = planBlock(installPath, pluginName, targetPath, foreignNames, template, replace);
  if (original.action === 'no_marker') return { error: 'no_marker' };
  if (original.action === 'needs_rendering') return { status: 'needs_rendering' };

  const split = splitResident(template);
  const shared = planBlock(installPath, pluginName, targetPath, foreignNames, split.shared, replace);
  const resident = split.resident
    ? planBlock(installPath, pluginName, residentPath, foreignNames, split.resident, replace)
    : planResidentRemoval(original, residentPath, foreignNames);
  const refused = [original, shared, resident].find(p => p.action === 'ambiguous');
  if (refused) return { status: 'refused', reason: 'ambiguous_marker', file: refused.targetFile };

  const result = applyBlock(shared);
  const residentResult = applyBlock(resident);
  // `written` covers both files: a run that only refreshed RESIDENT.md is still a
  // write, and reporting the shared block's `false` would read as "nothing changed".
  return {
    action: result.action,
    written: result.written || residentResult.written,
    resident: residentResult.action,
    marker: result.marker,
    target_file: targetPath,
  };
}
