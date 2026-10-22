import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './cli';

// Enumerate the directories that directly contain a sibling plugin's
// .claude-plugin/. Handles both layouts core actually ships in:
//   - monorepo / legacy flat cache: siblings are one level up (plugins/<name>/).
//   - versioned marketplace cache: .claude/plugins/cache/<mp>/<plugin>/<version>/,
//     where pluginRoot's parent is core's OWN name dir and real siblings live two
//     levels up under <mp>/<other-plugin>/<max-version>/. The old one-level scan
//     saw only other versions of core there, so `checked` was always 0 — a false
//     all-clear for exactly the operators the check exists to protect.
// pluginRoot's own-name directory in the versioned-cache layout
// (.claude/plugins/cache/<mp>/<coreName>/), or null in the flat/monorepo layout where
// pluginRoot's parent isn't named after core. Shared by siblingPluginDirs,
// marketplaceCacheFile, and cachedVersionChangelogPath — all three need this same
// layout switch before deriving their own paths.
export function versionedCacheCoreDir(pluginRoot: string, coreName: string): string | null {
  const parent = path.resolve(pluginRoot, '..');
  return path.basename(parent) === coreName ? parent : null;
}

// A marketplace clone root (<base>/plugins/marketplaces/<mp>/plugins/<dir>/) mapped to the
// install-cache dir Claude Code runs the same release from
// (<base>/plugins/cache/<mp>/<name>/<version>/). bin/hermitd-run boots from the clone while
// the session runs the cache copy, so identity checks compare roots through this. Any
// other root, or a clone without a readable name and version, is returned unchanged.
export function installedRootFor(pluginRoot: string): string {
  const pluginsDir = path.dirname(pluginRoot);
  const mpDir = path.dirname(pluginsDir);
  const marketplaces = path.dirname(mpDir);
  if (path.basename(pluginsDir) !== 'plugins' || path.basename(marketplaces) !== 'marketplaces') return pluginRoot;
  const meta = readJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
  if (typeof meta?.name !== 'string' || !meta.name || typeof meta.version !== 'string' || !meta.version) return pluginRoot;
  return path.join(path.dirname(marketplaces), 'cache', path.basename(mpDir), meta.name, meta.version);
}

export function siblingPluginDirs(pluginRoot: string, coreName: string): string[] {
  const parent = path.resolve(pluginRoot, '..');
  const dirs: string[] = [];
  const coreDir = versionedCacheCoreDir(pluginRoot, coreName);
  if (coreDir) {
    // Versioned cache: walk the marketplace root, pick each sibling's newest version.
    const marketplaceRoot = path.resolve(coreDir, '..');
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(marketplaceRoot, { withFileTypes: true }); } catch {}
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const pluginDir = path.join(marketplaceRoot, ent.name);
      if (pluginDir === coreDir) continue; // skip core's own name dir
      let versions: fs.Dirent[] = [];
      try { versions = fs.readdirSync(pluginDir, { withFileTypes: true }); } catch { continue; }
      // Pick the newest cached version deliberately, not the currently-pinned
      // one (we don't read installed_plugins.json): this check is forward-
      // looking — a `/plugin update` pulls the newest — so warning when the
      // newest sibling demands a core the operator lacks is the conservative,
      // warn-favoring direction. A false warn is cheaper than the false
      // all-clear this function exists to prevent.
      const newest = versions
        .filter(v => v.isDirectory() && fs.existsSync(path.join(pluginDir, v.name, '.claude-plugin', 'plugin.json')))
        .map(v => v.name)
        // Guard the comparator: Bun.semver.order throws on a non-semver-named dir
        // (e.g. a `backup/` copy), which would degrade the whole dependency check.
        .filter(name => /^\d+\.\d+\.\d+/.test(name))
        .sort((a, b) => Bun.semver.order(b, a))[0];
      if (newest) dirs.push(path.join(pluginDir, newest));
    }
  } else {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(parent, { withFileTypes: true }); } catch {}
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const dir = path.join(parent, ent.name);
      if (dir === pluginRoot) continue; // skip self
      if (fs.existsSync(path.join(dir, '.claude-plugin', 'plugin.json'))) dirs.push(dir);
    }
  }
  return dirs;
}

// Reads <dir>/.claude-plugin/hermit-meta.json, returning {} on any error
// (missing file, malformed JSON) — callers treat absence of a field as "not
// declared" rather than failing the whole check over one bad sibling.
export function readHermitMeta(dir: string): any {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'hermit-meta.json'), 'utf8'));
  } catch {
    return {};
  }
}

// Reads the `name` field from <pluginRoot>/.claude-plugin/plugin.json, returning
// '' on any error. For callers that only need the core plugin's name, not its
// version or other manifest fields.
export function readCoreName(pluginRoot: string): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).name || '';
  } catch {
    return '';
  }
}
