import { describe, expect, it, vi } from 'vitest';
import { PipedriveClient, PipedriveTokenError, TOKEN_URL, refreshTokenSecret, type PipedriveClientOptions } from '../src/pipedrive/client.js';
import { createPipedriveGateway } from '../src/gateway.js';

// Placeholder values with little entropy: obviously not real credentials.
const CLIENT_ID = 'app-client-id-1';
const CLIENT_SECRET = 'cccc-ssss-eeee-tttt-1'; // gitleaks:allow (a test value)
// The form Pipedrive's refresh tokens are said to have (<company id>:<user id>:<secret>); the ids are not secret.
const REFRESH = '7001:7002:rrrr-ffff-rrrr-ffff-2'; // gitleaks:allow (a test value)
const ACCESS_1 = 'v1u:aaaa-cccc-aaaa-cccc-3'; // gitleaks:allow (a test value)
const ACCESS_2 = 'v1u:bbbb-dddd-bbbb-dddd-4'; // gitleaks:allow (a test value)
const DOMAIN = 'https://demofirma.pipedrive.com';
const BASIC = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;

type Call = { url: string; init: RequestInit | undefined };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A Pipedrive stand-in: the token endpoint hands out the given access tokens in turn; the API answers with `api`. */
function pipedrive(options: { tokens?: string[]; tokenStatus?: number; api?: (url: string, auth: string) => Response; rotate?: string }) {
  const calls: Call[] = [];
  const tokens = [...(options.tokens ?? [ACCESS_1, ACCESS_2])];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === TOKEN_URL) {
      if (options.tokenStatus) return new Response('{"error":"invalid_grant","echo":"' + REFRESH + '"}', { status: options.tokenStatus });
      return json({
        access_token: tokens.shift(),
        token_type: 'Bearer',
        refresh_token: options.rotate ?? REFRESH,
        scope: 'base,deals:full',
        expires_in: 3599,
        api_domain: DOMAIN,
      });
    }
    const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
    return options.api ? options.api(url, auth) : json({ success: true, data: { id: 7002, name: 'Sælger Demo' } });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function client(fetchImpl: typeof fetch, extra: Partial<PipedriveClientOptions> = {}) {
  return new PipedriveClient({
    oauth: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH },
    baseUrl: DOMAIN,
    fetchImpl,
    credentialEnv: {},
    sleep: async () => undefined,
    ...extra,
  });
}

