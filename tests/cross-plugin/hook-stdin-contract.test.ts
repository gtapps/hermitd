// Cross-plugin guard for the hook stdin contract stated in
// plugins/hermitd/scripts/lib/hook-input.ts: every hook consumes
// stdin to completion even past its size cap, and each hook has ONE declared
// fail direction for input it cannot parse.
//
// Five stdin idioms ship across the fleet (shared helper, hand-rolled loops,
// readFileSync(0), Bun.stdin.text()) — deliberately, since fleet plugins cannot
// import core at runtime. This test is what keeps the sealed copies honest: it
// feeds every gate the same adversarial corpus on REAL stdin and pins both the
// exit code and the drain.
//
// Not covered here (owned elsewhere, on purpose): the JSON permissionDecision
// envelope bytes, pinned byte-for-byte by HA's tests/gate-corpus.test.ts; and
// each hook's positive gating behavior, owned by its own plugin suite.
//
// Lives at the repo root (outside every plugin's `bun test` / run-all.sh
// discovery) so it never blocks a plugin release; the path-scoped
// test-cross-plugin.yml workflow runs it when any fleet hook changes.

import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../..');

const MAX_HOOK_STDIN = 1024 * 1024; // mirrors lib/hook-input.ts and the dev copies

interface Spec {
  name: string;
  script: string;
  /** Well-formed payload this hook must allow (exit 0). */
  benign: unknown;
  /** Exit code for EVERY adversarial shape: empty, garbage, non-object, oversize. */
  failExit: number;
}

const BASH_LS = { tool_name: 'Bash', tool_input: { command: 'ls -la' } };
const BENIGN_EDIT = { tool_name: 'Edit', tool_input: { file_path: 'scratch.txt' } };

// failExit is the hook's DECLARED fail direction — 0 = fail open (the default
// hook contract), 2 = fail closed. The HA gates fail closed: a payload they
// cannot parse is exactly the shape an evasion takes, so they block
// (hooks/mcp-safety-gate.ts fail() at :79-88, non-object check at :114).
// Changing a value here is a deliberate contract change.
const SPECS: Spec[] = [
  { name: 'ha/cli-approval', script: 'plugins/hermitd-homeassistant/hooks/cli-approval.ts', benign: BASH_LS, failExit: 2 },
  {
    name: 'core/pause-gate',
    script: 'plugins/hermitd/scripts/pause-gate.ts',
    benign: BASH_LS,
    failExit: 0, // unpaused: denyIfPaused() returns, runHook exits 0
  },
  {
    name: 'core/ask-gate',
    script: 'plugins/hermitd/scripts/ask-gate.ts',
    benign: BASH_LS,
    failExit: 0,
  },
  {
    name: 'core/cache-edit-guard',
    script: 'plugins/hermitd/scripts/cache-edit-guard.ts',
    benign: BENIGN_EDIT,
    failExit: 0,
  },
  {
    name: 'core/skill-guard',
    script: 'plugins/hermitd/scripts/skill-guard.ts',
    benign: BENIGN_EDIT,
    failExit: 0, // Malformed input exits 0; it denies only when the raw text names a skill folder.
  },
  {
    name: 'core/artifact-backend-guard',
    script: 'plugins/hermitd/scripts/artifact-backend-guard.ts',
    // Bash, not Artifact: the guard returns on any non-Artifact tool_name, so
    // the benign case stays independent of the sandbox's artifacts.backend.
    benign: BASH_LS,
    failExit: 0,
  },
  {
    name: 'core/helper-report-relay',
    script: 'plugins/hermitd/scripts/helper-report-relay.ts',
    // Refuses (exit 2) only a readable placeholder it cannot resolve; a reply
    // payload it cannot read passes through for the PostToolUse alarm.
    benign: { hook_event_name: 'PreToolUse', tool_name: 'mcp__discord__reply', tool_input: { chat_id: '1', text: 'hello' } },
    failExit: 0,
  },
  {
    name: 'core/settings-gate',
    script: 'plugins/hermitd/scripts/settings-gate.ts',
    benign: BASH_LS,
    // 0: oversized stdin raises a native ask (exit 0 + JSON) rather than a
    // deny. What this corpus pins is that the oversize path still drains.
    failExit: 0,
  },
  {
    name: 'core/mcp-auth-gate',
    script: 'plugins/hermitd/scripts/mcp-auth-gate.ts',
    benign: { hook_event_name: 'PreToolUse', tool_name: 'mcp__tool__complete_authentication', tool_input: {} },
    // 0: oversized stdin raises a native ask (exit 0 + JSON) rather than a deny.
    failExit: 0,
  },
  {
    name: 'core/stop-failure-stamp',
    script: 'plugins/hermitd/scripts/stop-failure-stamp.ts',
    // A StopFailure payload, not a tool call: this hook fires at turn end. The
    // sandbox cwd has no hermit folder, so the stamp write fails open and the
    // benign case stays independent of the dev box's own state dir.
    benign: {
      hook_event_name: 'StopFailure',
      error: 'model_not_found',
      session_id: '63d3ccda-cd07-4fd0-a88c-e56ac4ca311a',
      last_assistant_message: 'There is an issue with the selected model.',
    },
    failExit: 0,
  },
  {
    name: 'dev/git-push-guard',
    script: 'plugins/hermitd-dev/scripts/git-push-guard.ts',
    benign: BASH_LS,
    failExit: 0,
  },
  {
    name: 'dev/worktree-boundary-guard',
    script: 'plugins/hermitd-dev/scripts/worktree-boundary-guard.ts',
    benign: BENIGN_EDIT,
    failExit: 0,
  },
  {
    name: 'ha/mcp-safety-gate',
    script: 'plugins/hermitd-homeassistant/hooks/mcp-safety-gate.ts',
    // A read-only tool is allowed before any entity/config resolution, so the
    // benign case stays independent of the machine's HA configuration.
    benign: { tool_name: 'mcp__homeassistant__GetDateTime', tool_input: {} },
    failExit: 2,
  },
  {
    name: 'ha/curl-host-gate',
    script: 'plugins/hermitd-homeassistant/hooks/curl-host-gate.ts',
    benign: BASH_LS,
    failExit: 0,
  },
  {
    name: 'feed/fetch-guard',
    script: 'plugins/hermitd-feed/hooks/fetch-guard.ts',
    // No feed-sources.md in the sandbox cwd → the allowlist read fails open.
    benign: { tool_name: 'WebFetch', tool_input: { url: 'https://example.com/x' } },
    failExit: 0,
  },
];

