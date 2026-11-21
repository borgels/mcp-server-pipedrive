// The sink check (README, "Threat model"): nothing that leaves a gateway holds a piece of 6 characters of the key.
// Every output is checked in its final form; the round-7 counterexamples and keys spliced from real outputs.
import { describe, expect, it } from 'vitest';
import { createPipedriveGateway } from '../src/gateway.js';
import { visibleTexts } from '../src/key-admission.js';
import { BASE, ORG_CREATED, record, testGateway } from './helpers.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A vendor-like value that our texts do not share. */
const PLAIN = 'FakeKeyZZZZ1111YYYY2222XXXX3333W';

function pieces(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 6 <= value.length; i += 1) out.push(value.slice(i, i + 6));
  return out;
}

/** The pieces of the key found in any text a host or a log could see. */
function leaked(key: string, outputs: unknown[]): string[] {
  const texts = outputs.flatMap(output => (typeof output === 'string' ? [output] : visibleTexts(output)));
  return pieces(key).filter(piece => texts.some(text => text.includes(piece)));
}

const upstream: typeof fetch = async input => {
  const path = (String(input).split('?')[0] ?? '').slice(BASE.length);
  if (path === `/api/v2/deals/12`) return json(record('12', { title: 'Item one', status: 'open' }));
  if (path === `/api/v2/organizations`) return json(ORG_CREATED);
  if (path === `/api/v2/organizations/2`) return json(record('2', { name: 'n' }));
  return json({ message: 'no stub' }, 404);
};

/** Every output of a normal session with this key, or the refusal when the key is not admitted. */
async function outputs(apiToken: string): Promise<{ refused?: string; outputs: unknown[] }> {
  const records: unknown[] = [];
  let gw: ReturnType<typeof createPipedriveGateway>;
  try {
    gw = testGateway({
      apiToken,
      baseUrl: BASE,
      fetchImpl: upstream,
      maxAttempts: 1,
      policy: { enableWrites: true, audit: record => void records.push(record) },
    });
  } catch (error) {
    return { refused: (error as Error).message, outputs: [(error as Error).message, (error as Error).name] };
  }
  const results = [
    await gw.callTool('get_deal', { dealId: 12 }, { caller: 'person-1', requestId: 'r1' }),
    await gw.callTool('create_organization', { name: 'n' }, { caller: 'person-1', requestId: 'r2' }),
    await gw.callTool('get_deal', { dealId: 8 }),
    await gw.callTool('no_such_tool', {}),
    await gw.callTool('get_deal', { unknown: 1 }),
  ];
  return { outputs: [gw.tools, ...results, ...records] };
}

describe('the sink check', () => {
  it('holds for the round-7 counterexamples', async () => {
    for (const apiToken of [
      'riskLevelFakeKeyZZZZ1',
      'FakeK1isErrorZZZZ1111Y',
      'fk1":"staZZZZ111',
      'FakeK1-kind,p-ZZ1111',
      'x"ok":y-0123456789',
      'URI malformedFakeKeyZZZZ1\uD800',
    ]) {
      const { refused, outputs: seen } = await outputs(apiToken);
      if (refused !== undefined) expect(refused, apiToken).toMatch(/key was refused/);
      expect(leaked(apiToken, seen), apiToken).toEqual([]);
    }
  });

  it('refuses a key that is not printable ASCII before anything is built from it', () => {
    for (const apiToken of ['URI malformedFakeKeyZZZZ1\uD800', 'FakeKeyZZZZ1111Yé', 'FakeKe ZZZZ1111YYYY']) {
      expect(() => testGateway({ apiToken, baseUrl: BASE }), apiToken).toThrow(/key was refused/);
    }
  });

  it('refuses a key that shares a piece with the tool list', () => {
    expect(() => testGateway({ apiToken: 'riskLevelFakeKeyZZZZ1', baseUrl: BASE })).toThrow(/key was refused/);
  });

  it('holds for keys spliced from the outputs of a normal session', async () => {
    const base = await outputs('FakeKeyZZZZ1111YYYY2222XXXX3333W');
    expect(base.refused).toBeUndefined();
    const texts = base.outputs.flatMap(output => visibleTexts(output)).filter(text => text.length >= 6);
    let seed = 7;
    const random = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const filler = (n: number) => Array.from({ length: n }, () => String.fromCharCode(0x30 + random(43))).join('');
    let admitted = 0;
    for (let round = 0; round < 300; round += 1) {
      const text = texts[random(texts.length)]!;
      const start = random(text.length - 5);
      const window = text.slice(start, start + 6);
      if (!/^[\x21-\x7E]{6}$/.test(window)) continue;
      const apiToken = `${filler(6)}${window}${filler(6)}`;
      const { refused, outputs: seen } = await outputs(apiToken);
      if (refused === undefined) admitted += 1;
      expect(leaked(apiToken, seen), apiToken).toEqual([]);
    }
    expect(admitted).toBeGreaterThan(0);
  });
});

