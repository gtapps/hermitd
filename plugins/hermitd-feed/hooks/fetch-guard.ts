/**
 * PreToolUse hook: validate WebFetch URLs against the feed-sources.md domain allowlist.
 * Blocks fetches to domains not in feed-sources.md (plus a small hardcoded infra list).
 * Exit 0 = allow. Exit 2 = block. Fails open on missing feed-sources.md / malformed input.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const SOURCES_FILE = "feed-sources.md";
const SENTINEL = join(".hermit", "config.json");

const INFRA_ALLOWLIST = [
  "raw.githubusercontent.com",
  "api.github.com",
  "registry.npmjs.org",
  "pypi.org",
  "codeload.github.com",
];

// Sealed copy of the fleet root walk (core cc-compat.ts hermitDir, dev
// find-hermit-dir.ts) — fleet plugins cannot import core at runtime. Returns the
// project ROOT, not the state dir: feed-sources.md is operator-owned and lives at
// the root. A hook's cwd is the session's shell cwd and drifts with `cd`, so the
// allowlist is never read relative to it.
//
// Deliberately WITHOUT the other resolvers' worktree-projection skip. They walk
// past a worktree's projected `.hermit/` because they want the
// main-rooted shared STATE dir. This one wants the project the session is in,
// and feed-sources.md is a tracked file, so a `claude --worktree` session must
// read the worktree's copy — the branch's allowlist, not main's. Stopping at the
// projection is the correct answer here. Do not "align" this with the others.
export function projectRoot(): string {
  const proj = process.env.CLAUDE_PROJECT_DIR;
  if (proj && existsSync(join(proj, SENTINEL))) return proj;
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, SENTINEL))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd(); // never-hatched project — same behavior as before this anchor existed
}

export function parseAllowlist(sourcesMd: string): string[] {
  const hosts = new Set<string>();
  const urlRegex = /https?:\/\/(?:www\.)?([^/\s|)]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(sourcesMd)) !== null) {
    hosts.add(match[1].toLowerCase());
  }
  return [...hosts];
}

export function isAllowed(hostname: string, allowlist: string[]): boolean {
  return allowlist.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

async function readStdin(): Promise<string> {
  return Bun.stdin.text();
}

function extractUrl(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const toolInput = (data as Record<string, unknown>).tool_input;
  if (typeof toolInput !== "object" || toolInput === null) return undefined;
  const url = (toolInput as Record<string, unknown>).url;
  return typeof url === "string" ? url : undefined;
}

async function main(): Promise<void> {
  let data: unknown;
  try {
    data = JSON.parse(await readStdin());
  } catch {
    process.exit(0); // malformed input — don't block
  }

  const url = extractUrl(data);
  if (!url) process.exit(0);

  let hostname: string;
  try {
    hostname = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    console.error(`WebFetch blocked: could not parse URL "${url}"`);
    process.exit(2);
  }

  let sources: string;
  try {
    sources = await Bun.file(join(projectRoot(), SOURCES_FILE)).text();
  } catch {
    process.exit(0); // can't read the allowlist file — fail open
  }

  const allowlist = [...parseAllowlist(sources), ...INFRA_ALLOWLIST];

  if (isAllowed(hostname, allowlist)) {
    process.exit(0);
  }
  console.error(
    `WebFetch blocked: "${hostname}" is not in the ${SOURCES_FILE} allowlist. ` +
      `Add the source to ${SOURCES_FILE} to permit fetches from this domain.`,
  );
  process.exit(2);
}

if (import.meta.main) {
  void main();
}
