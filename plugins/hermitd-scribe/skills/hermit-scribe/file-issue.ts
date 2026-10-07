#!/usr/bin/env bun

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

type Json = any;

function b64url(input: Buffer | string): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64url");
}

function makeJWT(appId: string, pem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));
  const input = `${header}.${payload}`;
  const sig = b64url(createSign("RSA-SHA256").update(input).sign(pem));
  return `${input}.${sig}`;
}

// fetch, not node:https: Bun's fetch honours HTTPS_PROXY / NO_PROXY, so the
// script works on hosts whose only egress is a proxy. A proxy that refuses the
// tunnel answers in GitHub's place, so its errors are labelled separately:
// only GitHub's own responses carry x-github-request-id.
async function ghRequest(method: string, path: string, auth: string, body?: Json): Promise<Json> {
  const proxied = Boolean(process.env.HTTPS_PROXY || process.env.https_proxy);
  const data = body ? JSON.stringify(body) : undefined;
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: auth,
      "User-Agent": "hermit-scribe/1",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    body: data,
  }).catch((err) => {
    throw proxied ? new Error(`Proxy error: ${err.message} (check HTTPS_PROXY)`) : err;
  });
  if (res.status >= 400 && proxied && !res.headers.has("x-github-request-id")) {
    const status = `${res.status} ${res.statusText}`.trimEnd();
    throw new Error(`Proxy ${status}: request did not reach GitHub (check HTTPS_PROXY)`);
  }
  const raw = await res.text();
  let json: Json;
  try { json = JSON.parse(raw); } catch { json = { message: raw }; }
  if (res.status >= 400) throw new Error(`GH ${res.status}: ${json.message || raw}`);
  return json;
}

function loadEnv(): Json {
  const {
    HERMIT_GH_APP_ID,
    HERMIT_GH_APP_INSTALL_ID,
    HERMIT_GH_APP_KEY_FILE,
    HERMIT_GH_REPO = "gtapps/hermitd",
  } = process.env;

  for (const [name, val] of [
    ["HERMIT_GH_APP_ID", HERMIT_GH_APP_ID],
    ["HERMIT_GH_APP_INSTALL_ID", HERMIT_GH_APP_INSTALL_ID],
    ["HERMIT_GH_APP_KEY_FILE", HERMIT_GH_APP_KEY_FILE],
  ]) {
    if (!val) {
      process.stderr.write(`Missing env var: ${name}\n`);
      process.exit(1);
    }
  }

  const repoParts = HERMIT_GH_REPO.split("/");
  if (repoParts.length !== 2) {
    process.stderr.write(`HERMIT_GH_REPO must be "owner/repo", got: ${HERMIT_GH_REPO}\n`);
    process.exit(1);
  }

  const [owner, repo] = repoParts;
  return { HERMIT_GH_APP_ID, HERMIT_GH_APP_INSTALL_ID, HERMIT_GH_APP_KEY_FILE, owner, repo };
}

async function getInstallToken({ HERMIT_GH_APP_ID, HERMIT_GH_APP_INSTALL_ID, HERMIT_GH_APP_KEY_FILE }: Json): Promise<string> {
  let pem: string;
  try {
    pem = readFileSync(HERMIT_GH_APP_KEY_FILE, "utf8");
  } catch {
    process.stderr.write(
      `HERMIT_GH_APP_KEY_FILE='${HERMIT_GH_APP_KEY_FILE}' does not exist (cwd=${process.cwd()}) — check .env\n`
    );
    process.exit(1);
  }
  const jwt = makeJWT(HERMIT_GH_APP_ID, pem);
  const { token } = await ghRequest(
    "POST",
    `/app/installations/${HERMIT_GH_APP_INSTALL_ID}/access_tokens`,
    `Bearer ${jwt}`
  );
  return token;
}

