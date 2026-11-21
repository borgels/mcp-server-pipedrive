import { ConfigError, readEnvBoolean, readEnvInteger, readEnvString, type Env } from '../config-env.js';
import { PipedriveHttpError, describeUrl, parseRetryAfterMs, SecretRedactor } from '../errors.js';
import { USER_AGENT } from '../version.js';

/**
 * The client sends one personal API token in the `x-api-token` header, as
 * Pipedrive's documentation asks ("The API token must be provided in the
 * x-api-token header for all requests",
 * https://pipedrive.readme.io/docs/core-api-concepts-authentication). The
 * token belongs to one user in one Pipedrive company and carries that user's
 * permissions. It is never exchanged or renewed, and never put in a URL.
 */
export interface PipedriveClientOptions {
  /** The personal API token. A secret. When omitted, read from PIPEDRIVE_API_TOKEN. */
  apiToken?: string;
  /** API base URL (default https://api.pipedrive.com; env PIPEDRIVE_BASE_URL). */
  baseUrl?: string;
  /**
   * Where omitted credentials are read from. Defaults to process.env for the
   * standalone server. The gateway passes `{}`, so an embedded instance only
   * ever uses the credentials it was given.
   */
  credentialEnv?: Env;
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout covering headers and body (default 30 s, env PIPEDRIVE_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Maximum number of concurrent upstream requests from this client (default 4, env PIPEDRIVE_MAX_CONCURRENCY). */
  maxConcurrency?: number;
  /** Largest successful response body read, in bytes (default 10 MB, env PIPEDRIVE_MAX_RESPONSE_BYTES). */
  maxResponseBytes?: number;
  /** Total attempts for reads on 429/502/503/504 and transient network errors (default 3). */
  maxAttempts?: number;
  /** Base delay of the exponential backoff between retries (default 500 ms). */
  retryBaseDelayMs?: number;
  /**
   * Total time one call may spend waiting between retries (default 10 s). A
   * Retry-After that does not fit in the remaining budget is not waited for;
   * the response is returned to the caller instead.
   */
  retryBudgetMs?: number;
  /** Allow hosts other than Pipedrive's API host (env PIPEDRIVE_ALLOW_CUSTOM_BASE_URL=true). Loopback http is always allowed for mocks. */
  allowCustomBaseUrl?: boolean;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export type QueryValue = string | number | boolean | null | undefined | readonly (string | number)[];

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT';

/** The header that carries the API token; error text redaction follows it. */
export const API_KEY_HEADER = 'x-api-token';

/**
 * Pipedrive's API host (exact host match, no subdomains). It serves both
 * `/api/v1` and `/api/v2` for every company and finds the company from the
 * token, so the token is only ever sent to this one host.
 */
export const API_HOST = 'api.pipedrive.com';
export const DEFAULT_BASE_URL = `https://${API_HOST}`;

const ID = '[1-9][0-9]{0,15}';

/**
 * The only writes the client sends: method and path (relative to the base
 * URL). Anything else is refused before it is sent, whatever a tool or a
 * policy says: no DELETE, no merge, no bulk or batch change, nothing on
 * users, permissions, pipelines, stages, fields, filters, products, mail,
 * files or webhooks. New and changed deals, persons, organizations and
 * activities go to API v2; notes exist only in API v1. The client has no
 * delete method at all.
 */
export const ALLOWED_WRITES: ReadonlyArray<{ method: 'POST' | 'PATCH' | 'PUT'; path: RegExp }> = [
  { method: 'POST', path: /^\/api\/v2\/(deals|persons|organizations|activities)$/ },
  { method: 'PATCH', path: new RegExp(`^/api/v2/(deals|persons|organizations|activities)/${ID}$`) },
  { method: 'POST', path: /^\/api\/v1\/notes$/ },
  { method: 'PUT', path: new RegExp(`^/api/v1/notes/${ID}$`) },
];

export const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES_LIMIT = 100 * 1024 * 1024;

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
/** Largest delay accepted by Node timers. */
const MAX_TIMER_MS = 2_147_483_647;
/** System error codes a network error may name: a fixed list, so no other text from a cause is ever shown. */
const SHOWN_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Error codes (on `error.cause`) of connection-level failures worth retrying. */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * The client as handed to tool handlers. Read-only tools get a view without
 * post and patch (see readOnlyClient), so the write gate does not depend on
 * tool annotations alone.
 */
export interface UpstreamClient {
  get<T>(path: string, query?: Record<string, QueryValue>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
}

/** A view of the client that only reads: GET. */
export function readOnlyClient(client: UpstreamClient, toolName: string): UpstreamClient {
  const refuse = (method: string) => async () => {
    throw new Error(`Read-only tool ${toolName} attempted an upstream ${method}; refused.`);
  };
  return {
    get: (path, query) => client.get(path, query),
    post: refuse('POST'),
    patch: refuse('PATCH'),
    put: refuse('PUT'),
  };
}

/**
 * Client for the Pipedrive API. The API token is sent in the x-api-token header.
 *
 * Redirects are never followed, so the token can never be forwarded to
 * another origin. Reads (GET) are retried with backoff on
 * throttling, gateway errors and transient network failures; writes are never
 * retried. A missing token only fails when a request is made, so the tool
 * list can be read without one.
 *
 * Each client owns a SecretRedactor holding its token; errors raised by the
 * client, and the audit and tool results of calls made through it, are
 * redacted with it.
 */
export class PipedriveClient implements UpstreamClient {
  readonly redactor: SecretRedactor;
  private readonly apiToken?: string;
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryBudgetMs: number;
  private readonly semaphore: Semaphore;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: PipedriveClientOptions = {}) {
    const credentialEnv = options.credentialEnv ?? process.env;
    this.apiToken = options.apiToken ?? readEnvString('PIPEDRIVE_API_TOKEN', credentialEnv);
    this.redactor = new SecretRedactor().addHeader(API_KEY_HEADER).addSecret(this.apiToken);
    const allowCustom = options.allowCustomBaseUrl ?? readEnvBoolean('PIPEDRIVE_ALLOW_CUSTOM_BASE_URL', false);
    this.baseUrl = trimTrailingSlash(options.baseUrl ?? readEnvString('PIPEDRIVE_BASE_URL', credentialEnv) ?? DEFAULT_BASE_URL);
    assertSafeUrl(this.baseUrl, API_HOST, 'PIPEDRIVE_BASE_URL', allowCustom);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = intOption('timeoutMs', options.timeoutMs, 'PIPEDRIVE_TIMEOUT_MS', 30_000, 1, MAX_TIMER_MS);
    this.maxResponseBytes = intOption(
      'maxResponseBytes',
      options.maxResponseBytes,
      'PIPEDRIVE_MAX_RESPONSE_BYTES',
      DEFAULT_MAX_RESPONSE_BYTES,
      1,
      MAX_RESPONSE_BYTES_LIMIT,
    );
    this.semaphore = new Semaphore(intOption('maxConcurrency', options.maxConcurrency, 'PIPEDRIVE_MAX_CONCURRENCY', 4, 1, 64));
    this.maxAttempts = intOption('maxAttempts', options.maxAttempts, undefined, 3, 1, 10);
    this.retryBaseDelayMs = intOption('retryBaseDelayMs', options.retryBaseDelayMs, undefined, 500, 0, 60_000);
    this.retryBudgetMs = intOption('retryBudgetMs', options.retryBudgetMs, undefined, 10_000, 0, 600_000);
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  async get<T>(path: string, query?: Record<string, QueryValue>): Promise<T> {
    return this.request<T>('GET', this.buildUrl(path, query));
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', this.buildUrl(path), body);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', this.buildUrl(path), body);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', this.buildUrl(path), body);
  }

  /** A query value that is a list is sent as one comma-separated value, as Pipedrive takes lists (ids). */
  buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${normalizedPath}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, Array.isArray(value) ? value.join(',') : String(value));
    }
    return url.toString();
  }

  private async request<T>(method: HttpMethod, url: string, body?: unknown): Promise<T> {
    if (method !== 'GET') {
      // The fixed list of writes: anything else is refused before the token is put in a header.
      const path = new URL(url).pathname.slice(new URL(`${this.baseUrl}/`).pathname.length - 1);
      const allowed = ALLOWED_WRITES.some(entry => entry.method === method && entry.path.test(path));
      if (!allowed) {
        throw new Error(`Refused: ${method} to that Pipedrive path is not among the requests this server sends.`);
      }
    }
    if (!this.apiToken) throw new Error('Missing PIPEDRIVE_API_TOKEN. Set it in the MCP server environment.');
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
      [API_KEY_HEADER]: this.apiToken,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return this.execute(method === 'GET', method, url, init, async response => {
      if (isRedirect(response.status)) {
        await discardBody(response);
        throw new Error(this.redactor.redact(redirectRefusedMessage(response, method, url)));
      }
      if (!response.ok) {
        // The body is Pipedrive's text: it is never read into an error, a result or an audit record.
        await discardBody(response);
        throw new PipedriveHttpError({
          status: response.status,
          url: describeUrl(url),
          retryAfter: response.headers.get('retry-after') ?? undefined,
        });
      }
      return (await readResponseBody(response, this.maxResponseBytes)) as T;
    });
  }

  /**
   * Run one logical request: limit concurrency, apply the timeout, and retry
   * reads on retryable statuses and transient network errors
   * within the retry budget. `handle` runs while the concurrency slot is
   * held, so body reads count against it.
   */
  private async execute<R>(
    retryable: boolean,
    method: HttpMethod,
    url: string,
    init: RequestInit,
    handle: (response: Response) => Promise<R>,
  ): Promise<R> {
    const maxAttempts = retryable ? this.maxAttempts : 1;
    let slept = 0;

    for (let attempt = 1; ; attempt += 1) {
      const canRetry = attempt < maxAttempts;
      let delayMs: number | undefined;
      const release = await this.semaphore.acquire();
      try {
        const signal = AbortSignal.timeout(this.timeoutMs);
        let response: Response | undefined;
        try {
          response = await this.fetchImpl(url, { ...init, redirect: 'manual', signal });
        } catch (error) {
          delayMs = canRetry && isTransientNetworkError(error) ? this.retryDelay(attempt, undefined, slept) : undefined;
          if (delayMs === undefined) {
            throw this.transportError(method, url, error);
          }
        }

        if (response) {
          if (canRetry && RETRYABLE_STATUS.has(response.status)) {
            delayMs = this.retryDelay(attempt, parseRetryAfterMs(response.headers.get('retry-after')), slept);
          }
          if (delayMs === undefined) {
            try {
              return await handle(response);
            } catch (error) {
              // Failures while reading the body surface as raw fetch errors.
              if (isTimeoutError(error)) {
                throw this.transportError(method, url, error);
              }
              if (!isTransientNetworkError(error)) {
                throw error;
              }
              delayMs = canRetry ? this.retryDelay(attempt, undefined, slept) : undefined;
              if (delayMs === undefined) {
                throw this.transportError(method, url, error);
              }
            }
          }
          await discardBody(response);
        }
      } finally {
        release();
      }
      // Wait outside the concurrency slot.
      const wait = delayMs ?? 0;
      slept += wait;
      await this.sleep(wait);
    }
  }

  /**
   * Delay before the next attempt: exponential backoff with jitter, or the
   * server's Retry-After if longer. Undefined when the wait would exceed the
   * remaining retry budget (the caller then gives up).
   */
  private retryDelay(attempt: number, retryAfterMs: number | undefined, slept: number): number | undefined {
    const backoff = this.retryBaseDelayMs * 2 ** (attempt - 1) + Math.random() * this.retryBaseDelayMs;
    const delay = Math.max(backoff, retryAfterMs ?? 0);
    return slept + delay > this.retryBudgetMs ? undefined : delay;
  }

  // Our own words with the method only: the address is configuration and is not quoted.
  private transportError(method: HttpMethod, _url: string, error: unknown): Error {
    if (isTimeoutError(error)) {
      return new Error(this.redactor.redact(`Pipedrive API request timed out after ${this.timeoutMs} ms (${method}).`));
    }
    // Only a system error code (ECONNREFUSED, ENOTFOUND, ...) from the cause, never its message.
    const code = (error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : undefined) ?? undefined;
    const shown = typeof code === 'string' && SHOWN_NETWORK_CODES.has(code) ? ` (${code})` : '';
    return new Error(this.redactor.redact(`Network error calling the Pipedrive API (${method})${shown}.`), { cause: error });
  }
}

