import { readFileSync } from 'node:fs';
import { vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PipedriveClient } from '../src/pipedrive/client.js';
import { createPipedriveGateway, type PipedriveGatewayOptions } from '../src/gateway.js';
import { createServer } from '../src/server.js';

export const BASE = 'https://api.pipedrive.com';

/**
 * Options in the shape the shared tests were written in (`apiToken`,
 * `baseUrl`, `fetchImpl`) as Pipedrive options: the documented address is the
 * default, so it is left out; another one is passed on, so a test of a
 * refused address still runs.
 */
type TestOptions = Omit<Partial<PipedriveGatewayOptions>, 'fetchImpl'> & {
  apiToken?: string;
  baseUrl?: string;
  allowCustomBaseUrl?: boolean;
  fetchImpl?: unknown;
  credentialEnv?: Record<string, string | undefined>;
};

function pipedriveOptions(options: TestOptions): Record<string, unknown> {
  const { baseUrl, ...rest } = options;
  return { ...(baseUrl === undefined || baseUrl === BASE ? {} : { baseUrl }), ...rest };
}

export function testGateway(options: TestOptions) {
  return createPipedriveGateway(pipedriveOptions(options) as never);
}

export function testClient(options: TestOptions) {
  return new PipedriveClient(pipedriveOptions(options) as never);
}

export type Stub = { status?: number; body?: unknown; raw?: string };

/** A fetch stub keyed by "METHOD URL" (URL without query string). Unknown routes answer 404. */
export function stubFetch(routes: Record<string, Stub>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).split('?')[0] ?? '';
    const stub = routes[`${init?.method ?? 'GET'} ${url}`];
    if (!stub) {
      return new Response(JSON.stringify({ message: `no stub for ${url}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (stub.raw !== undefined) {
      return new Response(stub.raw, { status: stub.status ?? 200, headers: { 'content-type': 'text/plain' } });
    }
    return new Response(JSON.stringify(stub.body), {
      status: stub.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

export function makeClient(fetchImpl: unknown) {
  return testClient({ apiToken: 'test-api-key', fetchImpl });
}

export async function connect(routes: Record<string, Stub> = {}) {
  const fetchImpl = stubFetch(routes);
  const server = createServer({ client: makeClient(fetchImpl) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);
  return { mcpClient, fetchImpl };
}

export function gateway(routes: Record<string, Stub> = {}) {
  const fetchImpl = stubFetch(routes);
  const gw = testGateway({ apiToken: 'tttt-gggg-wwww-vvvv-1', fetchImpl });
  return { gw, fetchImpl };
}

export function texts(result: unknown): string[] {
  return (((result as { content?: unknown }).content ?? []) as Array<{ text: string }>).map(c => c.text);
}

export function auditLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);
}


/** What POST /api/v2/organizations answers for the organization the shared tests create. */
export const ORG_CREATED = { success: true, data: { id: 2, name: 'n' } };

/** What GET /api/v2/{type}/{id} answers for a record the shared tests read. */
export function record(id: string, fields: Record<string, string | number | null> = {}) {
  return {
    success: true,
    data: { id: Number(id), ...fields, add_time: '2026-11-01T10:00:00Z', update_time: '2026-11-02T10:00:00Z' },
  };
}
