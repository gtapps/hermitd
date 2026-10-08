import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// docs/schema.md is the product's spine — the archive-frontmatter and registry
// contracts the pipeline depends on. Guard against silent drift.
const schema = readFileSync(join(import.meta.dir, "..", "docs", "schema.md"), "utf8");

const DAILY_ARCHIVE_KEYS = [
  "top_categories",
  "item_count",
  "sources_used",
  "sources_skipped",
  "sources_quiet",
  "fetch_log",
];

for (const key of DAILY_ARCHIVE_KEYS) {
  test(`schema.md documents daily-archive key: ${key}`, () => {
    expect(schema).toContain(key);
  });
}

test('scratch producer and schema agree on caller-supplied run identity', () => {
  const agent = readFileSync(join(import.meta.dir, '..', 'agents', 'source-fetcher.md'), 'utf8');
  const scratch = schema.split('## 5. source-items JSON')[1].split('## 6.')[0];
  for (const text of [agent.split('## Output contract')[1], scratch]) {
    const example = JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)![1]);
    expect(example.run_id).toBe('<caller-supplied-run-id>');
    expect(Array.isArray(example.sources)).toBe(true);
    expect(text).toContain('`run_id`');
  }
  expect(agent).toContain('Never reuse one from an existing file');
  expect(agent).toContain('After writing, `Read` the same absolute path');
  expect(agent).toContain('Report a failed write');
  expect(scratch).toContain('source-fetch-result.ts verify');
  expect(scratch).toContain('Existing scratch files without `run_id`');
  expect(scratch).toContain('`sources_skipped`');
  expect(scratch).toContain('`sources_quiet`');
});
