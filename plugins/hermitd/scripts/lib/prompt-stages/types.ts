// The contract every UserPromptSubmit stage implements.
//
// Stages are plain functions, not scripts: they never read stdin, never write
// stdout, and never call process.exit. They return what they want emitted and
// let user-prompt-pipeline.ts decide — which is what makes the "a block emits
// JSON alone" rule enforceable in one place instead of seven.

// Re-exported, never redeclared: parseChannelEnvelope is the only producer, and
// a structurally-compatible copy here silently drifts from it (a field added to
// the parser stayed invisible to every stage until a typecheck caught it).
import type { ChannelEnvelope } from '../channel-envelope';
export type { ChannelEnvelope };

export interface StageContext {
  harnessMode?: boolean;
  skipHarnessCommand?: boolean;
  suppressResponderInvoke?: boolean;
  sessionId?: string | null;
  closedThread?: boolean;
  conversation?: { key: string; task_id: string; owner: string };
  /** Resolved hermit state dir — computed once for the whole pipeline. */
  dir: string;
  /** The submitted prompt text. */
  prompt: string;
  /** Parsed channel envelope, or null for operator/internal input. */
  envelope: ChannelEnvelope | null;
  /**
   * The hook payload's `transcript_path`, or null when absent (CC documents it as
   * present on most, not all, events). Stages treat null as "can't tell" and fail closed.
   */
  transcriptPath: string | null;
  /** config.json, read at most once per prompt regardless of how many stages ask. */
  config(): any;
  /** state/runtime.json, read at most once per prompt. */
  runtime(): any;
}

export interface StageResult {
  harness?: import('../harness-mod').HarnessDecision;
  /** additionalContext to inject. Concatenated with other stages', in stage order. */
  context?: string;
  /**
   * Reason for a `{"decision":"block"}`. Set only after the stage has confirmed
   * the operator was told out-of-band (a successful channel send) — blocking
   * without that would swallow the message into silence. Passive-chat capture is
   * the exception: unaddressed or non-allowed chatter is intentionally silent.
   */
  block?: string;
}

export type Stage = (ctx: StageContext) => StageResult | void | Promise<StageResult | void>;
