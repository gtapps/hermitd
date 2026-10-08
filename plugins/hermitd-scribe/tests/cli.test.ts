#!/usr/bin/env bun

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import path from "node:path";
import {
  buildLabels,
  deriveType,
  resolveScope,
  deriveLabels,
  buildTitleLine,
} from "../skills/hermit-scribe/file-issue";

type Json = any;

const SCRIPT = path.join(import.meta.dir, "..", "skills", "hermit-scribe", "file-issue.ts");

let pass = 0;
let fail = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ok    ${name}`);
  } catch (err: any) {
    fail++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function run(env: Json, args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
}

function assertEqual(actual: any, expected: any, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertMatch(actual: string, pattern: RegExp, label: string) {
  if (!pattern.test(actual)) {
    throw new Error(`${label}: ${JSON.stringify(actual)} does not match ${pattern}`);
  }
}

function assertFails(env: Json, args: string[], pattern: RegExp) {
  const r = run(env, args);
  assertEqual(r.status, 1, "exit code");
  assertMatch(r.stderr, pattern, "stderr");
}

const fixtures = mkdtempSync(path.join(tmpdir(), "hermit-scribe-test-"));
const keyFile = path.join(fixtures, "key.pem");
const titleFile = path.join(fixtures, "title");
const wsTitleFile = path.join(fixtures, "ws");
const bodyFile = path.join(fixtures, "body.md");

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
writeFileSync(keyFile, privateKey.export({ type: "pkcs1", format: "pem" }));
writeFileSync(titleFile, "valid issue title\n");
writeFileSync(wsTitleFile, "   \n\t\n  ");
writeFileSync(bodyFile, "issue body content\n");

const fullEnv = {
  HERMIT_GH_APP_ID: "1",
  HERMIT_GH_APP_INSTALL_ID: "2",
  HERMIT_GH_APP_KEY_FILE: keyFile,
};

console.log("hermit-scribe CLI tests");

test("one arg prints usage and exits 1", () => {
  assertFails({}, ["--publish", titleFile], /Usage: bun file-issue\.ts/);
});

// Filing must stay behind the named verb: the seeded permissions.ask rule
// matches on `--publish`, so a bare positional call reaching the API would
// publish with no operator checkpoint.
test("bare positional args no longer file an issue", () => {
  assertFails({}, [titleFile, bodyFile], /Usage: bun file-issue\.ts --publish/);
});

test("missing HERMIT_GH_APP_ID is named in error", () => {
  assertFails({}, ["--publish", titleFile, bodyFile], /Missing env var: HERMIT_GH_APP_ID/);
});

test("missing HERMIT_GH_APP_INSTALL_ID is named in error", () => {
  assertFails(
    { HERMIT_GH_APP_ID: "1" },
    ["--publish", titleFile, bodyFile],
    /Missing env var: HERMIT_GH_APP_INSTALL_ID/
  );
});

test("missing HERMIT_GH_APP_KEY_FILE is named in error", () => {
  assertFails(
    { HERMIT_GH_APP_ID: "1", HERMIT_GH_APP_INSTALL_ID: "2" },
    ["--publish", titleFile, bodyFile],
    /Missing env var: HERMIT_GH_APP_KEY_FILE/
  );
});

test("HERMIT_GH_REPO with too many slashes is rejected", () => {
  assertFails(
    { ...fullEnv, HERMIT_GH_REPO: "a/b/c" },
    ["--publish", titleFile, bodyFile],
    /HERMIT_GH_REPO must be "owner\/repo"/
  );
});

test("HERMIT_GH_REPO with no slash is rejected", () => {
  assertFails(
    { ...fullEnv, HERMIT_GH_REPO: "single" },
    ["--publish", titleFile, bodyFile],
    /HERMIT_GH_REPO must be "owner\/repo"/
  );
});

test("--check with no proposal id prints usage and exits 1", () => {
  assertFails({}, ["--check"], /Usage: bun file-issue\.ts --check/);
});

test("--check with missing env var reports the var name", () => {
  assertFails({}, ["--check", "PROP-001"], /Missing env var: HERMIT_GH_APP_ID/);
});

test("--check with missing key file shows labeled error", () => {
  assertFails(
    { ...fullEnv, HERMIT_GH_APP_KEY_FILE: "/nonexistent/key.pem" },
    ["--check", "PROP-001"],
    /HERMIT_GH_APP_KEY_FILE=.*does not exist/
  );
});

test("--templates with missing env var reports the var name", () => {
  assertFails({}, ["--templates"], /Missing env var: HERMIT_GH_APP_ID/);
});

test("--templates with missing key file shows labeled error", () => {
  assertFails(
    { ...fullEnv, HERMIT_GH_APP_KEY_FILE: "/nonexistent/key.pem" },
    ["--templates"],
    /HERMIT_GH_APP_KEY_FILE=.*does not exist/
  );
});

// API calls must go through HTTPS_PROXY: node:https ignored it and timed out on
// proxy-only hosts. The stub proxy logs the CONNECT and refuses it, so nothing
// reaches GitHub. It runs as a child process because spawnSync blocks this one.
const proxyLog = path.join(fixtures, "proxy.log");
const proxy = spawn(process.execPath, [path.join(import.meta.dir, "stub-proxy.ts"), proxyLog], {
  stdio: ["ignore", "pipe", "inherit"],
});
// Reject on early exit: an unresolved top-level await hangs Bun forever.
const proxyPort = await new Promise<string>((resolve, reject) => {
  proxy.stdout!.once("data", (b) => resolve(b.toString().trim()));
  proxy.once("exit", () => reject(new Error("stub proxy exited before listening")));
});

test("API calls are tunnelled through HTTPS_PROXY", () => {
  writeFileSync(proxyLog, "");
  const r = run({ ...fullEnv, HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` }, ["--check", "PROP-001"]);
  assertEqual(r.status, 1, "exit code");
  assertMatch(readFileSync(proxyLog, "utf8"), /^CONNECT api\.github\.com:443 /, "proxy log");
  // A refused tunnel must not read as a GitHub rejection ("GH 407: ").
  assertMatch(
    r.stderr,
    /^Proxy 407 Proxy Authentication Required: request did not reach GitHub \(check HTTPS_PROXY\)$/m,
    "stderr"
  );
});

