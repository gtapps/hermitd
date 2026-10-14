// WP7 tier 3 port of src/ha_agent_lab/boot.py — boot status/store: language
// persistence in OPERATOR.md, setup checklist/hints, endpoint probing.
//
// BootStatus keeps its snake_case keys (CLI output contract — `boot status`
// prints it as JSON, same as policy.ts checkEntity).
//
// Async note: bootStatus is async because probe=true runs live URL selection
// (selectHomeAssistantUrl) through fetch.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  AppConfig,
  HERMIT_OPERATOR_MD,
  normalizedContextPath,
  saveEnvFile,
  saveOperatorContext,
} from './config';
import { probeHomeAssistantUrl, selectHomeAssistantUrl, type FetchLike } from './ha-api';

const LANGUAGE_PATTERN = /^- Language:\s*(.+?)\s*$/m;
const HA_SECTION_HEADING = '## HA hermit';
// src/boot.ts -> plugin root (Python: Path(__file__).resolve().parents[2]
// from src/ha_agent_lab/boot.py).
const PLUGIN_ROOT = resolve(import.meta.dir, '..');

export interface BootStatus {
  language: string | null;
  token_configured: boolean;
  url: string | null;
  local_url: string | null;
  remote_url: string | null;
  active_url: string | null;
  active_source: string | null;
  context_exists: boolean;
  context_age_hours: number | null;
  context_fresh: boolean;
  needs_language: boolean;
  needs_token: boolean;
  needs_endpoint: boolean;
  needs_context_refresh: boolean;
  can_refresh_context: boolean;
  command_prefix: string;
  setup_checklist: Array<Record<string, unknown>>;
  setup_hints: Array<Record<string, string>>;
}

export function operatorMdPath(root: string): string {
  return join(root, HERMIT_OPERATOR_MD);
}

function haSectionBody(text: string): string {
  const start = text.indexOf(HA_SECTION_HEADING);
  if (start === -1) return '';
  const after = start + HA_SECTION_HEADING.length;
  const nextSection = text.indexOf('\n## ', after);
  return nextSection !== -1 ? text.slice(after, nextSection) : text.slice(after);
}

export function readLanguage(root: string): string | null {
  const path = operatorMdPath(root);
  if (!existsSync(path)) return null;
  const match = LANGUAGE_PATTERN.exec(haSectionBody(readFileSync(path, 'utf8')));
  return match ? match[1]!.trim() : null;
}

export function writeLanguage(root: string, language: string): string {
  const path = operatorMdPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const line = `- Language: ${language}`;
  let text: string;
  if (existsSync(path)) {
    text = readFileSync(path, 'utf8');
    const sectionBody = haSectionBody(text);
    if (LANGUAGE_PATTERN.test(sectionBody)) {
      const newBody = sectionBody.replace(LANGUAGE_PATTERN, line); // count=1: non-global regex
      const sectionStart = text.indexOf(HA_SECTION_HEADING) + HA_SECTION_HEADING.length;
      text = text.slice(0, sectionStart) + newBody + text.slice(sectionStart + sectionBody.length);
    } else if (text.includes(HA_SECTION_HEADING)) {
      text = text.replace(HA_SECTION_HEADING, `${HA_SECTION_HEADING}\n\n${line}`);
    } else {
      const suffix = text.endsWith('\n') ? '\n' : '\n\n';
      text = `${text}${suffix}${HA_SECTION_HEADING}\n\n${line}\n`;
    }
  } else {
    text = `# Operator Context\n\n${HA_SECTION_HEADING}\n\n${line}\n`;
  }
  writeFileSync(path, text, 'utf8');
  return path;
}

export function commandPrefix(): string {
  const launcher = join(PLUGIN_ROOT, 'bin', 'ha-agent-lab');
  if (existsSync(launcher)) return launcher;
  return `bun ${join(PLUGIN_ROOT, 'src', 'cli.ts')}`;
}