async function checkMode() {
  const proposalId = process.argv[3];
  if (!proposalId) {
    process.stderr.write("Usage: bun file-issue.ts --check <proposal-id>\n");
    process.exit(1);
  }

  const env = loadEnv();
  const token = await getInstallToken(env);
  const { owner, repo } = env;

  let page = 1;
  while (true) {
    const issues = await ghRequest(
      "GET",
      `/repos/${owner}/${repo}/issues?labels=hermit-filed&state=open&per_page=100&page=${page}`,
      `Bearer ${token}`
    );
    if (!Array.isArray(issues) || issues.length === 0) break;
    const match = issues.find((i) => i.body && i.body.includes(`proposal=${proposalId}`));
    if (match) {
      process.stdout.write(match.html_url + "\n");
      process.exit(0);
    }
    if (issues.length < 100) break;
    page++;
  }

  process.stderr.write(`no match for ${proposalId}\n`);
  process.exit(2);
}

async function templatesMode() {
  const env = loadEnv();
  const token = await getInstallToken(env);
  const { owner, repo } = env;

  const noTemplates = () => {
    process.stderr.write(`no templates for ${owner}/${repo}\n`);
    process.exit(2);
  };

  let entries: Json;
  try {
    entries = await ghRequest("GET", `/repos/${owner}/${repo}/contents/.github/ISSUE_TEMPLATE`, `Bearer ${token}`);
  } catch (err: any) {
    if (/^GH 404/.test(err.message)) noTemplates();
    throw err;
  }

  const names = Array.isArray(entries)
    ? entries
        .filter((e) => e.type === "file" && /\.(md|ya?ml)$/.test(e.name) && e.name !== "config.yml")
        .map((e) => e.name)
    : [];

  if (names.length === 0) noTemplates();

  process.stdout.write(names.join("\n") + "\n");
}

async function commentMode() {
  const issueNumber = parseInt(process.argv[3], 10);
  const bodyFile = process.argv[4];
  if (!issueNumber || issueNumber <= 0 || !bodyFile) {
    process.stderr.write("Usage: bun file-issue.ts --comment <issue-number> <body-file>\n");
    process.exit(1);
  }

  const env = loadEnv();
  const token = await getInstallToken(env);
  const { owner, repo } = env;

  const body = readFileSync(bodyFile, "utf8");
  if (!body.trim()) {
    process.stderr.write(`Body file is empty: ${bodyFile}\n`);
    process.exit(1);
  }
  const comment = await ghRequest(
    "POST",
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    `Bearer ${token}`,
    { body }
  );

  process.stdout.write(comment.html_url + "\n");
}

function buildLabels(extra: string[] = []): string[] {
  return [...new Set(["hermit-filed", ...extra])];
}

// --- classify: pure derivation helpers (proposal-backed issues only) ---

// Conventional-Commits type from proposal category.
function deriveType(category: string): string {
  switch (category) {
    case "bug":
      return "fix";
    case "infrastructure":
    case "investigation":
      return "chore";
    default:
      return "feat"; // improvement/capability/routine/constraint/unknown
  }
}

// Strip the fleet-wide `hermitd-` prefix from a slug.
function stripSlug(slug: string): string {
  return slug.replace(/^hermitd-/, "");
}

// Resolve a single scope token from raw (pre-translation) text, or null.
// slugSet is the keys of `_hermit_versions`. Returns the stripped scope.
function resolveScope(rawText: string, slugSet: string[]): string | null {
  const matched = new Set<string>();
  for (const slug of slugSet) {
    const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wholeWord = new RegExp(`(?<![\\w-])${esc}(?![\\w-])`);
    const pathRef = new RegExp(`plugins/${esc}/`);
    if (wholeWord.test(rawText) || pathRef.test(rawText)) matched.add(slug);
  }
  if (matched.size === 1) return stripSlug([...matched][0]);
  if (matched.size > 1) return null; // ambiguous: signal present but unresolved — stop
  const fleet = slugSet.filter((s) => /^hermitd-.+$/.test(s) && s !== "hermitd");
  if (fleet.length === 1) return stripSlug(fleet[0]);
  return null;
}

