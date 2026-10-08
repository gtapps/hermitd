import { test, expect, afterEach } from "bun:test";
import { join } from "node:path";
import { parseArgs, buildUrl, mapPost, extractPosts, userAgent } from "../scripts/reddit-fetch";

const SCRIPT = join(import.meta.dir, "..", "scripts", "reddit-fetch.ts");

const originalUA = process.env.REDDIT_USER_AGENT;

afterEach(() => {
  if (originalUA === undefined) delete process.env.REDDIT_USER_AGENT;
  else process.env.REDDIT_USER_AGENT = originalUA;
});

test("parseArgs strips leading r/ prefix", () => {
  expect(parseArgs(["bun", "s", "r/programming"])?.subreddit).toBe("programming");
});

test("parseArgs defaults limit to 20", () => {
  expect(parseArgs(["bun", "s", "programming"])?.limit).toBe(20);
});

test("parseArgs honours a custom limit", () => {
  expect(parseArgs(["bun", "s", "programming", "5"])?.limit).toBe(5);
});

test("parseArgs returns null with no subreddit", () => {
  expect(parseArgs(["bun", "s"])).toBeNull();
});

test("buildUrl uses the unauthenticated hot.json endpoint", () => {
  expect(buildUrl("programming", 20)).toBe("https://www.reddit.com/r/programming/hot.json?limit=20");
});

test("mapPost maps all fields and prefixes the permalink", () => {
  const post = mapPost({
    data: {
      title: "Hello",
      url: "https://example.com",
      score: 42,
      num_comments: 7,
      permalink: "/r/x/comments/abc/hello/",
    },
  });
  expect(post).toEqual({
    title: "Hello",
    url: "https://example.com",
    score: 42,
    comments: 7,
    permalink: "https://reddit.com/r/x/comments/abc/hello/",
  });
});

test("mapPost prefers url_overridden_by_dest over url", () => {
  const post = mapPost({ data: { url: "https://fallback", url_overridden_by_dest: "https://real" } });
  expect(post.url).toBe("https://real");
});

test("extractPosts filters stickied posts", () => {
  const json = {
    data: {
      children: [
        { data: { title: "pinned", stickied: true } },
        { data: { title: "real" } },
      ],
    },
  };
  const posts = extractPosts(json, 20);
  expect(posts.map((p) => p.title)).toEqual(["real"]);
});

test("extractPosts caps at limit after filtering", () => {
  const json = {
    data: { children: [1, 2, 3].map((n) => ({ data: { title: `t${n}` } })) },
  };
  expect(extractPosts(json, 2)).toHaveLength(2);
});

test("extractPosts returns [] for empty data", () => {
  expect(extractPosts({ data: { children: [] } }, 20)).toEqual([]);
  expect(extractPosts({}, 20)).toEqual([]);
});

test("userAgent defaults when env unset", () => {
  delete process.env.REDDIT_USER_AGENT;
  expect(userAgent()).toBe("hermit/1.0 (feed bot)");
});

test("userAgent honours REDDIT_USER_AGENT override", () => {
  process.env.REDDIT_USER_AGENT = "custom/9.9";
  expect(userAgent()).toBe("custom/9.9");
});

test("no args → exit 1", async () => {
  const proc = Bun.spawn(["bun", SCRIPT], { stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  expect(code).toBe(1);
});