export async function bootStatus(
  config: AppConfig,
  options: { probe?: boolean; stalenessHours?: number; fetchImpl?: FetchLike } = {},
): Promise<BootStatus> {
  const { probe = false, stalenessHours = 24, fetchImpl = globalThis.fetch } = options;
  const root = config.root;
  const language = readLanguage(root);
  const prefix = commandPrefix();
  const contextPath = normalizedContextPath(root);
  const contextExists = existsSync(contextPath);
  let contextAgeHours: number | null = null;
  let contextFresh = false;
  if (contextExists) {
    const seconds = Math.max(0, (Date.now() - statSync(contextPath).mtimeMs) / 1000);
    contextAgeHours = Math.round((seconds / 3600) * 100) / 100; // round(x, 2)
    contextFresh = seconds <= stalenessHours * 3600;
  }

  let activeUrl: string | null = null;
  let activeSource: string | null = null;
  if (probe && config.haToken) {
    [activeUrl, activeSource] = await selectHomeAssistantUrl(config, fetchImpl);
  } else if (config.haUrl) {
    [activeUrl, activeSource] = [config.haUrl, 'single'];
  } else if (config.haLocalUrl) {
    [activeUrl, activeSource] = [config.haLocalUrl, 'local'];
  } else if (config.haRemoteUrl) {
    [activeUrl, activeSource] = [config.haRemoteUrl, 'remote'];
  }

  return {
    language,
    token_configured: Boolean(config.haToken),
    url: config.haUrl,
    local_url: config.haLocalUrl,
    remote_url: config.haRemoteUrl,
    active_url: activeUrl,
    active_source: activeSource,
    context_exists: contextExists,
    context_age_hours: contextAgeHours,
    context_fresh: contextFresh,
    needs_language: language === null,
    needs_token: !config.haToken,
    needs_endpoint: !config.hasHaEndpoint,
    needs_context_refresh: !contextFresh,
    can_refresh_context: Boolean(config.haToken && config.hasHaEndpoint),
    command_prefix: prefix,
    setup_checklist: setupChecklist(config, language, contextExists, contextFresh, prefix),
    setup_hints: setupHints(config, language),
  };
}

export function saveBootPreferences(
  root: string,
  options: {
    language?: string | null;
    url?: string | null;
    localUrl?: string | null;
    remoteUrl?: string | null;
    token?: string | null;
  } = {},
): Record<string, string> {
  // Python `is not None` distinguishes "flag absent" from "empty value" —
  // null/undefined both mean absent here (argparse defaults to None).
  const { language = null, url = null, localUrl = null, remoteUrl = null, token = null } = options;
  const changes: Record<string, string> = {};
  if (language) {
    writeLanguage(root, language);
    changes.language = language;
  }
  const envUpdates: Record<string, string | null> = {};
  if (token !== null) {
    envUpdates.HOMEASSISTANT_TOKEN = token;
    changes.token = 'updated';
  }
  if (url !== null) {
    envUpdates.HOMEASSISTANT_URL = url;
    changes.url = url;
  }
  if (localUrl !== null) {
    envUpdates.HOMEASSISTANT_LOCAL_URL = localUrl;
    changes.local_url = localUrl;
  }
  if (remoteUrl !== null) {
    envUpdates.HOMEASSISTANT_REMOTE_URL = remoteUrl;
    changes.remote_url = remoteUrl;
  }
  if (Object.keys(envUpdates).length > 0) saveEnvFile(root, envUpdates);
  if (url !== null || localUrl !== null || remoteUrl !== null) {
    saveOperatorContext(root, { url, localUrl, remoteUrl });
  }
  return changes;
}

export type McpConfigResult =
  | { ok: true; server: 'homeassistant'; action: 'added' | 'replaced' | 'skipped' }
  | { ok: false; missing?: string[]; message?: string };

/** Write the `homeassistant` entry into the project `.mcp.json` from config, so
 *  hatch never has to hold the token. Adds a missing entry, replaces one still
 *  carrying `${...}` placeholders, and skips one that already has literal
 *  values. The result never carries the URL or token. */