/** Option value if given (validated), else the environment variable (if any), else the default. */
function intOption(
  optionName: string,
  value: number | undefined,
  envName: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value !== undefined) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      // The value is not quoted: an option may hold a secret put there by mistake.
      throw new ConfigError(`${optionName} must be an integer between ${min} and ${max}.`);
    }
    return value;
  }
  return envName ? readEnvInteger(envName, fallback, { min, max }) : fallback;
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>(resolve => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next(); // hand the slot over directly
      } else {
        this.active -= 1;
      }
    };
  }
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** The redirect's Location is the vendor's text and is never quoted; only the status and our own request. */
function redirectRefusedMessage(response: Response, method: HttpMethod, _url: string): string {
  return (
    `Pipedrive API responded with a redirect (HTTP ${response.status}) for ${method}; ` +
    'redirects are not followed. Check PIPEDRIVE_BASE_URL.'
  );
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

/** fetch reports connection failures as TypeError with a coded cause; only those are retried. */
function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof TypeError)) {
    return false;
  }
  return causeCodes(error.cause).some(code => TRANSIENT_NETWORK_CODES.has(code));
}

function causeCodes(cause: unknown, depth = 0): string[] {
  if (typeof cause !== 'object' || cause === null || depth > 3) {
    return [];
  }
  const codes: string[] = [];
  const { code, errors, cause: inner } = cause as { code?: unknown; errors?: unknown; cause?: unknown };
  if (typeof code === 'string') {
    codes.push(code);
  }
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      codes.push(...causeCodes(entry, depth + 1));
    }
  }
  codes.push(...causeCodes(inner, depth + 1));
  return codes;
}

