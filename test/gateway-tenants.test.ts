import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_WRITES, API_KEY_HEADER, PipedriveClient } from '../src/pipedrive/client.js';
import { ConfigError } from '../src/config-env.js';
import { admitsKey, KEY_REFUSED, keyRefusedText } from '../src/key-admission.js';
import { createPipedriveGateway, pipedriveGatewayTools, pipedriveToolCatalog, type GatewayJsonObject } from '../src/gateway.js';
import { PIPEDRIVE_TOOLS, pseudonym } from '../src/tools/pipedrive.js';
import { BASE, auditLines, connect, record, stubFetch, texts, testGateway, testClient } from './helpers.js';

const originalEnv = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pipedrive-mcp-'));
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('PIPEDRIVE_')) {
      delete process.env[name];
    }
  }
});

afterEach(() => {
  process.env = { ...originalEnv };
  rmSync(dir, { recursive: true, force: true });
});

/** Placeholder credentials, built at runtime: long enough to be redacted by value. */
const fakeKey = (label: string) => `${label}-${'x'.repeat(12)}`;
// Keys with no piece of six characters in common: the redactor also removes any such piece of its own key.
const KEY_A = 'omega-0123456789-kq'; // gitleaks:allow (a test value, not a key)
const KEY_B = 'bravo-zyxwvutsrq-MP';
const ENV_KEY = 'envkey-ABCDEFGHIJ-77'; // gitleaks:allow (a test value, not a key)

/** Upstream that answers every request with an error body echoing `echo`. */
function echoingFetch(echo: string) {
  return vi.fn(
    async () =>
      new Response(`upstream rejected credentials ${echo}`, { status: 400, headers: { 'content-type': 'text/plain' } }),
  ) as unknown as typeof fetch;
}