// Type label from category, plus the scope token as an extra label when present.
// `hermit-filed` is added later by buildLabels — not included here.
function deriveLabels(category: string, scope: string | null): string[] {
  const typeLabel =
    category === "bug"
      ? "bug"
      : category === "infrastructure" || category === "investigation"
        ? "chore"
        : "enhancement";
  return scope ? [typeLabel, scope] : [typeLabel];
}

function buildTitleLine(type: string, scope: string | null, title: string): string {
  return scope ? `${type}(${scope}): ${title}` : `${type}: ${title}`;
}

// Walk up from cwd to the nearest `.hermit/config.json` and return
// the keys of `_hermit_versions` (the recognized slug set). Empty if unreadable.
function readSlugSet(): string[] {
  let dir = process.cwd();
  while (true) {
    try {
      const cfg = JSON.parse(readFileSync(path.join(dir, ".hermit", "config.json"), "utf8"));
      const versions = cfg._hermit_versions;
      return versions && typeof versions === "object" ? Object.keys(versions) : [];
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) return [];
    dir = parent;
  }
}

function classifyMode() {
  const category = process.argv[3];
  const titleFile = process.argv[4];
  const bodyFile = process.argv[5];
  if (!category || !titleFile || !bodyFile) {
    process.stderr.write("Usage: bun file-issue.ts classify <category> <title-file> <body-file>\n");
    process.exit(1);
  }

  const { title, body } = readTitleAndBody(titleFile, bodyFile);

  const type = deriveType(category);
  const scope = resolveScope(`${title}\n${body}`, readSlugSet());
  const labels = deriveLabels(category, scope);
  const title_line = buildTitleLine(type, scope, title);

  process.stdout.write(JSON.stringify({ type, scope, labels, title_line }) + "\n");
}

function readTitleAndBody(titleFile: string, bodyFile: string): { title: string; body: string } {
  const title = readFileSync(titleFile, "utf8").trim();
  const body = readFileSync(bodyFile, "utf8");
  if (!title) {
    process.stderr.write(`Title file is empty: ${titleFile}\n`);
    process.exit(1);
  }
  return { title, body };
}

async function main() {
  if (process.argv[2] === "--check") {
    await checkMode();
    return;
  }

  if (process.argv[2] === "--comment") {
    await commentMode();
    return;
  }

  if (process.argv[2] === "--templates") {
    await templatesMode();
    return;
  }

  if (process.argv[2] === "classify") {
    classifyMode();
    return;
  }

  // Filing is named, not the fallthrough: `--publish` and `--comment` are what
  // the seeded permissions.ask rules match on, and a read mode must never be
  // one typo away from a publish.
  if (process.argv[2] !== "--publish") {
    process.stderr.write("Usage: bun file-issue.ts --publish <title-file> <body-file> [label...]\n");
    process.exit(1);
  }

  const titleFile = process.argv[3];
  const bodyFile = process.argv[4];
  const extraLabels = process.argv.slice(5);

  if (!titleFile || !bodyFile) {
    process.stderr.write("Usage: bun file-issue.ts --publish <title-file> <body-file> [label...]\n");
    process.exit(1);
  }

  const env = loadEnv();

  const { title, body: issueBody } = readTitleAndBody(titleFile, bodyFile);

  const token = await getInstallToken(env);
  const { owner, repo } = env;

  const issue = await ghRequest(
    "POST",
    `/repos/${owner}/${repo}/issues`,
    `Bearer ${token}`,
    { title, body: issueBody, labels: buildLabels(extraLabels) }
  );

  process.stdout.write(issue.html_url + "\n");
}

export { buildLabels, deriveType, resolveScope, deriveLabels, buildTitleLine };

if (import.meta.main) {
  main().catch((err: any) => {
    process.stderr.write(err.message + "\n");
    process.exit(1);
  });
}