let sandbox: string;
const payloadFiles = new Map<string, string>();

// The oversize case is generated, never committed — a 2MB fixture in git to
// assert "the hook kept reading" is not worth the repo weight (HA's gate-corpus
// generates its oversize cases the same way).
function corpus(): Array<{ label: string; body: string }> {
  return [
    { label: 'empty stdin', body: '' },
    { label: 'non-JSON garbage', body: 'not json at all {{{' },
    { label: 'non-object JSON (array)', body: '[1,2]' },
    { label: 'non-object JSON (null)', body: 'null' },
    { label: 'non-object JSON (string)', body: '"str"' },
    { label: `oversize ${MAX_HOOK_STDIN * 2} bytes, unparseable`, body: 'x'.repeat(MAX_HOOK_STDIN * 2) },
  ];
}

// Built once: the oversize body is a 2MB string, and the registration loop
// below only needs the labels.
const CORPUS = corpus();

beforeAll(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-stdin-corpus-'));
  for (const { label, body } of CORPUS) {
    const file = path.join(sandbox, `payload-${payloadFiles.size}.bin`);
    fs.writeFileSync(file, body);
    payloadFiles.set(label, file);
  }
});

afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/**
 * Pipe a payload file into the hook and return BOTH pipeline exit codes.
 *
 * The writer's code is the drain signal: a hook that stops reading before EOF
 * leaves the writer pushing into a closed pipe, which is SIGPIPE (141). Piping
 * through bash and reading PIPESTATUS is what makes that observable — writing
 * the payload from the test process only surfaces the hook's own exit code, and
 * a mid-stream exit and a clean drain both report 0 there.
 *
 * Clean env (PATH/HOME only) so an ambient AGENT_HOOK_PROFILE or HOMEASSISTANT_*
 * on the dev box cannot change a verdict.
 */
