// cc-compat.js — Centralized accessors for Claude Code-owned formats.
//
// Contract: this module wraps surfaces that Anthropic owns and can change
// without notice. Every parse of a CC-owned format should go through here so
// a CC release breaks THIS FILE loudly, not five others quietly.
//
// In-scope surfaces:
//   - Hook-payload field names (session_id, transcript_path, session_crons,
//     background_tasks)
//   - Transcript JSONL entry shape (message.usage, cache field names,
//     assistant/user/tool_result type discrimination)
//   - Cost-log path resolution (record shape is hermit-owned — see costLogPath)
//   - Best-effort CC version string (diagnostic only — never branch on it;
//     the install-gate is min_claude_code_version in hermit-meta.json)
//
// Out-of-scope (NOT in this module):
//   - pricing.js: Anthropic published pricing — a hermit-owned data table
//   - Cron grammar (5-field POSIX, stable; CronCreate semantics are doc)
//   - Monitor sentinel constants (HEARTBEAT_EVALUATE is hermit's own protocol)

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultConfigDir } from './setup-token';
import { exitError } from './cli';

type Json = any;
type TriState = { state: string; count: number; entries: Json[] };

// ---------------------------------------------------------------------------
// Project-root resolution (robust to drifted hook cwd — fix for #384)
// ---------------------------------------------------------------------------

/**
 * Fleet resolver — one of three; same walk-up logic, different return and fallback:
 *   core hermitDir    (scripts/lib/cc-compat.ts)                    → the .cch dir (this file)
 *   HA   projectRoot  (homeassistant-hermit/src/config.ts)          → the project root (parent)
 *   dev  findHermitDir(dev-hermit/scripts/lib/find-hermit-dir.ts)   → the .cch dir or null
 * INVARIANT: hermitDir() === path.join(projectRoot(), '.hermit').
 * Fix one (env-var precedence, iteration cap, worktree-projection skip) → check
 * the other two.
 *
 * Robust to a drifted hook cwd (#384). A *relative* AGENT_DIR (the legacy
 * drift-prone default, e.g. `AGENT_DIR=".hermit"`) is intentionally
 * NOT honored — it falls through to CLAUDE_PROJECT_DIR, then walk-up, then fail-open.
 */
function hermitDir(): string {
  const agent = process.env.AGENT_DIR;
  if (agent && path.isAbsolute(agent)) return path.resolve(agent);
  const proj = process.env.CLAUDE_PROJECT_DIR;
  if (proj) { const d = path.join(proj, '.hermit'); if (fs.existsSync(d) && !isWorktreeProjection(d)) return d; }
  return findHermitDir(process.cwd())
    ?? path.resolve('.hermit'); // fail-open: preserves today's behavior
}

/**
 * A worktree's *projected* `.hermit/` — never a resolution target.
 *
 * `.worktreeinclude`'s managed block copies OPERATOR.md, config.json,
 * bin/hermitd-run and compiled/ into a `claude --worktree` worktree so skills can
 * Read (and run) them at the relative path they expect, but never `state/` —
 * hermit state is deliberately main-rooted and shared across worktrees. So a dir
 * carrying the config.json sentinel with no `state/` is a projection of a real
 * root further up, and the resolvers walk past it to that root.
 *
 * The `state/` test stays true only because no resolver returns a projection,
 * so nothing ever creates `state/` inside one. A writer that mkdir's its own
 * state dir must resolve through a resolver, never off cwd. Out-of-tree
 * worktrees (`git worktree add ../wt`) are the one gap: the walk can't reach
 * main, so hermitDir() fails open to the cwd-relative path — the projection —
 * exactly as it did before this guard existed.
 *
 * Mirrored by the sibling fleet resolvers named above — fix one, fix all.
 */
function isWorktreeProjection(cchDir: string): boolean {
  return fs.existsSync(path.join(cchDir, 'config.json')) && !fs.existsSync(path.join(cchDir, 'state'));
}