/** Read at most `limit` bytes of the body; cancels the rest and reports whether it was longer. */
async function readUpTo(response: Response, limit: number): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  if (!response.body) {
    return { bytes: new Uint8Array(0), exceeded: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (total + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - total));
      total = limit;
      exceeded = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, exceeded };
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }
}

/** Successful bodies are read up to maxBytes; a larger response is an error, not a truncated result. */
async function readResponseBody(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardBody(response);
    throw new Error(`Pipedrive API response of ${declared} bytes exceeds the ${maxBytes} byte limit (PIPEDRIVE_MAX_RESPONSE_BYTES).`);
  }
  let read: { bytes: Uint8Array; exceeded: boolean };
  try {
    read = await readUpTo(response, maxBytes);
  } catch (error) {
    // A timeout or a dropped connection goes on to execute(), which reports it as a transport error. Anything else
    // thrown while reading the body is replaced by a fixed text: its message is not ours.
    if (isTimeoutError(error) || isTransientNetworkError(error)) {
      throw error;
    }
    throw new Error('The Pipedrive API response could not be read.');
  }
  const { bytes, exceeded } = read;
  if (exceeded) {
    throw new Error(`Pipedrive API response exceeds the ${maxBytes} byte limit (PIPEDRIVE_MAX_RESPONSE_BYTES).`);
  }
  const text = new TextDecoder().decode(bytes);
  if (!text) {
    return null;
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return text;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function trimTrailingSlash(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end -= 1;
  }
  return value.slice(0, end);
}

/**
 * A URL a token may be sent to: https on exactly `host` (Pipedrive's documented
 * API host), no credentials, query or fragment. Loopback http is allowed
 * for local mocks; another host only with allowCustomHost. The value is
 * never quoted: it is configuration.
 */
function assertSafeUrl(value: string, host: string, name: string, allowCustomHost: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`${name} is not a valid URL.`);
  }
  if (parsed.username || parsed.password || value.includes('?') || value.includes('#')) {
    throw new ConfigError(`${name} must not contain credentials, a query string or a fragment.`);
  }
  if (isLocalHost(parsed.hostname) && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) return;
  if (parsed.protocol !== 'https:') {
    throw new ConfigError(`Refusing to send a token over a scheme other than https://. ${name} must use https://.`);
  }
  if (parsed.hostname.toLowerCase() === host || allowCustomHost) return;
  throw new ConfigError(`Refusing to send a token to that host: ${name} must be on ${host}. Set PIPEDRIVE_ALLOW_CUSTOM_BASE_URL=true to allow another host.`);
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}
