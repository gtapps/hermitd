// Shared sanitizer for the operator's configured `config.language` value.
//
// Extracted from startup-context.ts so every surface that echoes the raw
// language string into context — the SessionStart injection and the
// resolve-outbound-channel CLI (which hands it to the model's channel-send
// path) — applies the identical gate. The structural whitelist rejects anything
// tag-, newline-, or control-byte-shaped and accepts locale codes (`pt`,
// `pt-BR`, `pt_BR`) plus human language names; because `hermit-settings
// language` can be driven from a channel-tagged turn, the value is
// remote-influenceable and also goes through the same injection scan every
// other injected surface gets.
//
// Catalog *selection* (whether state/messages.json applies) is a separate,
// always-safe concern handled by loadMessages() in ./messages — that only
// compares the value with the file's own `language`, so it needs no sanitization.

import { scanInjected } from './sanitize';
import { readSettledConfig } from './config-read';

type Json = any;

const LANGUAGE_RE = /^[\p{L}\p{M}][\p{L}\p{M}\p{N} '._()-]*$/u;

/**
 * Validate and return a language string, or null if it fails the structural
 * whitelist, exceeds the length cap, or trips the injection scan. `onThreat` is
 * invoked with the scan reason when the injection scan fires (startup-context
 * uses it to record a context-scan hit for the doctor check); other callers
 * omit it.
 */
export function sanitizeLanguage(value: unknown, onThreat?: (reason: string) => void): string | null {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v || v.length > 40 || !LANGUAGE_RE.test(v)) return null;
  const reason = scanInjected(v);
  if (reason) {
    onThreat?.(reason);
    return null;
  }
  return v;
}

/** Read and sanitize `config.language` for the hermit at `agentDir`. */
export function operatorLanguage(agentDir: string, onThreat?: (reason: string) => void): string | null {
  const config: Json = readSettledConfig(agentDir);
  return sanitizeLanguage(config.language, onThreat);
}
