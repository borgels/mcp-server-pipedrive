// Failure metadata on gateway error results: the upstream API's HTTP status and its request id (a UUID or hex id
// only), for a host that counts failures without reading their text. Never the body, the vendor's code or message.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { failureMetadata, PipedriveHttpError, requestIdFrom, vendorRequestId } from '../src/errors.js';
import { BASE, testGateway } from './helpers.js';

const KEY = `tenant-kEy-${'Q7'.repeat(10)}-ZZtop-0123456789`;
const UUID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const BODY = { status: 'error', message: 'Customer Jane Doe not found', category: 'E_NOPE', correlationId: UUID };
const originalEnv = { ...process.env };

beforeEach(() => {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('PIPEDRIVE_')) delete process.env[name];
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
});

function gatewayAnswering(status: number, headers: Record<string, string>, body: unknown = BODY, apiToken = KEY) {
  const fetchImpl = (async () =>
    // A 304 has no body.
    new Response(status === 304 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })) as typeof fetch;
  return testGateway({ apiToken, baseUrl: BASE, fetchImpl, maxAttempts: 1 });
}

describe('vendorRequestId', () => {
  it('keeps a UUID and a hex id', () => {
    expect(vendorRequestId(UUID)).toBe(UUID);
    expect(vendorRequestId(` ${UUID} `)).toBe(UUID);
    expect(vendorRequestId('a1b2c3d4e5f60718')).toBe('a1b2c3d4e5f60718');
    expect(vendorRequestId('ABCDEF12-3456')).toBe('ABCDEF12-3456');
    expect(vendorRequestId('f'.repeat(64))).toBe('f'.repeat(64));
  });

  it('drops anything that could be text, and the shape of a personal number', () => {
    for (const value of [
      undefined,
      null,
      '',
      'abc123',
      'Jane Doe',
      'jane@example.com',
      'req_8f3a9c2d1e',
      'deadbeef deadbeef',
      '0101901234',
      'ab-010190-1234-cd',
      'f'.repeat(65),
      '-abcdef12',
      'abcdef12-',
      'abc--def',
      'abcdef12-ab',
      'abcdef1',
    ]) {
      expect(vendorRequestId(value)).toBeUndefined();
    }
  });

  it('reads the first header with an id in the right form', () => {
    const other = 'deadbeefcafe0011';
    expect(requestIdFrom(new Headers({ 'request-id': other, 'x-request-id': UUID }))).toBe(UUID);
    expect(requestIdFrom(new Headers({ 'x-request-id': 'not an id', 'x-correlation-id': other }))).toBe(other);
    expect(requestIdFrom(new Headers({ 'x-vendor-id': UUID }))).toBeUndefined();
  });

  it('gives metadata for an HTTP error only', () => {
    expect(failureMetadata(new PipedriveHttpError({ status: 404, url: `${BASE}/x`, requestId: UUID }))).toEqual({
      httpStatus: 404,
      requestId: UUID,
    });
    expect(failureMetadata(new PipedriveHttpError({ status: 500, url: `${BASE}/x`, requestId: 'Jane Doe' }))).toEqual({
      httpStatus: 500,
    });
    expect(failureMetadata(new Error('boom'))).toBeUndefined();
  });
});

describe('gateway error results', () => {
  it('carry the HTTP status and the correlation id, never the body', async () => {
    const result = await gatewayAnswering(404, { 'x-correlation-id': UUID }).callTool('get_deal', { dealId: 1 });
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 404, requestId: UUID });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('Jane Doe');
    expect(serialised).not.toContain('E_NOPE');
  });

  it('carry the status and request id of a redirect, which is not followed', async () => {
    for (const status of [301, 302, 304, 307, 308]) {
      const result = await gatewayAnswering(status, { location: 'https://elsewhere.example/', 'x-correlation-id': UUID }).callTool(
        'get_deal',
        { dealId: 1 },
      );
      expect(result.isError).toBe(true);
      expect(result.failure).toEqual({ httpStatus: status, requestId: UUID });
      expect(JSON.stringify(result)).not.toContain('elsewhere');
    }
  });

  it('carry the status alone when the request id is not in the form of one', async () => {
    const result = await gatewayAnswering(403, { 'x-correlation-id': 'Jane Doe <jane@example.com>' }).callTool(
      'get_deal',
      { dealId: 1 },
    );
    expect(result.failure).toEqual({ httpStatus: 403 });
    expect(JSON.stringify(result)).not.toContain('jane@example.com');
  });

  it('drop a request id that holds a piece of the key', async () => {
    // The token's own hex-looking piece as the id: redaction changes it, and the changed value is no id.
    const result = await gatewayAnswering(500, { 'x-correlation-id': 'deadbeef00112233' }, {}, 'deadbeef00112233-tenant-kEy-Q7Q7Q7Q7Q7Q7-ZZtop').callTool(
      'get_deal',
      { dealId: 1 },
    );
    expect(result.isError).toBe(true);
    expect(result.failure).toEqual({ httpStatus: 500 });
    expect(JSON.stringify(result)).not.toContain('deadbeef0011');
  });

  it('have no metadata when the cause is not the upstream API', async () => {
    const gw = gatewayAnswering(200, {}, {});
    expect((await gw.callTool('get_deal', {})).failure).toBeUndefined();
    expect((await gw.callTool('no_such_tool', {})).failure).toBeUndefined();
    const offline = testGateway({
      apiToken: KEY,
      baseUrl: BASE,
      maxAttempts: 1,
      fetchImpl: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    const result = await offline.callTool('get_deal', { dealId: 1 });
    expect(result.isError).toBe(true);
    expect(result.failure).toBeUndefined();
  });

  it('are absent on a successful result', async () => {
    const result = await gatewayAnswering(200, { 'x-correlation-id': UUID }, { success: true, data: { id: 1, title: 'x' } }).callTool(
      'get_deal',
      { dealId: 1 },
    );
    expect(result.isError).toBeUndefined();
    expect(result.failure).toBeUndefined();
  });
});
