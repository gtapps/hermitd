// WP7 tier 3 port of src/ha_agent_lab/cli.py — the argv-compatible CLI behind
// bin/ha-agent-lab. Stdout shapes and exit codes are a contract consumed by
// skills; JSON output replicates Python json.dumps byte-for-byte where
// feasible (indent=2, ensure_ascii escaping, compact separators with spaces).
//
// Parser: hand-rolled argparse equivalent. Error messages, usage strings and
// exit code 2 match CPython argparse for the observed paths (no args, unknown
// command/subcommand, missing positional/required sub, bad --reload choice,
// bad --window-days int, unrecognized arguments). Argparse's abbreviated
// `--flag` prefix matching is NOT replicated — flags must be spelled out.
//
// Dependency injection: main(argv, deps) accepts overrides for loadConfig,
// client construction and refreshContext — the TS equivalent of the pytest
// monkeypatching of cli.load_config / cli.HomeAssistantClient /
// cli.refresh_context.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { readConfig, removeConfig, validateAndApply } from './apply';
import {
  currentSessionId,
  slugify,
  standardMetadata,
  utcTimestamp,
  writeJsonArtifact,
  writeMarkdownArtifact,
} from './artifacts';
import { auditAutomations, auditScripts } from './audits';
import { automationDiff } from './automation-diff';
import { bootStatus, saveBootPreferences, writeMcpConfig } from './boot';
import { AppConfig, loadConfig, normalizedContextPath, projectRoot } from './config';
import { HomeAssistantClient, HomeAssistantError, haErrorToken } from './ha-api';
import { HomeAssistantWsClient } from './ha-ws';
import { fetchHistorySnapshot } from './history';
import { computeDegradedDomains, writeDegradedDomainsArtifact } from './integration-health';
import { checkEntity, gateServiceCall, gateStructuralMutation, normalizeEntityIndex } from './policy';
import type { MutationGate } from './policy';
import { evaluateYamlPolicy, simulateArtifact } from './simulate';
import { computeSilenceSummary } from './silence';
import { captureStates, restoreStates, DEFAULT_DOMAINS } from './snapshot-restore';
import { collectPendingUpdates, digestUpdates, listUpdates } from './update-check';
import {
  HELPER_TYPES,
  type WsCommandClient,
  type WsMutationResult,
  type WsReadResult,
  createArea,
  createBackup,
  createDashboard,
  createFloor,
  createHelper,
  createLabel,
  deleteArea,
  deleteDashboard,
  deleteFloor,
  deleteHelper,
  deleteLabel,
  disableConfigEntry,
  exposeEntity,
  getDashboard,
  getEnergyPrefs,
  importBlueprint,
  listAreas,
  listBackups,
  listBlueprints,
  listDashboards,
  listDevices,
  listEntities,
  listExposedEntities,
  listFloors,
  listHelpers,
  listLabels,
  listSystemLog,
  parseJsonObject,
  saveDashboard,
  setCoreConfig,
  setEnergyPrefs,
  updateArea,
  updateDevice,
  updateEntity,
} from './structure';
import { daysAgo, isoUtc } from './time-utils';
import { parseYaml } from './yaml';

// ---------------------------------------------------------------------------
// JSON output helpers — Python json.dumps parity
// ---------------------------------------------------------------------------

