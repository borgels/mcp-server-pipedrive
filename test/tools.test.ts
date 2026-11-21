import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpstreamClient } from '../src/pipedrive/client.js';
import { createServer, getDefaultClient } from '../src/server.js';
import { createPipedriveGateway, pipedriveGatewayTools } from '../src/gateway.js';
import { PIPEDRIVE_TOOLS, executeTool, validateStartupConfig, pseudonym } from '../src/tools/pipedrive.js';
import { BASE, auditLines, connect, gateway, makeClient, record, texts, testGateway, ORG_CREATED } from './helpers.js';

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

/** A deal as Pipedrive answers it, with a field that is not on the fixed list. */
const item = { ...record('12', { title: 'First deal', value: 1000, custom_secret: 'not passed on' }), extra: 'dropped' };
/** The deal as the tools give it on: the fixed fields only. */
const itemOut = {
  id: 12,
  title: 'First deal',
  value: 1000,
  add_time: item.data.add_time,
  update_time: item.data.update_time,
};
const created = ORG_CREATED;

describe('MCP tool surface', () => {
  it('registers every tool with matching annotations', async () => {
    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(PIPEDRIVE_TOOLS.map(t => t.name).sort());
    for (const tool of tools) {
      const definition = PIPEDRIVE_TOOLS.find(t => t.name === tool.name);
      expect(tool.annotations).toEqual(definition?.annotations);
    }
  });

  it('runs the read tool and labels upstream content as data', async () => {
    const { mcpClient, fetchImpl } = await connect({ [`GET ${BASE}/api/v2/deals/12`]: { body: item } });
    const result = await mcpClient.callTool({ name: 'pipedrive_get_deal', arguments: { dealId: 12 } });
    expect(result.isError).toBeFalsy();
    const [json, note] = texts(result);
    expect(JSON.parse(json ?? '')).toEqual(itemOut);
    expect(note).toContain('not instructions');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown arguments and path traversal', async () => {
    const { mcpClient, fetchImpl } = await connect();
    const extra = await mcpClient.callTool({ name: 'pipedrive_get_deal', arguments: { dealId: 12, other: 1 } });
    expect(extra.isError).toBe(true);
    const traversal = await mcpClient.callTool({ name: 'pipedrive_get_deal', arguments: { dealId: '-1' } });
    expect(traversal.isError).toBe(true);
    const slash = await mcpClient.callTool({ name: 'pipedrive_get_deal', arguments: { dealId: 'a/b' } });
    expect(slash.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses the write tool unless writes are enabled, without calling upstream', async () => {
    const { mcpClient, fetchImpl } = await connect();
    const result = await mcpClient.callTool({ name: 'pipedrive_create_organization', arguments: { name: 'Testfirma' } });
    expect(result.isError).toBe(true);
    expect(texts(result).join(' ')).toContain('PIPEDRIVE_ENABLE_WRITES');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('runs the write tool when enabled and audits it', async () => {
    process.env.PIPEDRIVE_ENABLE_WRITES = 'true';
    process.env.PIPEDRIVE_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { mcpClient, fetchImpl } = await connect({
      [`POST ${BASE}/api/v2/organizations`]: {
        status: 201,
        body: { success: true, data: { id: 2, name: 'Nyt firma', owner_id: 7, address: { value: 'Eksempelvej 1' } } },
      },
    });
    const result = await mcpClient.callTool({
      name: 'pipedrive_create_organization',
      arguments: { name: 'Nyt firma', address: 'Eksempelvej 1', ownerId: 7 },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(texts(result)[0] ?? '')).toEqual({
      created: true,
      id: 2,
      record: { id: 2, name: 'Nyt firma', owner_id: 7, address: { value: 'Eksempelvej 1' } },
    });
    const [post] = fetchImpl.mock.calls.map(([url, init]) => ({ url: String(url), init }));
    expect(post?.init?.method).toBe('POST');
    // The input fields as Pipedrive's fields, nothing else.
    expect(JSON.parse(String(post?.init?.body))).toEqual({ name: 'Nyt firma', address: { value: 'Eksempelvej 1' }, owner_id: 7 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const lines = auditLines(process.env.PIPEDRIVE_AUDIT_LOG);
    expect(lines.map(line => line.action)).toEqual(['start', 'finish']);
    expect(lines[0]?.requestId).toBe(lines[1]?.requestId);
    // The name and the address are not logged at all; ids are.
    expect(JSON.stringify(lines)).not.toContain('Nyt firma');
    expect(JSON.stringify(lines)).not.toContain('Eksempelvej');
    expect(lines[0]?.target).toEqual({ ownerId: 7 });
  });

  it('refuses an unwritable audit log path at startup, but not per server instance', async () => {
    process.env.PIPEDRIVE_AUDIT_LOG = join(dir, 'missing-dir', 'audit.jsonl');
    expect(() => validateStartupConfig()).toThrow('PIPEDRIVE_AUDIT_LOG');
    expect(() => testGateway({ apiToken: 'tttt-gggg-wwww-vvvv-1', baseUrl: BASE })).toThrow('PIPEDRIVE_AUDIT_LOG');

    // The HTTP transport creates a server per request: read tools keep working.
    const { mcpClient } = await connect({ [`GET ${BASE}/api/v2/deals/12`]: { body: item } });
    const result = await mcpClient.callTool({ name: 'pipedrive_get_deal', arguments: { dealId: 12 } });
    expect(result.isError).toBeFalsy();
  });

  it('fails closed when the audit log cannot be written before a write', async () => {
    process.env.PIPEDRIVE_ENABLE_WRITES = 'true';
    const { mcpClient, fetchImpl } = await connect({ [`POST ${BASE}/api/v2/organizations`]: { body: created } });
    // The log becomes unwritable after startup.
    process.env.PIPEDRIVE_AUDIT_LOG = join(dir, 'missing-dir', 'audit.jsonl');
    const result = await mcpClient.callTool({ name: 'pipedrive_create_organization', arguments: { name: 'Testfirma' } });
    expect(result.isError).toBe(true);
    expect(texts(result).join(' ')).toContain('Audit log is not writable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('removes disabled tools and refuses unknown names', async () => {
    process.env.PIPEDRIVE_DISABLED_TOOLS = 'create_organization,pipedrive_get_deal';
    const { mcpClient } = await connect();
    const { tools } = await mcpClient.listTools();
    expect(tools.map(t => t.name)).not.toContain('pipedrive_create_organization');
    expect(tools.map(t => t.name)).not.toContain('pipedrive_get_deal');
    expect(tools).toHaveLength(PIPEDRIVE_TOOLS.length - 2);

    process.env.PIPEDRIVE_DISABLED_TOOLS = 'no_such_tool';
    expect(() => createServer({ clientOptions: { apiToken: 'fake-token-aaaaaaaaaaaa' } })).toThrow('PIPEDRIVE_DISABLED_TOOLS');
  });

  it('logs only a summary of upstream errors', async () => {
    process.env.PIPEDRIVE_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { mcpClient } = await connect({
      [`GET ${BASE}/api/v2/deals/12`]: { status: 400, body: { message: 'bad value: jane@vendor.test' } },
    });
    const result = await mcpClient.callTool({ name: 'pipedrive_get_deal', arguments: { dealId: 12 } });
    expect(result.isError).toBe(true);
    const lines = auditLines(process.env.PIPEDRIVE_AUDIT_LOG);
    expect(lines.at(-1)).toMatchObject({ action: 'error', httpStatus: 400 });
    expect(JSON.stringify(lines)).not.toContain('jane@');
  });
});

describe('write gate beyond annotations', () => {
  it('gives read-only tools a client that refuses writes: only GET goes out', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    const client = makeClient(fetchImpl);
    const readTool = PIPEDRIVE_TOOLS.find(t => t.name === 'pipedrive_get_deal')!;
    const misannotated = (handler: (c: UpstreamClient) => Promise<unknown>) => ({ ...readTool, handler });
    await expect(
      executeTool(misannotated(c => c.post('/api/v2/persons', { properties: {} })), client, { dealId: 12 }),
    ).rejects.toThrow(/Read-only tool .* POST/);
    await expect(
      executeTool(misannotated(c => c.patch('/api/v2/deals/12', { properties: {} })), client, { dealId: 12 }),
    ).rejects.toThrow(/Read-only tool .* PATCH/);
    await expect(
      executeTool(misannotated(c => c.put('/api/v1/notes/12', { content: 'x' })), client, { dealId: 12 }),
    ).rejects.toThrow(/Read-only tool .* PUT/);
    expect(fetchImpl).not.toHaveBeenCalled();

    await executeTool(misannotated(c => c.get('/api/v2/deals/12')), client, { dealId: 12 });
    expect(fetchImpl.mock.calls.map(call => (call as unknown as [string, RequestInit])[1].method)).toEqual(['GET']);
  });

  it('redacts error text centrally on the MCP path', async () => {
    // A handler that throws a raw, unredacted error.
    const tool = PIPEDRIVE_TOOLS.find(t => t.name === 'pipedrive_get_deal')!;
    const original = tool.handler;
    tool.handler = async () => {
      throw new Error('failed: key test-api-key, header Authorization: Bearer other-secret, {"refresh_token":"third-secret"}');
    };
    try {
      const { mcpClient } = await connect();
      const result = await mcpClient.callTool({ name: 'pipedrive_get_deal', arguments: { dealId: 12 } });
      expect(result.isError).toBe(true);
      const text = texts(result).join(' ');
      expect(text).toContain('‹redacted›');
      for (const secret of ['test-api-key', 'other-secret', 'third-secret']) {
        expect(text).not.toContain(secret);
      }
    } finally {
      tool.handler = original;
    }
  });
});

describe('gateway export', () => {
  it('exposes tools without the prefix and with valid JSON Schemas', () => {
    for (const tool of pipedriveGatewayTools) {
      expect(tool.name.startsWith('pipedrive_')).toBe(false);
      // Reads are on by default; writes are 'write' (none deletes) and off by default.
      expect([tool.riskLevel, tool.enabledByDefault]).toEqual(
        tool.riskLevel === 'read' ? ['read', true] : ['write', false],
      );
    }
    expect(pipedriveGatewayTools.filter(t => t.riskLevel === 'write').map(t => t.name)).toEqual([
      'create_deal',
      'update_deal',
      'move_deal',
      'create_person',
      'update_person',
      'create_organization',
      'update_organization',
      'create_activity',
      'update_activity',
      'add_note',
      'update_note',
    ]);
    const ajv = new Ajv({ strict: true });
    for (const tool of pipedriveGatewayTools) {
      expect(() => ajv.compile(tool.inputSchema), tool.name).not.toThrow();
    }
  });

  it('validates input, applies the policy and records the caller', async () => {
    process.env.PIPEDRIVE_AUDIT_LOG = join(dir, 'audit.jsonl');
    const { gw, fetchImpl } = gateway({ [`GET ${BASE}/api/v2/deals/12`]: { body: item } });

    const ok = await gw.callTool('get_deal', { dealId: 12 }, { caller: 'user@vendor.test', requestId: 'req-1' });
    expect(ok.isError).toBeUndefined();
    expect(ok.structuredContent).toEqual(itemOut);

    const invalid = await gw.callTool('get_deal', { dealId: 12, extra: true });
    expect(invalid.isError).toBe(true);
    const unknown = await gw.callTool('delete_everything', {});
    expect(unknown.isError).toBe(true);
    const write = await gw.callTool('create_organization', { name: 'x' });
    expect(write.isError).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const lines = auditLines(process.env.PIPEDRIVE_AUDIT_LOG);
    expect(lines[0]).toMatchObject({ requestId: pseudonym('req-1'), caller: expect.stringMatching(/^sha256:[0-9a-f]{16}$/), action: 'start' });
    expect(JSON.stringify(lines)).not.toContain('user@vendor.test');
    expect(lines.map(line => line.action)).toEqual(['start', 'finish', 'rejected', 'rejected', 'policy_denied']);
  });
});

describe('default client', () => {
  it('is shared by servers created without a client, so its concurrency limit is process-wide', () => {
    const first = getDefaultClient();
    createServer();
    createServer();
    expect(getDefaultClient()).toBe(first);
  });
});