test("an unreachable proxy is reported as a proxy error", () => {
  const r = run({ ...fullEnv, HTTPS_PROXY: "http://127.0.0.1:1" }, ["--check", "PROP-001"]);
  assertEqual(r.status, 1, "exit code");
  assertMatch(r.stderr, /^Proxy error: .*\(check HTTPS_PROXY\)$/m, "stderr");
});

proxy.kill();

// Requires real GitHub App credentials. Set HERMIT_GH_CHECK_LIVE=1 to run.
if (process.env.HERMIT_GH_CHECK_LIVE) {
  test("--check with unknown proposal id exits 2 with no match message", () => {
    const liveEnv = {
      HERMIT_GH_APP_ID: process.env.HERMIT_GH_APP_ID,
      HERMIT_GH_APP_INSTALL_ID: process.env.HERMIT_GH_APP_INSTALL_ID,
      HERMIT_GH_APP_KEY_FILE: process.env.HERMIT_GH_APP_KEY_FILE,
    };
    const r = run(liveEnv, ["--check", "PROP-NOTREAL-99999"]);
    assertEqual(r.status, 2, "exit code");
    assertMatch(r.stderr, /no match/, "stderr");
  });
}

test("whitespace-only title file is rejected after trim", () => {
  assertFails(fullEnv, ["--publish", wsTitleFile, bodyFile], /Title file is empty/);
});

// --- buildLabels unit tests ---