/**
 * The bounded walk behind hermitDir(), for callers that start somewhere other than
 * cwd and need to know when nothing was found: same 8-level cap and config.json
 * sentinel, null instead of the fail-open default. Worktree projections are
 * walked past, not returned — see isWorktreeProjection().
 *
 * Deliberately env-free. Callers like routines/event.ts pass a root their caller
 * already resolved; an ambient CLAUDE_PROJECT_DIR must not override an explicit
 * argument. Env precedence belongs in hermitDir(), which owns the cwd default.
 */
function findHermitDir(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const cch = path.join(dir, '.hermit');
    if (fs.existsSync(path.join(cch, 'config.json')) && !isWorktreeProjection(cch)) return cch;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// The main checkout's state dir, or null when we are not in a LINKED worktree
// (or git can't answer). In a worktree `--git-common-dir` still points at the
// main `.git`, so this identifies the one shared, intentionally main-rooted
// `.hermit/`. It cannot name a foreign project: git resolves it
// from our own cwd, never from argv.
//
// Gated on `--git-dir !== --git-common-dir` — true only in a linked worktree.
// Without that gate the main checkout also gets a second accepted root, so a
// hermit living in a SUBDIRECTORY of a repo would accept the repo root's
// `.hermit/` — a sibling hermit's state, i.e. exactly the
// cross-project write this pin exists to block. In the main checkout
// hermitDir()'s walk-up already resolves correctly, so gating loses nothing.
// Both values are path.resolve()d before comparing: from a subdirectory of the
// main checkout git answers with an absolute `--git-dir` but a relative
// `--git-common-dir` (`/repo/.git` and `../.git`), which a raw string compare
// would misread as a worktree.
function mainCheckoutStateDir(): string | null {
  try {
    const r = spawnSync('git', ['rev-parse', '--git-dir', '--git-common-dir'], { timeout: 5000, encoding: 'utf8' });
    const [gitDir, common] = (r.stdout ?? '').trim().split('\n').map(l => l.trim());
    if (!gitDir || !common) return null;
    const abs = path.resolve(common);
    if (path.resolve(gitDir) === abs) return null; // main checkout, not a worktree
    if (path.basename(abs) !== '.git') return null;
    return path.join(path.dirname(abs), '.hermit');
  } catch {
    return null;
  }
}

// The state dir is not caller-chosen. Scripts reached through a wildcarded
// `Bash(bun */scripts/*.ts*)` grant have every argument pre-approved, so an
// argv-supplied root let one pre-approved call mutate another project's hermit
// state. Callers pass their argv value here and refuse on null.
//
// Returns the pinned dir when argv agrees with hermitDir(), else null. Because
// hermitDir() resolves an absolute AGENT_DIR first, that env var stays the one
// redirect a caller can use — and it has to be written as an env prefix, which
// is what makes it a boundary rather than a bypass. Probed live on CC 2.1.220:
// with `Bash(bun */scripts/wildcard.ts*)` allowed, `bun <dir>/scripts/
// wildcard.ts go` runs unprompted (mid-string wildcards do match), but
// `AGENT_DIR=/tmp/x bun <dir>/scripts/literal.ts go` prompts for approval even
// though the same command without the prefix is covered by a literal rule.
//
// Two accepted roots — hermitDir() and, on a mismatch only, the main
// checkout's state dir — apply to both the exact-match and the containment
// form below, so the walk lives once here and each caller just supplies its
// own comparison.
function pinnedRoot(resolved: string, matches: (root: string) => boolean): string | null {
  if (matches(hermitDir())) return resolved;
  // Worktree case. Hermit state is deliberately main-rooted and shared across
  // worktrees, so a worktree session legitimately passes the main checkout's
  // absolute path. For a worktree under the repo the two now agree — the walk-up
  // skips the projection and lands on main — so this is the out-of-tree fallback
  // (`git worktree add ../wt`), where the walk can't reach main and hermitDir()
  // fails open to the projection. Consulted only after a mismatch, so the common
  // path never spawns git.
  const main = mainCheckoutStateDir();
  return main !== null && matches(main) ? resolved : null;
}

// A worktree projection named as the state dir means the caller's own root, one
// level up. The commands the resident prompt documents pass the relative
// `.hermit`, which from a `claude --worktree` session resolves to the
// projection while every accepted root is main's — so without this the pin
// refuses the very spelling the hermit ships. Not a widening: a projection can
// only normalize to the root its own walk-up finds, and that root still has to
// equal hermitDir() or the main checkout below. A foreign projection normalizes
// to its own foreign root and is refused exactly as before.
function resolveProjection(resolved: string): string {
  if (!isWorktreeProjection(resolved)) return resolved;
  return findHermitDir(path.dirname(resolved)) ?? resolved;
}

// Line comments, not a block comment: the grant strings above contain `*` and
// `/` sequences that would close a block comment early.
function assertStateDir(argvValue: string): string | null {
  const resolved = resolveProjection(path.resolve(argvValue));
  return pinnedRoot(resolved, root => resolved === root);
}

// Sibling of assertStateDir() for callers whose argv is a FILE or subdirectory
// under the state dir, not the state dir itself (e.g. update-reflection-state.ts's
// state-file argument, generate-summary.ts's <hermit>/state argument). A caller
// whose argv already equals a root also passes here, since containment includes
// equality — a script that only ever receives the root itself should still use
// the plain assertStateDir() so its error message names the expectation exactly.
//
// `subdir` narrows the bound from the whole hermit dir to one branch of it, and
// is REQUIRED rather than optional on purpose. Containment against the hermit
// root alone still admits every operator-owned file beside `state/` —
// OPERATOR.md, sessions/task records, bin/ — and a caller that
// JSON.parse-with-fallback-then-rewrites (update-reflection-state.ts does
// exactly that) would overwrite any of them wholesale. An optional parameter on
// a security-narrowing helper is a footgun: a future caller that omits it
// silently gets the wide bound this check exists to close. Make each caller
// state the narrowest branch its argument can name.
function assertUnderStateDir(argvValue: string, subdir: string): string | null {
  const resolved = path.resolve(argvValue);
  const isUnder = (root: string) => {
    const base = subdir ? path.join(root, subdir) : root;
    return resolved === base || resolved.startsWith(base + path.sep);
  };
  return pinnedRoot(resolved, isUnder);
}

// assertStateDir(), or exit 1 with `{"error":"foreign_state_dir:<expected dir>"}`
// naming the dir to rerun with.
function pinStateDirOrExit(argvValue: string): string {
  return assertStateDir(argvValue) ?? exitError(`foreign_state_dir:${hermitDir()}`);
}

// assertUnderStateDir(), or exit 1 with the same `foreign_state_dir:<expected dir>` error.
function pinUnderStateDirOrExit(argvValue: string, subdir: string): string {
  return assertUnderStateDir(argvValue, subdir) ?? exitError(`foreign_state_dir:${hermitDir()}`);
}

// ---------------------------------------------------------------------------
// Hook-payload accessors (pure, null-safe)
// ---------------------------------------------------------------------------

/**
 * Extract session_id from a Stop (or any) hook payload.
 * CC has used both `session_id` and `sessionId` across versions.
 * @param {object} payload
 * @returns {string|null}
 */
function sessionId(payload: Json): string | null {
  if (!payload || typeof payload !== 'object') return null;
  return payload.session_id != null ? payload.session_id
    : payload.sessionId != null ? payload.sessionId
    : null;
}

/**
 * Extract transcript_path from a hook payload. A common field rather than a
 * Stop-only one — Stop (cost-tracker) and PostToolUse (channel-hook's
 * turn-boundary lookup) both read it; PostToolUse carrying it was confirmed
 * live (tmux probe, CC v2.1.232). CC still documents it as present on most,
 * not all, events, so callers treat null as "can't tell" and fail closed.
 * @param {object} payload
 * @returns {string|null}
 */
function transcriptPath(payload: Json): string | null {
  if (!payload || typeof payload !== 'object') return null;
  return payload.transcript_path != null ? payload.transcript_path : null;
}

/**
 * Extract the SUBAGENT transcript path from a SubagentStop hook payload.
 * Distinct from transcript_path, which on SubagentStop is the PARENT transcript.
 * @param {object} payload
 * @returns {string|null}
 */
function agentTranscriptPath(payload: Json): string | null {
  if (!payload || typeof payload !== 'object') return null;
  return payload.agent_transcript_path != null ? payload.agent_transcript_path : null;
}

/**
 * Extract the subagent id from a SubagentStop hook payload.
 * Matches toolUseResult.agentId in the parent transcript and the
 * subagents/agent-<id>.jsonl filename.
 * @param {object} payload
 * @returns {string|null}
 */
function agentId(payload: Json): string | null {
  if (!payload || typeof payload !== 'object') return null;
  return payload.agent_id != null ? payload.agent_id
    : payload.agentId != null ? payload.agentId
    : null;
}

/**
 * Extract session_crons with tri-state presence semantics.
 *
 * The tri-state is critical:
 *   - 'unsupported_or_unreachable': field absent — old CC or task registry
 *     unreachable. NEVER render this as "0 crons" — that's the silent-wrong
 *     this module exists to prevent.
 *   - 'empty': field present and array is empty — CC supports it, nothing scheduled.
 *   - 'populated': field present and non-empty.
 *
 * @param {object} payload
 * @returns {{ state: string, count: number, entries: Array }}
 */
function triStateField(payload: Json, field: string): TriState {
  if (!payload || typeof payload !== 'object' || !(field in payload)) {
    return { state: 'unsupported_or_unreachable', count: 0, entries: [] };
  }
  const raw = payload[field];
  const entries = Array.isArray(raw) ? raw : [];
  if (entries.length === 0) {
    return { state: 'empty', count: 0, entries: [] };
  }
  return { state: 'populated', count: entries.length, entries };
}

function sessionCrons(payload: Json): TriState {
  return triStateField(payload, 'session_crons');
}

/**
 * Extract background_tasks with tri-state presence semantics.
 * Same rules as sessionCrons — see above.
 * @param {object} payload
 * @returns {{ state: string, count: number, entries: Array }}
 */
function backgroundTasks(payload: Json): TriState {
  return triStateField(payload, 'background_tasks');
}

// ---------------------------------------------------------------------------
// Transcript parsing (CC-owned JSONL shape)
// ---------------------------------------------------------------------------

/**
 * Trailing `tailBytes` of a JSONL file as whole lines, dropping the partial leading
 * line when the read started mid-file. The one copy every tail-window reader uses
 * (cost-tracker's usage scan, channel-hook's turn-boundary lookup) so the
 * partial-line and short-read handling can't drift between them.
 *
 * Throws on any fs error — callers already run inside a try/catch that turns that
 * into "no usable data".
 * @param {string} filePath
 * @param {number} tailBytes
 * @returns {{ lines: string[], readFrom: number }}
 */
function readTailLines(filePath: string, tailBytes: number): { lines: string[]; readFrom: number } {
  const stat = fs.statSync(filePath);
  const readFrom = Math.max(0, stat.size - tailBytes);
  const fd = fs.openSync(filePath, 'r');
  const buf = Buffer.alloc(Math.min(tailBytes, stat.size));
  let bytesRead = 0;
  try {
    bytesRead = fs.readSync(fd, buf, 0, buf.length, readFrom);
  } finally {
    fs.closeSync(fd);
  }
  // A short read must not leave the zero-fill tail in the string — those NUL bytes
  // would corrupt the last line instead of simply truncating the window.
  const lines = buf.subarray(0, bytesRead).toString('utf-8').split('\n');
  if (readFrom > 0) lines.shift();
  return { lines, readFrom };
}

/**
 * Drop sidechain (subagent-owned) lines before a turn-boundary walk. A
 * subagent's opening prompt is a plain `type:'user'` entry written into the
 * same transcript, so a walk that keeps them resolves to the subagent's prompt
 * rather than the turn's. A line that fails to parse is kept — the caller's own
 * parse stays the authority on malformed lines.
 * @param {string[]} lines
 * @returns {string[]}
 */
function dropSidechainLines(lines: string[]): string[] {
  return lines.filter(l => {
    try { return JSON.parse(l).isSidechain !== true; } catch { return true; }
  });
}

/**
 * Stringify an entry's message.content regardless of whether it is a string
 * or a content-block array. Real CC transcripts use both shapes.
 * @param {object} entry
 * @returns {string}
 */
function entryText(entry: Json): string {
  const c = entry.message?.content;
  if (!c) return '';
  return typeof c === 'string' ? c : JSON.stringify(c);
}

/**
 * The model that most recently served this session, per the transcript.
 *
 * Ground truth for "what am I running": the serving model is stamped on every
 * assistant entry, whereas the model's own sense of it is fixed at session start
 * and does not follow a mid-session /model switch (live-verified — an Opus-served
 * turn reported itself as Sonnet).
 *
 * Sidechains are excluded: a subagent dispatched with its own model would
 * otherwise answer for the main session. Reads a bounded tail only — 64KB is far
 * more than the handful of entries needed and keeps this cheap on every prompt.
 *
 * @param {string} filePath
 * @returns {{ model: string, timestamp: string } | null} null when unreadable or
 *   when the window holds no qualifying entry.
 */
function lastAssistantModel(filePath: string): { model: string; timestamp: string } | null {
  const TAIL_BYTES = 65536;
  try {
    const { lines } = readTailLines(filePath, TAIL_BYTES);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry: Json;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || entry.type !== 'assistant' || entry.isSidechain === true) continue;
      const model = entry.message?.model;
      if (typeof model !== 'string' || !model) continue;
      // Parseable, not just present: the harness-verify gate compares this with
      // Date.parse, and NaN fails every comparison — which would take the
      // fail-OPEN branch there. Skip the entry instead.
      if (typeof entry.timestamp !== 'string' || Number.isNaN(Date.parse(entry.timestamp))) continue;
      return { model, timestamp: entry.timestamp };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * A user entry is a tool_result carrier (not a turn boundary) when its content
 * is an array containing any tool_result block. The triggering prompt that
 * opens a turn is a "real" user entry: string content, or an array with no
 * tool_result.
 * @param {object} entry
 * @returns {boolean}
 */
function isToolResult(entry: Json): boolean {
  if (entry.type !== 'user') return false;
  const c = entry.message?.content;
  return Array.isArray(c) && c.some((b: Json) => b && b.type === 'tool_result');
}

type ExtractedUsage = {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  model: string;
  requestId: string;
  fast: boolean;
};

/**
 * Extract token usage from a transcript entry.
 * Returns an object if the entry is an assistant entry with usage, else null.
 * This centralizes the CC-owned field names: input_tokens, output_tokens,
 * cache_creation_input_tokens, cache_read_input_tokens, requestId, cache TTL
 * split, and speed.
 *
 * @param {object} entry
 * @returns {ExtractedUsage | null}
 */
function extractUsage(entry: Json): ExtractedUsage | null {
  if (entry.type !== 'assistant' || !entry.message?.usage) return null;
  const u = entry.message.usage;
  return {
    inputTokens:         u.input_tokens || 0,
    cacheWriteTokens:    u.cache_creation_input_tokens || 0,
    cacheWrite1hTokens:  u.cache_creation?.ephemeral_1h_input_tokens || 0,
    cacheReadTokens:     u.cache_read_input_tokens || 0,
    outputTokens:        u.output_tokens || 0,
    model:               entry.message.model || '',
    requestId:           entry.requestId || entry.message?.id || '',
    fast:                u.speed === 'fast',
  };
}

/**
 * Group extracted usages by requestId, keeping the max of each token field
 * per key. Entries with an empty key pass through unfolded. Order of first
 * appearance is preserved.
 */
function foldUsageByRequest(usages: ExtractedUsage[]): ExtractedUsage[] {
  const out: ExtractedUsage[] = [];
  const byId = new Map<string, ExtractedUsage>();
  for (const u of usages) {
    if (!u.requestId) {
      out.push(u);
      continue;
    }
    const prev = byId.get(u.requestId);
    if (!prev) {
      const copy = { ...u };
      byId.set(u.requestId, copy);
      out.push(copy);
      continue;
    }
    prev.inputTokens = Math.max(prev.inputTokens, u.inputTokens);
    prev.cacheWriteTokens = Math.max(prev.cacheWriteTokens, u.cacheWriteTokens);
    prev.cacheWrite1hTokens = Math.max(prev.cacheWrite1hTokens, u.cacheWrite1hTokens);
    prev.cacheReadTokens = Math.max(prev.cacheReadTokens, u.cacheReadTokens);
    prev.outputTokens = Math.max(prev.outputTokens, u.outputTokens);
    if (u.fast) prev.fast = true;
    if (!prev.model && u.model) prev.model = u.model;
  }
  return out;
}

/**
 * A structured mid-turn injection — CC writes skill bodies and similar scaffolding
 * as `isMeta:true` user entries. `isMeta` alone cannot discriminate these from real
 * prompts: routine wakes (`[hermit-routine:<id>] …`) and inbound channel envelopes
 * (`<channel source="…">`) are ALSO `isMeta:true`. That is why a bare `isMeta !== true`
 * guard must not be used to find the prompt that opens a turn — it would skip the
 * marker-bearing entries themselves. Measured on live hermit transcripts: skipping the
 * injections recovers 77 real routine/channel prompts that they would otherwise shadow.
 *
 * TWO shapes, both scaffolding:
 *   - ARRAY content — the skill body itself, written on first invocation.
 *   - `turnCompanion:true` — what CC writes instead when the model re-invokes a skill
 *     already in context ("(Re-invocation of /<skill> …)", "Skill /<skill> is already
 *     loaded above…"), since 2.1.202 stopped appending a duplicate body. It carries
 *     STRING content, so the content shape alone missed it and the walk stopped here
 *     instead of on the wake behind it — measured live, a weekly-review fire and a
 *     pipeline-digest co-fire both billed to 'other'.
 * No real prompt carries `turnCompanion` (surveyed across a week of live transcripts),
 * so it is safe as the second discriminator where content shape is not.
 * @param {object} entry
 * @returns {boolean}
 */
function isSkillInjection(entry: Json): boolean {
  if (entry.isMeta !== true) return false;
  return Array.isArray(entry.message?.content) || entry.turnCompanion === true;
}

/**
 * A turn-opening user entry: the delivered prompt itself, not a tool_result carrier
 * and not a structured mid-turn injection. This is the boundary both consumers of
 * turn segmentation share — `turnPromptText` (which prompt classifies the turn) and
 * transcript-digest's turn counter — so they cannot drift apart on what a turn is.
 *
 * NOTE for cost-tracker: its usage walks (`sumTurnUsage`, the agent-usage scan) use a
 * deliberately looser boundary (`user && !isToolResult`). Tightening those would move
 * billed amounts, not just labels — don't "align" them without re-measuring totals.
 * @param {object} entry
 * @returns {boolean}
 */
function isTurnBoundary(entry: Json): boolean {
  return entry.type === 'user' && !isToolResult(entry) && !isSkillInjection(entry);
}

/**
 * The delivered prompt that opened this turn: walk back from `billedIndex` to the
 * first user entry that is neither a tool_result carrier nor a structured injection,
 * and return THAT entry's text alone.
 *
 * Returning only the boundary entry — never the intervening tool_results — is the
 * point: `classifySource` anchors on the sentinel line the boundary entry delivered, so
 * concatenating the walked entries would put a tool_result's own text where that line
 * belongs and let any output that merely *mentions* a routine id capture the turn's cost.
 *
 * `boundaryFound` is false when the walk ran off the start of `lines` without
 * finding a prompt — the caller uses that to detect a truncated tail window that
 * doesn't cover the real turn start. `index` is the boundary entry's position, so a
 * caller can resume the walk from an earlier turn (see cost-tracker's dispatch hop).
 * @param {string[]} lines
 * @param {number} billedIndex
 * @returns {{ text: string, boundaryFound: boolean, index: number }}
 */
function turnPromptText(lines: string[], billedIndex: number): { text: string; boundaryFound: boolean; index: number } {
  for (let j = billedIndex - 1; j >= 0; j--) {
    try {
      const prev = JSON.parse(lines[j]);
      if (isTurnBoundary(prev)) {
        return { text: entryText(prev), boundaryFound: true, index: j };
      }
    } catch {}
  }
  return { text: '', boundaryFound: false, index: -1 };
}

/**
 * A compact_boundary marker — CC writes one `type:'system'` entry per context
 * compaction (auto or manual). `compactMetadata.trigger` distinguishes them but
 * callers that only count compactions need the type/subtype discriminator.
 * @param {object} entry
 * @returns {boolean}
 */
function isCompactBoundary(entry: Json): boolean {
  return entry.type === 'system' && entry.subtype === 'compact_boundary';
}

/**
 * The {id, name} of every tool_use block in an assistant entry. One assistant
 * API response may split across multiple JSONL entries sharing message.id, but
 * a given tool_use id never appears twice — callers building an id→name map
 * should first-write-wins on id to make re-emission harmless.
 * @param {object} entry
 * @returns {Array<{ id: string, name: string }>}
 */
function toolUseNames(entry: Json): Array<{ id: string; name: string }> {
  if (entry.type !== 'assistant') return [];
  const c = entry.message?.content;
  if (!Array.isArray(c)) return [];
  const out: Array<{ id: string; name: string }> = [];
  for (const b of c) {
    if (b && b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
      out.push({ id: b.id, name: b.name });
    }
  }
  return out;
}

/**
 * Classify the tool_result blocks of a carrier user entry into denials (with
 * kind) and genuine-failure tool_use_ids, per block. Both denials and failures
 * carry `is_error:true`, so we walk each is_error block and separate them:
 *
 *   - Current CC stamps a top-level `toolDenialKind` field
 *     (`user-rejected` | `automode-blocked` | `permission-rule`); when present
 *     it is authoritative and entry-scoped — CC writes one denial per carrier,
 *     so every is_error block in that entry is attributed to it.
 *   - Older CC lacked the field, so fall back to sniffing each block's text
 *     (CC-authored, drift-prone phrases, hence they live here in cc-compat).
 *     Only `is_error` blocks are sniffed, so benign output that merely quotes a
 *     denial phrase is never mistaken for a rejection.
 *
 * Any is_error block that is neither field- nor phrase-flagged is a real
 * failure. Returning per block (not one verdict per entry) means a parallel
 * batch that mixes a rejection with a genuine error counts both, and N denials
 * count as N.
 * @param {object} entry
 * @returns {{ rejections: string[]; failureIds: string[] }}
 */
function classifyToolResults(entry: Json): { rejections: string[]; failureIds: string[] } {
  const rejections: string[] = [];
  const failureIds: string[] = [];
  if (entry.type !== 'user') return { rejections, failureIds };
  const c = entry.message?.content;
  if (!Array.isArray(c)) return { rejections, failureIds };
  const fieldKind = (typeof entry.toolDenialKind === 'string' && entry.toolDenialKind) ? entry.toolDenialKind : null;
  for (const b of c) {
    if (!b || b.type !== 'tool_result' || b.is_error !== true) continue;
    if (fieldKind) { rejections.push(fieldKind); continue; }
    const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
    if (t.includes("doesn't want to proceed with this tool use")) { rejections.push('user-rejected'); continue; }
    if (t.includes('Permission for this action was denied') || t.includes('Permission to use')) { rejections.push('automode-blocked'); continue; }
    if (typeof b.tool_use_id === 'string') failureIds.push(b.tool_use_id);
  }
  return { rejections, failureIds };
}

/**
 * CC's own path-key derivation: the absolute project root with every
 * non-alphanumeric character replaced by '-' (so `/home/u/.claude/x` →
 * `-home-u--claude-x`). CC replaces dots too — a `/`-only scheme silently
 * mis-keys any dotted path.
 * @param {string} projectRoot absolute project root
 * @returns {string} the path key naming this project's CC-owned directories
 */
function transcriptPathKey(projectRoot: string): string {
  return projectRoot.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * The transcript directory for a project root, under the config dir CC actually
 * resolved. Honors CLAUDE_CONFIG_DIR: a hermit pointed at a custom config dir
 * keeps its transcripts there, and a caller that hardcoded ~/.claude would read
 * a directory that does not exist. An out-of-session caller must adopt the
 * session's stamped `config_dir` onto its own env first — the watchdog does this
 * in adoptSessionConfigDir(), which also covers the children it spawns.
 * @param {string} projectRoot absolute project root
 * @param {string} [configDir] override for the config dir (tests); defaults to defaultConfigDir()
 * @returns {string} absolute path to <configDir>/projects/<key>
 */
function transcriptDirFor(projectRoot: string, configDir?: string): string {
  return path.join(configDir ?? defaultConfigDir(), 'projects', transcriptPathKey(projectRoot));
}

/**
 * The auto-memory directory for a project root: `memory/` inside the project's
 * transcript directory. One derivation, so callers never re-key the path by hand.
 * @param {string} projectRoot absolute project root
 * @param {string} [configDir] override for the config dir (tests); defaults to defaultConfigDir()
 * @returns {string} absolute path to <configDir>/projects/<key>/memory
 */
function memoryDirFor(projectRoot: string, configDir?: string): string {
  return path.join(transcriptDirFor(projectRoot, configDir), 'memory');
}

// ---------------------------------------------------------------------------
// Cost-log path and record shape
// ---------------------------------------------------------------------------

/**
 * Canonical cost-log path resolution.
 * Replaces the 5 divergent path.resolve strategies scattered across scripts.
 * The cost-log is always at .claude/cost-log.jsonl relative to the project
 * root; stateDir is .hermit/state/ or the hermit root.
 *
 * Accepts either the hermit root (e.g. '.hermit') or a deeper
 * path under it. Walks up until .hermit is found, then resolves
 * sibling .claude/ from its parent.
 *
 * @param {string} [hermitRootOrState] path to hermit root or state subdir;
 *   defaults to '.hermit' relative to cwd.
 * @returns {string} absolute path to .claude/cost-log.jsonl
 */
function costLogPath(hermitRootOrState?: string): string {
  if (!hermitRootOrState) {
    return path.resolve('.claude', 'cost-log.jsonl');
  }
  const abs = path.resolve(hermitRootOrState);
  // Walk up to find the directory named .hermit
  let dir = abs;
  for (let i = 0; i < 5; i++) {
    if (path.basename(dir) === '.hermit') {
      return path.join(path.dirname(dir), '.claude', 'cost-log.jsonl');
    }
    dir = path.dirname(dir);
  }
  // Fallback: treat hermitRootOrState as the hermit root itself
  return path.join(path.dirname(abs), '.claude', 'cost-log.jsonl');
}

// ---------------------------------------------------------------------------
// Capability / version sniff (diagnostic only — never branch on it)
// ---------------------------------------------------------------------------

/**
 * Best-effort CC version string.
 * Reads from payload if CC ever ships it there, else checks env.
 * Returns null rather than spawning `claude --version` on the hot path.
 * Use this for diagnostic labeling only; runtime behavior should key on
 * field presence, never on this string.
 *
 * @param {object} [payload]
 * @returns {string|null}
 */
function ccVersion(payload?: Json): string | null {
  if (payload && typeof payload === 'object') {
    const v = payload.claude_code_version || payload.cc_version;
    if (v && typeof v === 'string') return v;
  }
  return process.env.CLAUDE_CODE_VERSION || null;
}

// ---------------------------------------------------------------------------

export {
  // Project-root resolution
  hermitDir,
  findHermitDir,
  assertStateDir,
  assertUnderStateDir,
  pinStateDirOrExit,
  pinUnderStateDirOrExit,
  // Hook-payload accessors
  sessionId,
  transcriptPath,
  agentTranscriptPath,
  agentId,
  sessionCrons,
  backgroundTasks,
  // Transcript parsing
  readTailLines,
  dropSidechainLines,
  lastAssistantModel,
  entryText,
  isToolResult,
  extractUsage,
  foldUsageByRequest,
  isTurnBoundary,
  isSkillInjection,
  turnPromptText,
  isCompactBoundary,
  toolUseNames,
  classifyToolResults,
  transcriptPathKey,
  transcriptDirFor,
  memoryDirFor,
  // Cost-log
  costLogPath,
  // Capability sniff
  ccVersion,
};
