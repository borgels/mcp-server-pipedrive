// Pipedrive-specific behaviour, against answers shaped as Pipedrive's developer documentation shows them (API v2:
// `{ success, data, additional_data: { next_cursor } }`, search `{ data: { items: [{ result_score, item }] } }`; API v1
// for notes and users: `{ success, data, additional_data: { pagination } }`). They are written from the documentation,
// not recorded from a live account; test/live.test.ts runs against a real test company when a token is given.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPipedriveGateway, pipedriveToolCatalog, resolvePipedriveChange, type GatewayJsonObject } from '../src/gateway.js';
import { ALLOWED_WRITES } from '../src/pipedrive/client.js';
import { noteHtml, noteText } from '../src/pipedrive/resources.js';

const TOKEN = 'pppp-dddd-rrrr-vvvv-1';
const originalEnv = { ...process.env };

beforeEach(() => {
  for (const name of Object.keys(process.env)) if (name.startsWith('PIPEDRIVE_')) delete process.env[name];
});
afterEach(() => {
  process.env = { ...originalEnv };
});

type Handler = (url: URL, init: RequestInit) => unknown;
type Call = { method: string; path: string; query: URLSearchParams; body: unknown; token: string | null; url: string };

/** A Pipedrive stand-in: routes by "METHOD /path". An unknown route answers 404 as Pipedrive does. */
function pipedrive(routes: Record<string, Handler | unknown>, policy: Record<string, unknown> = { enableWrites: true }) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      path: url.pathname,
      query: url.searchParams,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      token: headers.get('x-api-token'),
      url: String(input),
    });
    const route = routes[`${method} ${url.pathname}`];
    if (route === undefined) return Response.json({ success: false, error: 'Not found', errorCode: 404 }, { status: 404 });
    const body = typeof route === 'function' ? (route as Handler)(url, init ?? {}) : route;
    if (body instanceof Response) return body;
    return Response.json(body);
  });
  const gw = createPipedriveGateway({ apiToken: TOKEN, maxAttempts: 1, fetchImpl, policy: policy as never });
  return { gw, calls, fetchImpl };
}

const call = (gw: ReturnType<typeof pipedrive>['gw'], tool: string, input: GatewayJsonObject = {}) => gw.callTool(tool, input);
const V2 = '/api/v2';
const V1 = '/api/v1';
const ok = (data: unknown, additional?: unknown) => ({ success: true, data, ...(additional ? { additional_data: additional } : {}) });

/** A deal as GET /api/v2/deals/{id} answers it, with fields the server does not pass on. */
const DEAL = {
  id: 23,
  title: 'Ny hjemmeside',
  creator_user_id: 7,
  owner_id: 7,
  value: 12400,
  currency: 'DKK',
  person_id: 21,
  org_id: 22,
  pipeline_id: 1,
  stage_id: 2,
  status: 'open',
  probability: null,
  expected_close_date: '2026-12-15',
  add_time: '2026-11-01T10:00:00Z',
  update_time: '2026-11-20T13:02:00Z',
  stage_change_time: '2026-11-10T09:00:00Z',
  is_deleted: false,
  visible_to: 3,
  label_ids: [5],
  custom_fields: { '8a1f0c2d': 'not passed on' },
  origin: 'ManuallyCreated',
};

const PERSON = {
  id: 21,
  name: 'Testa Person',
  first_name: 'Testa',
  last_name: 'Person',
  owner_id: 7,
  org_id: 22,
  emails: [{ value: 'testa@eksempel.test', primary: true, label: 'work' }],
  phones: [{ value: '+45 00 00 00 00', primary: true, label: 'mobile' }],
  add_time: '2026-11-01T10:00:00Z',
  update_time: '2026-11-02T10:00:00Z',
  is_deleted: false,
  visible_to: 3,
  custom_fields: {},
  picture_id: null,
};

