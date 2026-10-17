#!/usr/bin/env bun
/**
 * Fetch top posts from a subreddit.
 *
 * Default path: unauthenticated JSON endpoint (https://www.reddit.com/r/<sub>/hot.json).
 * Optional: authed OAuth path when REDDIT_CLIENT_ID/SECRET are set (falls back on failure).
 *
 * USAGE:  bun reddit-fetch.ts <subreddit> [limit]
 * OUTPUT: {"posts":[{title, url, score, comments, permalink}]} on stdout.
 * An unreachable or failing Reddit prints {"status":"unavailable","reason":"<token>"} and exits 0;
 * bad arguments print {"error":"usage"} and exit 1.
 */

const DEFAULT_LIMIT = 20;
const DEFAULT_USER_AGENT = "hermit/1.0 (feed bot)";

export interface Post {
  title: string;
  url: string;
  score: number;
  comments: number;
  permalink: string;
}

interface RedditChild {
  data?: {
    stickied?: boolean;
    title?: string;
    url_overridden_by_dest?: string;
    url?: string;
    score?: number;
    num_comments?: number;
    permalink?: string;
  };
}

export function parseArgs(argv: string[]): { subreddit: string; limit: number } | null {
  const args = argv.slice(2);
  if (args.length < 1) return null;
  const subreddit = args[0].replace(/^r\//, "");
  const limit = args.length > 1 ? parseInt(args[1], 10) : DEFAULT_LIMIT;
  return { subreddit, limit: Number.isNaN(limit) || limit < 1 ? DEFAULT_LIMIT : limit };
}

export function userAgent(): string {
  return process.env.REDDIT_USER_AGENT || DEFAULT_USER_AGENT;
}

export function buildUrl(subreddit: string, limit: number): string {
  return `https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}`;
}

export function mapPost(child: RedditChild): Post {
  const d = child.data ?? {};
  return {
    title: d.title ?? "",
    url: d.url_overridden_by_dest || d.url || "",
    score: d.score ?? 0,
    comments: d.num_comments ?? 0,
    permalink: `https://reddit.com${d.permalink ?? ""}`,
  };
}

function extractChildren(json: unknown): RedditChild[] {
  if (typeof json !== "object" || json === null) return [];
  const data = (json as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return [];
  const children = (data as { children?: unknown }).children;
  return Array.isArray(children) ? (children as RedditChild[]) : [];
}

export function extractPosts(json: unknown, limit: number): Post[] {
  const posts: Post[] = [];
  for (const child of extractChildren(json)) {
    if (child.data?.stickied) continue;
    posts.push(mapPost(child));
  }
  return posts.slice(0, limit);
}

async function getAccessToken(clientId: string, clientSecret: string, ua: string): Promise<string | null> {
  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const resp = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": ua,
      },
      body: "grant_type=client_credentials",
    });
    if (!resp.ok) return null;
    const json: unknown = await resp.json();
    if (typeof json === "object" && json !== null) {
      const token = (json as { access_token?: unknown }).access_token;
      if (typeof token === "string" && token.length > 0) return token;
    }
    return null;
  } catch {
    return null;
  }
}

export class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** Snake-case reason for a fetch that did not yield posts. */
export function unavailableReason(error: unknown): string {
  if (error instanceof HttpError) return `http_${error.status}`;
  if (error instanceof SyntaxError) return "invalid_response";
  return "network_error";
}

async function fetchAndExtract(
  url: string,
  headers: Record<string, string>,
  limit: number,
): Promise<Post[]> {
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new HttpError(resp.status);
  const json: unknown = await resp.json();
  return extractPosts(json, limit);
}

async function fetchUnauthed(subreddit: string, limit: number, ua: string): Promise<Post[]> {
  return fetchAndExtract(buildUrl(subreddit, limit), { "User-Agent": ua }, limit);
}

async function fetchAuthed(subreddit: string, limit: number, ua: string, token: string): Promise<Post[]> {
  return fetchAndExtract(
    `https://oauth.reddit.com/r/${subreddit}/hot?limit=${limit}`,
    { Authorization: `bearer ${token}`, "User-Agent": ua },
    limit,
  );
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  if (!parsed) {
    console.log(JSON.stringify({ error: "usage" }));
    process.exit(1);
  }
  const { subreddit, limit } = parsed;
  const ua = userAgent();
  const clientId = process.env.REDDIT_CLIENT_ID;
  const clientSecret = process.env.REDDIT_CLIENT_SECRET;

  try {
    let posts: Post[];
    if (clientId && clientSecret) {
      const token = await getAccessToken(clientId, clientSecret, ua);
      posts = token ? await fetchAuthed(subreddit, limit, ua, token) : await fetchUnauthed(subreddit, limit, ua);
    } else {
      posts = await fetchUnauthed(subreddit, limit, ua);
    }
    console.log(JSON.stringify({ posts }));
  } catch (e) {
    console.log(JSON.stringify({ status: "unavailable", reason: unavailableReason(e) }));
  }
}

if (import.meta.main) {
  void main();
}
