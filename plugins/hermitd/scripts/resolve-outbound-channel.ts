#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { emitJson, exitError } from './lib/cli';
import { sanitizeLanguage } from './lib/operator-language';

type Json = any;

// Unattended sends use only the pinned home.
function proactiveChatId(ch: Json): string {
  return ch?.default_chat_id;
}

// Primary-first, then config-order resolution shared by resolve() and
// resolveMaintainerTarget() — only the eligibility test and the target extractor
// differ between the two audiences. No hardcoded slug list: a freshly installed channel
// plugin becomes eligible the moment its config block lands in config.json.
function resolveTarget(
  channels: Json,
  isEligible: (ch: Json) => boolean,
  target: (ch: Json) => string,
): { id: string; chat_id: string } | null {
  channels = channels || {};
  const primary = typeof channels.primary === 'string' ? channels.primary : null;
  if (primary && isEligible(channels[primary])) {
    return { id: primary, chat_id: target(channels[primary]) };
  }
  for (const [id, ch] of Object.entries(channels) as [string, Json][]) {
    if (id === 'primary') continue;
    if (isEligible(ch)) {
      return { id, chat_id: target(ch) };
    }
  }
  return null;
}

function eligible(ch: Json): boolean {
  if (!ch || typeof ch !== 'object') return false;
  if (ch.enabled === false) return false;
  if (Array.isArray(ch.allowed_users) && ch.allowed_users.length === 0) return false;
  return !!proactiveChatId(ch);
}

function resolve(channels: Json): { id: string; chat_id: string } | null {
  return resolveTarget(channels, eligible, proactiveChatId);
}

// A channel block is maintainer-eligible when it's enabled and carries a
// non-empty maintainer_channel_id — the outbound-only second destination on the
// same platform/bot token, used for technical/ops/spend content that should not
// reach a non-technical client chat.
function maintainerEligible(ch: Json): boolean {
  if (!ch || typeof ch !== 'object') return false;
  if (ch.enabled === false) return false;
  return typeof ch.maintainer_channel_id === 'string' && ch.maintainer_channel_id.length > 0;
}

function resolveMaintainerTarget(channels: Json): { id: string; chat_id: string } | null {
  return resolveTarget(channels, maintainerEligible, (ch) => ch.maintainer_channel_id);
}

export { eligible, resolve, maintainerEligible, resolveMaintainerTarget, proactiveChatId };

if (import.meta.main) {
  const hermitDir = process.argv[2] || '.hermit';
  const configPath = path.join(hermitDir, 'config.json');

  let config: Json;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e: any) {
    exitError(`config_read_failed:${e.message}`);
  }

  const result = resolve(config.channels);
  if (result) {
    // Surface the operator's language so channel-composing skills (the model
    // path) reply in it. Additive + sanitized; omitted when null/invalid.
    const language = sanitizeLanguage(config.language);
    emitJson(language ? { ...result, language } : result);
  } else {
    emitJson({ status: 'none', reason: 'no_reachable_channel' });
  }
}
