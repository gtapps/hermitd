// WP7 tier 2 port of src/ha_agent_lab/ha_api.py — Home Assistant REST client.
// Upstream contract: https://developers.home-assistant.io/docs/api/rest/
//
// ASYNC DECISION (tier-2): the Python client is synchronous (urllib); fetch is
// not. This port goes async END-TO-END — every request method returns a
// Promise, `selectHomeAssistantUrl` and `probeHomeAssistantUrl` are async
// (they perform live probes), and construction with URL selection happens via
// the static `HomeAssistantClient.create()` factory (constructors can't
// await). Tier-3 callers (cli/apply/boot/...) must `await` these. The direct
// constructor takes a pre-selected base URL — it exists for callers/tests
// that bypass the probe, mirroring pytest's `select_home_assistant_url`
// patch.
//
// Error semantics preserved from Python:
//   - HA error responses carry {"message": "..."} in the body —
//     `extractHaErrorMessage` surfaces it verbatim (see plugin CLAUDE.md:
//     DELETE of a missing id returns 400, not 404 — never special-case 404).
//   - HTTP errors throw immediately (no retry); only network failures and
//     timeouts retry with 0.25s * attempt backoff, `retryCount` times.
//   - `Error.message` carries the Python `str(exc)` form: the raw message,
//     plus " (status=N)" when a status code is present.
//   - Empty response bodies return {}; malformed JSON throws with the raw
//     text as payload.
//
// The CLI `ha probe <path>` passthrough is just `client.get(path)` — get()
// returns the parsed payload untouched, so the raw passthrough is preserved.
//
// Injectable transport: every probe/request goes through a `fetchImpl`
// (defaults to global fetch) so tests can stub the network without patching
// globals.

import type { AppConfig } from './config';
import { isoUtc } from './time-utils';

// Mirrors src/ha_agent_lab/__init__.py __version__ (the Python package
// version, not the plugin version).
const VERSION = '0.0.2';

const USER_AGENT =
  process.env.HOMEASSISTANT_USER_AGENT ||
  `ha-agent-lab/${VERSION} (+https://github.com/gtapps/hermitd)`;

// Cloudflare/Nabu Casa rejects oversize filter_entity_id query strings with HTTP 520.
// Empirically 24 IDs pass and 306 fail; 50 keeps URLs well under the proxy limit.
const HISTORY_CHUNK_SIZE = 50;

export type FetchLike = typeof fetch;

export class HomeAssistantError extends Error {
  readonly statusCode: number | null;
  readonly payload: unknown;

  constructor(message: string, statusCode: number | null = null, payload: unknown = null) {
    // Python __str__: message, or "message (status=N)" — baked into
    // Error.message so `exc.message` equals Python's str(exc).
    super(statusCode === null ? message : `${message} (status=${statusCode})`);
    this.name = 'HomeAssistantError';
    this.statusCode = statusCode;
    this.payload = payload;
  }
}

function assertHaConfigured(config: AppConfig): void {
  const missing = config.missingHaConfigurationFields();
  if (missing.length > 0) {
    throw new HomeAssistantError(
      `Missing Home Assistant configuration: ${missing.join(', ')}. ` +
        'Run `./bin/ha-agent-lab boot status --probe` and persist the missing values.',
    );
  }
}

export class HomeAssistantClient {
  readonly config: AppConfig;
  readonly baseUrl: string;
  readonly baseUrlSource: string;
  private readonly fetchImpl: FetchLike;

  /**
   * Direct constructor with a pre-selected base URL (no probe). Most callers
   * should use `HomeAssistantClient.create()`, which runs URL selection.
   */
  constructor(
    config: AppConfig,
    baseUrl: string,
    baseUrlSource: string,
    fetchImpl: FetchLike = globalThis.fetch,
  ) {
    assertHaConfigured(config);
    this.config = config;
    this.baseUrl = baseUrl;
    this.baseUrlSource = baseUrlSource;
    this.fetchImpl = fetchImpl;
  }

  /** Async equivalent of the Python constructor: validate config, then select the base URL. */
  static async create(
    config: AppConfig,
    fetchImpl: FetchLike = globalThis.fetch,
  ): Promise<HomeAssistantClient> {
    assertHaConfigured(config);
    const [baseUrl, baseUrlSource] = await selectHomeAssistantUrl(config, fetchImpl);
    return new HomeAssistantClient(config, baseUrl, baseUrlSource, fetchImpl);
  }

  get(path: string): Promise<any> {
    return this.request('GET', path, null);
  }

