import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAllowed, parseAllowlist } from "../hooks/fetch-guard";

const SCRIPT = join(import.meta.dir, "..", "hooks", "fetch-guard.ts");

const HN_ONLY = "| Name | Type | URL |\n| - | - | - |\n| HN | web | https://news.ycombinator.com |\n";

// Every spawn scrubs CLAUDE_PROJECT_DIR: these tests run inside a Claude Code
// session, where the inherited value names the real repo and would win the
// resolver's first branch, silently deciding the fixture's outcome.
function guardEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  delete env.CLAUDE_PROJECT_DIR;
  return { ...env, ...overrides };
}

/** A hatched project: sentinel + allowlist at the root, plus a nested dir to drift into. */
function hatchedProject(sources = HN_ONLY): { root: string; deep: string } {
  const root = mkdtempSync(join(tmpdir(), "fetch-guard-proj-"));
  mkdirSync(join(root, ".hermit"), { recursive: true });
  writeFileSync(join(root, ".hermit", "config.json"), "{}");
  writeFileSync(join(root, "feed-sources.md"), sources);
  const deep = join(root, "sub", "deeper");
  mkdirSync(deep, { recursive: true });
  return { root, deep };
}

async function runGuard(cwd: string, url: string, env = guardEnv()): Promise<number> {
  const proc = Bun.spawn(["bun", SCRIPT], { stdin: "pipe", stdout: "ignore", stderr: "ignore", cwd, env });
  proc.stdin.write(JSON.stringify({ tool_input: { url } }));
  await proc.stdin.end();
  return await proc.exited;
}

test("exact domain match is allowed", () => {
  expect(isAllowed("news.ycombinator.com", ["news.ycombinator.com"])).toBe(true);
});

test("subdomain of an allowlist entry is allowed", () => {
  expect(isAllowed("api.example.com", ["example.com"])).toBe(true);
});

test("off-allowlist domain is denied", () => {
  expect(isAllowed("evil.com", ["example.com"])).toBe(false);
});

test("parseAllowlist extracts hostnames from a feed-sources.md table", () => {
  const md = `| Name | Type | URL |
| ---- | ---- | --- |
| HN | web | https://news.ycombinator.com |
| Example | web | http://www.example.com/path |
`;
  const hosts = parseAllowlist(md);
  expect(hosts).toContain("news.ycombinator.com");
  expect(hosts).toContain("example.com");
});

test("hook blocks (exit 2) an off-allowlist URL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fetch-guard-"));
  writeFileSync(join(dir, "feed-sources.md"), HN_ONLY);
  expect(await runGuard(dir, "https://evil.example.org")).toBe(2);
});

test("drifted cwd inside a hatched project still enforces the allowlist", async () => {
  const { deep } = hatchedProject();
  expect(await runGuard(deep, "https://evil.example.org")).toBe(2);
  expect(await runGuard(deep, "https://news.ycombinator.com")).toBe(0);
});

test("hook allows the hardcoded infra list on top of feed-sources.md", async () => {
  const { root } = hatchedProject(); // allows news.ycombinator.com only
  expect(await runGuard(root, "https://raw.githubusercontent.com/o/r/main/f")).toBe(0);
});

test("CLAUDE_PROJECT_DIR names the project even when cwd has its own allowlist", async () => {
  const { root } = hatchedProject(); // allows news.ycombinator.com only
  const decoy = mkdtempSync(join(tmpdir(), "fetch-guard-decoy-"));
  writeFileSync(join(decoy, "feed-sources.md"), "| Name | Type | URL |\n| - | - | - |\n| Evil | web | https://evil.example.org |\n");
  expect(await runGuard(decoy, "https://evil.example.org", guardEnv({ CLAUDE_PROJECT_DIR: root }))).toBe(2);
});

test("stale CLAUDE_PROJECT_DIR falls through to the walk-up", async () => {
  const { deep } = hatchedProject();
  const stale = join(tmpdir(), "fetch-guard-does-not-exist");
  expect(await runGuard(deep, "https://evil.example.org", guardEnv({ CLAUDE_PROJECT_DIR: stale }))).toBe(2);
});

test("never-hatched project keeps the documented fail-open", async () => {
  const bare = mkdtempSync(join(tmpdir(), "fetch-guard-bare-"));
  expect(await runGuard(bare, "https://evil.example.org")).toBe(0);
});