function assertDeepEqual(actual: any, expected: any, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label}: expected ${e}, got ${a}`);
  }
}

test("buildLabels([]) returns [hermit-filed]", () => {
  assertDeepEqual(buildLabels([]), ["hermit-filed"], "labels");
});

test("buildLabels with extra labels puts hermit-filed first", () => {
  assertDeepEqual(
    buildLabels(["bug", "homeassistant-hermit"]),
    ["hermit-filed", "bug", "homeassistant-hermit"],
    "labels"
  );
});

test("buildLabels deduplicates hermit-filed if passed explicitly", () => {
  assertDeepEqual(buildLabels(["hermit-filed", "bug"]), ["hermit-filed", "bug"], "labels");
});

// --- trailing label args CLI test ---

test("trailing label args do not break arg parsing (reaches token acquisition)", () => {
  assertFails(
    { ...fullEnv, HERMIT_GH_APP_KEY_FILE: "/nonexistent/key.pem" },
    ["--publish", titleFile, bodyFile, "bug", "homeassistant-hermit"],
    /HERMIT_GH_APP_KEY_FILE=.*does not exist/
  );
});

// --- classify: deriveType ---

test("deriveType: bug -> fix", () => assertEqual(deriveType("bug"), "fix", "type"));
test("deriveType: infrastructure -> chore", () =>
  assertEqual(deriveType("infrastructure"), "chore", "type"));
test("deriveType: investigation -> chore", () =>
  assertEqual(deriveType("investigation"), "chore", "type"));
test("deriveType: improvement -> feat", () => assertEqual(deriveType("improvement"), "feat", "type"));
test("deriveType: capability -> feat", () => assertEqual(deriveType("capability"), "feat", "type"));
test("deriveType: routine -> feat", () => assertEqual(deriveType("routine"), "feat", "type"));
test("deriveType: constraint -> feat", () => assertEqual(deriveType("constraint"), "feat", "type"));
test("deriveType: unknown -> feat", () => assertEqual(deriveType("whatever"), "feat", "type"));

// --- classify: resolveScope ---

const slugSet = [
  "hermitd",
  "hermitd-dev",
  "hermitd-homeassistant",
  "hermitd-scribe",
];

test("resolveScope priority 2: single whole-word match", () => {
  assertEqual(resolveScope("touches hermitd-scribe today", slugSet), "scribe", "scope");
});

test("resolveScope priority 2: plugins/<slug>/ path match", () => {
  assertEqual(
    resolveScope("edit plugins/hermitd-homeassistant/foo.ts", slugSet),
    "homeassistant",
    "scope"
  );
});

test("resolveScope priority 2: substring of longer identifier is not a match", () => {
  // "hermitd-scribe" appears only inside "my-hermitd-scribe-thing" -> no whole-word match.
  // Falls through to priority 3 (single fleet hermit among the two-slug set below).
  assertEqual(resolveScope("my-hermitd-scribe-thing", ["hermitd-scribe", "hermitd-dev"]), null, "scope");
});

test("resolveScope priority 2: multiple matches -> omit (null)", () => {
  assertEqual(resolveScope("hermitd-scribe and hermitd-dev", slugSet), null, "scope");
});

test("resolveScope priority 3: zero matches, single fleet hermit -> use it", () => {
  assertEqual(
    resolveScope("nothing named here", ["hermitd", "hermitd-dev"]),
    "dev",
    "scope"
  );
});

test("resolveScope priority 4: zero matches, multiple fleet hermits -> omit", () => {
  assertEqual(resolveScope("nothing named here", slugSet), null, "scope");
});

test("resolveScope priority 4: zero matches, no fleet hermits -> omit", () => {
  assertEqual(resolveScope("nothing named here", ["hermitd"]), null, "scope");
});

test("resolveScope: empty slug set (config absent) -> omit", () => {
  assertEqual(resolveScope("mentions hermitd-scribe", []), null, "scope");
});

// --- classify: deriveLabels ---

test("deriveLabels: bug + scope", () =>
  assertDeepEqual(deriveLabels("bug", "hermit-scribe"), ["bug", "hermit-scribe"], "labels"));
test("deriveLabels: infrastructure -> chore, no scope", () =>
  assertDeepEqual(deriveLabels("infrastructure", null), ["chore"], "labels"));
test("deriveLabels: investigation -> chore", () =>
  assertDeepEqual(deriveLabels("investigation", null), ["chore"], "labels"));
test("deriveLabels: capability -> enhancement + scope", () =>
  assertDeepEqual(deriveLabels("capability", "dev-hermit"), ["enhancement", "dev-hermit"], "labels"));
test("deriveLabels: unknown -> enhancement, no scope", () =>
  assertDeepEqual(deriveLabels("mystery", null), ["enhancement"], "labels"));

// --- classify: buildTitleLine ---

test("buildTitleLine: without scope", () =>
  assertEqual(buildTitleLine("fix", null, "squash bug"), "fix: squash bug", "line"));

// --- classify: CLI subcommand (config reader + JSON emission) ---

test("classify with no args prints usage and exits 1", () => {
  assertFails({}, ["classify"], /Usage: bun file-issue\.ts classify/);
});

test("classify emits JSON derived from config _hermit_versions", () => {
  const cfgDir = mkdtempSync(path.join(tmpdir(), "hermit-scribe-cfg-"));
  const stateDir = path.join(cfgDir, ".hermit");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, "config.json"),
    JSON.stringify({ _hermit_versions: { "hermitd": "1.0.0", "hermitd-scribe": "1.0.0" } })
  );
  const t = path.join(cfgDir, "title");
  const b = path.join(cfgDir, "body.md");
  writeFileSync(t, "make scribe classify\n");
  writeFileSync(b, "this touches hermitd-scribe internals\n");

  const r = spawnSync(process.execPath, [SCRIPT, "classify", "capability", t, b], {
    env: { PATH: process.env.PATH },
    cwd: cfgDir,
    encoding: "utf8",
  });
  assertEqual(r.status, 0, "exit code");
  const out = JSON.parse(r.stdout);
  assertEqual(out.type, "feat", "type");
  assertEqual(out.scope, "scribe", "scope");
  assertDeepEqual(out.labels, ["enhancement", "scribe"], "labels");
  assertEqual(out.title_line, "feat(scribe): make scribe classify", "title_line");
});

console.log("");
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
