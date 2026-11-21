// The rest of the threat model (README, "Threat model"), through callTool: a key that is a number and pieces of it in
// numbers, an error while reading a successful body, failures reported inside a successful body, and a result too
// deep to serialise naively. Every result must still be valid JSON.
import { describe, expect, it, vi } from 'vitest';
import { createPipedriveGateway } from '../src/gateway.js';
import { BASE, ORG_CREATED, testGateway } from './helpers.js';

const KEY = `tenant"a\\kEy-${'Q7'.repeat(10)}-ZZtop-0123456789`;
const DEEP = 20_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const failingBody = (message: string) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
        controller.error(new Error(message));
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

function stub(key: string): typeof fetch {
  return async input => {
    const path = (String(input).split('?')[0] ?? '').slice(BASE.length);
    switch (path) {
      case '/api/v1/users/me':
        return json({ success: true, data: { id: Number(key), company_id: 1, timezone_name: 'Europe/Copenhagen', default_currency: 'DKK' } });
      case '/api/v2/deals/search':
        return json({
          success: true,
          data: { items: [{ result_score: Number(key.slice(1, 7)), item: { id: 13, title: 'parts', value: Number(key) } }] },
          additional_data: { next_cursor: null },
        });
      case `/api/v2/deals/14`:
        // The vendor's text and a piece of the key shorter than six characters.
        return failingBody(`Vendor diagnostic ${key.slice(0, 5)}`);
      case `/api/v2/deals/9`:
        return json({
          success: true,
          data: { id: 9, title: 'ok' },
          metadata: { status: 401, error: `Vendor diagnostic ${key}` },
          failures: [{ status: 403, error: 'Vendor detail' }, { error: 'Vendor text' }],
        });
      case `/api/v2/deals/10`:
        return new Response(`{"success":true,"data":{"id":10},"extra":${'['.repeat(DEEP)}1${']'.repeat(DEEP)}}`, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      default:
        return json({ message: 'no stub' }, 404);
    }
  };
}

describe('the threat model, through callTool', () => {
  it('redacts a numeric key and its pieces in numbers, and the result stays valid JSON', async () => {
    const key = '1234567890123456';
    const records: unknown[] = [];
    const gw = testGateway({ apiToken: key, baseUrl: BASE, fetchImpl: stub(key), maxAttempts: 1, policy: { audit: r => void records.push(r) } });
    const connection = await gw.callTool('check_connection', {});
    expect(connection.isError).toBeUndefined();
    expect(connection.structuredContent).toEqual({
      connected: true,
      userId: '‹redacted›',
      companyId: 1,
      companyName: null,
      companyDomain: null,
      defaultCurrency: 'DKK',
      timezone: 'Europe/Copenhagen',
      locale: null,
      isAdmin: null,
    });
    const search = await gw.callTool('search_deals', { query: 'parts' });
    expect(search.isError).toBeUndefined();
    expect(search.structuredContent).toEqual({
      results: [{ id: 13, title: 'parts', value: '‹redacted›' }],
      next: null,
      note: 'Search matches in short form; get the record for all its fields.',
    });
    for (const result of [connection, search]) {
      const serialised = JSON.stringify(result);
      expect(JSON.parse(serialised)).toEqual(result);
      expect(serialised).not.toMatch(/234567|12345678/);
    }
    expect(JSON.stringify(records)).not.toMatch(/234567|12345678/);
  });

  it('turns an error while reading a successful body into a fixed text, for the host and the audit', async () => {
    const records: unknown[] = [];
    const gw = testGateway({ apiToken: KEY, baseUrl: BASE, fetchImpl: stub(KEY), maxAttempts: 1, policy: { audit: r => void records.push(r) } });
    const result = await gw.callTool('get_deal', { dealId: 14 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('The Pipedrive API response could not be read.');
    for (const value of [result, records]) {
      expect(JSON.stringify(value)).not.toContain('Vendor');
      expect(JSON.stringify(value)).not.toContain(JSON.stringify(KEY.slice(0, 5)).slice(1, -1));
    }
  });

  it('reduces failures reported inside a successful body to status-only text', async () => {
    const gw = testGateway({ apiToken: KEY, baseUrl: BASE, fetchImpl: stub(KEY), maxAttempts: 1 });
    const result = await gw.callTool('get_deal', { dealId: 9 });
    // The failure lists are reduced before the parse, which then drops them: they are not record fields.
    expect(result.structuredContent).toEqual({ id: 9, title: 'ok' });
    expect(JSON.stringify(result)).not.toContain('Vendor');
  });

  it('answers a very deep result without exhausting the stack', async () => {
    const gw = testGateway({ apiToken: KEY, baseUrl: BASE, fetchImpl: stub(KEY), maxAttempts: 1, maxResponseBytes: 1_000_000 });
    const result = await gw.callTool('get_deal', { dealId: 10 });
    expect(result.isError).toBeUndefined();
    // The deep field is not in the record schema and is dropped.
    expect(result.structuredContent).toEqual({ id: 10 });
  });
});

describe('round 5 of the threat model, through callTool', () => {
  function pieces(value: string): string[] {
    const out: string[] = [];
    for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
    return out;
  }

  it('refuses a key that overlaps the redaction marker, and redacts one that looks like the old marker', async () => {
    for (const apiToken of ['‹redacted›-0123456789', 'my-redacted-value', 'xx-dacted›-yy']) {
      expect(() => testGateway({ apiToken, baseUrl: BASE }), apiToken).toThrow(/key was refused/);
    }
    const LOOKALIKE = '[REDACTED]-0123456789';
    const records: unknown[] = [];
    const gw = testGateway({
      apiToken: LOOKALIKE,
      baseUrl: BASE,
      maxAttempts: 1,
      fetchImpl: async () => json({ echo: LOOKALIKE, [LOOKALIKE]: 1 }),
      policy: { audit: r => void records.push(r) },
    });
    const result = await gw.callTool('get_deal', { dealId: 11, echo: LOOKALIKE }, { caller: LOOKALIKE });
    const text = JSON.stringify([result, records]);
    for (const piece of pieces(LOOKALIKE)) expect(text, piece).not.toContain(piece);
  });

  it('keeps only the status of a failure object, on reads and on create_organization', async () => {
    const body = {
      metadata: { status: 401, error: 'Vendor diagnostic', message: 'Vendor message', code: 'VENDOR_CODE', detail: { more: 'Vendor' } },
      failures: [{ error: 'Vendor text', hint: 'Vendor hint' }],
    };
    const gw = testGateway({
      apiToken: KEY,
      baseUrl: BASE,
      maxAttempts: 1,
      // A read answers the record asked for (the deal, or the company read back after it is created).
      fetchImpl: async (input: unknown, init?: RequestInit) =>
        init?.method === 'POST'
          ? json({ ...body, ...ORG_CREATED })
          : json({ ...body, success: true, data: { id: Number(String(input).split('?')[0]!.split('/').pop()), title: 'ok' } }),
      policy: { enableWrites: true },
    });
    for (const result of [await gw.callTool('get_deal', { dealId: 11 }), await gw.callTool('create_organization', { name: 'n' })]) {
      expect(result.isError, JSON.stringify(result.content)).toBeUndefined();
      expect(JSON.stringify(result)).not.toMatch(/Vendor|VENDOR|metadata|failures/);
    }
  });

  it('gives our own text when the body of a failed response cannot be read', async () => {
    const records: unknown[] = [];
    const gw = testGateway({
      apiToken: KEY,
      baseUrl: BASE,
      maxAttempts: 1,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(`Vendor diagnostic ${KEY.slice(0, 5)}`));
            },
          }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        ),
      policy: { audit: r => void records.push(r) },
    });
    const result = await gw.callTool('get_deal', { dealId: 11 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^Pipedrive API request failed with HTTP 500/);
    expect(JSON.stringify([result, records])).not.toContain('Vendor');
  });

  it('redacts an audit sink failure before it reaches stderr', async () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      written.push(String(chunk));
      return true;
    });
    try {
      const gw = testGateway({
        apiToken: KEY,
        baseUrl: BASE,
        maxAttempts: 1,
        fetchImpl: async () => json({ success: true, data: { id: 11, title: 'ok' } }),
        policy: {
          audit: () => {
            throw new Error(`sink failed for ${KEY}`);
          },
        },
      });
      const result = await gw.callTool('get_deal', { dealId: 11 });
      expect(result.isError).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    const text = written.join('');
    expect(text).toContain('audit log write failed');
    for (const piece of pieces(KEY)) expect(text, piece).not.toContain(piece);
  });
});