describe('connection, users and pipelines', () => {
  it('checks the connection with users/me, sends the token only in x-api-token to api.pipedrive.com', async () => {
    const { gw, calls } = pipedrive({
      [`GET ${V1}/users/me`]: ok({
        id: 7,
        name: 'Sælger Eksempel',
        email: 'saelger@eksempel.test',
        company_id: 1001,
        company_name: 'Eksempel ApS',
        company_domain: 'eksempel',
        default_currency: 'DKK',
        timezone_name: 'Europe/Copenhagen',
        locale: 'da_DK',
        is_admin: 1,
      }),
    });
    const result = await call(gw, 'check_connection');
    expect(result.structuredContent).toEqual({
      connected: true,
      userId: 7,
      companyId: 1001,
      companyName: 'Eksempel ApS',
      companyDomain: 'eksempel',
      defaultCurrency: 'DKK',
      timezone: 'Europe/Copenhagen',
      locale: 'da_DK',
      isAdmin: true,
    });
    expect(JSON.stringify(result)).not.toContain('saelger@');
    expect(calls[0]?.url.startsWith('https://api.pipedrive.com/api/v1/users/me')).toBe(true);
    expect(calls[0]?.token).toBe(TOKEN);
    expect(calls[0]?.url).not.toContain(TOKEN);
  });

  it('lists active users by default', async () => {
    const { gw } = pipedrive({
      [`GET ${V1}/users`]: ok([
        { id: 7, name: 'Sælger Eksempel', email: 's@eksempel.test', active_flag: true, is_admin: 0, role_id: 1 },
        { id: 8, name: 'Tidligere Ansat', email: 't@eksempel.test', active_flag: false, is_admin: 0 },
      ]),
    });
    const result = await call(gw, 'list_users');
    expect(result.structuredContent).toEqual({ users: [{ id: 7, name: 'Sælger Eksempel', email: 's@eksempel.test', active: true, isAdmin: false }] });
    expect(((await call(gw, 'list_users', { activeOnly: false })).structuredContent as { users: unknown[] }).users).toHaveLength(2);
  });

  it('lists the pipelines with their stages in order, deleted ones left out, following the stage cursor', async () => {
    const { gw, calls } = pipedrive({
      [`GET ${V2}/pipelines`]: ok([
        { id: 2, name: 'Service', order_nr: 2, is_deleted: false },
        { id: 1, name: 'Salg', order_nr: 1, is_deleted: false },
        { id: 3, name: 'Gammel', order_nr: 3, is_deleted: true },
      ]),
      [`GET ${V2}/stages`]: (url: URL) =>
        url.searchParams.get('cursor') === null
          ? ok(
              [
                { id: 11, name: 'Tilbud', order_nr: 2, pipeline_id: 1, deal_probability: 50, is_deleted: false },
                { id: 10, name: 'Kontakt', order_nr: 1, pipeline_id: 1, deal_probability: 10, is_deleted: false },
              ],
              { next_cursor: 'c2' },
            )
          : ok([{ id: 20, name: 'Ny', order_nr: 1, pipeline_id: 2, deal_probability: 100, is_deleted: false }], { next_cursor: null }),
    });
    const result = await call(gw, 'list_pipelines');
    expect(result.structuredContent).toEqual({
      pipelines: [
        { id: 1, name: 'Salg', stages: [{ id: 10, name: 'Kontakt', probability: 10 }, { id: 11, name: 'Tilbud', probability: 50 }] },
        { id: 2, name: 'Service', stages: [{ id: 20, name: 'Ny', probability: 100 }] },
      ],
    });
    expect(calls.filter(c => c.path === `${V2}/stages`).map(c => c.query.get('cursor'))).toEqual([null, 'c2']);
  });
});

