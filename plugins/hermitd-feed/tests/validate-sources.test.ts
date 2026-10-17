import { test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { validateSourcesTable } from "../scripts/validate-sources";

const SCRIPT = join(import.meta.dir, "..", "scripts", "validate-sources.ts");

const BAD_TABLE = `| Name | Type | URL |
| ---- | ---- | --- |
| Bad | bogus | https://x.com |
`;

/** Writes feed-sources.md into a fresh dir and returns its absolute path. */
function sourcesFileIn(markdown: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "validate-sources-"));
  const file = join(dir, "feed-sources.md");
  writeFileSync(file, markdown);
  return { dir, file };
}

async function runHook(cwd: string, filePath: string): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["bun", SCRIPT], { stdin: "pipe", stdout: "pipe", stderr: "ignore", cwd });
  proc.stdin.write(JSON.stringify({ tool_input: { file_path: filePath } }));
  await proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  return { code: await proc.exited, stdout };
}

const GOOD = `# Sources

| Name | Type | URL |
| ---- | ---- | --- |
| Hacker News | \`web\` | https://news.ycombinator.com |
| r/programming | reddit | https://reddit.com/r/programming |
`;

test("well-formed table has no violations", () => {
  expect(validateSourcesTable(GOOD)).toEqual([]);
});

test("invalid Type value is a violation", () => {
  const md = `| Name | Type | URL |
| ---- | ---- | --- |
| Bad | bogus | https://x.com |
`;
  const v = validateSourcesTable(md);
  expect(v.length).toBe(1);
  expect(v[0]).toContain("invalid Type");
});

test("column-count mismatch is a violation", () => {
  const md = `| Name | Type | URL |
| ---- | ---- | --- |
| Missing | web |
`;
  const v = validateSourcesTable(md);
  expect(v.length).toBe(1);
  expect(v[0]).toContain("expected 3 columns");
});

test("empty Name is a violation", () => {
  const md = `| Name | Type | URL |
| ---- | ---- | --- |
|  | web | https://x.com |
`;
  const v = validateSourcesTable(md);
  expect(v.length).toBe(1);
  expect(v[0]).toContain("Name column is empty");
});

test("hook passes through (exit 0) for a foreign sources.md edit", async () => {
  const proc = Bun.spawn(["bun", SCRIPT], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  proc.stdin.write(JSON.stringify({ tool_input: { file_path: "/tmp/sources.md" } }));
  await proc.stdin.end();
  expect(await proc.exited).toBe(0);
});

// Two same-named feed-sources.md files: the one the hook reports is the one
// validated, in both directions — cwd's copy is never opened.
test("validates the payload-named file, not cwd's copy (payload good, cwd bad)", async () => {
  const cwdCopy = sourcesFileIn(BAD_TABLE);
  const edited = sourcesFileIn(GOOD);
  expect(await runHook(cwdCopy.dir, edited.file)).toEqual({ code: 0, stdout: "" });
});

test("validates the payload-named file, not cwd's copy (payload bad, cwd good)", async () => {
  const cwdCopy = sourcesFileIn(GOOD);
  const edited = sourcesFileIn(BAD_TABLE);
  const { code, stdout } = await runHook(cwdCopy.dir, edited.file);
  // Exit 0 with a PostToolUse block decision, so the violations reach Claude.
  expect(code).toBe(0);
  const output = JSON.parse(stdout);
  expect(output.decision).toBe("block");
  expect(output.reason).toContain("invalid Type 'bogus'");
});