describe('OAuth access in the client', () => {
  it('renews at the token endpoint with Basic auth and sends the access token as Bearer to the company address', async () => {
    const p = pipedrive({});
    const c = client(p.fetchImpl);
    await c.get('/api/v1/users/me');
    expect(p.calls).toHaveLength(2);
    const [token, api] = p.calls as [Call, Call];
    expect(token.url).toBe('https://oauth.pipedrive.com/oauth/token');
    expect(token.init?.method).toBe('POST');
    expect((token.init?.headers as Record<string, string>).Authorization).toBe(BASIC);
    expect(String(token.init?.body)).toBe(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: REFRESH }).toString());
    expect(token.init?.redirect).toBe('manual');
    expect(api.url).toBe(`${DOMAIN}/api/v1/users/me`);
    expect((api.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS_1}`);
    expect(api.init?.headers).not.toHaveProperty('x-api-token');
    // Nothing secret in any address.
    for (const call of p.calls) expect(call.url).not.toMatch(/rrrr|cccc|aaaa/);
  });

  it('keeps the access token for its lifetime and renews it shortly before it runs out', async () => {
    let now = 1_000_000;
    const p = pipedrive({});
    const c = client(p.fetchImpl, { now: () => now });
    await c.get('/api/v2/deals');
    await c.get('/api/v2/deals');
    expect(p.calls.filter(call => call.url === TOKEN_URL)).toHaveLength(1);
    now += 3599_000 - 30_000;
    await c.get('/api/v2/deals');
    expect(p.calls.filter(call => call.url === TOKEN_URL)).toHaveLength(2);
    expect((p.calls.at(-1)?.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS_2}`);
  });

  it('renews once and sends again when Pipedrive does not take the access token', async () => {
    const p = pipedrive({ api: (_url, auth) => (auth === `Bearer ${ACCESS_1}` ? json({ success: false }, 401) : json({ success: true, data: [] })) });
    const c = client(p.fetchImpl);
    await expect(c.get('/api/v2/deals')).resolves.toEqual({ success: true, data: [] });
    expect(p.calls.map(call => call.url)).toEqual([TOKEN_URL, `${DOMAIN}/api/v2/deals`, TOKEN_URL, `${DOMAIN}/api/v2/deals`]);
  });

  it('a refused refresh is an access error in our own words, as a 401, and never quotes the answer', async () => {
    const p = pipedrive({ tokenStatus: 400 });
    const c = client(p.fetchImpl);
    const error = await c.get('/api/v2/deals').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PipedriveTokenError);
    expect((error as Error).message).toMatch(/^Pipedrive API request failed with HTTP 401 \| /);
    expect((error as Error).message).not.toMatch(/invalid_grant|rrrr/);
    // Only the token endpoint was asked; no request went to the API without access.
    expect(p.calls).toHaveLength(1);
  });

  it('uses a new refresh token if Pipedrive ever hands one out, and tells the host', async () => {
    const rotated = '7001:7002:nnnn-eeee-wwww-rrrr-5'; // gitleaks:allow (a test value)
    const seen: string[] = [];
    const p = pipedrive({ rotate: rotated });
    const c = client(p.fetchImpl, { onRefreshToken: token => void seen.push(token) });
    await c.get('/api/v2/deals');
    expect(seen).toEqual([rotated]);
  });

  it('sends nothing but to the company address and oauth.pipedrive.com', () => {
    const p = pipedrive({});
    for (const baseUrl of [
      'https://api.pipedrive.com',
      'https://oauth.pipedrive.com',
      'http://demofirma.pipedrive.com',
      'https://demofirma.pipedrive.com.evil.test',
      'https://evil.test',
      'https://demofirma.pipedrive.com:8443',
      'https://demofirma.pipedrive.com/api',
      'https://user:pw@demofirma.pipedrive.com',
      'https://a.b.pipedrive.com',
    ]) {
      expect(() => client(p.fetchImpl, { baseUrl }), baseUrl).toThrow();
    }
    expect(() => client(p.fetchImpl, { tokenUrl: 'https://evil.test/oauth/token' })).toThrow();
    expect(() => client(p.fetchImpl, { baseUrl: undefined })).toThrow(/company address/);
    expect(() => client(p.fetchImpl, { baseUrl: 'https://DemoFirma.pipedrive.com' })).not.toThrow();
  });

  it('treats only the secret part of a refresh token of the form <id>:<id>:<secret> as secret', () => {
    expect(refreshTokenSecret(REFRESH)).toBe('rrrr-ffff-rrrr-ffff-2');
    expect(refreshTokenSecret('no-colons-in-this-token-6')).toBe('no-colons-in-this-token-6');
    const c = client(pipedrive({}).fetchImpl);
    expect(c.redactor.redact(`id 7002 and ${REFRESH}`)).not.toContain('rrrr-ffff');
    expect(c.redactor.redact('owner 7002 in company 7001')).toBe('owner 7002 in company 7001');
  });
});