/**
 * A valid record (the one asked for) or created company with the body's fields beside its own:
 * failure lists are reduced before the answer is parsed, and the parse then drops every field its schema does
 * not name.
 */
const asRecord =
  (body: Record<string, unknown>): typeof fetch =>
  async (input, init) => {
    const id = (String(input).split('?')[0] ?? '').split('/').pop() ?? '';
    const answer = init?.method === 'POST' ? ORG_CREATED : record(id, { name: 'ok', title: 'ok' });
    return json({ ...body, ...answer });
  };

describe('failure texts', () => {
  it('replaces texts in failure lists of a successful answer, for reads and writes', async () => {
    const gw = testGateway({
      apiToken: PLAIN,
      baseUrl: BASE,
      maxAttempts: 1,
      policy: { enableWrites: true },
      fetchImpl: asRecord({ failures: ['Vendor diagnostic'], errors: ['Vendor diagnostic'] }),
    });
    for (const result of [await gw.callTool('get_deal', { dealId: 11 }), await gw.callTool('create_organization', { name: 'n' })]) {
      expect(result.isError).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('Vendor');
      expect(JSON.stringify(result)).not.toContain('failures');
    }
  });
});

describe('round 8', () => {
  it('throws construction errors in final form: no frames or paths in the stack, no cause', () => {
    for (const [apiToken, baseUrl] of [
      ['scratchpadFakeKeyZZZZ1', 'https://elsewhere.invalid'],
      ['scratchpadFakeKeyZZZZ1', 'bad'],
      ['FakeK1-node:i-ZZ1111', 'bad'],
      ['short', 'bad'],
    ] as const) {
      let caught: Error | undefined;
      try {
        testGateway({ apiToken, baseUrl });
      } catch (error) {
        caught = error as Error;
      }
      expect(caught, apiToken).toBeInstanceOf(Error);
      const stack = String(caught!.stack);
      expect(stack).toBe(`${caught!.name}: ${caught!.message}`);
      expect(stack).not.toMatch(/\n\s+at /);
      expect((caught as { cause?: unknown }).cause).toBeUndefined();
      expect(leaked(apiToken, [stack, caught!.message, caught!.name, caught])).toEqual([]);
    }
  });

  it('reduces every element of a failure list, whatever its fields, also below a wrapper', async () => {
    for (const body of [
      { failures: [{ reason: 'Vendor diagnostic' }], errors: [{ code: 'Vendor diagnostic' }] },
      { failures: [{ code: 'Vendor diagnostic' }] },
    ]) {
      const gw = testGateway({
        apiToken: PLAIN,
        baseUrl: BASE,
        maxAttempts: 1,
        policy: { enableWrites: true },
        fetchImpl: asRecord(body),
      });
      for (const result of [await gw.callTool('get_deal', { dealId: 11 }), await gw.callTool('create_organization', { name: 'n' })]) {
        expect(result.isError).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain('Vendor');
      }
    }
  });

  it('quotes no configured address in network, timeout or redirect errors', async () => {
    const ADDRESS = 'https://api.pipedrive.com';
    for (const fetchImpl of [
      async () => {
        throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) });
      },
      async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid/' } }),
    ] as Array<typeof fetch>) {
      const gw = testGateway({ apiToken: PLAIN, baseUrl: ADDRESS, maxAttempts: 1, fetchImpl });
      const result = await gw.callTool('get_deal', { dealId: 11 });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain('api.pipedrive');
    }
  });
});
