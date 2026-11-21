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

describe('OAuth access in the gateway', () => {
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
