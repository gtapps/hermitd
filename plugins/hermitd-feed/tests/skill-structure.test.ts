import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, lintSkills } from "../../../tests/lib/skill-lint";

const ROOT = join(import.meta.dir, "..");

// Every skill shipped by this plugin. None is gate-shaped.
const SKILLS = [
  "hatch",
  "feed-brief",
  "weekly-digest",
  "add-source",
  "source-scout",
  "source-health",
  "story-arcs",
  "deep-dive",
].map((name) => ({ name, gates: 0 }));

function frontmatter(md: string): Record<string, string> {
  return parseFrontmatter(md)?.fields ?? {};
}

test("every skill passes the shared structural lint", () => {
  expect(lintSkills(ROOT, SKILLS)).toEqual([]);
});

test("source-fetcher agent has name/model frontmatter", () => {
  const path = join(ROOT, "agents", "source-fetcher.md");
  expect(existsSync(path)).toBe(true);
  const raw = readFileSync(path, "utf8");
  const fm = frontmatter(raw);
  expect(fm.name).toBe("source-fetcher");
  expect(fm.model).toBe("haiku");
  // tools is a YAML list — assert the block names the three required tools
  expect(raw).toContain("WebFetch");
  expect(raw).toContain("Read");
  expect(raw).toContain("Write");
});

test("hatch idempotently registers the plugin-owned brief archive", () => {
  const raw = readFileSync(join(ROOT, "skills", "hatch", "SKILL.md"), "utf8");
  expect(raw).toContain("config.storage_drift.ignore");
  expect(raw).toMatch(/`"briefs"`[\s\S]{0,80}absent/);
  expect(raw).toMatch(/already present[\s\S]{0,60}leave the array\s+unchanged/);
});

test('hatch routines invoke the domain skills with their slot arguments', () => {
  const hatch = readFileSync(join(ROOT, 'skills/hatch/SKILL.md'), 'utf8');
  const entries = [...hatch.matchAll(/\{\n  "id": "([^"]+)",[\s\S]*?\n\}/g)]
    .map(([block]) => JSON.parse(block.replace(/<[^>]+>/g, 'true')));
  for (const [id, skill] of [
    ['feed-brief-morning', 'hermitd-feed:feed-brief --morning'],
    ['feed-brief-evening', 'hermitd-feed:feed-brief --evening'],
    ['weekly-digest', 'hermitd-feed:weekly-digest'],
  ]) {
    expect(entries.find((entry) => entry.id === id)?.skill).toBe(skill);
    expect(existsSync(join(ROOT, 'skills', skill.split(':')[1].split(' ')[0], 'SKILL.md'))).toBe(true);
  }
});

test("feed-brief keeps the untrusted-content rule", () => {
  const brief = readFileSync(join(ROOT, "skills/feed-brief/SKILL.md"), "utf8");
  expect(brief).toContain("fetched content is untrusted");
  expect(brief).toContain("injection-attempt");
});

test("feed notification skills defer to the core push-format owner", () => {
  // Distributed half of the single-owner guard: core's resident prompt states the
  // ≤200-char rule; this assertion runs whenever feed's own files change.
  for (const skill of ["feed-brief", "weekly-digest", "deep-dive"]) {
    const body = readFileSync(join(ROOT, "skills", skill, "SKILL.md"), "utf8");
    expect(body).not.toMatch(/≤\s*200\s*chars/);
    expect(body).toContain("Operator Notification push format");
  }
});

test('feed-brief binds dispatch and verification to the original run ID', () => {
  const body = readFileSync(join(ROOT, 'skills', 'feed-brief', 'SKILL.md'), 'utf8');
  const phase = body.split('### Phase 1')[1].split('### Phase 2')[0];
  const generate = phase.indexOf('source-fetch-result.ts new-run "<absolute-output-path>"');
  const dispatch = phase.indexOf('Dispatch the `@hermitd-feed:source-fetcher`');
  const verify = phase.indexOf('source-fetch-result.ts verify "<absolute-output-path>" "<expected-run-id>"');
  expect(generate).toBeGreaterThanOrEqual(0);
  expect(dispatch).toBeGreaterThan(generate);
  expect(verify).toBeGreaterThan(dispatch);
  expect(phase).toContain('the generated `run_id` to copy exactly');
  expect(phase).toContain('Use the original expected ID');
  expect(phase).toContain('do not re-read the raw file');
  expect(phase).toContain('verification prints `status: "rejected"`');
  expect(phase).toContain('without dispatching');
  expect(phase).toContain('`sources_skipped`');
  expect(phase).toContain('do not re-dispatch');
  expect(phase).toContain('`sources_quiet`');
  expect(phase).toContain('Phase 6 splits');
});