  post(path: string, payload: Record<string, unknown> | null = null): Promise<any> {
    return this.request('POST', path, payload);
  }

  delete(path: string): Promise<any> {
    return this.request('DELETE', path, null);
  }

  /** POST returning the raw response body — some endpoints (e.g. /api/template) return plain text, not JSON. */
  postText(path: string, payload: Record<string, unknown> | null = null): Promise<string> {
    return this.request('POST', path, payload, { raw: true });
  }

  /** GET returning the raw response body — /api/error_log serves the raw log file, not JSON. */
  getText(path: string): Promise<string> {
    return this.request('GET', path, null, { raw: true });
  }

  getStates(): Promise<Array<Record<string, any>>> {
    return this.get('/api/states');
  }

  getState(entityId: string): Promise<Record<string, any>> {
    return this.get(`/api/states/${entityId}`);
  }

  callService(domain: string, service: string, data: Record<string, unknown>): Promise<any> {
    return this.post(`/api/services/${domain}/${service}`, data);
  }

  /**
   * Fetch state-change history for the given entities over [startTime, endTime].
   *
   * Returns {entity_id: [state_change, ...]}. Entities with no events in the
   * window are absent from the result — callers that need zero-count rows
   * synthesize them.
   *
   * Large entity lists are split into chunks of HISTORY_CHUNK_SIZE and fetched
   * sequentially to keep the filter_entity_id query string under the Cloudflare
   * proxy's URL-length limit (which otherwise rejects with HTTP 520). Duplicate
   * entity IDs are collapsed (first occurrence wins) so chunks never re-fetch the
   * same entity and merge order can't silently drop one chunk's rows.
   *
   * Throws HomeAssistantError if entityIds is empty (avoids an unbounded
   * all-entity fetch). Flags are sent as bare query params (minimal_response,
   * not minimal_response=true) matching the HA REST API docs.
   */
  async getHistory(
    entityIds: string[],
    startTime: Date,
    endTime: Date,
    options: { minimalResponse?: boolean; significantChangesOnly?: boolean } = {},
  ): Promise<Record<string, Array<Record<string, any>>>> {
    const { minimalResponse = true, significantChangesOnly = true } = options;
    if (entityIds.length === 0) {
      throw new HomeAssistantError('get_history requires entity_ids — pass at least one entity ID');
    }

    const uniqueIds = [...new Set(entityIds)]; // dict.fromkeys: first occurrence wins
    const result: Record<string, Array<Record<string, any>>> = {};
    for (let i = 0; i < uniqueIds.length; i += HISTORY_CHUNK_SIZE) {
      const chunk = uniqueIds.slice(i, i + HISTORY_CHUNK_SIZE);
      Object.assign(
        result,
        await this.fetchHistoryChunk(chunk, startTime, endTime, {
          minimalResponse,
          significantChangesOnly,
        }),
      );
    }
    return result;
  }

  private async fetchHistoryChunk(
    entityIds: string[],
    startTime: Date,
    endTime: Date,
    options: { minimalResponse: boolean; significantChangesOnly: boolean },
  ): Promise<Record<string, Array<Record<string, any>>>> {
    // isoUtc keeps the Python `datetime.isoformat()` "+00:00" form, so the
    // encoded timestamp carries %2B/%3A exactly like the Python client.
    const startIso = encodeURIComponent(isoUtc(startTime));
    let params = `filter_entity_id=${entityIds.map((e) => encodeURIComponent(e)).join(',')}`;
    params += `&end_time=${encodeURIComponent(isoUtc(endTime))}`;
    if (options.minimalResponse) params += '&minimal_response';
    if (options.significantChangesOnly) params += '&significant_changes_only';

    const response = await this.get(`/api/history/period/${startIso}?${params}`);
    if (!Array.isArray(response)) return {};
    const result: Record<string, Array<Record<string, any>>> = {};
    for (const inner of response) {
      if (
        Array.isArray(inner) &&
        inner.length > 0 &&
        inner[0] !== null &&
        typeof inner[0] === 'object' &&
        'entity_id' in inner[0]
      ) {
        result[inner[0].entity_id] = inner;
      }
    }
    return result;
  }

