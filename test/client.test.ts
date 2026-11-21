import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_WRITES,
  API_KEY_HEADER,
  PipedriveClient,
  readOnlyClient,
  type PipedriveClientOptions,
} from '../src/pipedrive/client.js';
import { PipedriveHttpError, parseRetryAfterMs, redactSecrets, SecretRedactor } from '../src/errors.js';
import { USER_AGENT } from '../src/version.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

const BASE = 'https://api.pipedrive.com';
/** A test token: obviously not a real one. */
const TOKEN = 'fake-token-aaaaaaaaaaaa';

/** A client with an explicit token, so nothing is read from the environment. */
function pc(options: Omit<Partial<PipedriveClientOptions>, 'fetchImpl'> & { fetchImpl?: unknown }) {
  return new PipedriveClient({ apiToken: TOKEN, fetchImpl: fetch, ...options } as PipedriveClientOptions);
}

type Handler = (url: string, init?: RequestInit) => Response | unknown | Promise<Response | unknown>;

function makeFetch(handler: Handler) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const result = await handler(String(input), init);
    if (result instanceof Response) {
      return result;
    }
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function headersOf(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

function methodsOf(fetchImpl: ReturnType<typeof makeFetch>): string[] {
  return fetchImpl.mock.calls.map(call => String((call[1] as RequestInit | undefined)?.method));
}

const noSleep = vi.fn(async (_ms: number) => undefined);

function makeClient(fetchImpl: typeof fetch, extra: Partial<PipedriveClientOptions> = {}) {
  return pc({ baseUrl: BASE, fetchImpl, sleep: noSleep, ...extra });
}

const OBJ = '/api/v2';

describe('PipedriveClient', () => {
  it('sends the API token in x-api-token with the User-Agent, never in the URL, and never follows redirects', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const fetchImpl = makeFetch((url, init) => {
      seenUrl = url;
      seenInit = init;
      return { id: '12', properties: {} };
    });

    await pc({ baseUrl: `${BASE}/`, fetchImpl }).get(`${OBJ}/deals/12`, { include_fields: 'x' });

    expect(seenUrl).toBe(`${BASE}${OBJ}/deals/12?include_fields=x`);
    expect(seenUrl).not.toContain(TOKEN);
    expect(seenInit?.method).toBe('GET');
    expect(API_KEY_HEADER).toBe('x-api-token');
    expect(headersOf(seenInit)[API_KEY_HEADER]).toBe(TOKEN);
    expect(headersOf(seenInit)['User-Agent']).toBe(USER_AGENT);
    expect(seenInit?.redirect).toBe('manual');
    expect(seenInit?.body).toBeUndefined();
  });

  it('joins a list in the query with commas, as Pipedrive takes lists', () => {
    const url = new URL(pc({}).buildUrl(`${OBJ}/deals`, { ids: [1, 2], status: 'open' }));
    expect(url.searchParams.get('ids')).toBe('1,2');
    expect(url.searchParams.get('status')).toBe('open');
  });

  it('throws before sending anything when the access token is missing, and uses the documented host by default', async () => {
    const fetchImpl = makeFetch(() => ({}));
    for (const name of Object.keys(process.env)) if (name.startsWith('PIPEDRIVE_')) delete process.env[name];

    await expect(new PipedriveClient({ fetchImpl }).get('/x')).rejects.toThrow('PIPEDRIVE_API_TOKEN');
    await expect(new PipedriveClient({ fetchImpl, apiToken: '' }).get('/x')).rejects.toThrow('PIPEDRIVE_API_TOKEN');
    await expect(new PipedriveClient({ fetchImpl }).post(`${OBJ}/deals`, {})).rejects.toThrow('PIPEDRIVE_API_TOKEN');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(new PipedriveClient({ fetchImpl }).baseUrl).toBe(BASE);

    // The standalone server reads the token from the environment; an instance given credentialEnv {} never does.
    process.env.PIPEDRIVE_API_TOKEN = TOKEN;
    await new PipedriveClient({ fetchImpl }).get('/x');
    expect(headersOf(fetchImpl.mock.calls[0]?.[1] as RequestInit)[API_KEY_HEADER]).toBe(TOKEN);
    await expect(new PipedriveClient({ fetchImpl, credentialEnv: {} }).get('/x')).rejects.toThrow('PIPEDRIVE_API_TOKEN');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('pins the token to the Pipedrive API host', () => {
    delete process.env.PIPEDRIVE_ALLOW_CUSTOM_BASE_URL;
    expect(() => pc({ baseUrl: BASE })).not.toThrow();
    expect(() => pc({ baseUrl: 'https://API.PIPEDRIVE.COM' })).not.toThrow();
    expect(() => pc({ baseUrl: 'https://api.pipedrive.com.evil.test' })).toThrow(/must be on/);
    expect(() => pc({ baseUrl: 'https://evil.api.pipedrive.com' })).toThrow(/must be on/);
    expect(() => pc({ baseUrl: 'https://evil.test' })).toThrow(/must be on/);
    expect(() => pc({ baseUrl: 'https://evil.test', allowCustomBaseUrl: true })).not.toThrow();
  });

  it('sends only the writes on its fixed list, refused before the token is sent, and has no DELETE', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({ success: true, data: { id: 1 } }, 200));
    const client = makeClient(fetchImpl);
    const refused: Array<[string, () => Promise<unknown>]> = [
      ['post a record id', () => client.post(`${OBJ}/deals/1`, {})],
      ['merge persons', () => client.put('/api/v1/persons/1/merge', {})],
      ['merge organizations', () => client.put('/api/v1/organizations/1/merge', {})],
      ['merge deals', () => client.put('/api/v1/deals/1/merge', {})],
      ['duplicate a deal', () => client.post(`${OBJ}/deals/1/duplicate`, {})],
      ['v1 deal', () => client.post('/api/v1/deals', {})],
      ['v1 put a deal', () => client.put('/api/v1/deals/1', {})],
      ['bulk', () => client.put('/api/v1/activities/bulk', {})],
      ['pipeline', () => client.post(`${OBJ}/pipelines`, {})],
      ['stage', () => client.patch(`${OBJ}/stages/1`, {})],
      ['product', () => client.post(`${OBJ}/products`, {})],
      ['deal field', () => client.post('/api/v1/dealFields', {})],
      ['user', () => client.post('/api/v1/users', {})],
      ['change a user', () => client.put('/api/v1/users/1', {})],
      ['permission set', () => client.post('/api/v1/roles', {})],
      ['webhook', () => client.post('/api/v1/webhooks', {})],
      ['mail', () => client.post('/api/v1/mailbox/mailThreads', {})],
      ['file', () => client.post('/api/v1/files', {})],
      ['filter', () => client.post('/api/v1/filters', {})],
      ['deal participant', () => client.post(`${OBJ}/deals/1/participants`, {})],
      ['trailing slash', () => client.post(`${OBJ}/deals/`, {})],
      ['patch a type', () => client.patch(`${OBJ}/deals`, {})],
      ['patch a note', () => client.patch('/api/v1/notes/1', {})],
      ['put a note list', () => client.put('/api/v1/notes', {})],
      ['leading zero', () => client.patch(`${OBJ}/deals/012`, {})],
      ['not an id', () => client.patch(`${OBJ}/deals/x`, {})],
    ];
    for (const [what, call] of refused) {
      const error = (await call().catch((e: unknown) => e)) as Error;
      expect(error.message, what).toMatch(/^Refused: (POST|PATCH|PUT) to that Pipedrive path/);
      expect(error.message).not.toContain(TOKEN);
    }
    // Nothing was sent, so the token never left in a header.
    expect(fetchImpl).not.toHaveBeenCalled();

    for (const call of [
      () => client.post(`${OBJ}/deals`, {}),
      () => client.post(`${OBJ}/persons`, {}),
      () => client.post(`${OBJ}/organizations`, {}),
      () => client.post(`${OBJ}/activities`, {}),
      () => client.patch(`${OBJ}/deals/7`, {}),
      () => client.patch(`${OBJ}/activities/7`, {}),
      () => client.post('/api/v1/notes', {}),
      () => client.put('/api/v1/notes/7', {}),
    ]) {
      await expect(call()).resolves.toEqual({ success: true, data: { id: 1 } });
    }
    expect(methodsOf(fetchImpl)).toEqual(['POST', 'POST', 'POST', 'POST', 'PATCH', 'PATCH', 'POST', 'PUT']);
    expect('delete' in client).toBe(false);
    expect(ALLOWED_WRITES.every(entry => entry.method !== ('DELETE' as string))).toBe(true);
  });

  it('gives a read-only tool a client that sends only GET', async () => {
    const fetchImpl = makeFetch(() => ({ success: true, data: [] }));
    const client = readOnlyClient(makeClient(fetchImpl), 'pipedrive_get_deal');
    await expect(client.post(`${OBJ}/deals`, {})).rejects.toThrow('Read-only tool pipedrive_get_deal attempted an upstream POST');
    await expect(client.patch(`${OBJ}/deals/1`, {})).rejects.toThrow('Read-only tool pipedrive_get_deal attempted an upstream PATCH');
    await expect(client.put('/api/v1/notes/1', {})).rejects.toThrow('Read-only tool pipedrive_get_deal attempted an upstream PUT');
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(client.get(`${OBJ}/deals/1`)).resolves.toEqual({ success: true, data: [] });
    expect(methodsOf(fetchImpl)).toEqual(['GET']);
    expect(Object.keys(client).sort()).toEqual(['get', 'patch', 'post', 'put']);
  });

  it('refuses unsafe base URLs without echoing credentials', () => {
    expect(() => pc({ baseUrl: 'http://api.vendor.test' })).toThrow('https://');
    expect(() => pc({ baseUrl: 'http://api.pipedrive.com' })).toThrow('https://');
    expect(() => pc({ baseUrl: 'not a url' })).toThrow('not a valid URL');
    expect(() => pc({ baseUrl: 'http://127.0.0.1:8080/api' })).not.toThrow();
    expect(() => pc({ baseUrl: 'http://localhost:8080/api' })).not.toThrow();
    expect(() => pc({ baseUrl: 'http://[::1]:8080/api' })).not.toThrow();

    for (const baseUrl of [
      'https://user:hunter2@api.vendor.test/v1',
      'https://api.pipedrive.com?x=1',
      'https://api.pipedrive.com#frag',
    ]) {
      let message = '';
      try {
        pc({ baseUrl });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('credentials, a query string or a fragment');
      expect(message).not.toContain('hunter2');
    }
  });

  it('validates numeric environment variables and options instead of producing NaN', () => {
    process.env.PIPEDRIVE_TIMEOUT_MS = '30s';
    expect(() => pc({})).toThrow('PIPEDRIVE_TIMEOUT_MS');
    process.env.PIPEDRIVE_TIMEOUT_MS = '3000000000';
    expect(() => pc({})).toThrow('PIPEDRIVE_TIMEOUT_MS');
    delete process.env.PIPEDRIVE_TIMEOUT_MS;
    process.env.PIPEDRIVE_MAX_CONCURRENCY = 'many';
    expect(() => pc({})).toThrow('PIPEDRIVE_MAX_CONCURRENCY');
    delete process.env.PIPEDRIVE_MAX_CONCURRENCY;
    process.env.PIPEDRIVE_MAX_RESPONSE_BYTES = '10MB';
    expect(() => pc({})).toThrow('PIPEDRIVE_MAX_RESPONSE_BYTES');
    delete process.env.PIPEDRIVE_MAX_RESPONSE_BYTES;
    process.env.PIPEDRIVE_ALLOW_CUSTOM_BASE_URL = 'perhaps';
    expect(() => pc({ baseUrl: BASE })).toThrow('PIPEDRIVE_ALLOW_CUSTOM_BASE_URL');
    delete process.env.PIPEDRIVE_ALLOW_CUSTOM_BASE_URL;

    expect(() => pc({ maxConcurrency: 0 })).toThrow('maxConcurrency');
    expect(() => pc({ maxConcurrency: Number.NaN })).toThrow('maxConcurrency');
    expect(() => pc({ timeoutMs: 2 ** 31 })).toThrow('timeoutMs');
    expect(() => pc({ maxAttempts: 0 })).toThrow('maxAttempts');
  });
});

describe('error handling', () => {
  it('gives the status and our own hint on 401 and 403, never the vendor body or code, and does not retry', async () => {
    const vendor = {
      status: 'error',
      category: 'INVALID_AUTHENTICATION',
      message: 'Authentication credentials not found for this portal',
      correlationId: 'corr-id-zzzzzzzzzzzz',
    };
    for (const [status, hint] of [
      [401, 'Pipedrive did not accept the API token.'],
      [403, 'the user whose token this is may not see or change this'],
    ] as const) {
      const fetchImpl = makeFetch(() => jsonResponse(vendor, status));
      const error = await makeClient(fetchImpl).get('/x').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PipedriveHttpError);
      expect((error as PipedriveHttpError).status).toBe(status);
      expect((error as Error).message).toContain(`HTTP ${status}`);
      expect((error as Error).message).toContain(hint);
      expect(JSON.stringify({ ...(error as object), message: (error as Error).message })).not.toMatch(
        /INVALID_AUTHENTICATION|Authentication credentials|corr-id|correlationId/,
      );
      // The token is used as given and never renewed: an authorisation failure is sent once.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('never puts an error body in the error', async () => {
    const html = `<html>${'x'.repeat(5000)}</html>`;
    const fetchImpl = makeFetch(() => new Response(html, { status: 502, headers: { 'content-type': 'text/html' } }));
    const error = (await makeClient(fetchImpl, { maxAttempts: 1 })
      .get('/x')
      .catch((e: unknown) => e)) as PipedriveHttpError;
    expect(error.message).toBe('Pipedrive API request failed with HTTP 502');
  });

  it('reads at most 64 KB of an error body', async () => {
    let pulled = 0;
    const fetchImpl = makeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += 1;
              controller.enqueue(new TextEncoder().encode('e'.repeat(16 * 1024)));
            },
          }),
          { status: 500, headers: { 'content-type': 'text/html' } },
        ),
    );
    const error = (await makeClient(fetchImpl)
      .get('/x')
      .catch((e: unknown) => e)) as PipedriveHttpError;
    expect(error).toBeInstanceOf(PipedriveHttpError);
    expect(pulled).toBeLessThan(10);
    expect(error.message.length).toBeLessThan(700);
  });

  it('redacts the configured access token wherever it appears, before truncating', async () => {
    const apiToken = 'fake-token-0000000000000000'; // gitleaks:allow (a test value, not a key)
    const respond = (body: string, type = 'text/plain') =>
      pc({
        apiToken,
        baseUrl: BASE,
        fetchImpl: makeFetch(() => new Response(body, { status: 400, headers: { 'content-type': type } })),
      });

    const echoed = (await respond(`proxy error: ${apiToken} and ${encodeURIComponent(apiToken)}`)
      .get('/x')
      .catch((e: unknown) => e)) as PipedriveHttpError;
    expect(echoed.message).not.toContain(apiToken);
    expect(echoed.message).not.toContain('proxy error');

    const boundary = (await respond(`${'x'.repeat(490)}${apiToken}`)
      .get('/x')
      .catch((e: unknown) => e)) as PipedriveHttpError;
    expect(boundary.message).not.toContain(apiToken.slice(0, 6));

    const nested = (await respond(JSON.stringify({ message: 'bad', nested: { echo: apiToken } }), 'application/json')
      .get('/x')
      .catch((e: unknown) => e)) as PipedriveHttpError;
    expect(JSON.stringify(nested)).not.toContain(apiToken);

    const redactor = pc({ apiToken }).redactor;
    expect(redactor.redact(`echo ${apiToken} again`)).not.toContain(apiToken);
    expect(redactor.redact(`Authorization: Bearer ${apiToken}`)).not.toContain(apiToken);

    expect(redactSecrets('X-API-KEY: abc123')).not.toContain('abc123');
    expect(redactSecrets('Authorization: Bearer abc123')).not.toContain('abc123');
    expect(redactSecrets('PIPEDRIVE_API_TOKEN=abc123')).not.toContain('abc123');
  });

  it('redacts the configured key header by name', () => {
    const redactor = new SecretRedactor().addHeader('X-Vendor-Token').addHeader(API_KEY_HEADER);
    const redactSecrets = (text: string) => redactor.redact(text);
    expect(redactSecrets('sent x-vendor-token: abc123, ok')).toBe('sent x-vendor-token: ‹redacted›, ok');
    expect(redactSecrets(`${API_KEY_HEADER}: abc123`)).not.toContain('abc123');
    for (const text of [
      '{"X-Vendor-Token":"abc123"}',
      "{'x-vendor-token': 'abc123'}",
      'x-vendor-token=abc123',
      `{"${API_KEY_HEADER}": "abc123"}`,
      '{"authorization":"Bearer abc123"}',
      'authorization=abc123',
      'x-api-key=abc123:def',
      'X-Vendor-Token=abc123=def',
      'authorization=abc123:pass',
      'Authorization: Basic abc123',
      'Authorization: Token abc123',
      '"Authorization": "Digest abc123"',
    ]) {
      expect(redactSecrets(text), text).not.toContain('abc123');
    }
  });

  it('keeps query strings out of error URLs', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}, 400));
    const error = (await makeClient(fetchImpl)
      .get(`${OBJ}/contacts`, { after: 'secret-cursor' })
      .catch((e: unknown) => e)) as PipedriveHttpError;
    expect(error.url).toBe(`${BASE}${OBJ}/contacts`);
    expect(error.message).not.toContain('secret-cursor');
  });

  it('parses Retry-After as seconds or an HTTP date', async () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfterMs('5', now)).toBe(5000);
    expect(parseRetryAfterMs('Thu, 01 Jan 2026 00:00:10 GMT', now)).toBe(10_000);
    for (const value of ['0', 'Wed, 31 Dec 2025 23:59:00 GMT', 'soon', '1.5', '-1', '+5', '']) {
      expect(parseRetryAfterMs(value, now)).toBeUndefined();
    }
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
  });

  it('names only the system error code of a network error, never its message', async () => {
    const fetchImpl = makeFetch(() => {
      throw new TypeError('fetch failed somewhere odd', {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.vendor.test'), { code: 'ENOTFOUND' }),
      });
    });
    const message = await makeClient(fetchImpl, { maxAttempts: 1 })
      .get('/x')
      .catch((e: Error) => e.message);
    expect(message).toMatch(/Network error calling the Pipedrive API \(GET\) \(ENOTFOUND\)\./);
    expect(message).not.toMatch(/odd|getaddrinfo/);
  });

  it('reports timeouts clearly', async () => {
    const fetchImpl = makeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    await expect(makeClient(fetchImpl).get('/items?cursor=c')).rejects.toThrow(
      /timed out after \d+ ms \(GET\)/,
    );
  });

  it('caps successful response bodies', async () => {
    const big = makeFetch(
      () => new Response('x'.repeat(100), { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    await expect(makeClient(big, { maxResponseBytes: 10 }).get('/x')).rejects.toThrow('exceeds the 10 byte limit');
    await expect(makeClient(big, { maxResponseBytes: 1000 }).get('/x')).resolves.toBe('x'.repeat(100));
  });
});

describe('redirects', () => {
  it('never follows redirects and names the target without its query', async () => {
    const fetchImpl = makeFetch(
      () => new Response(null, { status: 302, headers: { location: 'https://other.vendor.test/v1/items?t=1' } }),
    );
    const message = await makeClient(fetchImpl)
      .get(`${OBJ}/contacts/1`)
      .catch((e: Error) => e.message);
    expect(message).toContain('redirect (HTTP 302) for GET');
    expect(message).toContain('PIPEDRIVE_BASE_URL');
    // The Location is the vendor's text: never quoted.
    expect(message).not.toContain('other.vendor.test');
    await expect(makeClient(fetchImpl).post(`${OBJ}/persons`, {})).rejects.toThrow(/redirect/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every(([url]) => !String(url).includes('other.vendor.test'))).toBe(true);
  });
});

describe('retries and concurrency', () => {
  it('retries idempotent GETs on 429/502/503/504 honouring Retry-After', async () => {
    const statuses = [503, 429];
    const fetchImpl = makeFetch(() => {
      const status = statuses.shift();
      if (status === 429) {
        return jsonResponse({}, 429, { 'retry-after': '2' });
      }
      if (status) {
        return jsonResponse({}, status);
      }
      return { ok: true };
    });
    const sleep = vi.fn(async (_ms: number) => undefined);
    const client = makeClient(fetchImpl, { sleep, retryBaseDelayMs: 10 });

    await expect(client.get('/x')).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[1]).toEqual([2000]);
  });

  it('does not wait for a Retry-After beyond the retry budget and surfaces it', async () => {
    const fetchImpl = makeFetch(() => jsonResponse({}, 503, { 'retry-after': '3600' }));
    const sleep = vi.fn(async (_ms: number) => undefined);
    const error = (await makeClient(fetchImpl, { sleep })
      .get('/x')
      .catch((e: unknown) => e)) as PipedriveHttpError;

    expect(error).toBeInstanceOf(PipedriveHttpError);
    expect(error.message).toContain('retry-after=3600s');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries GETs on transient network errors only', async () => {
    let calls = 0;
    const fetchImpl = makeFetch(() => {
      calls += 1;
      if (calls === 1) {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
      }
      return { ok: true };
    });
    await expect(makeClient(fetchImpl).get('/x')).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);

    const permanent = makeFetch(() => {
      throw new TypeError('Headers.append: invalid header value');
    });
    await expect(makeClient(permanent).get('/x')).rejects.toThrow('Network error');
    expect(permanent).toHaveBeenCalledTimes(1);
  });

  it('never retries writes (POST, PATCH), on a retryable status or a network error', async () => {
    for (const status of [429, 503]) {
      const fetchImpl = makeFetch(() => jsonResponse({}, status));
      const client = makeClient(fetchImpl);
      await expect(client.post(`${OBJ}/persons`, {})).rejects.toBeInstanceOf(PipedriveHttpError);
      await expect(client.patch(`${OBJ}/persons/7`, {})).rejects.toBeInstanceOf(PipedriveHttpError);
      expect(methodsOf(fetchImpl)).toEqual(['POST', 'PATCH']);
    }

    const failing = makeFetch(() => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    });
    await expect(makeClient(failing).post(`${OBJ}/persons`, {})).rejects.toThrow('Network error');
    await expect(makeClient(failing).patch(`${OBJ}/deals/7`, {})).rejects.toThrow('Network error');
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('releases the concurrency slot after failures', async () => {
    let calls = 0;
    const fetchImpl = makeFetch(() => {
      calls += 1;
      if (calls === 1) {
        throw new DOMException('timeout', 'TimeoutError');
      }
      if (calls === 2) {
        return jsonResponse({}, 500);
      }
      return { ok: true };
    });
    const client = makeClient(fetchImpl, { maxConcurrency: 1 });
    await expect(client.get('/x')).rejects.toThrow('timed out');
    await expect(client.get('/x')).rejects.toBeInstanceOf(PipedriveHttpError);
    await expect(client.get('/x')).resolves.toEqual({ ok: true });
  });

  it('limits concurrent requests per client', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = makeFetch(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      return { ok: true };
    });
    const client = makeClient(fetchImpl, { maxConcurrency: 2 });

    await Promise.all(Array.from({ length: 8 }, () => client.get('/x')));
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(peak).toBe(2);
  });
});