describe('reading records', () => {
  it('lists deals with exact filters, newest change first, and gives on only the fixed fields', async () => {
    const { gw, calls } = pipedrive({ [`GET ${V2}/deals`]: ok([DEAL], { next_cursor: 'eyJpZCI6MjN9' }) });
    const result = await call(gw, 'search_deals', { pipelineId: 1, stageId: 2, status: 'open', ownerId: 7, updatedSince: '2026-11-01', limit: 50 });
    expect(result.isError).toBeUndefined();
    const query = Object.fromEntries(calls[0]!.query);
    expect(query).toEqual({
      pipeline_id: '1',
      stage_id: '2',
      status: 'open',
      owner_id: '7',
      updated_since: '2026-11-01T00:00:00Z',
      limit: '50',
      sort_by: 'update_time',
      sort_direction: 'desc',
    });
    const data = result.structuredContent as { results: Array<Record<string, unknown>>; next: string };
    expect(data.next).toBe('eyJpZCI6MjN9');
    expect(data.results[0]).toEqual({
      id: 23,
      title: 'Ny hjemmeside',
      value: 12400,
      currency: 'DKK',
      status: 'open',
      pipeline_id: 1,
      stage_id: 2,
      owner_id: 7,
      person_id: 21,
      org_id: 22,
      expected_close_date: '2026-12-15',
      probability: null,
      add_time: '2026-11-01T10:00:00Z',
      update_time: '2026-11-20T13:02:00Z',
      stage_change_time: '2026-11-10T09:00:00Z',
      label_ids: [5],
    });
    expect(JSON.stringify(result)).not.toMatch(/custom_fields|not passed on|visible_to/);
  });

  it('searches deals by text with the search endpoint and gives each match in short form', async () => {
    const { gw, calls } = pipedrive({
      [`GET ${V2}/deals/search`]: ok(
        {
          items: [
            {
              result_score: 1.2,
              item: {
                id: 23,
                type: 'deal',
                title: 'Ny hjemmeside',
                value: 12400,
                currency: 'DKK',
                status: 'open',
                visible_to: 3,
                owner: { id: 7 },
                stage: { id: 2, name: 'Tilbud' },
                person: { id: 21, name: 'Testa Person' },
                organization: { id: 22, name: 'Eksempel ApS', address: null },
                custom_fields: [],
                notes: [],
              },
            },
          ],
        },
        { next_cursor: null },
      ),
    });
    const result = await call(gw, 'search_deals', { query: 'hjemmeside', personId: 21, pipelineId: 1 });
    expect(Object.fromEntries(calls[0]!.query)).toEqual({ term: 'hjemmeside', fields: 'title', limit: '20', person_id: '21' });
    expect(result.structuredContent).toEqual({
      results: [{ id: 23, title: 'Ny hjemmeside', value: 12400, currency: 'DKK', status: 'open', owner_id: 7, stage_id: 2, person_id: 21, org_id: 22 }],
      next: null,
      note: 'Search matches in short form; get the record for all its fields.',
    });
  });

  it('refuses a search text shorter than two characters before anything is sent', async () => {
    const { gw, calls } = pipedrive({});
    expect((await call(gw, 'search_persons', { query: 'a' })).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('searches persons in name, e-mail and phone and flattens their contact details', async () => {
    const { gw, calls } = pipedrive({
      [`GET ${V2}/persons/search`]: ok({
        items: [{ result_score: 0.9, item: { id: 21, type: 'person', name: 'Testa Person', phones: ['+45 00 00 00 00'], emails: ['testa@eksempel.test'], owner: { id: 7 }, organization: { id: 22, name: 'Eksempel ApS' } } }],
      }),
    });
    const result = await call(gw, 'search_persons', { query: 'Testa', orgId: 22 });
    expect(Object.fromEntries(calls[0]!.query)).toEqual({ term: 'Testa', fields: 'name,email,phone', limit: '20', organization_id: '22' });
    expect((result.structuredContent as { results: unknown[] }).results).toEqual([
      { id: 21, name: 'Testa Person', owner_id: 7, org_id: 22, emails: ['testa@eksempel.test'], phones: ['+45 00 00 00 00'] },
    ]);
  });

  it('gets a person with e-mail addresses and phone numbers, without custom fields', async () => {
    const { gw } = pipedrive({ [`GET ${V2}/persons/21`]: ok(PERSON) });
    const result = await call(gw, 'get_person', { personId: 21 });
    expect(result.structuredContent).toEqual({
      id: 21,
      name: 'Testa Person',
      first_name: 'Testa',
      last_name: 'Person',
      org_id: 22,
      owner_id: 7,
      emails: [{ value: 'testa@eksempel.test', primary: true, label: 'work' }],
      phones: [{ value: '+45 00 00 00 00', primary: true, label: 'mobile' }],
      add_time: '2026-11-01T10:00:00Z',
      update_time: '2026-11-02T10:00:00Z',
    });
  });

  it('gets an organization with its address', async () => {
    const { gw } = pipedrive({
      [`GET ${V2}/organizations/22`]: ok({
        id: 22,
        name: 'Eksempel ApS',
        owner_id: 7,
        address: { value: 'Eksempelvej 1, 8000 Aarhus C', street_number: '1', route: 'Eksempelvej', locality: 'Aarhus', postal_code: '8000', country: 'Danmark' },
        add_time: '2026-11-01T10:00:00Z',
        update_time: '2026-11-02T10:00:00Z',
        is_deleted: false,
      }),
    });
    const result = await call(gw, 'get_organization', { orgId: 22 });
    expect(result.structuredContent).toEqual({
      id: 22,
      name: 'Eksempel ApS',
      owner_id: 7,
      address: { value: 'Eksempelvej 1, 8000 Aarhus C', postal_code: '8000', locality: 'Aarhus', country: 'Danmark' },
      add_time: '2026-11-01T10:00:00Z',
      update_time: '2026-11-02T10:00:00Z',
    });
  });

  it('refuses an answer for another record than the one asked for', async () => {
    const { gw } = pipedrive({ [`GET ${V2}/deals/23`]: ok({ ...DEAL, id: 24 }) });
    const result = await call(gw, 'get_deal', { dealId: 23 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('without the expected data');
  });

  it('refuses ids that are not positive integers before anything is sent', async () => {
    const { gw, calls } = pipedrive({});
    for (const dealId of ['23', 0, -1, 1.5, '../users']) {
      expect((await call(gw, 'get_deal', { dealId } as GatewayJsonObject)).isError, String(dealId)).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it('lists the activities of a deal that are not done, with the note as plain text and participants as ids', async () => {
    const { gw, calls } = pipedrive({
      [`GET ${V2}/activities`]: ok(
        [
          {
            id: 41,
            subject: 'Ring om tilbuddet',
            type: 'call',
            owner_id: 7,
            deal_id: 23,
            person_id: 21,
            org_id: 22,
            due_date: '2026-11-23',
            due_time: '09:00',
            duration: '00:15',
            busy: false,
            done: false,
            note: '<p>Spørg til &quot;budget&quot;</p>',
            participants: [{ person_id: 21, primary: true }],
            attendees: [{ email: 'gaest@eksempel.test' }],
            is_deleted: false,
          },
        ],
        { next_cursor: null },
      ),
    });
    const result = await call(gw, 'list_activities', { dealId: 23, done: false });
    expect(calls[0]?.query.get('deal_id')).toBe('23');
    expect(calls[0]?.query.get('done')).toBe('false');
    expect((result.structuredContent as { results: unknown[] }).results).toEqual([
      {
        id: 41,
        subject: 'Ring om tilbuddet',
        type: 'call',
        done: false,
        due_date: '2026-11-23',
        due_time: '09:00',
        duration: '00:15',
        owner_id: 7,
        deal_id: 23,
        person_id: 21,
        org_id: 22,
        participants: [21],
        busy: false,
        note: 'Spørg til "budget"',
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('gaest@');
  });

  it('lists the notes of a deal through API v1, newest first, as plain text with the next page', async () => {
    const { gw, calls } = pipedrive({
      [`GET ${V1}/notes`]: ok(
        [
          {
            id: 5,
            user_id: 7,
            deal_id: 23,
            person_id: 21,
            org_id: 22,
            content: 'Ringede i dag<br>Vil have tilbud &amp; tegning',
            add_time: '2026-11-20 13:02:00',
            update_time: '2026-11-20 13:02:00',
            active_flag: true,
            user: { email: 's@eksempel.test', name: 'Sælger Eksempel' },
          },
        ],
        { pagination: { start: 0, limit: 1, more_items_in_collection: true, next_start: 1 } },
      ),
    });
    const result = await call(gw, 'list_notes', { dealId: 23, limit: 1 });
    expect(Object.fromEntries(calls[0]!.query)).toEqual({ deal_id: '23', start: '0', limit: '1', sort: 'add_time DESC' });
    expect(result.structuredContent).toEqual({
      results: [
        {
          id: 5,
          content: 'Ringede i dag\nVil have tilbud & tegning',
          deal_id: 23,
          person_id: 21,
          org_id: 22,
          user_id: 7,
          add_time: '2026-11-20 13:02:00',
          update_time: '2026-11-20 13:02:00',
        },
      ],
      nextStart: 1,
    });
    expect(JSON.stringify(result)).not.toContain('s@eksempel');
  });

  it('refuses notes filtered on two records at once', async () => {
    const { gw, calls } = pipedrive({});
    expect((await call(gw, 'list_notes', { dealId: 23, personId: 21 })).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('writes', () => {
  it('are off without enableWrites, and nothing is sent', async () => {
    const { gw, calls } = pipedrive({}, {});
    const result = await call(gw, 'create_deal', { title: 'x' });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('create a deal with POST to API v2 and give the new deal from the answer', async () => {
    const { gw, calls } = pipedrive({ [`POST ${V2}/deals`]: ok({ ...DEAL, id: 30, title: 'Ny aftale' }) });
    const result = await call(gw, 'create_deal', {
      title: 'Ny aftale',
      value: 1000,
      currency: 'DKK',
      personId: 21,
      orgId: 22,
      stageId: 2,
      ownerId: 7,
      expectedCloseDate: '2026-12-31',
    });
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      title: 'Ny aftale',
      value: 1000,
      currency: 'DKK',
      person_id: 21,
      org_id: 22,
      stage_id: 2,
      owner_id: 7,
      expected_close_date: '2026-12-31',
    });
    expect(result.structuredContent).toMatchObject({ created: true, id: 30, record: { id: 30, title: 'Ny aftale' } });
  });

  it('keep the deal created when its answer cannot be read, so a retry does not make a duplicate', async () => {
    const { gw } = pipedrive({ [`POST ${V2}/deals`]: { success: true, data: { title: 'no id' } } });
    const result = await call(gw, 'create_deal', { title: 'Ny aftale' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ created: true, id: null, record: null });
    expect((result.structuredContent as { note: string }).note).toContain('Do not repeat the change');
  });

  it('move a deal to another stage with PATCH and answer with the stage it was in', async () => {
    const { gw, calls } = pipedrive({
      [`GET ${V2}/deals/23`]: ok(DEAL),
      [`PATCH ${V2}/deals/23`]: ok({ ...DEAL, stage_id: 3 }),
    });
    const result = await call(gw, 'move_deal', { dealId: 23, stageId: 3 });
    expect(calls.map(c => c.method)).toEqual(['GET', 'PATCH']);
    expect(calls[1]?.body).toEqual({ stage_id: 3 });
    expect(result.structuredContent).toMatchObject({ updated: true, id: 23, changed: ['stageId'], before: { stageId: 2 }, record: { stage_id: 3 } });
  });

  it('mark a deal lost with a reason, and refuse a reason without status lost', async () => {
    const { gw, calls } = pipedrive({
      [`GET ${V2}/deals/23`]: ok(DEAL),
      [`PATCH ${V2}/deals/23`]: ok({ ...DEAL, status: 'lost', lost_reason: 'Pris' }),
    });
    expect((await call(gw, 'update_deal', { dealId: 23, lostReason: 'Pris' })).isError).toBe(true);
    expect(calls).toHaveLength(0);
    const result = await call(gw, 'update_deal', { dealId: 23, status: 'lost', lostReason: 'Pris' });
    expect(calls[1]?.body).toEqual({ status: 'lost', lost_reason: 'Pris' });
    expect(result.structuredContent).toMatchObject({ before: { status: 'open', lostReason: null } });
  });

  it('refuse an update without a field to change', async () => {
    const { gw, calls } = pipedrive({});
    expect((await call(gw, 'update_deal', { dealId: 23 })).isError).toBe(true);
    expect((await call(gw, 'update_person', { personId: 21 })).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('create a person with one primary e-mail and phone', async () => {
    const { gw, calls } = pipedrive({ [`POST ${V2}/persons`]: ok({ ...PERSON, id: 31 }) });
    await call(gw, 'create_person', { name: 'Testa Person', email: 'testa@eksempel.test', phone: '+45 00 00 00 00', orgId: 22 });
    expect(calls[0]?.body).toEqual({
      name: 'Testa Person',
      emails: [{ value: 'testa@eksempel.test', primary: true, label: 'work' }],
      phones: [{ value: '+45 00 00 00 00', primary: true, label: 'work' }],
      org_id: 22,
    });
  });

  it('update a person and give the old primary e-mail back as the text the tool takes', async () => {
    const { gw, calls } = pipedrive({
      [`GET ${V2}/persons/21`]: ok(PERSON),
      [`PATCH ${V2}/persons/21`]: ok({ ...PERSON, emails: [{ value: 'ny@eksempel.test', primary: true }] }),
    });
    const result = await call(gw, 'update_person', { personId: 21, email: 'ny@eksempel.test', orgId: null });
    expect(calls[1]?.body).toEqual({ emails: [{ value: 'ny@eksempel.test', primary: true, label: 'work' }], org_id: null });
    expect(result.structuredContent).toMatchObject({ before: { email: 'testa@eksempel.test', orgId: 22 } });
  });

  it('create an organization with the address as one line', async () => {
    const { gw, calls } = pipedrive({ [`POST ${V2}/organizations`]: ok({ id: 32, name: 'Nyt Firma ApS' }) });
    await call(gw, 'create_organization', { name: 'Nyt Firma ApS', address: 'Eksempelvej 1, 8000 Aarhus C' });
    expect(calls[0]?.body).toEqual({ name: 'Nyt Firma ApS', address: { value: 'Eksempelvej 1, 8000 Aarhus C' } });
  });

  it('create an activity on a deal with the person as primary participant and the note escaped', async () => {
    const { gw, calls } = pipedrive({ [`POST ${V2}/activities`]: ok({ id: 42, subject: 'Ring tilbage', type: 'call', done: false }) });
    const result = await call(gw, 'create_activity', {
      subject: 'Ring tilbage',
      type: 'call',
      dueDate: '2026-11-23',
      dueTime: '08:30',
      dealId: 23,
      personId: 21,
      note: 'Om <pris>\nog levering',
    });
    expect(calls[0]?.body).toEqual({
      subject: 'Ring tilbage',
      type: 'call',
      due_date: '2026-11-23',
      due_time: '08:30',
      deal_id: 23,
      participants: [{ person_id: 21, primary: true }],
      note: 'Om &lt;pris&gt;<br>og levering',
    });
    expect(result.structuredContent).toMatchObject({ created: true, id: 42 });
  });

  it('mark an activity done with PATCH and answer with done as it was', async () => {
    const activity = { id: 41, subject: 'Ring', type: 'call', done: false, due_date: '2026-11-23' };
    const { gw, calls } = pipedrive({
      [`GET ${V2}/activities/41`]: ok(activity),
      [`PATCH ${V2}/activities/41`]: ok({ ...activity, done: true }),
    });
    const result = await call(gw, 'update_activity', { activityId: 41, done: true });
    expect(calls[1]?.body).toEqual({ done: true });
    expect(result.structuredContent).toMatchObject({ before: { done: false }, record: { done: true } });
  });

  it('refuse a due time that is not HH:MM', async () => {
    const { gw, calls } = pipedrive({});
    expect((await call(gw, 'create_activity', { subject: 'x', dueTime: '9.00' })).isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('add a note to an organization through API v1 as escaped text', async () => {
    const { gw, calls } = pipedrive({ [`POST ${V1}/notes`]: ok({ id: 50, content: 'x', org_id: 22 }) });
    const result = await call(gw, 'add_note', { on: 'organization', recordId: 22, content: 'Ringede <i dag>\nOK' });
    expect(calls[0]?.body).toEqual({ content: 'Ringede &lt;i dag&gt;<br>OK', org_id: 22 });
    expect(result.structuredContent).toEqual({ created: true, noteId: 50, on: 'organization', recordId: 22 });
  });

  it('update a note with PUT and give the old text back', async () => {
    const { gw, calls } = pipedrive({
      [`GET ${V1}/notes/50`]: ok({ id: 50, content: 'Gammel<br>tekst', deal_id: 23 }),
      [`PUT ${V1}/notes/50`]: ok({ id: 50, content: 'Ny tekst', deal_id: 23 }),
    });
    const result = await call(gw, 'update_note', { noteId: 50, content: 'Ny tekst' });
    expect(calls.map(c => `${c.method} ${c.path}`)).toEqual([`GET ${V1}/notes/50`, `PUT ${V1}/notes/50`]);
    expect(calls[1]?.body).toEqual({ content: 'Ny tekst' });
    expect(result.structuredContent).toMatchObject({ before: { content: 'Gammel\ntekst' }, record: { content: 'Ny tekst' } });
  });

  it('a Pipedrive refusal comes back as our own text, never the body', async () => {
    const { gw } = pipedrive({
      [`POST ${V2}/deals`]: Response.json({ success: false, error: 'Stage 999 secret detail', errorCode: 400 }, { status: 400 }),
    });
    const result = await call(gw, 'create_deal', { title: 'x', stageId: 999 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/^Pipedrive API request failed with HTTP 400 \| Pipedrive refused the input/);
    expect(JSON.stringify(result)).not.toContain('secret detail');
  });

  it('never send a DELETE, a merge or a bulk change: only POST, PATCH and PUT on the fixed paths', () => {
    expect(ALLOWED_WRITES.map(entry => entry.method).sort()).toEqual(['PATCH', 'POST', 'POST', 'PUT']);
    for (const entry of pipedriveToolCatalog) {
      for (const operation of entry.upstream) expect(operation.path).not.toMatch(/merge|bulk|duplicate|users\/\{|fields|webhooks/);
    }
  });
});

describe('the change resolution', () => {
  it('logs ids, keys, dates and flags of a change, never a title, an amount, a name or a text', () => {
    const deal = resolvePipedriveChange('create_deal', {
      title: 'Hemmelig aftale',
      value: 99999,
      currency: 'DKK',
      personId: 21,
      orgId: 22,
      expectedCloseDate: '2026-12-31',
    });
    expect(deal).toEqual({
      ok: true,
      change: {
        tool: 'create_deal',
        action: 'create',
        record: 'deal',
        movesMoney: false,
        requiresConfirmation: false,
        values: { personId: 21, orgId: 22, currency: 'DKK', expectedCloseDate: '2026-12-31' },
      },
    });
    const move = resolvePipedriveChange('move_deal', { dealId: 23, stageId: 3 });
    expect(move.ok && move.change.values).toEqual({ dealId: 23, stageId: 3 });
    const person = resolvePipedriveChange('update_person', { personId: 21, email: 'hemmelig@eksempel.test', name: 'Navn' });
    expect(person.ok && person.change.values).toEqual({ personId: 21, changed: 'email,name' });
    const note = resolvePipedriveChange('add_note', { on: 'deal', recordId: 23, content: 'Hemmelig tekst' });
    expect(note.ok && note.change.values).toEqual({ on: 'deal', recordId: 23 });
    const activity = resolvePipedriveChange('update_activity', { activityId: 41, done: true, note: 'tekst' });
    expect(activity.ok && activity.change.values).toEqual({ activityId: 41, done: true, changed: 'done,note' });
    for (const result of [deal, move, person, note, activity]) {
      expect(JSON.stringify(result)).not.toMatch(/Hemmelig|hemmelig|99999|Navn|tekst/);
    }
  });

  it('refuses read tools and invalid input', () => {
    expect(resolvePipedriveChange('get_deal', { dealId: 23 }).ok).toBe(false);
    expect(resolvePipedriveChange('move_deal', { dealId: 23 }).ok).toBe(false);
    expect(resolvePipedriveChange('delete_deal', { dealId: 23 }).ok).toBe(false);
  });

  it('marks no tool as needing confirmation and no tool as broad', () => {
    expect(pipedriveToolCatalog.filter(entry => entry.requiresConfirmation || entry.broad)).toEqual([]);
  });
});

describe('note text', () => {
  it('escapes plain text as HTML and reads it back unchanged', () => {
    const text = 'A & B <c> "d"\nnew line';
    expect(noteHtml(text)).toBe('A &amp; B &lt;c&gt; &quot;d&quot;<br>new line');
    expect(noteText(noteHtml(text))).toBe(text);
    expect(noteText('<p>One</p><p>Two <b>bold</b></p>')).toBe('One\nTwo bold');
    expect(noteText('<scr<script>ipt>x')).not.toContain('<script');
  });
});