/** json.dumps(ensure_ascii=True): escape every non-ASCII UTF-16 code unit. */
function escapeNonAscii(text: string): string {
  return text.replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function jsonDumps(value: unknown, options: { indent?: number; ensureAscii?: boolean } = {}): string {
  const { indent = 2, ensureAscii = true } = options;
  const text = JSON.stringify(value, null, indent);
  return ensureAscii ? escapeNonAscii(text) : text;
}

/** Python json.dumps default separators (', ', ': ') — single-line. */
function jsonDumpsCompact(value: unknown): string {
  if (value === null || typeof value !== 'object') return escapeNonAscii(JSON.stringify(value));
  if (Array.isArray(value)) return `[${value.map(jsonDumpsCompact).join(', ')}]`;
  const entries = Object.entries(value).map(
    ([key, child]) => `${escapeNonAscii(JSON.stringify(key))}: ${jsonDumpsCompact(child)}`,
  );
  return `{${entries.join(', ')}}`;
}

/** Print a failure as `{"error":"<token>[:detail]"}` and return exit 1. */
function printError(error: string): number {
  console.log(jsonDumps({ error }, { ensureAscii: false }));
  return 1;
}

/** Print a HomeAssistantError as its `{"error"}` token and return exit 1. */
function printHaError(exc: HomeAssistantError, fallback?: string): number {
  return printError(haErrorToken(exc, fallback));
}

/** Print an expected alternative outcome as `{"status","reason",...}` and return exit 0. */
function printStatus(status: string, reason: string, extra: Record<string, unknown> = {}): number {
  console.log(jsonDumps({ status, reason, ...extra }, { ensureAscii: false }));
  return 0;
}

/** Print a gate refusal. */
function printBlocked(gate: MutationGate): number {
  return printStatus('blocked', gate.code ?? 'policy_deny', { detail: gate.reason });
}

/** Print a scheduled check that could not run. */
function printSkipped(date: string, reason: string, exc: any): number {
  return printStatus('skipped', reason, { date, detail: String(exc?.message ?? exc) });
}

/** Print a config id HA does not know. */
function printNotFound(configId: string): number {
  return printStatus('not_found', 'no_config', { config_id: configId });
}

/** Print a findings payload that a scheduled skill renders, on one line. */
function printFindings(findings: Record<string, unknown>): number {
  console.log(jsonDumps(findings, { indent: 0, ensureAscii: false }));
  return 0;
}

/** date.today().isoformat() — local date. */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Dependency injection (pytest monkeypatch equivalent)
// ---------------------------------------------------------------------------

/** The client surface the CLI uses (HomeAssistantClient satisfies it). */
export interface CliClient {
  baseUrlSource: string;
  get(path: string): Promise<any>;
  post(path: string, payload?: Record<string, unknown> | null): Promise<any>;
  delete(path: string): Promise<any>;
  postText(path: string, payload?: Record<string, unknown> | null): Promise<string>;
  getText(path: string): Promise<string>;
  callService(domain: string, service: string, data: Record<string, unknown>): Promise<any>;
  getStates(): Promise<Array<Record<string, any>>>;
  getHistory(
    entityIds: string[],
    startTime: Date,
    endTime: Date,
  ): Promise<Record<string, Array<Record<string, any>>>>;
}

export interface CliDeps {
  loadConfig: (root?: string | null) => AppConfig;
  createClient: (config: AppConfig) => Promise<CliClient>;
  createWsClient: (config: AppConfig) => Promise<WsCommandClient>;
  refreshContext: (root: string, client: CliClient) => Promise<Record<string, any>>;
}

function resolveDeps(overrides: Partial<CliDeps>): CliDeps {
  return {
    loadConfig: overrides.loadConfig ?? loadConfig,
    createClient: overrides.createClient ?? ((config) => HomeAssistantClient.create(config)),
    createWsClient: overrides.createWsClient ?? ((config) => HomeAssistantWsClient.create(config)),
    refreshContext: overrides.refreshContext ?? refreshContext,
  };
}

// ---------------------------------------------------------------------------
// Argparse-equivalent parsing
// ---------------------------------------------------------------------------

class ParserExit extends Error {
  constructor(readonly code: number, readonly error?: string) {
    super(`parser exit ${code}`);
  }
}

const TOP_USAGE = 'usage: ha_agent_lab [-h] {boot,ha} ...';
const BOOT_USAGE = 'usage: ha_agent_lab boot [-h] {status,store,mcp-config} ...';
/** A malformed command line is a usage failure like any other: one `{"error"}` on stdout, exit 1. */
function argError(prog: string, message: string): never {
  throw new ParserExit(1, `usage:${prog}: ${message}`);
}

function printHelp(text: string): never {
  console.log(text);
  throw new ParserExit(0);
}

interface FlagSpec {
  // 'store_true' | 'value' | 'plus' (nargs='+')
  kind: 'store_true' | 'value' | 'plus';
  choices?: readonly string[];
  int?: boolean;
}

interface LeafSpec {
  prog: string;
  usage: string;
  positionals: string[];
  flags: Record<string, FlagSpec>;
}

interface CommandContext {
  config: AppConfig;
  root: string;
  deps: CliDeps;
}

interface CommandRecord {
  spec: LeafSpec;
  /** This command's block of the `ha --help` body, pre-wrapped to argparse's
   *  column layout. Empty for commands argparse never described. */
  help: string;
  run(args: ParsedArgs, ctx: CommandContext): number | Promise<number>;
}

interface ParsedLeaf {
  positionals: string[];
  flags: Record<string, unknown>;
  extras: string[];
}

function parseLeaf(spec: LeafSpec, args: string[]): ParsedLeaf {
  const positionals: string[] = [];
  const flags: Record<string, unknown> = {};
  const extras: string[] = [];

  for (let i = 0; i < args.length; i++) {
    let token = args[i]!;
    if (token === '-h' || token === '--help') {
      printHelp(`${spec.usage}\n\noptions:\n  -h, --help  show this help message and exit`);
    }
    let inlineValue: string | null = null;
    if (token.startsWith('--') && token.includes('=')) {
      const eq = token.indexOf('=');
      inlineValue = token.slice(eq + 1);
      token = token.slice(0, eq);
    }
    if (token.startsWith('--')) {
      const flag = spec.flags[token];
      if (!flag) {
        extras.push(args[i]!);
        continue;
      }
      if (flag.kind === 'store_true') {
        if (inlineValue !== null) {
          argError(spec.prog, `argument ${token}: ignored explicit argument '${inlineValue}'`);
        }
        flags[token] = true;
        continue;
      }
      if (flag.kind === 'plus') {
        const values: string[] = [];
        if (inlineValue !== null) values.push(inlineValue);
        while (i + 1 < args.length && !args[i + 1]!.startsWith('-')) {
          values.push(args[++i]!);
        }
        if (values.length === 0) {
          argError(spec.prog, `argument ${token}: expected at least one argument`);
        }
        flags[token] = values;
        continue;
      }
      let value: string;
      if (inlineValue !== null) {
        value = inlineValue;
      } else if (i + 1 < args.length) {
        value = args[++i]!;
      } else {
        argError(spec.prog, `argument ${token}: expected one argument`);
      }
      if (flag.choices && !flag.choices.includes(value)) {
        const choices = flag.choices.map((c) => `'${c}'`).join(', ');
        argError(spec.prog, `argument ${token}: invalid choice: '${value}' (choose from ${choices})`);
      }
      if (flag.int) {
        if (!/^[+-]?\d+$/.test(value.trim())) {
          argError(spec.prog, `argument ${token}: invalid int value: '${value}'`);
        }
        flags[token] = parseInt(value.trim(), 10);
      } else {
        flags[token] = value;
      }
      continue;
    }
    if (positionals.length < spec.positionals.length) positionals.push(token);
    else extras.push(token);
  }

  if (positionals.length < spec.positionals.length) {
    const missing = spec.positionals.slice(positionals.length).join(', ');
    argError(spec.prog, `the following arguments are required: ${missing}`);
  }
  return { positionals, flags, extras };
}

function rejectExtras(extras: string[]): void {
  if (extras.length > 0) {
    argError('ha_agent_lab', `unrecognized arguments: ${extras.join(' ')}`);
  }
}

/** Everything the CLI knows about one command: how to parse it, how it
 *  documents itself, and what it does. Adding a command means adding one
 *  record — the command list, the `ha --help` body and the dispatch all
 *  derive from this table, so they cannot drift out of sync.
 *
 *  Declaration order is load-bearing: it is the order `--help` prints. */
export const COMMANDS: Record<string, CommandRecord> = {
  'boot status': {
    spec: {
      prog: 'ha_agent_lab boot status',
      usage: 'usage: ha_agent_lab boot status [-h] [--probe]',
      positionals: [],
      flags: { '--probe': { kind: 'store_true' } },
    },
    help: '',
    run: async (args, { config, root, deps }) => {
      const status = await bootStatus(config, { probe: Boolean(args.flags['--probe']) });
      console.log(jsonDumps(status));
      return 0;
    },
  },
  'boot store': {
    spec: {
      prog: 'ha_agent_lab boot store',
      usage:
        'usage: ha_agent_lab boot store [-h] [--language LANGUAGE] [--url URL]\n' +
        '                               [--local-url LOCAL_URL]\n' +
        '                               [--remote-url REMOTE_URL] [--token TOKEN]',
      positionals: [],
      flags: {
        '--language': { kind: 'value' },
        '--url': { kind: 'value' },
        '--local-url': { kind: 'value' },
        '--remote-url': { kind: 'value' },
        '--token': { kind: 'value' },
      },
    },
    help: '',
    run: async (args, { config, root, deps }) => {
      const changes = saveBootPreferences(root, {
        language: (args.flags['--language'] as string | undefined) ?? null,
        url: (args.flags['--url'] as string | undefined) ?? null,
        localUrl: (args.flags['--local-url'] as string | undefined) ?? null,
        remoteUrl: (args.flags['--remote-url'] as string | undefined) ?? null,
        token: (args.flags['--token'] as string | undefined) ?? null,
      });
      console.log(jsonDumps({ updated: changes }));
      return 0;
    },
  },
  'boot mcp-config': {
    spec: {
      prog: 'ha_agent_lab boot mcp-config',
      usage: 'usage: ha_agent_lab boot mcp-config [-h]',
      positionals: [],
      flags: {},
    },
    help: '',
    run: async (args, { config }) => {
      const result = writeMcpConfig(config);
      console.log(jsonDumps(result));
      return 'error' in result ? 1 : 0;
    },
  },
  'ha refresh-context': {
    spec: {
      prog: 'ha_agent_lab ha refresh-context',
      usage: 'usage: ha_agent_lab ha refresh-context [-h] [--incremental]',
      positionals: [],
      flags: { '--incremental': { kind: 'store_true' } },
    },
    help: '',
    run: async (args, { config, root, deps }) => {
      try {
        const client = await deps.createClient(config);
        if (args.flags['--incremental']) {
          const [payload, delta] = await refreshContextIncremental(root, client, deps);
          console.log(
            jsonDumps({
              mode: 'incremental',
              entities: Object.keys(payload.entity_index).length,
              added: delta.added.length,
              removed: delta.removed.length,
              changed: delta.changed.length,
              base_url_source: client.baseUrlSource,
            }),
          );
        } else {
          const payload = await deps.refreshContext(root, client);
          console.log(
            jsonDumps({
              mode: 'full',
              entities: Object.keys(payload.entity_index).length,
              base_url_source: client.baseUrlSource,
            }),
          );
        }
        return 0;
      } catch (exc) {
        if (!(exc instanceof HomeAssistantError)) throw exc;
        return printHaError(exc);
      }
    },
  },
  'ha simulate': {
    spec: {
      prog: 'ha_agent_lab ha simulate',
      usage: 'usage: ha_agent_lab ha simulate [-h] artifact',
      positionals: ['artifact'],
      flags: {},
    },
    help: '',
    run: async (args, { config, root, deps }) => {
      const result = simulateArtifact(root, resolve(args.positionals[0]!));
      if (result.isValid) {
        console.log('OK');
        return 0;
      }
      return printStatus('invalid', result.blockedReasons.length > 0 ? 'blocked' : 'missing_entities', {
        missing_entities: result.missingEntities,
        blocked_reasons: result.blockedReasons,
      });
    },
  },
  'ha validate-apply': {
    spec: {
      prog: 'ha_agent_lab ha validate-apply',
      usage:
        'usage: ha_agent_lab ha validate-apply [-h] [--reload {automation,script,scene}]\n' +
        '                                      artifact',
      positionals: ['artifact'],
      flags: { '--reload': { kind: 'value', choices: ['automation', 'script', 'scene'] } },
    },
    help: '',
    run: async (args, { config, root, deps }) => {
      try {
        const client = await deps.createClient(config);
        const result = await validateAndApply(
          root,
          client,
          resolve(args.positionals[0]!),
          (args.flags['--reload'] as string | undefined) ?? null,
        );
        const reportPath = relative(root, result.reportPath);
        if (result.message === 'simulation-failed') {
          return printStatus('invalid', 'simulation_failed', { report_path: reportPath });
        }
        if (result.message === 'reload-blocked') {
          return printStatus('blocked', 'reload_domain_not_allowed', { report_path: reportPath });
        }
        if (!result.ok) return printError(`apply_failed:${result.message}`);
        console.log(
          jsonDumps({
            config_id: result.configId,
            creation_attempted: result.creationAttempted,
            creation_ok: result.creationOk,
            reload_attempted: result.reloadAttempted,
            message: result.message,
            report_path: reportPath,
            base_url_source: client.baseUrlSource,
          }),
        );
        return 0;
      } catch (exc) {
        if (!(exc instanceof HomeAssistantError)) throw exc;
        return printHaError(exc);
      }
    },
  },
  'ha policy-check': {
    spec: {
      prog: 'ha_agent_lab ha policy-check',
      usage: 'usage: ha_agent_lab ha policy-check [-h] target',
      positionals: ['target'],
      flags: {},
    },
    help: '',
    run: async (args, { config, root, deps }) => {
      return handlePolicyCheck(args.positionals[0]!, root);
    },
  },
  'ha audit-automations': {
    spec: {
      prog: 'ha_agent_lab ha audit-automations',
      usage: 'usage: ha_agent_lab ha audit-automations [-h]',
      positionals: [],
      flags: {},
    },
    help: `    audit-automations   Audit all live HA automations against the safety
                        policy.`,
    run: async (args, { config, root, deps }) => {
      return handleAudit('automation', root, config, deps);
    },
  },
  'ha audit-scripts': {
    spec: {
      prog: 'ha_agent_lab ha audit-scripts',
      usage: 'usage: ha_agent_lab ha audit-scripts [-h]',
      positionals: [],
      flags: {},
    },
    help: `    audit-scripts       Audit all live HA scripts against the safety policy.`,
    run: async (args, { config, root, deps }) => {
      return handleAudit('script', root, config, deps);
    },
  },
  'ha probe': {
    spec: {
      prog: 'ha_agent_lab ha probe',
      usage: 'usage: ha_agent_lab ha probe [-h] path',
      positionals: ['path'],
      flags: {},
    },
    help: `    probe               GET a raw HA REST path and print the JSON response.
                        Useful for verifying endpoints.`,
    run: async (args, { config, root, deps }) => {
      try {
        const client = await deps.createClient(config);
        const response = await client.get(args.positionals[0]!);
        console.log(jsonDumps({ data: response }, { ensureAscii: false }));
        return 0;
      } catch (exc) {
        if (!(exc instanceof HomeAssistantError)) throw exc;
        return printHaError(exc);
      }
    },
  },
  'ha integration-health': {
    spec: {
      prog: 'ha_agent_lab ha integration-health',
      usage: 'usage: ha_agent_lab ha integration-health [-h]',
      positionals: [],
      flags: {},
    },
    help: `    integration-health  Detect degraded HA integrations and write
                        state/integration-health-degraded-domains.json.`,
    run: async (args, { config, root, deps }) => {
      return handleIntegrationHealth(root, config, deps);
    },
  },
  'ha updates': {
    spec: {
      prog: 'ha_agent_lab ha updates',
      usage: 'usage: ha_agent_lab ha updates [-h] [--digest]',
      positionals: [],
      flags: { '--digest': { kind: 'store_true' } },
    },
    help: `    updates             List pending Home Assistant updates (update.* domain)
                        with version deltas, tiered core/os/supervisor/addon/
                        hacs.`,
    run: async (args, { config, root, deps }) => {
      return handleUpdates(config, deps, Boolean(args.flags['--digest']));
    },
  },
  'ha fetch-history': {
    spec: {
      prog: 'ha_agent_lab ha fetch-history',
      usage:
        'usage: ha_agent_lab ha fetch-history [-h] [--window-days WINDOW_DAYS]\n' +
        '                                     [--entities ENTITY [ENTITY ...]]\n' +
        '                                     [--include-transitions]',
      positionals: [],
      flags: {
        '--window-days': { kind: 'value', int: true },
        '--entities': { kind: 'plus' },
        '--include-transitions': { kind: 'store_true' },
      },
    },
    help: `    fetch-history       Fetch and aggregate HA history into a snapshot
                        artifact. Requires a normalized snapshot; runs
                        \`refresh-context\` first if none exists.`,
    run: async (args, { config, root, deps }) => {
      return handleFetchHistory(
        root,
        config,
        deps,
        (args.flags['--window-days'] as number | undefined) ?? 7,
        (args.flags['--entities'] as string[] | undefined) ?? null,
        Boolean(args.flags['--include-transitions']),
      );
    },
  },
  'ha list-automations': {
    spec: {
      prog: 'ha_agent_lab ha list-automations',
      usage: 'usage: ha_agent_lab ha list-automations [-h]',
      positionals: [],
      flags: {},
    },
    help: `    list-automations    List all automation entity IDs and config IDs.`,
    run: async (args, { config, root, deps }) => {
      return handleListDomain('automation', config, deps);
    },
  },
  'ha list-scripts': {
    spec: {
      prog: 'ha_agent_lab ha list-scripts',
      usage: 'usage: ha_agent_lab ha list-scripts [-h]',
      positionals: [],
      flags: {},
    },
    help: `    list-scripts        List all script entity IDs and config IDs.`,
    run: async (args, { config, root, deps }) => {
      return handleListDomain('script', config, deps);
    },
  },
  'ha list-scenes': {
    spec: {
      prog: 'ha_agent_lab ha list-scenes',
      usage: 'usage: ha_agent_lab ha list-scenes [-h]',
      positionals: [],
      flags: {},
    },
    help: `    list-scenes         List all scene entity IDs and config IDs.`,
    run: async (args, { config, root, deps }) => {
      return handleListDomain('scene', config, deps);
    },
  },
  'ha delete-automation': {
    spec: {
      prog: 'ha_agent_lab ha delete-automation',
      usage: 'usage: ha_agent_lab ha delete-automation [-h] id',
      positionals: ['id'],
      flags: {},
    },
    help: `    delete-automation   Delete an automation config by ID.`,
    run: async (args, { config, root, deps }) => {
      return handleDeleteConfig('automation', args.positionals[0]!, root, config, deps);
    },
  },
  'ha delete-script': {
    spec: {
      prog: 'ha_agent_lab ha delete-script',
      usage: 'usage: ha_agent_lab ha delete-script [-h] id',
      positionals: ['id'],
      flags: {},
    },
    help: `    delete-script       Delete a script config by ID.`,
    run: async (args, { config, root, deps }) => {
      return handleDeleteConfig('script', args.positionals[0]!, root, config, deps);
    },
  },
  'ha delete-scene': {
    spec: {
      prog: 'ha_agent_lab ha delete-scene',
      usage: 'usage: ha_agent_lab ha delete-scene [-h] id',
      positionals: ['id'],
      flags: {},
    },
    help: `    delete-scene        Delete a scene config by ID.`,
    run: async (args, { config, root, deps }) => {
      return handleDeleteConfig('scene', args.positionals[0]!, root, config, deps);
    },
  },
  'ha get-automation-config': {
    spec: {
      prog: 'ha_agent_lab ha get-automation-config',
      usage: 'usage: ha_agent_lab ha get-automation-config [-h] id',
      positionals: ['id'],
      flags: {},
    },
    help: `    get-automation-config
                        Read an automation's stored config from HA.`,
    run: async (args, { config, root, deps }) => {
      return handleReadConfig('automation', args.positionals[0]!, config, deps);
    },
  },
  'ha get-script-config': {
    spec: {
      prog: 'ha_agent_lab ha get-script-config',
      usage: 'usage: ha_agent_lab ha get-script-config [-h] id',
      positionals: ['id'],
      flags: {},
    },
    help: `    get-script-config   Read a script's stored config from HA.`,
    run: async (args, { config, root, deps }) => {
      return handleReadConfig('script', args.positionals[0]!, config, deps);
    },
  },
  'ha get-scene-config': {
    spec: {
      prog: 'ha_agent_lab ha get-scene-config',
      usage: 'usage: ha_agent_lab ha get-scene-config [-h] id',
      positionals: ['id'],
      flags: {},
    },
    help: `    get-scene-config    Read a scene's stored config from HA.`,
    run: async (args, { config, root, deps }) => {
      return handleReadConfig('scene', args.positionals[0]!, config, deps);
    },
  },
  'ha automation-diff': {
    spec: {
      prog: 'ha_agent_lab ha automation-diff',
      usage: 'usage: ha_agent_lab ha automation-diff [-h]',
      positionals: [],
      flags: {},
    },
    help: `    automation-diff     Report automations added/removed/edited/disabled since
                        the last snapshot (change memory across sessions).`,
    run: async (args, { config, root, deps }) => {
      try {
        const client = await deps.createClient(config);
        const result = await automationDiff(root, client);
        if (result.baseline) {
          return printStatus('baseline', 'no_prior_snapshot', { date: todayIso(), tracked: result.tracked });
        }
        const changes = (['added', 'removed', 'edited', 'disabled', 'enabled'] as const).flatMap((change) =>
          result[change].map((item) => ({ change, name: item.friendly_name ?? item.entity_id, id: item.id })),
        );
        return printFindings({ date: todayIso(), tracked: result.tracked, changes, untracked: result.untracked.length });
      } catch (exc) {
        if (!(exc instanceof HomeAssistantError)) throw exc;
        return printHaError(exc);
      }
    },
  },
  'ha snapshot-states': {
    spec: {
      prog: 'ha_agent_lab ha snapshot-states',
      usage:
        'usage: ha_agent_lab ha snapshot-states [-h] [--name NAME]\n' +
        '                                       [--domains DOMAINS]\n' +
        '                                       [--entities ENTITY [ENTITY ...]]',
      positionals: [],
      flags: {
        '--name': { kind: 'value' },
        '--domains': { kind: 'value' },
        '--entities': { kind: 'plus' },
      },
    },
    help: `    snapshot-states     Capture entity states to a named artifact for later
                        restore.`,
    run: async (args, { config, root, deps }) => {
      try {
        const client = await deps.createClient(config);
        const domainsFlag = args.flags['--domains'] as string | undefined;
        const entities = args.flags['--entities'] as string[] | undefined;
        const result = await captureStates(root, client, {
          name: (args.flags['--name'] as string | undefined) ?? 'snapshot',
          domains: domainsFlag
            ? domainsFlag.split(',').map((d) => d.trim()).filter(Boolean)
            : DEFAULT_DOMAINS,
          entities,
        });
        console.log(
          jsonDumps(
            {
              name: result.name,
              captured: result.captured,
              entities: result.entities,
              report_path: relative(root, result.reportPath),
            },
            { ensureAscii: false },
          ),
        );
        return 0;
      } catch (exc) {
        if (!(exc instanceof HomeAssistantError)) throw exc;
        return printHaError(exc);
      }
    },
  },
  'ha restore-states': {
    spec: {
      prog: 'ha_agent_lab ha restore-states',
      usage: 'usage: ha_agent_lab ha restore-states [-h] artifact',
      positionals: ['artifact'],
      flags: {},
    },
    help: `    restore-states      Restore captured entity states via scene.apply
                        (gated by ha_safety_mode).`,
    run: async (args, { config, root, deps }) => {
      try {
        const client = await deps.createClient(config);
        const result = await restoreStates(root, client, {
          artifactPath: resolve(args.positionals[0]!),
        });
        if (result.blocked) {
          return printStatus('blocked', 'strict_mode', { entities: result.entities, sensitive: result.sensitive });
        }
        if (result.empty) return printStatus('empty', 'no_entities');
        if (!result.ok) return printError(`snapshot_unreadable:${result.reason}`);
        const payload: Record<string, unknown> = {
          applied: result.applied,
          entities: result.entities,
          sensitive: result.sensitive,
        };
        if (result.reportPath) payload.report_path = relative(root, result.reportPath);
        console.log(jsonDumps(payload, { ensureAscii: false }));
        return 0;
      } catch (exc) {
        if (!(exc instanceof HomeAssistantError)) throw exc;
        return printHaError(exc);
      }
    },
  },
  'ha list-helpers': {
    spec: {
      prog: 'ha_agent_lab ha list-helpers',
      usage: `usage: ha_agent_lab ha list-helpers [-h] [--type {${HELPER_TYPES.join(',')}}]`,
      positionals: [],
      flags: { '--type': { kind: 'value', choices: HELPER_TYPES } },
    },
    help: `    list-helpers        List helpers (input_*, timer, counter, schedule) via
                        WebSocket. Optional --type to scope to one.`,
    run: async (args, { config, root, deps }) => {
      return runWsRead(deps, config, (ws) => listHelpers(ws, args.flags['--type'] as string | undefined));
    },
  },
  'ha create-helper': {
    spec: {
      prog: 'ha_agent_lab ha create-helper',
      usage: `usage: ha_agent_lab ha create-helper [-h] {${HELPER_TYPES.join(',')}} json`,
      positionals: ['type', 'json'],
      flags: {},
    },
    help: `    create-helper       Create a helper from JSON via WebSocket (gated write).`,
    run: async (args, { config, root, deps }) => {
      return runWsMutation(deps, config, root, (ws) =>
        createHelper(root, ws, args.positionals[0]!, args.positionals[1]!),
      );
    },
  },
  'ha delete-helper': {
    spec: {
      prog: 'ha_agent_lab ha delete-helper',
      usage: `usage: ha_agent_lab ha delete-helper [-h] {${HELPER_TYPES.join(',')}} id`,
      positionals: ['type', 'id'],
      flags: {},
    },
    help: `    delete-helper       Delete a helper by id via WebSocket (gated write).`,
    run: async (args, { config, root, deps }) => {
      return runWsMutation(deps, config, root, (ws) =>
        deleteHelper(root, ws, args.positionals[0]!, args.positionals[1]!),
      );
    },
  },
  'ha list-areas': {
    spec: {
      prog: 'ha_agent_lab ha list-areas',
      usage: 'usage: ha_agent_lab ha list-areas [-h]',
      positionals: [],
      flags: {},
    },
    help: `    list-areas          List areas via WebSocket.`,
    run: async (args, { config, root, deps }) => {
      return runWsRead(deps, config, listAreas);
    },
  },
  'ha create-area': {
    spec: {
      prog: 'ha_agent_lab ha create-area',
      usage: 'usage: ha_agent_lab ha create-area [-h] name',
      positionals: ['name'],
      flags: {},
    },
    help: `    create-area         Create an area by name via WebSocket (gated write).`,
    run: async (args, { config, root, deps }) => {
      return runWsMutation(deps, config, root, (ws) =>
        createArea(root, ws, args.positionals[0]!),
      );
    },
  },
  'ha delete-area': {
    spec: {
      prog: 'ha_agent_lab ha delete-area',
      usage: 'usage: ha_agent_lab ha delete-area [-h] id',
      positionals: ['id'],
      flags: {},
    },
    help: `    delete-area         Delete an area by id via WebSocket (gated write).`,
    run: async (args, { config, root, deps }) => {
      return runWsMutation(deps, config, root, (ws) =>
        deleteArea(root, ws, args.positionals[0]!),
      );
    },
  },
  'ha list-entities': {
    spec: {
      prog: 'ha_agent_lab ha list-entities',
      usage: 'usage: ha_agent_lab ha list-entities [-h] --registry',
      positionals: [],
      flags: { '--registry': { kind: 'store_true' } },
    },
    help: `    list-entities       List the entity registry via WebSocket (--registry).`,
    run: async (args, { config, root, deps }) => {
      if (!args.flags['--registry']) {
        return printError('usage:only registry mode is supported; pass --registry');
      }
      return runWsRead(deps, config, listEntities);
    },
  },
  'ha rename-entity': {
    spec: {
      prog: 'ha_agent_lab ha rename-entity',
      usage: 'usage: ha_agent_lab ha rename-entity [-h] --name NAME entity_id',
      positionals: ['entity_id'],
      flags: { '--name': { kind: 'value' } },
    },
    help: `    rename-entity       Set an entity's friendly name (gated write).`,
    run: async (args, { config, root, deps }) => {
      const name = requireFlag(args.flags['--name'], '--name');
      if (name === null) return 1;
      return runWsMutation(deps, config, root, (ws) =>
        updateEntity(root, ws, args.positionals[0]!, { name }, 'rename-entity'),
      );
    },
  },
  'ha set-entity-area': {
    spec: {
      prog: 'ha_agent_lab ha set-entity-area',
      usage: 'usage: ha_agent_lab ha set-entity-area [-h] --area AREA entity_id',
      positionals: ['entity_id'],
      flags: { '--area': { kind: 'value' } },
    },
    help: `    set-entity-area     Assign an entity to an area (gated write).`,
    run: async (args, { config, root, deps }) => {
      const area = requireFlag(args.flags['--area'], '--area');
      if (area === null) return 1;
      return runWsMutation(deps, config, root, (ws) =>
        updateEntity(root, ws, args.positionals[0]!, { area_id: area }, 'set-entity-area'),
      );
    },
  },
  'ha set-entity-enabled': {
    spec: {
      prog: 'ha_agent_lab ha set-entity-enabled',
      usage: 'usage: ha_agent_lab ha set-entity-enabled [-h] --enabled {true,false} entity_id',
      positionals: ['entity_id'],
      flags: { '--enabled': { kind: 'value', choices: ['true', 'false'] } },
    },
    help: `    set-entity-enabled  Enable/disable an entity (gated write).`,
    run: async (args, { config, root, deps }) => {
      const enabled = requireFlag(args.flags['--enabled'], '--enabled');
      if (enabled === null) return 1;
      const disabledBy = enabled === 'true' ? null : 'user';
      return runWsMutation(deps, config, root, (ws) =>
        updateEntity(root, ws, args.positionals[0]!, { disabled_by: disabledBy }, 'set-entity-enabled'),
      );
    },
  },
  'ha set-entity-icon': {
    spec: {
      prog: 'ha_agent_lab ha set-entity-icon',
      usage: 'usage: ha_agent_lab ha set-entity-icon [-h] --icon ICON entity_id',
      positionals: ['entity_id'],
      flags: { '--icon': { kind: 'value' } },
    },
    help: `    set-entity-icon     Set an entity's icon (gated write).`,
    run: async (args, { config, root, deps }) => {
      const icon = requireFlag(args.flags['--icon'], '--icon');
      if (icon === null) return 1;
      return runWsMutation(deps, config, root, (ws) =>
        updateEntity(root, ws, args.positionals[0]!, { icon }, 'set-entity-icon'),
      );
    },
  },
  'ha set-entity-hidden': {
    spec: {
      prog: 'ha_agent_lab ha set-entity-hidden',
      usage: 'usage: ha_agent_lab ha set-entity-hidden [-h] --hidden {true,false} entity_id',
      positionals: ['entity_id'],
      flags: { '--hidden': { kind: 'value', choices: ['true', 'false'] } },
    },
    help: `    set-entity-hidden   Hide/show an entity in the UI (gated write).`,
    run: async (args, { config, root, deps }) => {
      const hidden = requireFlag(args.flags['--hidden'], '--hidden');
      if (hidden === null) return 1;
      const hiddenBy = hidden === 'true' ? 'user' : null;
      return runWsMutation(deps, config, root, (ws) =>
        updateEntity(root, ws, args.positionals[0]!, { hidden_by: hiddenBy }, 'set-entity-hidden'),
      );
    },
  },
  'ha set-entity-labels': {
    spec: {
      prog: 'ha_agent_lab ha set-entity-labels',
      usage: 'usage: ha_agent_lab ha set-entity-labels [-h] --labels LABEL [LABEL ...] entity_id',
      positionals: ['entity_id'],
      flags: { '--labels': { kind: 'plus' } },
    },
    help: `    set-entity-labels   Set an entity's labels (gated write).`,
    run: async (args, { config, root, deps }) => {
      const labels = requirePlusFlag(args.flags['--labels'], '--labels');
      if (labels === null) return 1;
      return runWsMutation(deps, config, root, (ws) =>
        updateEntity(root, ws, args.positionals[0]!, { labels }, 'set-entity-labels'),
      );
    },
  },
  'ha set-entity-categories': {
    spec: {
      prog: 'ha_agent_lab ha set-entity-categories',
      usage: 'usage: ha_agent_lab ha set-entity-categories [-h] --categories JSON entity_id',
      positionals: ['entity_id'],
      flags: { '--categories': { kind: 'value' } },
    },
    help: `    set-entity-categories
                        Set an entity's per-scope categories from JSON
                        (gated write).`,
    run: async (args, { config, root, deps }) => {
      const raw = requireFlag(args.flags['--categories'], '--categories');
      if (raw === null) return 1;
      const parsed = parseJsonObject(raw);
      if (!parsed.ok) {
        return printError(`usage:--categories ${parsed.message}`);
      }
      return runWsMutation(deps, config, root, (ws) =>
        updateEntity(root, ws, args.positionals[0]!, { categories: parsed.payload }, 'set-entity-categories'),
      );
    },
  },
  'ha set-entity-aliases': {
    spec: {
      prog: 'ha_agent_lab ha set-entity-aliases',
      usage: 'usage: ha_agent_lab ha set-entity-aliases [-h] --aliases ALIAS [ALIAS ...] entity_id',
      positionals: ['entity_id'],
      flags: { '--aliases': { kind: 'plus' } },
    },
    help: `    set-entity-aliases  Set an entity's Assist aliases (gated write).`,
    run: async (args, { config, root, deps }) => {
      const aliases = requirePlusFlag(args.flags['--aliases'], '--aliases');
      if (aliases === null) return 1;
      return runWsMutation(deps, config, root, (ws) =>
        updateEntity(root, ws, args.positionals[0]!, { aliases }, 'set-entity-aliases'),
      );
    },
  },
  'ha list-devices': {
    spec: {
      prog: 'ha_agent_lab ha list-devices',
      usage: 'usage: ha_agent_lab ha list-devices [-h]',
      positionals: [],
      flags: {},
    },
    help: `    list-devices        List the device registry via WebSocket.`,
    run: async (args, { config, root, deps }) => {
      return runWsRead(deps, config, listDevices);
    },
  },
  'ha set-device-area': {
    spec: {
      prog: 'ha_agent_lab ha set-device-area',
      usage: 'usage: ha_agent_lab ha set-device-area [-h] --area AREA device_id',
      positionals: ['device_id'],
      flags: { '--area': { kind: 'value' } },
    },
    help: `    set-device-area     Assign a device to an area (gated write).`,
    run: async (args, { config, root, deps }) => {
      const area = requireFlag(args.flags['--area'], '--area');
      if (area === null) return 1;
      return runWsMutation(deps, config, root, (ws) =>
        updateDevice(root, ws, args.positionals[0]!, { area_id: area }, 'set-device-area'),
      );
    },
  },
  'ha rename-device': {
    spec: {
      prog: 'ha_agent_lab ha rename-device',
      usage: 'usage: ha_agent_lab ha rename-device [-h] --name NAME device_id',
      positionals: ['device_id'],
      flags: { '--name': { kind: 'value' } },
    },
    help: `    rename-device       Set a device's user name (gated write).`,
    run: async (args, { config, root, deps }) => {
      const name = requireFlag(args.flags['--name'], '--name');
      if (name === null) return 1;
      return runWsMutation(deps, config, root, (ws) =>
        updateDevice(root, ws, args.positionals[0]!, { name_by_user: name }, 'rename-device'),
      );
    },
  },
  'ha list-dashboards': {
    spec: {
      prog: 'ha_agent_lab ha list-dashboards',
      usage: 'usage: ha_agent_lab ha list-dashboards [-h]',
      positionals: [],
      flags: {},
    },
    help: `    list-dashboards     List Lovelace dashboards via WebSocket.`,
    run: async (args, { config, root, deps }) => {
      return runWsRead(deps, config, listDashboards);
    },
  },
  'ha get-dashboard': {
    spec: {
      prog: 'ha_agent_lab ha get-dashboard',
      usage: 'usage: ha_agent_lab ha get-dashboard [-h] [--url-path URL_PATH]',
      positionals: [],
      flags: { '--url-path': { kind: 'value' } },
    },
    help: `    get-dashboard       Read a dashboard's config via WebSocket (--url-path;
                        default dashboard if omitted).`,
    run: async (args, { config, root, deps }) => {
      const urlPath = (args.flags['--url-path'] as string | undefined) ?? null;
      return runWsRead(deps, config, (ws) => getDashboard(ws, urlPath));
    },
  },
  'ha apply-dashboard': {
    spec: {
      prog: 'ha_agent_lab ha apply-dashboard',
      usage:
        'usage: ha_agent_lab ha apply-dashboard [-h] [--url-path URL_PATH]\n' +
        '                                       artifact',
      positionals: ['artifact'],
      flags: { '--url-path': { kind: 'value' } },
    },
    help: `    apply-dashboard     Save/replace a dashboard's config from an artifact
                        via WebSocket (gated write).`,
    run: async (args, { config, root, deps }) => {
      const urlPath = (args.flags['--url-path'] as string | undefined) ?? null;
      const artifactPath = resolve(args.positionals[0]!);
      // Read+parse before opening the WS: a missing/malformed artifact must
      // surface a clean {"error"} (not an uncaught throw past runWsMutation's
      // HomeAssistantError-only catch), and without wasting a WS connection.
      if (!existsSync(artifactPath)) {
        return printError(`artifact_not_found:${args.positionals[0]}`);
      }
      let dashboardConfig: unknown;
      try {
        dashboardConfig = parseYaml(readFileSync(artifactPath, 'utf8'));
      } catch (exc) {
        return printError(`invalid_artifact:${exc instanceof Error ? exc.message : String(exc)}`);
      }
      return runWsMutation(deps, config, root, (ws) =>
        saveDashboard(root, ws, urlPath, dashboardConfig),
      );
    },
  },
  'ha create-dashboard': {
    spec: {
      prog: 'ha_agent_lab ha create-dashboard',
      usage: 'usage: ha_agent_lab ha create-dashboard [-h] json',
      positionals: ['json'],
      flags: {},
    },
    help: `    create-dashboard    Create a dashboard from JSON via WebSocket (gated
                        write).`,
    run: async (args, { config, root, deps }) => {
      return runWsMutation(deps, config, root, (ws) =>
        createDashboard(root, ws, args.positionals[0]!),
      );
    },
  },
  'ha delete-dashboard': {
    spec: {
      prog: 'ha_agent_lab ha delete-dashboard',
      usage: 'usage: ha_agent_lab ha delete-dashboard [-h] dashboard_id',
      positionals: ['dashboard_id'],
      flags: {},
    },
    help: `    delete-dashboard    Delete a dashboard by id via WebSocket (gated write).`,
    run: async (args, { config, root, deps }) => {
      return runWsMutation(deps, config, root, (ws) =>
        deleteDashboard(root, ws, args.positionals[0]!),
      );
    },
  },
  'ha render-template': {
    spec: {
      prog: 'ha_agent_lab ha render-template',
      usage: 'usage: ha_agent_lab ha render-template [-h] template',
      positionals: ['template'],
      flags: {},
    },
    help: `    render-template     Render a Jinja2 template against live state
                        (POST /api/template). Not gated (read-only against
                        HA's template engine).`,
    run: async (args, { config, root, deps }) => {
      const source = args.positionals[0]!;
      if (source !== '-' && !existsSync(resolve(source))) {
        return printError(`template_not_found:${source}`);
      }
      try {
        const client = await deps.createClient(config);
        const template = source === '-' ? await Bun.stdin.text() : readFileSync(resolve(source), 'utf8');
        const rendered = await client.postText('/api/template', { template });
        console.log(jsonDumps({ rendered }, { ensureAscii: false }));
        return 0;
      } catch (exc) {
        if (!(exc instanceof HomeAssistantError)) throw exc;
        return printHaError(exc);
      }
    },
  },
  'ha check-config': {
    spec: {
      prog: 'ha_agent_lab ha check-config',
      usage: 'usage: ha_agent_lab ha check-config [-h]',
      positionals: [],
      flags: {},
    },
    help: `    check-config        Validate the HA configuration
                        (POST /api/config/core/check_config). Not gated.`,
    run: async (args, { config, root, deps }) => {
      try {
        const client = await deps.createClient(config);
        const result = await client.post('/api/config/core/check_config');
        console.log(jsonDumps(result, { ensureAscii: false }));
        return 0;
      } catch (exc) {
        if (!(exc instanceof HomeAssistantError)) throw exc;
        return printHaError(exc);
      }
    },
  },
  'ha call-service': {
    spec: {
      prog: 'ha_agent_lab ha call-service',
      usage: 'usage: ha_agent_lab ha call-service [-h] [--data DATA] domain.service',
      positionals: ['domain.service'],
      flags: { '--data': { kind: 'value' } },
    },
    help: `    call-service        Call any HA service (POST /api/services/...).
                        Sensitive domains/entities gated by ha_safety_mode;
                        non-sensitive calls proceed in both modes.`,
    run: async (args, { config, root, deps }) => {
      return handleCallService(
        args.positionals[0]!,
        args.flags['--data'] as string | undefined,
        root,
        config,
        deps,
      );
    },
  },
  'ha set-core-config': {
    spec: {
      prog: 'ha_agent_lab ha set-core-config',
      usage:
        'usage: ha_agent_lab ha set-core-config [-h] [--latitude LATITUDE]\n' +
        '                                       [--longitude LONGITUDE]\n' +
        '                                       [--elevation ELEVATION]\n' +
        '                                       [--unit-system {metric,us_customary}]\n' +
        '                                       [--currency CURRENCY]\n' +
        '                                       [--time-zone TIME_ZONE] [--country COUNTRY]',
      positionals: [],
      flags: {
        '--latitude': { kind: 'value' },
        '--longitude': { kind: 'value' },
        '--elevation': { kind: 'value', int: true },
        '--unit-system': { kind: 'value', choices: ['metric', 'us_customary'] },
        '--currency': { kind: 'value' },
        '--time-zone': { kind: 'value' },
        '--country': { kind: 'value' },
      },
    },
    help: `    set-core-config     Partial update of location/unit system/currency/
                        timezone/country via WebSocket (gated write).`,
    run: async (args, { config, root, deps }) => {
      const fields: Record<string, unknown> = {};
      // Reject a non-numeric latitude/longitude up front: Number('40,7') is NaN,
      // which JSON.stringify serializes as null, silently blanking the stored
      // coordinate instead of erroring.
      for (const [flag, key] of [
        ['--latitude', 'latitude'],
        ['--longitude', 'longitude'],
      ] as const) {
        const raw = args.flags[flag];
        if (raw === undefined) continue;
        const num = Number(raw);
        if (!Number.isFinite(num)) {
          return printError(`usage:${flag} must be a number, got: '${raw}'`);
        }
        fields[key] = num;
      }
      const setIfPresent = (flag: string, key: string) => {
        const value = args.flags[flag];
        if (value !== undefined) fields[key] = value;
      };
      setIfPresent('--elevation', 'elevation');
      setIfPresent('--unit-system', 'unit_system');
      setIfPresent('--currency', 'currency');
      setIfPresent('--time-zone', 'time_zone');
      setIfPresent('--country', 'country');

      if (Object.keys(fields).length === 0) {
        return printError('usage:at least one config field flag is required');
      }
      return runWsMutation(deps, config, root, (ws) =>
        setCoreConfig(root, ws, fields),
      );
    },
  },
  'ha error-log': {
    spec: {
      prog: 'ha_agent_lab ha error-log',
      usage: 'usage: ha_agent_lab ha error-log [-h]',
      positionals: [],
      flags: {},
    },
    help: `    error-log           Print the current-session HA error log
                        (GET /api/error_log, plaintext).`,
    run: async (args, { config, root, deps }) => {
      try {
        const client = await deps.createClient(config);
        console.log(jsonDumps({ log: await client.getText('/api/error_log') }, { ensureAscii: false }));
        return 0;
      } catch (exc) {
        if (!(exc instanceof HomeAssistantError)) throw exc;
        return printHaError(exc);
      }
    },
  },
  'ha logbook': {
    spec: {
      prog: 'ha_agent_lab ha logbook',
      usage:
        'usage: ha_agent_lab ha logbook [-h] [--window-days WINDOW_DAYS]\n' +
        '                               [--entity ENTITY]',
      positionals: [],
      flags: { '--window-days': { kind: 'value', int: true }, '--entity': { kind: 'value' } },
    },
    help: `    logbook             Fetch the HA logbook (GET /api/logbook/<ts>).`,
    run: async (args, { config, root, deps }) => {
      try {
        const client = await deps.createClient(config);
        const windowDays = (args.flags['--window-days'] as number | undefined) ?? 1;
        const windowStart = daysAgo(windowDays);
        const entity = args.flags['--entity'] as string | undefined;
        const path = `/api/logbook/${encodeURIComponent(isoUtc(windowStart))}${entity ? `?entity=${encodeURIComponent(entity)}` : ''}`;
        const entries = await client.get(path);
        console.log(jsonDumps({ entries }, { ensureAscii: false }));
        return 0;
      } catch (exc) {
        if (!(exc instanceof HomeAssistantError)) throw exc;
        return printHaError(exc);
      }
    },
  },
  'ha system-log': {
    spec: {
      prog: 'ha_agent_lab ha system-log',
      usage: 'usage: ha_agent_lab ha system-log [-h]',
      positionals: [],
      flags: {},
    },
    help: `    system-log          List structured system log entries, with levels,
                        via WebSocket (system_log/list).`,
    run: async (args, { config, root, deps }) => {
      return runWsRead(deps, config, listSystemLog);
    },
  },
  'ha list-floors': {
    spec: {
      prog: 'ha_agent_lab ha list-floors',
      usage: 'usage: ha_agent_lab ha list-floors [-h]',
      positionals: [],
      flags: {},
    },
    help: `    list-floors         List floors via WebSocket.`,
    run: async (args, { config, root, deps }) => {
      return runWsRead(deps, config, listFloors);
    },
  },
  'ha create-floor': {
    spec: {
      prog: 'ha_agent_lab ha create-floor',
      usage: 'usage: ha_agent_lab ha create-floor [-h] name',
      positionals: ['name'],
      flags: {},
    },
    help: `    create-floor        Create a floor by name via WebSocket (gated write).`,
    run: async (args, { config, root, deps }) => {
      return runWsMutation(deps, config, root, (ws) =>
        createFloor(root, ws, args.positionals[0]!),
      );
    },
  },
  'ha delete-floor': {
    spec: {
      prog: 'ha_agent_lab ha delete-floor',
      usage: 'usage: ha_agent_lab ha delete-floor [-h] id',
      positionals: ['id'],
      flags: {},
    },
    help: `    delete-floor        Delete a floor by id via WebSocket (gated write).`,
    run: async (args, { config, root, deps }) => {
      return runWsMutation(deps, config, root, (ws) =>
        deleteFloor(root, ws, args.positionals[0]!),
      );
    },
  },
  'ha list-labels': {
    spec: {
      prog: 'ha_agent_lab ha list-labels',
      usage: 'usage: ha_agent_lab ha list-labels [-h]',
      positionals: [],
      flags: {},
    },
    help: `    list-labels         List labels via WebSocket.`,
    run: async (args, { config, root, deps }) => {
      return runWsRead(deps, config, listLabels);
    },
  },
  'ha create-label': {
    spec: {
      prog: 'ha_agent_lab ha create-label',
      usage: 'usage: ha_agent_lab ha create-label [-h] name',
      positionals: ['name'],
      flags: {},
    },
    help: `    create-label        Create a label by name via WebSocket (gated write).`,
    run: async (args, { config, root, deps }) => {
      return runWsMutation(deps, config, root, (ws) =>
        createLabel(root, ws, args.positionals[0]!),
      );
    },
  },
  'ha delete-label': {
    spec: {
      prog: 'ha_agent_lab ha delete-label',
      usage: 'usage: ha_agent_lab ha delete-label [-h] id',
      positionals: ['id'],
      flags: {},
    },
    help: `    delete-label        Delete a label by id via WebSocket (gated write).`,
    run: async (args, { config, root, deps }) => {
      return runWsMutation(deps, config, root, (ws) =>
        deleteLabel(root, ws, args.positionals[0]!),
      );
    },
  },
  'ha rename-area': {
    spec: {
      prog: 'ha_agent_lab ha rename-area',
      usage: 'usage: ha_agent_lab ha rename-area [-h] --name NAME area_id',
      positionals: ['area_id'],
      flags: { '--name': { kind: 'value' } },
    },
    help: `    rename-area         Set an area's friendly name (gated write).`,
    run: async (args, { config, root, deps }) => {
      const name = requireFlag(args.flags['--name'], '--name');
      if (name === null) return 1;
      return runWsMutation(deps, config, root, (ws) =>
        updateArea(root, ws, args.positionals[0]!, { name }, 'rename-area'),
      );
    },
  },
  'ha set-area-icon': {
    spec: {
      prog: 'ha_agent_lab ha set-area-icon',
      usage: 'usage: ha_agent_lab ha set-area-icon [-h] --icon ICON area_id',
      positionals: ['area_id'],
      flags: { '--icon': { kind: 'value' } },
    },
    help: `    set-area-icon       Set an area's icon (gated write).`,
    run: async (args, { config, root, deps }) => {
      const icon = requireFlag(args.flags['--icon'], '--icon');
      if (icon === null) return 1;
      return runWsMutation(deps, config, root, (ws) =>
        updateArea(root, ws, args.positionals[0]!, { icon }, 'set-area-icon'),
      );
    },
  },
  'ha set-area-floor': {
    spec: {
      prog: 'ha_agent_lab ha set-area-floor',
      usage: 'usage: ha_agent_lab ha set-area-floor [-h] --floor FLOOR area_id',
      positionals: ['area_id'],
      flags: { '--floor': { kind: 'value' } },
    },
    help: `    set-area-floor      Assign an area to a floor (gated write).`,
    run: async (args, { config, root, deps }) => {
      const floor = requireFlag(args.flags['--floor'], '--floor');
      if (floor === null) return 1;
      return runWsMutation(deps, config, root, (ws) =>
        updateArea(root, ws, args.positionals[0]!, { floor_id: floor }, 'set-area-floor'),
      );
    },
  },
  'ha set-area-labels': {
    spec: {
      prog: 'ha_agent_lab ha set-area-labels',
      usage: 'usage: ha_agent_lab ha set-area-labels [-h] --labels LABEL [LABEL ...] area_id',
      positionals: ['area_id'],
      flags: { '--labels': { kind: 'plus' } },
    },
    help: `    set-area-labels     Set an area's labels (gated write).`,
    run: async (args, { config, root, deps }) => {
      const labels = requirePlusFlag(args.flags['--labels'], '--labels');
      if (labels === null) return 1;
      return runWsMutation(deps, config, root, (ws) =>
        updateArea(root, ws, args.positionals[0]!, { labels }, 'set-area-labels'),
      );
    },
  },
  'ha list-exposed-entities': {
    spec: {
      prog: 'ha_agent_lab ha list-exposed-entities',
      usage: 'usage: ha_agent_lab ha list-exposed-entities [-h]',
      positionals: [],
      flags: {},
    },
    help: `    list-exposed-entities
                        List entities exposed to each Assist assistant via
                        WebSocket.`,
    run: async (args, { config, root, deps }) => {
      return runWsRead(deps, config, listExposedEntities);
    },
  },
  'ha expose-entity': {
    spec: {
      prog: 'ha_agent_lab ha expose-entity',
      usage:
        'usage: ha_agent_lab ha expose-entity [-h] --entity-ids ENTITY [ENTITY ...]\n' +
        '                                     --assistants ASSISTANT [ASSISTANT ...]\n' +
        '                                     --expose {true,false}',
      positionals: [],
      flags: {
        '--entity-ids': { kind: 'plus' },
        '--assistants': { kind: 'plus' },
        '--expose': { kind: 'value', choices: ['true', 'false'] },
      },
    },
    help: `    expose-entity       Expose/unexpose entities to one or more Assist
                        assistants (gated write). Sets HA's expose-to-
                        Assist boundary; config, not control (see
                        SAFETY.md's Assist Control section).`,
    run: async (args, { config, root, deps }) => {
      const entityIds = requirePlusFlag(args.flags['--entity-ids'], '--entity-ids');
      if (entityIds === null) return 1;
      const assistants = requirePlusFlag(args.flags['--assistants'], '--assistants');
      if (assistants === null) return 1;
      const expose = requireFlag(args.flags['--expose'], '--expose');
      if (expose === null) return 1;
      return runWsMutation(deps, config, root, (ws) =>
        exposeEntity(root, ws, entityIds, assistants, expose === 'true'),
      );
    },
  },
  'ha list-backups': {
    spec: {
      prog: 'ha_agent_lab ha list-backups',
      usage: 'usage: ha_agent_lab ha list-backups [-h]',
      positionals: [],
      flags: {},
    },
    help: `    list-backups        List backups via WebSocket (backup/info).`,
    run: async (args, { config, root, deps }) => {
      return runWsRead(deps, config, listBackups);
    },
  },
  'ha create-backup': {
    spec: {
      prog: 'ha_agent_lab ha create-backup',
      usage:
        'usage: ha_agent_lab ha create-backup [-h] --agent-ids AGENT [AGENT ...]\n' +
        '                                     [--name NAME] [--password PASSWORD]\n' +
        '                                     [--include-addons SLUG [SLUG ...]]\n' +
        '                                     [--include-all-addons]\n' +
        '                                     [--include-database {true,false}]\n' +
        '                                     [--include-folders FOLDER [FOLDER ...]]\n' +
        '                                     [--include-homeassistant {true,false}]',
      positionals: [],
      flags: {
        '--agent-ids': { kind: 'plus' },
        '--name': { kind: 'value' },
        '--password': { kind: 'value' },
        '--include-addons': { kind: 'plus' },
        '--include-all-addons': { kind: 'store_true' },
        '--include-database': { kind: 'value', choices: ['true', 'false'] },
        '--include-folders': { kind: 'plus' },
        '--include-homeassistant': { kind: 'value', choices: ['true', 'false'] },
      },
    },
    help: `    create-backup       Generate a backup via WebSocket (backup/generate,
                        gated write).`,
    run: async (args, { config, root, deps }) => {
      const agentIds = requirePlusFlag(args.flags['--agent-ids'], '--agent-ids');
      if (agentIds === null) return 1;
      const fields: Record<string, unknown> = { agent_ids: agentIds };
      const setIfPresent = (flag: string, key: string, transform: (v: unknown) => unknown = (v) => v) => {
        const value = args.flags[flag];
        if (value !== undefined) fields[key] = transform(value);
      };
      setIfPresent('--name', 'name');
      setIfPresent('--password', 'password');
      setIfPresent('--include-addons', 'include_addons');
      setIfPresent('--include-all-addons', 'include_all_addons');
      setIfPresent('--include-database', 'include_database', (v) => v === 'true');
      setIfPresent('--include-folders', 'include_folders');
      setIfPresent('--include-homeassistant', 'include_homeassistant', (v) => v === 'true');

      return runWsMutation(deps, config, root, (ws) =>
        createBackup(root, ws, fields),
      );
    },
  },
  'ha list-blueprints': {
    spec: {
      prog: 'ha_agent_lab ha list-blueprints',
      usage: 'usage: ha_agent_lab ha list-blueprints [-h] domain',
      positionals: ['domain'],
      flags: {},
    },
    help: `    list-blueprints     List blueprints for a domain via WebSocket
                        (blueprint/list).`,
    run: async (args, { config, root, deps }) => {
      return runWsRead(deps, config, (ws) => listBlueprints(ws, args.positionals[0]!));
    },
  },
  'ha import-blueprint': {
    spec: {
      prog: 'ha_agent_lab ha import-blueprint',
      usage: 'usage: ha_agent_lab ha import-blueprint [-h] domain url',
      positionals: ['domain', 'url'],
      flags: {},
    },
    help: `    import-blueprint    Import a blueprint from a URL and save it under a
                        domain via WebSocket (gated write).`,
    run: async (args, { config, root, deps }) => {
      return runWsMutation(deps, config, root, (ws) =>
        importBlueprint(root, ws, args.positionals[0]!, args.positionals[1]!),
      );
    },
  },
  'ha get-energy-prefs': {
    spec: {
      prog: 'ha_agent_lab ha get-energy-prefs',
      usage: 'usage: ha_agent_lab ha get-energy-prefs [-h]',
      positionals: [],
      flags: {},
    },
    help: `    get-energy-prefs    Read energy dashboard preferences via WebSocket
                        (energy/get_prefs).`,
    run: async (args, { config, root, deps }) => {
      return runWsRead(deps, config, getEnergyPrefs);
    },
  },
  'ha set-energy-prefs': {
    spec: {
      prog: 'ha_agent_lab ha set-energy-prefs',
      usage: 'usage: ha_agent_lab ha set-energy-prefs [-h] json',
      positionals: ['json'],
      flags: {},
    },
    help: `    set-energy-prefs    Replace energy dashboard preferences from JSON via
                        WebSocket (energy/save_prefs, gated write).`,
    run: async (args, { config, root, deps }) => {
      const parsed = parseJsonObject(args.positionals[0]!);
      if (!parsed.ok) {
        return printError(`usage:energy prefs JSON ${parsed.message}`);
      }
      return runWsMutation(deps, config, root, (ws) =>
        setEnergyPrefs(root, ws, parsed.payload),
      );
    },
  },
  'ha reload-entry': {
    spec: {
      prog: 'ha_agent_lab ha reload-entry',
      usage: 'usage: ha_agent_lab ha reload-entry [-h] entry_id',
      positionals: ['entry_id'],
      flags: {},
    },
    help: `    reload-entry        Reload a config entry (REST, gated write).`,
    run: async (args, { config, root, deps }) => {
      return handleReloadEntry(args.positionals[0]!, root, config, deps);
    },
  },
  'ha disable-entry': {
    spec: {
      prog: 'ha_agent_lab ha disable-entry',
      usage: 'usage: ha_agent_lab ha disable-entry [-h] --disabled {true,false} entry_id',
      positionals: ['entry_id'],
      flags: { '--disabled': { kind: 'value', choices: ['true', 'false'] } },
    },
    help: `    disable-entry       Enable/disable a config entry via WebSocket
                        (config_entries/disable, gated write).`,
    run: async (args, { config, root, deps }) => {
      const disabled = requireFlag(args.flags['--disabled'], '--disabled');
      if (disabled === null) return 1;
      return runWsMutation(deps, config, root, (ws) =>
        disableConfigEntry(root, ws, args.positionals[0]!, disabled === 'true'),
      );
    },
  },
  'ha trigger-automation': {
    spec: {
      prog: 'ha_agent_lab ha trigger-automation',
      usage: 'usage: ha_agent_lab ha trigger-automation [-h] automation_id',
      positionals: ['automation_id'],
      flags: {},
    },
    help: `    trigger-automation  Fire an automation by entity_id via automation.trigger.`,
    run: async (args, { config, root, deps }) => {
      return handleTriggerAutomation(args.positionals[0]!, config, deps);
    },
  },
};

export const HA_COMMANDS = Object.keys(COMMANDS)
  .filter((key) => key.startsWith('ha '))
  .map((key) => key.slice(3));

const BOOT_COMMANDS = Object.keys(COMMANDS)
  .filter((key) => key.startsWith('boot '))
  .map((key) => key.slice(5));

const HA_USAGE = [
  'usage: ha_agent_lab ha [-h]',
  `                       {${HA_COMMANDS.join(',')}}`,
  '                       ...',
].join('\n');

const TOP_HELP = `${TOP_USAGE}

positional arguments:
  {boot,ha}

options:
  -h, --help  show this help message and exit`;

const BOOT_HELP = `${BOOT_USAGE}

positional arguments:
  {status,store,mcp-config}

options:
  -h, --help            show this help message and exit`;

// argparse only described the commands that carry a help block; the four
// oldest ha commands never had one, and their records leave `help` empty.
const HA_HELP = `${HA_USAGE}

positional arguments:
  {${HA_COMMANDS.join(',')}}
${HA_COMMANDS.map((cmd) => COMMANDS[`ha ${cmd}`].help)
  .filter(Boolean)
  .join('\n')}

options:
  -h, --help            show this help message and exit`;

interface ParsedArgs {
  command: 'boot' | 'ha';
  sub: string;
  positionals: string[];
  flags: Record<string, unknown>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv[0] === '-h' || argv[0] === '--help') printHelp(TOP_HELP);
  if (argv.length === 0) {
    argError('ha_agent_lab', 'the following arguments are required: command');
  }
  const command = argv[0]!;
  if (command !== 'boot' && command !== 'ha') {
    argError(
      'ha_agent_lab',
      `argument command: invalid choice: '${command}' (choose from 'boot', 'ha')`,
    );
  }

  const rest = argv.slice(1);
  if (rest[0] === '-h' || rest[0] === '--help') {
    printHelp(command === 'boot' ? BOOT_HELP : HA_HELP);
  }
  const subProg = `ha_agent_lab ${command}`;
  const subDest = command === 'boot' ? 'boot_command' : 'ha_command';
  if (rest.length === 0) {
    argError(subProg, `the following arguments are required: ${subDest}`);
  }
  const sub = rest[0]!;
  const validSubs = command === 'boot' ? BOOT_COMMANDS : HA_COMMANDS;
  const record = COMMANDS[`${command} ${sub}`];
  if (!record) {
    const choices = validSubs.map((c) => `'${c}'`).join(', ');
    argError(subProg, `argument ${subDest}: invalid choice: '${sub}' (choose from ${choices})`);
  }

  const leaf = parseLeaf(record.spec, rest.slice(1));
  rejectExtras(leaf.extras);
  return { command: command as 'boot' | 'ha', sub, positionals: leaf.positionals, flags: leaf.flags };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/** Shared body for `audit-automations` / `audit-scripts`. */
async function handleAudit(
  domain: 'automation' | 'script',
  root: string,
  config: AppConfig,
  deps: CliDeps,
): Promise<number> {
  try {
    const client = await deps.createClient(config);
    const summary =
      domain === 'automation'
        ? await auditAutomations(root, client)
        : await auditScripts(root, client);
    return printFindings(safetyAuditFindings(summary, domain));
  } catch (exc) {
    if (!(exc instanceof HomeAssistantError)) throw exc;
    return printHaError(exc);
  }
}

/** Shared body for `list-automations` / `list-scripts` / `list-scenes`. */
async function handleListDomain(
  domain: 'automation' | 'script' | 'scene',
  config: AppConfig,
  deps: CliDeps,
): Promise<number> {
  try {
    const client = await deps.createClient(config);
    const items = await listDomain(client, domain);
    console.log(jsonDumps({ [`${domain}s`]: items }, { ensureAscii: false }));
    return 0;
  } catch (exc) {
    if (!(exc instanceof HomeAssistantError)) throw exc;
    return printHaError(exc);
  }
}

/** HA's message for a config id it does not have (a 400, not a 404). */
const RESOURCE_NOT_FOUND = 'Resource not found';

/** Shared body for `delete-automation` / `delete-script` / `delete-scene`. */
async function handleDeleteConfig(
  domain: 'automation' | 'script' | 'scene',
  configId: string,
  root: string,
  config: AppConfig,
  deps: CliDeps,
): Promise<number> {
  try {
    const client = await deps.createClient(config);
    const result = await removeConfig(root, client, domain, configId);
    if (result.ok) {
      console.log('OK');
      return 0;
    }
    if (result.message === RESOURCE_NOT_FOUND) return printNotFound(result.configId);
    return printError(`delete_failed:${result.message}`);
  } catch (exc) {
    if (!(exc instanceof HomeAssistantError)) throw exc;
    return printHaError(exc);
  }
}

/** Shared body for `get-automation-config` / `get-script-config` / `get-scene-config`. */
async function handleReadConfig(
  domain: 'automation' | 'script' | 'scene',
  configId: string,
  config: AppConfig,
  deps: CliDeps,
): Promise<number> {
  try {
    const client = await deps.createClient(config);
    const result = await readConfig(client, domain, configId);
    if (result.message === RESOURCE_NOT_FOUND) return printNotFound(result.configId);
    if (!result.ok) return printError(`read_failed:${result.message}`);
    console.log(
      jsonDumps(
        {
          domain: result.domain,
          config_id: result.configId,
          config: result.config,
        },
        { ensureAscii: false },
      ),
    );
    return 0;
  } catch (exc) {
    if (!(exc instanceof HomeAssistantError)) throw exc;
    return printHaError(exc);
  }
}

export async function main(argv: string[], overrides: Partial<CliDeps> = {}): Promise<number> {
  const deps = resolveDeps(overrides);

  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (exc) {
    if (exc instanceof ParserExit) return exc.error === undefined ? exc.code : printError(exc.error);
    throw exc;
  }

  const config = deps.loadConfig(projectRoot());
  const root = config.root;

  const record = COMMANDS[`${args.command} ${args.sub}`];
  if (!record) {
    // Unreachable: parseArgs rejects any key this table does not carry.
    return printError('usage:ha_agent_lab: unsupported command');
  }
  return record.run(args, { config, root, deps });
}

/** A value flag the handler needs but argparse treats as optional. Prints and returns null when absent. */
function requireFlag(value: unknown, name: string): string | null {
  if (typeof value === 'string') return value;
  printError(`usage:${name} is required`);
  return null;
}

/** A plus (nargs='+') flag the handler needs but argparse treats as optional. Prints and returns null when absent. */
function requirePlusFlag(value: unknown, name: string): string[] | null {
  if (Array.isArray(value)) return value as string[];
  printError(`usage:${name} is required`);
  return null;
}

/** Acquire a WS client, run a read, print {data[,unavailable]} or {error}, then close. */
async function runWsRead(
  deps: CliDeps,
  config: AppConfig,
  run: (ws: WsCommandClient) => Promise<WsReadResult>,
): Promise<number> {
  let ws: WsCommandClient;
  try {
    ws = await deps.createWsClient(config);
  } catch (exc) {
    if (!(exc instanceof HomeAssistantError)) throw exc;
    return printHaError(exc);
  }
  try {
    const result = await run(ws);
    if (!result.ok) return printError(result.error);
    const payload: Record<string, unknown> = { data: result.data };
    if (result.unavailable) payload.unavailable = result.unavailable;
    console.log(jsonDumps(payload, { ensureAscii: false }));
    return 0;
  } catch (exc) {
    if (!(exc instanceof HomeAssistantError)) throw exc;
    return printHaError(exc, 'ha_command_failed');
  } finally {
    ws.close();
  }
}

/**
 * Apply the safety gate *before* opening a connection. If blocked, print the
 * verdict and return without touching the network. Otherwise connect, run the
 * mutation, print, and close.
 */
async function runWsMutation(
  deps: CliDeps,
  config: AppConfig,
  root: string,
  run: (ws: WsCommandClient) => Promise<WsMutationResult>,
): Promise<number> {
  const gate = gateStructuralMutation(root);
  if (gate.decision === 'deny') return printBlocked(gate);

  let ws: WsCommandClient;
  try {
    ws = await deps.createWsClient(config);
  } catch (exc) {
    if (!(exc instanceof HomeAssistantError)) throw exc;
    return printHaError(exc);
  }
  try {
    const r = await run(ws);
    if (!r.ok) return printError(r.error);
    console.log(
      jsonDumps(
        { data: r.data, report_path: r.reportPath ? relative(root, r.reportPath) : null },
        { ensureAscii: false },
      ),
    );
    return 0;
  } catch (exc) {
    if (!(exc instanceof HomeAssistantError)) throw exc;
    return printHaError(exc, 'ha_command_failed');
  } finally {
    ws.close();
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleFetchHistory(
  root: string,
  config: AppConfig,
  deps: CliDeps,
  windowDays: number,
  entityOverride: string[] | null,
  includeTransitions: boolean,
): Promise<number> {
  let client: CliClient;
  try {
    client = await deps.createClient(config);
  } catch (exc) {
    if (!(exc instanceof HomeAssistantError)) throw exc;
    return printHaError(exc);
  }

  const snapshotPath = normalizedContextPath(root);
  if (!existsSync(snapshotPath)) {
    try {
      await deps.refreshContext(root, client);
    } catch (exc) {
      if (!(exc instanceof HomeAssistantError)) throw exc;
      return printHaError(exc);
    }
  }

  let payload: Record<string, any>;
  try {
    const normalized = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    payload = await fetchHistorySnapshot(root, client, normalized, {
      windowDays,
      entityOverride,
      includeTransitions,
    });
  } catch (exc: any) {
    // Python catches (HomeAssistantError, OSError, json.JSONDecodeError).
    if (exc instanceof HomeAssistantError) return printHaError(exc);
    return printError(`history_failed:${String(exc?.message ?? exc)}`);
  }

  console.log(
    jsonDumpsCompact({
      entities: payload.requested_entities.length,
      events: payload.event_total,
      window_days: windowDays,
    }),
  );
  return 0;
}

export async function handleIntegrationHealth(
  root: string,
  config: AppConfig,
  overrides: Partial<CliDeps> = {},
): Promise<number> {
  const deps = resolveDeps(overrides);
  const today = todayIso();
  const snapshotPath = normalizedContextPath(root);

  let stale = false;
  try {
    const mtimeMs = statSync(snapshotPath).mtimeMs;
    stale = Date.now() - mtimeMs > 24 * 3600 * 1000;
  } catch {
    stale = true;
  }

  if (stale) {
    try {
      const client = await deps.createClient(config);
      await deps.refreshContext(root, client);
    } catch (exc: any) {
      return printSkipped(today, 'refresh_failed', exc);
    }
  }

  let normalized: Record<string, any>;
  try {
    normalized = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  } catch (exc: any) {
    return printSkipped(today, 'snapshot_unreadable', exc);
  }

  const payload = computeDegradedDomains(normalized);
  writeDegradedDomainsArtifact(root, payload);
  const degraded = (payload.degraded_entity_domains as Array<Record<string, any>>).map((entry) => ({
    domain: entry.domain,
    unavailable: entry.unavailable,
    total: entry.total,
    // round(ratio * 100, 1)
    percent: Math.round(entry.ratio * 1000) / 10,
  }));
  return printFindings({ date: today, scanned_domains: payload.scanned_domains, degraded });
}

export async function handleUpdates(
  config: AppConfig,
  overrides: Partial<CliDeps> = {},
  digest = false,
): Promise<number> {
  const deps = resolveDeps(overrides);
  const today = todayIso();
  let states: Array<Record<string, any>>;
  try {
    const client = await deps.createClient(config);
    states = await client.getStates();
  } catch (exc: any) {
    const reason = exc instanceof HomeAssistantError && exc.statusCode !== null ? `ha_http_${exc.statusCode}` : 'ha_unreachable';
    return printSkipped(today, reason, exc);
  }
  const pending = collectPendingUpdates(states);
  const view = digest ? digestUpdates(pending) : listUpdates(pending);
  const updates = view.updates.map((u) => ({
    tier: u.tier,
    title: u.title,
    installed_version: u.installed_version,
    latest_version: u.latest_version,
    ...(digest ? {} : { release_url: u.release_url }),
  }));
  const payload: Record<string, unknown> = { date: today, total: pending.length, updates, hacs_pending: view.hacs };
  if (digest) payload.more = view.more;
  return printFindings(payload);
}

async function listDomain(client: CliClient, domain: string): Promise<Array<Record<string, any>>> {
  const states = await client.get('/api/states');
  const prefix = `${domain}.`;
  const items: Array<Record<string, any>> = [];
  for (const s of states) {
    if (!(s !== null && typeof s === 'object' && String(s.entity_id ?? '').startsWith(prefix))) {
      continue;
    }
    const attrs = s.attributes || {};
    const configId = attrs.id;
    items.push({
      entity_id: s.entity_id,
      id: configId ?? null,
      friendly_name: attrs.friendly_name ?? null,
      state: s.state ?? null,
      last_changed: s.last_changed ?? null,
      deletable: configId !== null && configId !== undefined,
    });
  }
  items.sort((a, b) => (a.entity_id < b.entity_id ? -1 : a.entity_id > b.entity_id ? 1 : 0));
  return items;
}

function safetyAuditFindings(summary: Record<string, any>, domain = 'automation'): Record<string, unknown> {
  const violations: Array<Record<string, any>> = summary.violations ?? [];
  return {
    date: todayIso(),
    domain,
    scanned: summary[`total_${domain}s`] ?? 0,
    passed: summary.passed ?? 0,
    violations: violations.map((v) => ({ alias: v.alias, id: v.id, reasons: v.reasons ?? [] })),
    acknowledged: (summary.acknowledged ?? []).length,
    unmanaged: (summary.unmanaged ?? []).length,
    fetch_failures: (summary.fetch_failures ?? []).length,
  };
}

interface GatedRestReportSpec {
  type: string;
  title: string;
  idKey: string;
}
const CALL_SERVICE_REPORT: GatedRestReportSpec = {
  type: 'call-service',
  title: 'Call-Service Report',
  idKey: 'domain_service',
};
const RELOAD_ENTRY_REPORT: GatedRestReportSpec = {
  type: 'reload-entry',
  title: 'Reload-Entry Report',
  idKey: 'entry_id',
};

/** Every gated REST write that actually reaches HA writes an audit report — matches restoreStates. */
function writeGatedRestReport(root: string, spec: GatedRestReportSpec, id: string, data: unknown): string {
  const tag = `ha-${spec.type}`;
  const prefix = `audit-${tag}`;
  const metadata = standardMetadata(spec.type, `${spec.title} — ${id}`, {
    session: currentSessionId(root),
    tags: [tag],
    extra: { [spec.idKey]: id, data },
  });
  const body = [`# ${spec.title} for \`${id}\``, '', `- data: ${JSON.stringify(data)}`].join('\n');
  return writeMarkdownArtifact(
    root,
    '.hermit/raw',
    `${prefix}-${slugify(id)}`,
    metadata,
    body,
    `${prefix}-latest.md`,
  );
}

/**
 * Shared driver for the two REST-based gated writes (call-service, reload-entry):
 * emit the blocked status if the gate refuses, otherwise run the call, write an
 * audit report, and emit {data,report_path} or {error}: mirrors runWsMutation
 * for the WS path.
 */
async function runGatedRestWrite(
  deps: CliDeps,
  config: AppConfig,
  root: string,
  gate: MutationGate,
  doCall: (client: CliClient) => Promise<unknown>,
  writeReport: (result: unknown) => string,
): Promise<number> {
  if (gate.decision === 'deny') return printBlocked(gate);
  try {
    const client = await deps.createClient(config);
    const result = await doCall(client);
    const reportPath = writeReport(result);
    console.log(
      jsonDumps({ data: result, report_path: relative(root, reportPath) }, { ensureAscii: false }),
    );
    return 0;
  } catch (exc) {
    if (!(exc instanceof HomeAssistantError)) throw exc;
    return printHaError(exc);
  }
}

async function handleCallService(
  target: string,
  rawData: string | undefined,
  root: string,
  config: AppConfig,
  deps: CliDeps,
): Promise<number> {
  const dot = target.indexOf('.');
  if (dot === -1) {
    return printError(`usage:domain.service must contain a '.', got: '${target}'`);
  }
  const domain = target.slice(0, dot);
  const service = target.slice(dot + 1);

  let data: Record<string, unknown> = {};
  if (rawData !== undefined) {
    const parsedData = parseJsonObject(rawData);
    if (!parsedData.ok) {
      return printError(`usage:--data ${parsedData.message}`);
    }
    data = parsedData.payload;
  }

  const gate = gateServiceCall(root, domain, service, data);
  return runGatedRestWrite(
    deps,
    config,
    root,
    gate,
    (client) => client.callService(domain, service, data),
    () => writeGatedRestReport(root, CALL_SERVICE_REPORT, target, data),
  );
}

async function handleReloadEntry(
  entryId: string,
  root: string,
  config: AppConfig,
  deps: CliDeps,
): Promise<number> {
  const gate = gateStructuralMutation(root);
  return runGatedRestWrite(
    deps,
    config,
    root,
    gate,
    (client) => client.post(`/api/config/config_entries/entry/${entryId}/reload`),
    (result) => writeGatedRestReport(root, RELOAD_ENTRY_REPORT, entryId, result),
  );
}

async function handleTriggerAutomation(
  automationId: string,
  config: AppConfig,
  deps: CliDeps,
): Promise<number> {
  if (!automationId.startsWith('automation.')) {
    return printError(`usage:automation_id must start with 'automation.', got: '${automationId}'`);
  }
  try {
    const client = await deps.createClient(config);
    await client.callService('automation', 'trigger', { entity_id: automationId });
    console.log('OK');
    return 0;
  } catch (exc) {
    if (!(exc instanceof HomeAssistantError)) throw exc;
    return printHaError(exc);
  }
}

function handlePolicyCheck(target: string, root: string): number {
  if (existsSync(target) && (target.endsWith('.yaml') || target.endsWith('.yml'))) {
    const [entities, services, decision] = evaluateYamlPolicy(target, root);
    console.log(
      jsonDumps({
        file: target,
        decision: decision.decision,
        entities,
        services,
        reasons: decision.reasons,
      }),
    );
    return 0;
  }
  console.log(jsonDumps(checkEntity(target)));
  return 0;
}

// ---------------------------------------------------------------------------
// Context refresh
// ---------------------------------------------------------------------------

export async function refreshContext(root: string, client: CliClient): Promise<Record<string, any>> {
  const paths = ['/api/', '/api/config', '/api/components', '/api/services', '/api/states'];
  const [apiRoot, config, components, services, states] = await Promise.all(
    paths.map((path) => client.get(path)),
  );

  const snapshot = {
    api: apiRoot,
    config,
    components,
    services,
    states,
  };
  writeJsonArtifact(root, '.hermit/raw', 'snapshot-ha-context', snapshot, 'snapshot-ha-context-latest.json');

  const normalized = normalizeContext(states, services, components);
  normalized.silence_summary = computeSilenceSummary(normalized, root);
  writeJsonArtifact(root, '.hermit/raw', 'snapshot-ha-normalized', normalized, 'snapshot-ha-normalized-latest.json');
  writeMarkdownArtifact(
    root,
    '.hermit/raw',
    'audit-ha-context-refresh',
    standardMetadata('audit', 'HA Context Refresh', {
      session: currentSessionId(root),
      tags: ['ha-context', 'refresh'],
      extra: {
        source: 'routine',
        entity_count: Object.keys(normalized.entity_index).length,
        service_domain_count: Object.keys(normalized.service_index).length,
      },
    }),
    [
      '# Home Assistant Context Refresh',
      '',
      `- entities: ${Object.keys(normalized.entity_index).length}`,
      `- service_domains: ${Object.keys(normalized.service_index).length}`,
      `- components: ${normalized.components.length}`,
    ].join('\n'),
    'audit-ha-context-refresh-latest.md',
  );
  return normalized;
}

/**
 * Fetch only /api/states, diff against the existing artifact, and merge the delta.
 *
 * Returns [updatedNormalized, deltaSummary].
 * Falls back to a full refresh if no baseline artifact exists.
 */
export async function refreshContextIncremental(
  root: string,
  client: CliClient,
  overrides: Partial<CliDeps> = {},
): Promise<[Record<string, any>, Record<string, any>]> {
  const deps = resolveDeps(overrides);
  const baselinePath = normalizedContextPath(root);
  if (!existsSync(baselinePath)) {
    const payload = await deps.refreshContext(root, client);
    return [payload, { added: [], removed: [], changed: [] }];
  }

  const baseline: Record<string, any> = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const baselineIndex: Record<string, any> = baseline.entity_index ?? {};

  const states: Array<Record<string, any>> = await client.get('/api/states');
  const newIndex = normalizeEntityIndex(states);

  const baselineIds = new Set(Object.keys(baselineIndex));
  const newIds = new Set(Object.keys(newIndex));

  const added = [...newIds].filter((eid) => !baselineIds.has(eid)).sort();
  const removed = [...baselineIds].filter((eid) => !newIds.has(eid)).sort();
  const changed = [...baselineIds]
    .filter(
      (eid) =>
        newIds.has(eid) &&
        (newIndex[eid]!.state !== baselineIndex[eid].state ||
          newIndex[eid]!.last_updated !== baselineIndex[eid].last_updated),
    )
    .sort();

  const mergedIndex: Record<string, any> = { ...baselineIndex };
  for (const eid of [...added, ...changed]) mergedIndex[eid] = newIndex[eid];
  for (const eid of removed) delete mergedIndex[eid];

  const unavailableEntities = collectUnavailable(mergedIndex);

  const normalized: Record<string, any> = {
    ...baseline,
    entity_index: mergedIndex,
    unavailable_entities: unavailableEntities,
    silence_summary: computeSilenceSummary(
      { entity_index: mergedIndex, unavailable_entities: unavailableEntities },
      root,
    ),
  };

  writeJsonArtifact(root, '.hermit/raw', 'snapshot-ha-normalized', normalized, 'snapshot-ha-normalized-latest.json');

  const delta: Record<string, any> = {
    mode: 'incremental',
    timestamp: utcTimestamp(),
    added,
    removed,
    changed,
    unavailable_total: unavailableEntities.length,
    entity_total: Object.keys(mergedIndex).length,
  };
  writeJsonArtifact(root, '.hermit/raw', 'snapshot-ha-delta', delta);

  writeMarkdownArtifact(
    root,
    '.hermit/raw',
    'audit-ha-context-refresh',
    standardMetadata('audit', 'HA Context Refresh (incremental)', {
      session: currentSessionId(root),
      tags: ['ha-context', 'refresh', 'incremental'],
      extra: {
        source: 'routine',
        mode: 'incremental',
        entity_count: Object.keys(mergedIndex).length,
        added: added.length,
        removed: removed.length,
        changed: changed.length,
        unavailable: unavailableEntities.length,
      },
    }),
    [
      '# Home Assistant Context Refresh (incremental)',
      '',
      `- entities: ${Object.keys(mergedIndex).length}`,
      `- added: ${added.length}`,
      `- removed: ${removed.length}`,
      `- changed: ${changed.length}`,
      `- unavailable: ${unavailableEntities.length}`,
    ].join('\n'),
    'audit-ha-context-refresh-latest.md',
  );

  return [normalized, delta];
}

function collectUnavailable(entityIndex: Record<string, any>): string[] {
  return Object.entries(entityIndex)
    .filter(([, state]) => String(state.state) === 'unavailable')
    .map(([eid]) => eid)
    .sort();
}

export function normalizeContext(
  states: Array<Record<string, any>>,
  services: Array<Record<string, any>>,
  components: unknown[],
): Record<string, any> {
  const entityIndex = normalizeEntityIndex(states);
  const serviceIndex: Record<string, string[]> = {};
  for (const item of services) {
    const domain = item.domain;
    if (typeof domain !== 'string') continue;
    const servicesPayload = item.services ?? {};
    const serviceNames = new Set<string>();
    if (Array.isArray(servicesPayload)) {
      for (const service of servicesPayload) {
        if (service !== null && typeof service === 'object') {
          const name = service.service;
          if (typeof name === 'string') serviceNames.add(name);
        }
      }
    } else if (servicesPayload !== null && typeof servicesPayload === 'object') {
      for (const name of Object.keys(servicesPayload)) serviceNames.add(name);
    }
    serviceIndex[domain] = [...serviceNames].sort();
  }
  return {
    entity_index: entityIndex,
    service_index: serviceIndex,
    components: components.filter((c): c is string => typeof c === 'string').sort(),
    unavailable_entities: collectUnavailable(entityIndex),
  };
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