export function writeMcpConfig(config: AppConfig): McpConfigResult {
  const missing = config.missingHaConfigurationFields();
  if (missing.length > 0) return { ok: false, missing };

  const mcpPath = join(config.root, '.mcp.json');
  let doc: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(mcpPath)) {
    try {
      doc = JSON.parse(readFileSync(mcpPath, 'utf8'));
    } catch {
      return { ok: false, message: '.mcp.json is not valid JSON; fix or remove it, then re-run.' };
    }
  }
  const servers = (doc.mcpServers ??= {});
  let action: 'added' | 'replaced';
  if (servers.homeassistant === undefined) action = 'added';
  else if (JSON.stringify(servers.homeassistant).includes('${')) action = 'replaced';
  else return { ok: true, server: 'homeassistant', action: 'skipped' };

  servers.homeassistant = {
    type: 'http',
    url: `${config.primaryUrl()!.replace(/\/+$/, '')}/api/mcp`,
    headers: { Authorization: `Bearer ${config.haToken}` },
  };
  writeFileSync(mcpPath, `${JSON.stringify(doc, null, 2)}\n`);
  return { ok: true, server: 'homeassistant', action };
}

export async function probeEndpoint(
  url: string | null,
  config: AppConfig,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<boolean> {
  if (!url || !config.haToken) return false;
  return probeHomeAssistantUrl(url, config.haToken, config.timeoutSeconds, fetchImpl);
}

function setupChecklist(
  config: AppConfig,
  language: string | null,
  contextExists: boolean,
  contextFresh: boolean,
  prefix: string,
): Array<Record<string, unknown>> {
  const endpointValue = config.primaryUrl();
  const contextStatus = contextFresh ? 'fresh' : contextExists ? 'stale' : 'missing';
  return [
    {
      field: 'Language',
      required: true,
      configured: language !== null,
      status: language !== null ? 'ok' : 'missing',
      location: '.hermit/OPERATOR.md',
      next_step: `${prefix} boot store --language <locale>`,
    },
    {
      field: 'Home Assistant endpoint',
      required: true,
      configured: config.hasHaEndpoint,
      status: config.hasHaEndpoint ? 'ok' : 'missing',
      location: '.env or .local/operator/context.md',
      current_value: endpointValue || '',
      next_step: `${prefix} boot store --url http://<home-assistant-ip>:8123`,
    },
    {
      field: 'HOMEASSISTANT_TOKEN',
      required: true,
      configured: Boolean(config.haToken),
      status: config.haToken ? 'ok' : 'missing',
      location: '.env',
      next_step: `${prefix} boot store --token <long-lived-access-token>`,
    },
    {
      field: 'Context snapshot',
      required: true,
      configured: contextExists,
      status: contextStatus,
      location: '.hermit/raw/snapshot-ha-normalized-latest.json',
      next_step: `${prefix} ha refresh-context`,
    },
    {
      field: 'HOMEASSISTANT_REMOTE_URL',
      required: false,
      configured: Boolean(config.haRemoteUrl),
      status: config.haRemoteUrl ? 'ok' : 'optional',
      location: '.env or .local/operator/context.md',
      next_step: `${prefix} boot store --local-url <local> --remote-url <remote>`,
    },
  ];
}

function setupHints(config: AppConfig, language: string | null): Array<Record<string, string>> {
  const hints: Array<Record<string, string>> = [];
  if (language === null) {
    hints.push({
      field: 'Language',
      how_to_get:
        'Choose the locale you want the agent to use for conversation plus aliases and descriptions, for example `en` or `pt-PT`.',
    });
  }
  if (!config.hasHaEndpoint) {
    hints.push({
      field: 'HOMEASSISTANT_URL',
      how_to_get:
        'The URL used to reach Home Assistant — local (`http://<ip>:8123`) or remote (Nabu Casa, reverse proxy). Set in `.env` as `HOMEASSISTANT_URL=...`.',
      source: 'https://developers.home-assistant.io/docs/api/rest',
    });
  }
  if (!config.haToken) {
    hints.push({
      field: 'HOMEASSISTANT_TOKEN',
      how_to_get:
        'In Home Assistant, open your user profile and create a Long-Lived Access Token from the profile page. Copy it once and store it in `.env`.',
      source: 'https://developers.home-assistant.io/docs/auth_api/',
    });
  }
  return hints;
}