function headersOf(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

describe('explicit gateway credentials', () => {
  it('requires the access token and ignores the environment', () => {
    process.env.PIPEDRIVE_API_TOKEN = ENV_KEY;

    for (const options of [undefined, {}, { apiToken: '' }, { apiToken: '   ' }, { apiToken: 42 }, { apiToken: null }]) {
      let caught: Error | undefined;
      try {
        createPipedriveGateway(options as never);
      } catch (error) {
        caught = error as Error;
      }
      expect(caught, JSON.stringify(options)).toBeInstanceOf(ConfigError);
      expect(caught!.message).toBe(
        'createPipedriveGateway requires options.apiToken. Embedded instances do not read credentials from the environment.',
      );
    }
  });

  it('refuses a key that is not admitted with a fixed text that holds no piece of it', () => {
    // Too short, not printable ASCII, or sharing a piece with the server's own texts.
    for (const apiToken of ['short', 'fake-token-é-aaaaaaaa', 'fake token aaaaaaaaaa', 'PIPEDRIVE_API_TOKEN-0000', 'Bearer-fake-token-aaaaaaa']) {
      let caught: Error | undefined;
      try {
        createPipedriveGateway({ apiToken, fetchImpl: echoingFetch(apiToken) });
      } catch (error) {
        caught = error as Error;
      }
      expect(caught, apiToken).toBeInstanceOf(ConfigError);
      expect(caught!.message, apiToken).toBe(keyRefusedText(apiToken));
      expect(caught!.message).toMatch(/^The key was refused/);
      for (let i = 0; i + 6 <= apiToken.length; i += 1) {
        expect(`${caught!.message} ${caught!.stack}`, apiToken).not.toContain(apiToken.slice(i, i + 6));
      }
    }
    // A key that shares nothing with the refusal gets the refusal word for word.
    expect(() => createPipedriveGateway({ apiToken: 'short' })).toThrow(KEY_REFUSED);
    expect(admitsKey(KEY_A)).toBe(true);
  });

  it('never reads credential variables from process.env, even when they are set', async () => {
    const reads = new Set<string>();
    const env = {
      ...process.env,
      PIPEDRIVE_API_TOKEN: ENV_KEY,
      PIPEDRIVE_BASE_URL: 'https://evil.test',
    };
    process.env = new Proxy(env, {
      get(target, property, receiver) {
        if (typeof property === 'string') {
          reads.add(property);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(() => createPipedriveGateway({} as never)).toThrow(/requires options\.apiToken/);

    const fetchImpl = stubFetch({ [`GET ${BASE}/api/v2/deals/12`]: { body: record('12') } });
    const gw = createPipedriveGateway({ apiToken: KEY_A, fetchImpl });
    const result = await gw.callTool('get_deal', { dealId: 12 });
    expect(result.isError).toBeUndefined();
    expect(String(fetchImpl.mock.calls[0]?.[0]).startsWith(`${BASE}/`)).toBe(true);
    expect(headersOf(fetchImpl.mock.calls[0]?.[1])[API_KEY_HEADER]).toBe(KEY_A);

    for (const name of ['PIPEDRIVE_API_TOKEN', 'PIPEDRIVE_BASE_URL']) {
      expect(reads.has(name), name).toBe(false);
    }
  });

  it('still reads the access token from the environment in the standalone client', async () => {
    process.env.PIPEDRIVE_API_TOKEN = ENV_KEY;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => Response.json({}));
    await new PipedriveClient({ fetchImpl }).get(`/api/v2/deals/1`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(headersOf(fetchImpl.mock.calls[0]?.[1])[API_KEY_HEADER]).toBe(ENV_KEY);
  });
});

describe('per-instance redaction', () => {
  it('redacts each instance’s own key in its tool results', async () => {
    const a = testGateway({ apiToken: KEY_A, baseUrl: BASE, fetchImpl: echoingFetch(KEY_A) });
    const b = testGateway({ apiToken: KEY_B, baseUrl: BASE, fetchImpl: echoingFetch(KEY_B) });

    const resultA = texts(await a.callTool('get_deal', { dealId: 12 })).join(' ');
    const resultB = texts(await b.callTool('get_deal', { dealId: 12 })).join(' ');
    // The echoing error body is never read into the result; the key is not there in any form.
    expect(resultA).not.toContain(KEY_A);
    expect(resultB).not.toContain(KEY_B);
  });

  it('keeps redactors separate: an instance holds only its own secrets', () => {
    const a = testClient({ apiToken: KEY_A, baseUrl: BASE, credentialEnv: {} });
    const b = testClient({ apiToken: KEY_B, baseUrl: BASE, credentialEnv: {} });
    expect(a.redactor.hasSecret(KEY_A)).toBe(true);
    expect(a.redactor.hasSecret(KEY_B)).toBe(false);
    expect(b.redactor.hasSecret(KEY_B)).toBe(true);
    expect(b.redactor.hasSecret(KEY_A)).toBe(false);
    // B neither knows nor needs A's key: its text is only redacted for its own.
    expect(b.redactor.redact(`a=${KEY_A} b ${KEY_B}`)).toBe(`a=${KEY_A} b ‹redacted›`);
  });

  it('does not accumulate keys of earlier instances', () => {
    for (let index = 0; index < 200; index += 1) {
      testGateway({ apiToken: `short-lived-key-${index}`, baseUrl: BASE });
    }
    const fresh = testClient({ apiToken: KEY_A, baseUrl: BASE, credentialEnv: {} });
    expect(fresh.redactor.redact('short-lived-key-7')).toBe('short-lived-key-7');
  });

  it('redacts audit records with the key of the instance that ran the call', async () => {
    process.env.PIPEDRIVE_AUDIT_LOG = join(dir, 'audit.jsonl');
    const failing = (key: string) =>
      vi.fn(async () => {
        throw new TypeError(`connection refused while sending ${key}`);
      }) as unknown as typeof fetch;
    const a = testGateway({ apiToken: KEY_A, baseUrl: BASE, fetchImpl: failing(KEY_A), maxAttempts: 1 });
    const b = testGateway({ apiToken: KEY_B, baseUrl: BASE, fetchImpl: failing(KEY_B), maxAttempts: 1 });
    await a.callTool('get_deal', { dealId: 12 }, { requestId: 'a' });
    await b.callTool('get_deal', { dealId: 12 }, { requestId: 'b' });

    const errors = auditLines(process.env.PIPEDRIVE_AUDIT_LOG).filter(line => line.action === 'error');
    expect(errors.map(line => line.requestId)).toEqual([pseudonym('a'), pseudonym('b')]);
    const log = JSON.stringify(errors);
    expect(log).not.toContain(KEY_A);
    expect(log).not.toContain(KEY_B);
  });

  it('redacts with the server client’s key on the MCP path', async () => {
    const tool = PIPEDRIVE_TOOLS.find(t => t.name === 'pipedrive_get_deal')!;
    const original = tool.handler;
    tool.handler = async () => {
      throw new Error('failed with test-api-key');
    };
    try {
      const { mcpClient } = await connect();
      const result = await mcpClient.callTool({ name: 'pipedrive_get_deal', arguments: { dealId: 12 } });
      expect(texts(result).join(' ')).not.toContain('test-api-key');
    } finally {
      tool.handler = original;
    }
  });

  it('lets a dropped instance and its key be garbage collected', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    let gateway: ReturnType<typeof createPipedriveGateway> | undefined = testGateway({
      apiToken: fakeKey('collectable'),
      baseUrl: BASE,
    });
    const ref = new WeakRef(gateway);
    gateway = undefined;
    for (let attempt = 0; attempt < 10 && ref.deref(); attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
      gc();
    }
    expect(ref.deref()).toBeUndefined();
  });
});

/** Sample input per tool, used to check each tool's declared upstream requests. */
const SAMPLE_INPUTS: Record<string, GatewayJsonObject> = {
  check_connection: {},
  list_users: {},
  list_pipelines: {},
  search_deals: { pipelineId: 1, stageId: 2, status: 'open', updatedSince: '2026-01-01' },
  get_deal: { dealId: 23 },
  search_persons: { query: 'Hansen', orgId: 22 },
  get_person: { personId: 21 },
  search_organizations: { query: 'Eksempel' },
  get_organization: { orgId: 22 },
  list_activities: { dealId: 23, done: false },
  list_notes: { dealId: 23 },
  create_deal: { title: 'Ny aftale', value: 1000, currency: 'DKK', personId: 21, orgId: 22, expectedCloseDate: '2026-06-30' },
  update_deal: { dealId: 23, status: 'won' },
  move_deal: { dealId: 23, stageId: 3 },
  create_person: { name: 'Ny Kontakt', email: 'kontakt@eksempel.test', orgId: 22 },
  update_person: { personId: 21, phone: '+45 11 22 33 44' },
  create_organization: { name: 'Nyt firma', address: 'Eksempelvej 1, 8000 Aarhus' },
  update_organization: { orgId: 22, ownerId: 7 },
  create_activity: { subject: 'Ring tilbage', type: 'call', dueDate: '2026-11-23', dealId: 23 },
  update_activity: { activityId: 25, done: true },
  add_note: { on: 'organization', recordId: 22, content: 'Ringede i dag.' },
  update_note: { noteId: 26, content: 'Ringede i dag kl. 14.' },
};

/** The id a created record gets in catalogFetch. */
const CREATED_ID = '9';

/** Answers that let every tool run to its end: the record asked for, an empty list, the created record. */
async function catalogFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const path = new URL(String(input)).pathname;
  const method = init?.method ?? 'GET';
  if (path === '/api/v1/users/me') return Response.json({ success: true, data: { id: 1, company_id: 2, default_currency: 'DKK' } });
  if (path === '/api/v1/users' || path === '/api/v1/notes' && method === 'GET') return Response.json({ success: true, data: [] });
  if (/\/search$/.test(path)) return Response.json({ success: true, data: { items: [] }, additional_data: { next_cursor: null } });
  if (method === 'POST') return Response.json({ success: true, data: { id: Number(CREATED_ID) } });
  if (/^\/api\/v2\/\w+$/.test(path)) return Response.json({ success: true, data: [], additional_data: { next_cursor: null } });
  const id = /^\/api\/v[12]\/\w+\/(\d+)$/.exec(path)?.[1];
  if (id) return Response.json(record(id));
  return Response.json({ message: 'no stub' }, { status: 404 });
}

/** A declared path template with the sample's values: an id not in the input is the created record's. */
function fill(template: string, input: GatewayJsonObject): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(String(input[name] ?? CREATED_ID)));
}

describe('tool catalog', () => {
  it('lists every registered tool, matching the gateway definitions', async () => {
    expect(pipedriveToolCatalog.map(entry => entry.name)).toEqual(pipedriveGatewayTools.map(tool => tool.name));
    for (const entry of pipedriveToolCatalog) {
      const { upstream, broad, requiresConfirmation, change, ...definition } = entry;
      expect(typeof requiresConfirmation).toBe('boolean');
      expect(change === undefined).toBe(entry.riskLevel === 'read');
      if (requiresConfirmation) expect(entry.riskLevel).toBe('write');
      expect(typeof broad).toBe('boolean');
      if (broad) expect(entry.riskLevel).toBe('read');
      expect(definition).toEqual(pipedriveGatewayTools.find(tool => tool.name === entry.name));
      expect(upstream.length).toBeGreaterThan(0);
      for (const operation of upstream) {
        // A read is a GET; a write is on the client's fixed list.
        const path = operation.path.replace(/\{\w+\}/g, '1');
        if (operation.access === 'read') {
          expect(operation.method, operation.path).toBe('GET');
        } else {
          expect(ALLOWED_WRITES.some(write => write.method === operation.method && write.path.test(path)), operation.path).toBe(true);
        }
        if (entry.riskLevel === 'read') {
          expect(operation.access).toBe('read');
        }
      }
    }

    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(
      pipedriveToolCatalog.map(entry => `pipedrive_${entry.name}`).sort(),
    );
    for (const tool of tools) {
      const entry = pipedriveToolCatalog.find(e => `pipedrive_${e.name}` === tool.name)!;
      expect(entry.title).toBe(tool.title);
      expect(entry.description).toBe(tool.description);
      expect(Object.keys(entry.inputSchema.properties as object).sort()).toEqual(
        Object.keys(tool.inputSchema.properties ?? {}).sort(),
      );
    }
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(pipedriveToolCatalog)).toBe(true);
    const visit = (value: unknown) => {
      if (typeof value === 'object' && value !== null) {
        expect(Object.isFrozen(value)).toBe(true);
        Object.values(value).forEach(visit);
      }
    };
    visit(pipedriveToolCatalog);
    expect(() => {
      (pipedriveToolCatalog[0] as { name: string }).name = 'changed';
    }).toThrow(TypeError);
  });

  it('declares exactly the upstream requests each tool makes', async () => {
    process.env.PIPEDRIVE_ENABLE_WRITES = 'true';
    for (const entry of pipedriveToolCatalog) {
      const input = SAMPLE_INPUTS[entry.name];
      expect(input, `sample input for ${entry.name}`).toBeDefined();
      const fetchImpl = vi.fn(catalogFetch);
      const gw = testGateway({ apiToken: KEY_A, fetchImpl });
      const result = await gw.callTool(entry.name, input!);
      expect(result.isError, texts(result).join(' ')).toBeUndefined();

      const declared = entry.upstream.map(op => ({ method: op.method, path: fill(op.path, input!) }));
      const made = (fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>).map(([url, init]) => ({
        method: init.method,
        path: new URL(url).pathname,
      }));
      expect(made.length, entry.name).toBeGreaterThan(0);
      for (const request of made) {
        expect(declared, `${entry.name} made ${request.method} ${request.path}`).toContainEqual(request);
      }
    }
  });
});