describe('against a local upstream (real sockets)', () => {
  let upstream: Server | undefined;

  afterEach(async () => {
    await new Promise<void>(resolve => (upstream ? upstream.close(() => resolve()) : resolve()));
    upstream = undefined;
  });

  async function startUpstream(handler: Parameters<typeof createHttpServer>[1]): Promise<string> {
    upstream = createHttpServer(handler);
    await new Promise<void>(resolve => upstream?.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  }

  it('sends the key, refuses a redirect and does not contact the redirect target', async () => {
    const seen: Array<{ url?: string; key?: string }> = [];
    const base = await startUpstream((req, res) => {
      seen.push({ url: req.url, key: req.headers[API_KEY_HEADER.toLowerCase()] as string | undefined });
      if (req.url === '/v1/contacts/1') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"id":"1"}');
        return;
      }
      res.writeHead(302, { location: `${base}/contacts/1` }).end();
    });
    const client = pc({ apiToken: 'fake-local-key-1111', baseUrl: base });

    await expect(client.get('/contacts/1')).resolves.toEqual({ id: '1' });
    await expect(client.get('/moved')).rejects.toThrow('redirects are not followed');
    expect(seen).toEqual([
      { url: '/v1/contacts/1', key: 'fake-local-key-1111' },
      { url: '/v1/moved', key: 'fake-local-key-1111' },
    ]);
  });

  it('times out a stalled upstream', async () => {
    const base = await startUpstream(() => {
      // never answers
    });
    const client = pc({ baseUrl: base, timeoutMs: 100, maxAttempts: 1 });
    await expect(client.get('/slow')).rejects.toThrow(/timed out after 100 ms/);
    upstream?.closeAllConnections();
  });
});