  private async request(
    method: string,
    path: string,
    payload: Record<string, unknown> | null,
    options: { raw?: boolean } = {},
  ): Promise<any> {
    if (!this.config.haToken) {
      throw new HomeAssistantError('HOMEASSISTANT_TOKEN is not configured.');
    }
    const url = `${this.baseUrl.replace(/\/+$/, '')}${path}`;
    const headers = {
      Authorization: `Bearer ${this.config.haToken}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    };
    const body = payload !== null ? JSON.stringify(payload) : undefined;

    for (let attempt = 0; attempt <= this.config.retryCount; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body,
          signal: AbortSignal.timeout(this.config.timeoutSeconds * 1000),
        });
      } catch (exc) {
        // urllib URLError equivalent: network failure or timeout — retry.
        if (attempt >= this.config.retryCount) {
          throw new HomeAssistantError('Failed to reach Home Assistant.', null, String(exc));
        }
        await Bun.sleep(250 * (attempt + 1));
        continue;
      }
      if (!response.ok) {
        // urllib HTTPError equivalent: surfaced immediately, no retry. Read the
        // error body defensively — a mid-stream failure must NOT lose the HTTP
        // status, or callers (apply.ts) skip the 403→YAML-mode / 400→message
        // handling keyed on statusCode and get an opaque error instead.
        let errorBody = '';
        try {
          errorBody = await response.text();
        } catch {}
        throw new HomeAssistantError(httpErrorMessage(response.status), response.status, errorBody);
      }
      let text: string;
      try {
        text = await response.text();
      } catch (exc) {
        // Success status but the body stream failed (truncated/aborted) — keep
        // it a HomeAssistantError carrying the status, not a raw TypeError.
        throw new HomeAssistantError('Failed to read Home Assistant response.', response.status, String(exc));
      }
      if (options.raw) return text;
      if (!text.trim()) return {};
      try {
        return JSON.parse(text);
      } catch {
        throw new HomeAssistantError('Malformed JSON from Home Assistant.', null, text);
      }
    }

    throw new HomeAssistantError('Exhausted Home Assistant retries.');
  }
}

function httpErrorMessage(statusCode: number): string {
  const mapping: Record<number, string> = {
    401: 'Unauthorized Home Assistant request.',
    403: 'Forbidden: Home Assistant is in YAML mode (REST config API unavailable).',
    404: 'Home Assistant endpoint not found.',
    405: 'Home Assistant method not allowed.',
  };
  return mapping[statusCode] ?? 'Home Assistant request failed.';
}

/** Pull HA's structured {"message": "..."} body from the error; fall back to str(exc). */
export function extractHaErrorMessage(exc: HomeAssistantError): string {
  if (typeof exc.payload === 'string') {
    try {
      const parsed = JSON.parse(exc.payload);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        typeof parsed.message === 'string'
      ) {
        return parsed.message;
      }
    } catch {
      // not JSON — fall through
    }
  }
  return exc.message;
}

/** The `{"error"}` token for a HomeAssistantError: `ha_http_<status>` when HA
 *  answered, `fallback` when it did not, with HA's message as the detail. */
export function haErrorToken(exc: HomeAssistantError, fallback = 'ha_unreachable'): string {
  return exc.statusCode === null
    ? `${fallback}:${exc.message}`
    : `ha_http_${exc.statusCode}:${extractHaErrorMessage(exc)}`;
}

export async function probeHomeAssistantUrl(
  baseUrl: string,
  token: string,
  timeoutSeconds: number,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<boolean> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/`;
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    // urlopen raises HTTPError on 4xx/5xx — only a 2xx (after redirects) probes true.
    return response.ok;
  } catch {
    return false;
  }
}

export async function selectHomeAssistantUrl(
  config: AppConfig,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<[string, string]> {
  if (!config.haToken) {
    throw new HomeAssistantError('HOMEASSISTANT_TOKEN is not configured.');
  }

  // Dual-URL mode: user opted in by setting both LOCAL and REMOTE — probe with fallback.
  if (config.haLocalUrl && config.haRemoteUrl) {
    if (await probeHomeAssistantUrl(config.haLocalUrl, config.haToken, config.timeoutSeconds, fetchImpl)) {
      return [config.haLocalUrl, 'local'];
    }
    if (await probeHomeAssistantUrl(config.haRemoteUrl, config.haToken, config.timeoutSeconds, fetchImpl)) {
      return [config.haRemoteUrl, 'remote'];
    }
    return [config.haLocalUrl, 'fallback'];
  }

  // Single-URL mode: HOMEASSISTANT_URL, or whichever of LOCAL/REMOTE is set alone.
  const url = config.primaryUrl();
  if (!url) {
    throw new HomeAssistantError('Missing Home Assistant base URL configuration.');
  }
  return [url, 'single'];
}