describe('round 6 of the threat model', () => {
  function pieces(value: string): string[] {
    const out: string[] = [];
    for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
    return out;
  }

  it('refuses keys that collide with our own texts, without repeating them', () => {
    for (const apiToken of ['[nested too deep]-0123456789', 'pipedrive-mcp-0123456789', 'PIPEDRIVE_BASE_URL-0123456789']) {
      let message = '';
      try {
        testGateway({ apiToken, baseUrl: BASE });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, apiToken).toMatch(/key was refused/);
      for (const piece of pieces(apiToken)) expect(message, piece).not.toContain(piece);
    }
  });

  it('sends a construction error through the redactor, configuration values included', () => {
    const HOSTLIKE = 'fakehostzzzz1111yy';
    let message = '';
    try {
      testGateway({ apiToken: HOSTLIKE, baseUrl: `https://${HOSTLIKE}.vendor.invalid/x?y=${HOSTLIKE}`, policy: {} });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    for (const piece of pieces(HOSTLIKE)) expect(message, piece).not.toContain(piece);
  });

  it('reduces failures without an error field, by status or in a failure context', async () => {
    const gw = testGateway({
      apiToken: KEY,
      baseUrl: BASE,
      maxAttempts: 1,
      fetchImpl: async () =>
        json({
          success: true,
          data: { id: 11, title: 'ok' },
          failures: [{ status: 403, message: 'Vendor diagnostic' }],
          metadata: { status: 401, error: null, message: 'Vendor diagnostic' },
          errors: [{ message: 'Vendor diagnostic' }],
        }),
    });
    const result = await gw.callTool('get_deal', { dealId: 11 });
    expect(result.structuredContent).toEqual({ id: 11, title: 'ok' });
    expect(JSON.stringify(result)).not.toContain('Vendor');
  });

  it('names a network error code only from the fixed list', async () => {
    const gw = testGateway({
      apiToken: KEY,
      baseUrl: BASE,
      maxAttempts: 1,
      fetchImpl: async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'VENDOR_DIAGNOSTIC' }) });
      },
    });
    const result = await gw.callTool('get_deal', { dealId: 11 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toContain('VENDOR_DIAGNOSTIC');
  });
});