async function feed(
  scriptRel: string,
  payloadFile: string,
  extraEnv: Record<string, string> = {},
): Promise<{ writer: number; hook: number }> {
  const proc = Bun.spawn({
    cmd: [
      'bash',
      '-c',
      'cat "$1" | bun "$2" >/dev/null 2>&1; echo "${PIPESTATUS[0]} ${PIPESTATUS[1]}"',
      '_',
      payloadFile,
      path.join(ROOT, scriptRel),
    ],
    cwd: sandbox,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...extraEnv },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  const [writer, hook] = out.trim().split(/\s+/).map(Number);
  return { writer: writer!, hook: hook! };
}

for (const spec of SPECS) {
  describe(`hook stdin contract — ${spec.name}`, () => {
    test('the script exists at its registered path', () => {
      expect(fs.existsSync(path.join(ROOT, spec.script))).toBe(true);
    });

    test('allows a well-formed payload', async () => {
      const file = path.join(sandbox, `benign-${spec.name.replace(/\W/g, '-')}.json`);
      fs.writeFileSync(file, JSON.stringify(spec.benign));
      const r = await feed(spec.script, file);
      expect(r.hook).toBe(0);
      expect(r.writer).toBe(0);
    });

    for (const { label } of CORPUS) {
      test(`${label} → exit ${spec.failExit}, stdin drained`, async () => {
        const r = await feed(spec.script, payloadFiles.get(label)!);
        // Declared fail direction.
        expect(r.hook).toBe(spec.failExit);
        // Drain: the writer completed. Only the oversize case can actually fail
        // this — smaller payloads fit in the pipe buffer, so the writer finishes
        // whether or not the hook ever reads. That one case is the whole point.
        expect(r.writer).toBe(0);
      });
    }
  });
}

// A hook's own disable switch must not become a mid-stream exit: the guard is
// off, but the pipe still has to be drained or the writer takes SIGPIPE.
test('dev/worktree-boundary-guard drains stdin even with WORKTREE_GUARD=off', async () => {
  const r = await feed(
    'plugins/hermitd-dev/scripts/worktree-boundary-guard.ts',
    payloadFiles.get(`oversize ${MAX_HOOK_STDIN * 2} bytes, unparseable`)!,
    { WORKTREE_GUARD: 'off' },
  );
  expect(r.hook).toBe(0);
  expect(r.writer).toBe(0);
});

test('the corpus covers every fleet hook registered in a hooks.json or a launch overlay', async () => {
  // Auto-discovery keeps SPECS honest in BOTH directions. Hardcoded plugin
  // lists went stale twice before (see domain-hatch.contract.test.ts) — derive
  // from the filesystem instead.
  const registered = new Set<string>();
  const registeredPreToolUse = new Set<string>();
  for (const slug of fs.readdirSync(path.join(ROOT, 'plugins'))) {
    // A plugin's manifest is no longer the only place a hook is registered: the
    // resident-only ones ride a per-boot --settings overlay and never appear in
    // hooks.json. Read the overlay definition the renderer and the doctor check
    // already share, so a hook that runs is discovered wherever it is declared.
    const overlayFile = path.join(ROOT, 'plugins', slug, 'scripts', 'lib', 'settings', 'overlay-hooks.ts');
    if (fs.existsSync(overlayFile)) {
      const { overlayHooks } = await import(overlayFile);
      for (const [event, entries] of Object.entries<any>(overlayHooks(path.join(ROOT, 'plugins', slug)))) {
        for (const entry of entries) {
          for (const hook of entry.hooks ?? []) {
            // Both registration forms, for the same reason the hooks.json scan below
            // takes both: reading only `args` lets a hook registered the other way
            // silently skip the corpus.
            const candidates: string[] = [...(hook.args ?? []), ...String(hook.command ?? '').split(/\s+/)];
            const script = candidates.find((a: string) => a.endsWith('.ts'));
            if (!script) continue;
            registered.add(`${slug}:${path.basename(script)}`);
            if (event === 'PreToolUse') registeredPreToolUse.add(`${slug}:${path.basename(script)}`);
          }
        }
      }
    }
    const hooksFile = path.join(ROOT, 'plugins', slug, 'hooks', 'hooks.json');
    if (!fs.existsSync(hooksFile)) continue;
    const raw = fs.readFileSync(hooksFile, 'utf8');
    for (const m of raw.matchAll(/([\w./-]+\.ts)/g)) {
      const script = m[1]!.split('/').pop()!;
      registered.add(`${slug}:${script}`);
    }
    for (const entry of JSON.parse(raw)?.hooks?.PreToolUse ?? []) {
      for (const hook of entry.hooks ?? []) {
        // Both registration forms: `args: [".../gate.ts"]` and an inline
        // `command: "bun .../gate.ts"` (core's hooks.json already uses the
        // inline form elsewhere). Reading only `args` would let a gate
        // registered the other way silently skip the corpus.
        const candidates: string[] = [...(hook.args ?? []), ...String(hook.command ?? '').split(/\s+/)];
        const script = candidates.find(a => a.endsWith('.ts'));
        if (script) registeredPreToolUse.add(`${slug}:${script.split('/').pop()}`);
      }
    }
  }
  const covered = new Set(SPECS.map(s => `${s.script.split('/')[1]}:${s.script.split('/').pop()}`));
  // A SPEC that no longer matches a real registration is stale or renamed.
  for (const entry of covered) {
    expect(registered.has(entry)).toBe(true);
  }
  // A registered PreToolUse gate missing from SPECS would silently skip the
  // corpus. Other hook types aren't required here.
  for (const entry of registeredPreToolUse) {
    expect(covered.has(entry)).toBe(true);
  }
});