describe('OAuth access: more cases', () => {
  it('asks the token endpoint once for calls made at the same time', async () => {
    const p = pipedrive({});
    const c = client(p.fetchImpl);
    await Promise.all([c.get('/api/v2/deals'), c.get('/api/v2/persons'), c.get('/api/v2/activities')]);
    expect(p.calls.filter(call => call.url === TOKEN_URL)).toHaveLength(1);
  });

  it('gives up with the 401 when the renewed access is not taken either', async () => {
    const p = pipedrive({ api: () => json({ success: false }, 401) });
    const c = client(p.fetchImpl);
    await expect(c.get('/api/v2/deals')).rejects.toMatchObject({ status: 401 });
    expect(p.calls.filter(call => call.url === TOKEN_URL)).toHaveLength(2);
    expect(p.calls.filter(call => call.url !== TOKEN_URL)).toHaveLength(2);
  });

  it('renews and sends a change again after a 401, since nothing was done', async () => {
    const p = pipedrive({
      api: (_url, auth) => (auth === `Bearer ${ACCESS_1}` ? json({ success: false }, 401) : json({ success: true, data: { id: 5 } })),
    });
    const c = client(p.fetchImpl);
    await expect(c.patch('/api/v2/deals/5', { title: 'Ny' })).resolves.toEqual({ success: true, data: { id: 5 } });
    const writes = p.calls.filter(call => call.url === `${DOMAIN}/api/v2/deals/5`);
    expect(writes).toHaveLength(2);
    expect(writes.map(w => w.init?.method)).toEqual(['PATCH', 'PATCH']);
  });

  it('follows no redirect from the token endpoint or the company address', async () => {
    const fromToken = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }));
    await expect(client(fromToken as unknown as typeof fetch).get('/api/v2/deals')).rejects.toThrow(/redirect/);
    expect(fromToken).toHaveBeenCalledTimes(1);
    const p = pipedrive({ api: () => new Response(null, { status: 301, headers: { location: 'https://evil.test/' } }) });
    await expect(client(p.fetchImpl).get('/api/v2/deals')).rejects.toThrow(/redirect/);
    expect(p.calls.every(call => call.url === TOKEN_URL || call.url.startsWith(DOMAIN))).toBe(true);
  });

  it('keeps every access token it was given a secret for as long as it lives', async () => {
    let now = 0;
    const tokens = ['v1u:aaaa-1111-aaaa-1111-x', 'v1u:bbbb-2222-bbbb-2222-y', 'v1u:cccc-3333-cccc-3333-z', 'v1u:dddd-4444-dddd-4444-w']; // gitleaks:allow
    const p = pipedrive({ tokens: [...tokens] });
    const c = client(p.fetchImpl, { now: () => now });
    for (let i = 0; i < 4; i += 1) {
      await c.get('/api/v2/deals');
      now += 3_600_000;
    }
    for (const token of tokens) expect(c.redactor.redact(`caller ${token}`)).not.toContain(token.slice(4, 14));
  });

  it('does not use an access token that shares a piece with its own texts, and asks again', async () => {
    const p = pipedrive({ tokens: ['v1u:content-answer-redact-q', ACCESS_1] });
    const c = client(p.fetchImpl);
    await c.get('/api/v2/deals');
    expect(p.calls.filter(call => call.url === TOKEN_URL)).toHaveLength(2);
    expect((p.calls.at(-1)?.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS_1}`);
  });

  it('gives up after three such tokens without sending anything to the API', async () => {
    const p = pipedrive({ tokens: ['v1u:content-1111-qqqq-q', 'v1u:content-2222-qqqq-q', 'v1u:content-3333-qqqq-q'] });
    const c = client(p.fetchImpl);
    await expect(c.get('/api/v2/deals')).rejects.toThrow(/cannot keep apart/);
    expect(p.calls.every(call => call.url === TOKEN_URL || call.url === 'https://oauth.pipedrive.com/oauth/revoke')).toBe(true);
    expect(p.calls.filter(call => call.url.endsWith('/oauth/revoke'))).toHaveLength(3);
  });
});

describe('OAuth access in the gateway', () => {
  const access = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH, apiDomain: DOMAIN };

  for (const refused of ['v1u:content-1111-qqqq-q', 'v1u:redact-answer-qqqq-q']) {
    it(`an access token that shares a piece with its own texts (${refused.slice(4, 10)}) is not used, and the answer keeps its form`, async () => {
      const p = pipedrive({ tokens: [refused, ACCESS_1], api: () => json({ success: true, data: { id: 7002, name: 'Sælger Demo', company_id: 7001 } }) });
      const records: unknown[] = [];
      const gateway = createPipedriveGateway({ oauth: access, fetchImpl: p.fetchImpl, policy: { audit: record => void records.push(record) } });
      const result = await gateway.callTool('check_connection', {}, { caller: 'demo-caller' } as never);
      expect(result.isError).toBeFalsy();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0]?.type).toBe('text');
      expect(result.structuredContent).toBeDefined();
      expect(JSON.stringify(result.structuredContent)).toContain('7002');
      // Taken back at Pipedrive, and never sent to the API.
      expect(p.calls.some(call => call.url === 'https://oauth.pipedrive.com/oauth/revoke' && String(call.init?.body).includes('token_type_hint=access_token'))).toBe(true);
      for (const call of p.calls.filter(c => c.url.startsWith(DOMAIN))) {
        expect((call.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACCESS_1}`);
      }
      expect(JSON.stringify(records)).not.toMatch(/aaaa-cccc|rrrr-ffff|cccc-ssss/);
    });
  }

  it('keeps earlier access tokens out of answers and audit records', async () => {
    const tokens = ['v1u:aaaa-1111-aaaa-1111-x', 'v1u:bbbb-2222-bbbb-2222-y']; // gitleaks:allow
    let call = 0;
    const p = pipedrive({
      tokens: [...tokens],
      // The first access token is refused once, so the instance holds two; Pipedrive then echoes the first.
      api: () => (call++ === 0 ? json({ success: false }, 401) : json({ success: true, data: { id: 7002, name: `echo ${tokens[0]}`, company_id: 7001 } })),
    });
    const records: unknown[] = [];
    const gateway = createPipedriveGateway({ oauth: access, fetchImpl: p.fetchImpl, policy: { audit: record => void records.push(record) } });
    const result = await gateway.callTool('check_connection', {});
    expect(JSON.stringify(result)).not.toMatch(/aaaa-1111|bbbb-2222/);
    expect(JSON.stringify(records)).not.toMatch(/aaaa-1111|bbbb-2222/);
  });

  it('redacts the secrets when Pipedrive echoes them in an answer', async () => {
    const p = pipedrive({
      api: () => json({ success: true, data: { id: 7002, name: `echo ${ACCESS_1} ${REFRESH} ${CLIENT_SECRET}`, company_id: 7001 } }),
    });
    const gateway = createPipedriveGateway({
      oauth: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH, apiDomain: DOMAIN },
      fetchImpl: p.fetchImpl,
    });
    const result = await gateway.callTool('check_connection', {});
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/aaaa-cccc|rrrr-ffff|cccc-ssss/);
  });

  const oauth = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH, apiDomain: DOMAIN };

  it('calls the user’s company address, and an owner id that is also in the refresh token comes through', async () => {
    const p = pipedrive({ api: () => json({ success: true, data: { id: 7002, name: 'Sælger Demo', email: 'demo@example.test', company_id: 7001 } }) });
    const gateway = createPipedriveGateway({ oauth, fetchImpl: p.fetchImpl });
    const result = await gateway.callTool('check_connection', {});
    expect(result.isError).toBeFalsy();
    expect(p.calls[0]?.url).toBe(TOKEN_URL);
    expect(p.calls[1]?.url.startsWith(`${DOMAIN}/api/v1/users/me`)).toBe(true);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/rrrr-ffff|cccc-ssss|aaaa-cccc/);
  });

  it('a refused refresh comes out as the 401 answer', async () => {
    const p = pipedrive({ tokenStatus: 401 });
    const gateway = createPipedriveGateway({ oauth, fetchImpl: p.fetchImpl });
    const result = await gateway.callTool('check_connection', {});
    expect(result.isError).toBe(true);
    const first = result.content[0];
    expect(first?.type === 'text' ? first.text : '').toMatch(/^Pipedrive API request failed with HTTP 401/);
  });

  it('refuses a missing or wrong company address, both kinds of access at once, and another base URL', () => {
    const p = pipedrive({});
    expect(() => createPipedriveGateway({ oauth: { ...oauth, apiDomain: 'https://api.pipedrive.com' }, fetchImpl: p.fetchImpl })).toThrow(/company address/);
    expect(() => createPipedriveGateway({ oauth: { ...oauth, apiDomain: '' }, fetchImpl: p.fetchImpl })).toThrow();
    expect(() => createPipedriveGateway({ oauth: { ...oauth, clientSecret: '' }, fetchImpl: p.fetchImpl })).toThrow();
    expect(() => createPipedriveGateway({ oauth, apiToken: 'pppp-dddd-rrrr-vvvv-1', fetchImpl: p.fetchImpl })).toThrow(/not both/);
    expect(() => createPipedriveGateway({ oauth, baseUrl: 'https://api.pipedrive.com', fetchImpl: p.fetchImpl })).toThrow(/baseUrl/);
    expect(() => createPipedriveGateway({ oauth, tokenUrl: 'https://evil.test', fetchImpl: p.fetchImpl } as never)).not.toThrow();
  });

  it('never quotes a secret in a refusal', () => {
    const p = pipedrive({});
    let caught: Error | undefined;
    try {
      createPipedriveGateway({ oauth: { ...oauth, clientSecret: 'zq9w' }, fetchImpl: p.fetchImpl });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toBeDefined();
    expect(caught?.message).not.toContain('zq9w');
    expect(caught?.message).not.toContain('rrrr-ffff');
  });
});
