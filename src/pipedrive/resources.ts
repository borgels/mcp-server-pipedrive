import { z } from 'zod/v4';
import { nestedFailuresAsStatus } from '../errors.js';
import { encodePathParam } from '../path-params.js';
import type { QueryValue, UpstreamClient } from './client.js';
import { startOfDay } from './values.js';

/**
 * Calls to the Pipedrive API, after Pipedrive's developer documentation
 * (https://developers.pipedrive.com/docs/api/v1, the v2 reference and the
 * migration guide https://pipedrive.readme.io/docs/pipedrive-api-v2-migration-guide):
 *
 * - Deals, persons, organizations, activities, pipelines and stages through
 *   API v2: `GET /api/v2/{type}` (cursor paging, `additional_data.next_cursor`),
 *   `GET /api/v2/{type}/{id}`, `GET /api/v2/{type}/search?term=`, `POST` to
 *   create and `PATCH` to change. Every answer is
 *   `{ success, data, additional_data? }`.
 * - Notes and users exist only in API v1: `GET /api/v1/notes` (offset paging,
 *   `additional_data.pagination`), `POST /api/v1/notes`, `PUT /api/v1/notes/{id}`,
 *   `GET /api/v1/users` and `GET /api/v1/users/me`.
 * - A note's content is HTML; it is written from plain text (escaped) and
 *   given back as plain text.
 * - A deal is moved in its pipeline by changing `stage_id` (PATCH); the stage
 *   decides the pipeline.
 *
 * Every answer is parsed with a schema: a present field must have its
 * documented type, and a record must have the id that was asked for. Only a
 * fixed list of fields per record type is given on. Custom fields are left
 * out: their keys are hashes that mean nothing without the company's field
 * settings, which this server does not read.
 */

type Json = Record<string, unknown>;

/** An answer that is not shaped as documented: our own text, nothing of the answer. */
export class UnexpectedAnswerError extends Error {
  constructor() {
    super('Pipedrive answered without the expected data. Nothing in the answer was used.');
    this.name = 'UnexpectedAnswerError';
  }
}

export const V1 = '/api/v1';
export const V2 = '/api/v2';

/** Record types read and written through API v2. */
export type RecordType = 'deals' | 'persons' | 'organizations' | 'activities';

/** What a note or an activity can be on. */
export const TARGET_KINDS = ['deal', 'person', 'organization'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

/** A deal's status. */
export const DEAL_STATUSES = ['open', 'won', 'lost'] as const;

// ---------------------------------------------------------------------------
// Schemas

const id = z.number().int().positive();
const text = (max: number) => z.string().max(max);
const opt = <S extends z.ZodType>(schema: S) => schema.nullable().optional();
const contact = z.object({ value: opt(text(500)), primary: opt(z.boolean()), label: opt(text(100)) });

const deal = z.object({
  id,
  title: opt(text(1000)),
  value: opt(z.number()),
  currency: opt(text(10)),
  status: opt(text(20)),
  pipeline_id: opt(id),
  stage_id: opt(id),
  owner_id: opt(id),
  person_id: opt(id),
  org_id: opt(id),
  expected_close_date: opt(text(40)),
  probability: opt(z.number()),
  lost_reason: opt(text(1000)),
  add_time: opt(text(40)),
  update_time: opt(text(40)),
  stage_change_time: opt(text(40)),
  won_time: opt(text(40)),
  lost_time: opt(text(40)),
  close_time: opt(text(40)),
  label_ids: opt(z.array(id).max(1000)),
  is_deleted: opt(z.boolean()),
});

const person = z.object({
  id,
  name: opt(text(1000)),
  first_name: opt(text(500)),
  last_name: opt(text(500)),
  owner_id: opt(id),
  org_id: opt(id),
  emails: opt(z.array(contact).max(100)),
  phones: opt(z.array(contact).max(100)),
  job_title: opt(text(500)),
  add_time: opt(text(40)),
  update_time: opt(text(40)),
  label_ids: opt(z.array(id).max(1000)),
  is_deleted: opt(z.boolean()),
});

const address = z.object({
  value: opt(text(2000)),
  postal_code: opt(text(100)),
  locality: opt(text(500)),
  country: opt(text(500)),
});

const organization = z.object({
  id,
  name: opt(text(1000)),
  owner_id: opt(id),
  address: opt(address),
  add_time: opt(text(40)),
  update_time: opt(text(40)),
  label_ids: opt(z.array(id).max(1000)),
  is_deleted: opt(z.boolean()),
});

const activity = z.object({
  id,
  subject: opt(text(1000)),
  type: opt(text(100)),
  owner_id: opt(id),
  deal_id: opt(id),
  person_id: opt(id),
  org_id: opt(id),
  due_date: opt(text(20)),
  due_time: opt(text(20)),
  duration: opt(text(20)),
  busy: opt(z.boolean()),
  done: opt(z.boolean()),
  marked_as_done_time: opt(text(40)),
  priority: opt(z.number()),
  note: opt(text(100_000)),
  participants: opt(z.array(z.object({ person_id: opt(id), primary: opt(z.boolean()) })).max(1000)),
  add_time: opt(text(40)),
  update_time: opt(text(40)),
  is_deleted: opt(z.boolean()),
});

const note = z.object({
  id,
  content: opt(text(200_000)),
  deal_id: opt(id),
  person_id: opt(id),
  org_id: opt(id),
  user_id: opt(id),
  add_time: opt(text(40)),
  update_time: opt(text(40)),
});

const SCHEMAS = { deals: deal, persons: person, organizations: organization, activities: activity } as const;

const v2List = <S extends z.ZodType>(row: S) =>
  z.object({
    success: opt(z.boolean()),
    data: opt(z.array(row).max(1000)),
    additional_data: opt(z.object({ next_cursor: opt(text(1000)) })),
  });

const v2One = <S extends z.ZodType>(row: S) => z.object({ success: opt(z.boolean()), data: row });

const searchItem = z.object({
  id,
  title: opt(text(1000)),
  name: opt(text(1000)),
  value: opt(z.number()),
  currency: opt(text(10)),
  status: opt(text(20)),
  owner: opt(z.object({ id: opt(id) })),
  stage: opt(z.object({ id: opt(id), name: opt(text(500)) })),
  person: opt(z.object({ id: opt(id), name: opt(text(1000)) })),
  organization: opt(z.object({ id: opt(id), name: opt(text(1000)) })),
  emails: opt(z.array(z.union([text(500), contact])).max(100)),
  phones: opt(z.array(z.union([text(500), contact])).max(100)),
  address: opt(z.union([text(2000), address])),
});

const searchAnswer = z.object({
  success: opt(z.boolean()),
  data: z.object({ items: z.array(z.object({ result_score: opt(z.number()), item: searchItem })).max(1000) }),
  additional_data: opt(z.object({ next_cursor: opt(text(1000)) })),
});

const v1Pagination = z.object({
  pagination: opt(z.object({ start: opt(z.number()), limit: opt(z.number()), more_items_in_collection: opt(z.boolean()), next_start: opt(z.number()) })),
});

const notesAnswer = z.object({ success: opt(z.boolean()), data: opt(z.array(note).max(1000)), additional_data: opt(v1Pagination) });

const me = z.object({
  success: opt(z.boolean()),
  data: z.object({
    id,
    company_id: opt(id),
    company_name: opt(text(500)),
    company_domain: opt(text(200)),
    default_currency: opt(text(10)),
    timezone_name: opt(text(100)),
    locale: opt(text(20)),
    is_admin: opt(z.union([z.boolean(), z.number()])),
  }),
});

const users = z.object({
  success: opt(z.boolean()),
  data: opt(
    z
      .array(
        z.object({
          id,
          name: opt(text(500)),
          email: opt(text(320)),
          active_flag: opt(z.boolean()),
          is_admin: opt(z.union([z.boolean(), z.number()])),
        }),
      )
      .max(10_000),
  ),
});

const pipeline = z.object({ id, name: opt(text(500)), order_nr: opt(z.number()), is_deleted: opt(z.boolean()) });
const stage = z.object({
  id,
  name: opt(text(500)),
  order_nr: opt(z.number()),
  pipeline_id: opt(id),
  deal_probability: opt(z.number()),
  is_deleted: opt(z.boolean()),
});

// ---------------------------------------------------------------------------
// Helpers

function parse<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(nestedFailuresAsStatus(body));
  if (!result.success) throw new UnexpectedAnswerError();
  return result.data as z.infer<S>;
}

/** A cursor as Pipedrive gives it (base64-like); anything else is not passed on. */
export const CURSOR_PATTERN = /^[A-Za-z0-9_=+/.-]{1,500}$/;

function nextCursor(value: string | null | undefined): string | null {
  return typeof value === 'string' && CURSOR_PATTERN.test(value) ? value : null;
}

/** The HTML Pipedrive keeps a note in, from plain text: escaped, line breaks as <br>. */
export function noteHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\r?\n/g, '<br>');
}

/**
 * The plain text of HTML Pipedrive keeps (a note, an activity's note): line
 * breaks and paragraphs as new lines, other tags left out, the common escapes
 * undone. The inverse of noteHtml for a text it wrote.
 */
export function noteText(html: string): string {
  let out = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6])\s*>/gi, '\n');
  // Tags removed until none is left, so a tag split around another cannot remain.
  for (let previous = ''; previous !== out; ) {
    previous = out;
    out = out.replace(/<[^>]*>/g, '');
  }
  return out
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n+$/, '');
}

function compact(entries: Array<[string, unknown]>): Json {
  const out: Json = {};
  for (const [key, value] of entries) if (value !== undefined) out[key] = value;
  return out;
}

const contacts = (list: Array<z.infer<typeof contact>> | null | undefined) =>
  list?.filter(entry => typeof entry.value === 'string' && entry.value !== '').map(entry => compact([
    ['value', entry.value],
    ['primary', entry.primary ?? undefined],
    ['label', entry.label ?? undefined],
  ]));

/** One record with the fixed fields of its type; absent fields left out. */
export function shape(type: RecordType, row: Json): Json {
  switch (type) {
    case 'deals': {
      const r = row as z.infer<typeof deal>;
      return compact([
        ['id', r.id],
        ['title', r.title],
        ['value', r.value],
        ['currency', r.currency],
        ['status', r.status],
        ['pipeline_id', r.pipeline_id],
        ['stage_id', r.stage_id],
        ['owner_id', r.owner_id],
        ['person_id', r.person_id],
        ['org_id', r.org_id],
        ['expected_close_date', r.expected_close_date],
        ['probability', r.probability],
        ['lost_reason', r.lost_reason],
        ['add_time', r.add_time],
        ['update_time', r.update_time],
        ['stage_change_time', r.stage_change_time],
        ['won_time', r.won_time],
        ['lost_time', r.lost_time],
        ['close_time', r.close_time],
        ['label_ids', r.label_ids],
      ]);
    }
    case 'persons': {
      const r = row as z.infer<typeof person>;
      return compact([
        ['id', r.id],
        ['name', r.name],
        ['first_name', r.first_name],
        ['last_name', r.last_name],
        ['org_id', r.org_id],
        ['owner_id', r.owner_id],
        ['emails', contacts(r.emails)],
        ['phones', contacts(r.phones)],
        ['job_title', r.job_title],
        ['add_time', r.add_time],
        ['update_time', r.update_time],
        ['label_ids', r.label_ids],
      ]);
    }
    case 'organizations': {
      const r = row as z.infer<typeof organization>;
      return compact([
        ['id', r.id],
        ['name', r.name],
        ['owner_id', r.owner_id],
        ['address', r.address ? compact([
          ['value', r.address.value],
          ['postal_code', r.address.postal_code],
          ['locality', r.address.locality],
          ['country', r.address.country],
        ]) : r.address],
        ['add_time', r.add_time],
        ['update_time', r.update_time],
        ['label_ids', r.label_ids],
      ]);
    }
    case 'activities': {
      const r = row as z.infer<typeof activity>;
      return compact([
        ['id', r.id],
        ['subject', r.subject],
        ['type', r.type],
        ['done', r.done],
        ['due_date', r.due_date],
        ['due_time', r.due_time],
        ['duration', r.duration],
        ['owner_id', r.owner_id],
        ['deal_id', r.deal_id],
        ['person_id', r.person_id],
        ['org_id', r.org_id],
        ['participants', r.participants?.filter(entry => typeof entry.person_id === 'number').map(entry => entry.person_id)],
        ['priority', r.priority],
        ['busy', r.busy],
        ['note', typeof r.note === 'string' ? noteText(r.note) : r.note],
        ['marked_as_done_time', r.marked_as_done_time],
        ['add_time', r.add_time],
        ['update_time', r.update_time],
      ]);
    }
  }
}

function shapeNote(row: z.infer<typeof note>): Json {
  return compact([
    ['id', row.id],
    ['content', typeof row.content === 'string' ? noteText(row.content) : row.content],
    ['deal_id', row.deal_id],
    ['person_id', row.person_id],
    ['org_id', row.org_id],
    ['user_id', row.user_id],
    ['add_time', row.add_time],
    ['update_time', row.update_time],
  ]);
}

function recordPath(type: RecordType, recordId?: number): string {
  const base = `${V2}/${type}`;
  return recordId === undefined ? base : `${base}/${encodePathParam(String(recordId), 'id')}`;
}

// ---------------------------------------------------------------------------
// Connection, users, pipelines

/** Who the token belongs to and the company (GET /api/v1/users/me). Nothing personal beyond the user id. */
export async function checkConnection(client: UpstreamClient): Promise<Json> {
  const answer = parse(me, await client.get(`${V1}/users/me`));
  const user = answer.data;
  return {
    connected: true,
    userId: user.id,
    companyId: user.company_id ?? null,
    companyName: user.company_name ?? null,
    companyDomain: user.company_domain ?? null,
    defaultCurrency: user.default_currency ?? null,
    timezone: user.timezone_name ?? null,
    locale: user.locale ?? null,
    isAdmin: user.is_admin === undefined || user.is_admin === null ? null : Boolean(user.is_admin),
  };
}

/** The company's users (GET /api/v1/users): id, name, e-mail, active. Owners of records are users. */
export async function listUsers(client: UpstreamClient, input: { activeOnly?: boolean }): Promise<Json> {
  const answer = parse(users, await client.get(`${V1}/users`));
  const rows = (answer.data ?? []).filter(user => input.activeOnly === false || user.active_flag !== false);
  return {
    users: rows.map(user => ({
      id: user.id,
      name: user.name ?? null,
      email: user.email ?? null,
      active: user.active_flag ?? null,
      isAdmin: user.is_admin === undefined || user.is_admin === null ? null : Boolean(user.is_admin),
    })),
  };
}

/** At most this many pages of stages are read (500 each). */
const MAX_STAGE_PAGES = 5;

/** The pipelines with their stages in order (GET /api/v2/pipelines and /api/v2/stages). */
export async function listPipelines(client: UpstreamClient): Promise<Json> {
  const pipelines = parse(v2List(pipeline), await client.get(`${V2}/pipelines`, { limit: 500 }));
  const stages: Array<z.infer<typeof stage>> = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_STAGE_PAGES; page += 1) {
    const answer = parse(v2List(stage), await client.get(`${V2}/stages`, { limit: 500, cursor }));
    stages.push(...(answer.data ?? []));
    cursor = nextCursor(answer.additional_data?.next_cursor);
    if (cursor === null) break;
  }
  const order = (entry: { order_nr?: number | null }) => entry.order_nr ?? 0;
  return {
    pipelines: (pipelines.data ?? [])
      .filter(entry => !entry.is_deleted)
      .sort((a, b) => order(a) - order(b))
      .map(entry => ({
        id: entry.id,
        name: entry.name ?? null,
        stages: stages
          .filter(row => row.pipeline_id === entry.id && !row.is_deleted)
          .sort((a, b) => order(a) - order(b))
          .map(row => ({ id: row.id, name: row.name ?? null, probability: row.deal_probability ?? null })),
      })),
  };
}

// ---------------------------------------------------------------------------
// Records

export interface ListInput {
  query?: string;
  ownerId?: number;
  personId?: number;
  orgId?: number;
  dealId?: number;
  pipelineId?: number;
  stageId?: number;
  status?: string;
  done?: boolean;
  updatedSince?: string;
  limit?: number;
  cursor?: string;
}

/** The search fields of each type, as Pipedrive names them (`fields` on /search). */
const SEARCH_FIELDS: Readonly<Record<Exclude<RecordType, 'activities'>, string>> = {
  deals: 'title',
  persons: 'name,email,phone',
  organizations: 'name,address',
};

/**
 * Records of one type: with `query`, Pipedrive's search
 * (GET /api/v2/{type}/search, best match first, a short form of each match);
 * without, the list (GET /api/v2/{type}) with exact filters, the most recently
 * changed first.
 */
export async function listRecords(client: UpstreamClient, type: RecordType, input: ListInput): Promise<Json> {
  if (input.query !== undefined && type !== 'activities') return searchRecords(client, type, input);
  const query: Record<string, QueryValue> = {
    owner_id: input.ownerId,
    person_id: input.personId,
    org_id: input.orgId,
    updated_since: input.updatedSince === undefined ? undefined : startOfDay(input.updatedSince),
    limit: input.limit ?? 20,
    cursor: input.cursor,
    sort_by: 'update_time',
    sort_direction: 'desc',
  };
  if (type === 'deals') {
    query.pipeline_id = input.pipelineId;
    query.stage_id = input.stageId;
    query.status = input.status;
  }
  if (type === 'activities') {
    query.deal_id = input.dealId;
    query.done = input.done;
  }
  const answer = parse(v2List(SCHEMAS[type]), await client.get(recordPath(type), query));
  return {
    results: (answer.data ?? []).map(row => shape(type, row as Json)),
    next: nextCursor(answer.additional_data?.next_cursor),
  };
}

function flatContacts(list: Array<string | z.infer<typeof contact>> | null | undefined): string[] | undefined {
  return list
    ?.map(entry => (typeof entry === 'string' ? entry : entry.value ?? ''))
    .filter(value => value !== '');
}

async function searchRecords(client: UpstreamClient, type: Exclude<RecordType, 'activities'>, input: ListInput): Promise<Json> {
  const query: Record<string, QueryValue> = {
    term: input.query,
    fields: SEARCH_FIELDS[type],
    limit: Math.min(input.limit ?? 20, 100),
    cursor: input.cursor,
  };
  if (type === 'deals') {
    query.person_id = input.personId;
    query.organization_id = input.orgId;
    query.status = input.status;
  }
  if (type === 'persons') query.organization_id = input.orgId;
  const answer = parse(searchAnswer, await client.get(`${recordPath(type)}/search`, query));
  return {
    results: answer.data.items.map(({ item }) =>
      compact([
        ['id', item.id],
        ['title', item.title ?? undefined],
        ['name', item.name ?? undefined],
        ['value', item.value ?? undefined],
        ['currency', item.currency ?? undefined],
        ['status', item.status ?? undefined],
        ['owner_id', item.owner?.id ?? undefined],
        ['stage_id', item.stage?.id ?? undefined],
        ['person_id', item.person?.id ?? undefined],
        ['org_id', item.organization?.id ?? undefined],
        ['emails', flatContacts(item.emails)],
        ['phones', flatContacts(item.phones)],
        ['address', typeof item.address === 'string' ? item.address : (item.address?.value ?? undefined)],
      ]),
    ),
    next: nextCursor(answer.additional_data?.next_cursor),
    note: 'Search matches in short form; get the record for all its fields.',
  };
}

async function readRecord(client: UpstreamClient, type: RecordType, recordId: number): Promise<Json> {
  const answer = parse(v2One(SCHEMAS[type]), await client.get(recordPath(type, recordId)));
  if (answer.data.id !== recordId) throw new UnexpectedAnswerError();
  return answer.data as Json;
}

/** One record with the fixed fields of its type (GET /api/v2/{type}/{id}). */
export async function getRecord(client: UpstreamClient, type: RecordType, recordId: number): Promise<Json> {
  return shape(type, await readRecord(client, type, recordId));
}

/** Notes, newest first (GET /api/v1/notes), on one deal, person or organization, or across the company. */
export async function listNotes(
  client: UpstreamClient,
  input: { dealId?: number; personId?: number; orgId?: number; limit?: number; start?: number },
): Promise<Json> {
  const answer = parse(
    notesAnswer,
    await client.get(`${V1}/notes`, {
      deal_id: input.dealId,
      person_id: input.personId,
      org_id: input.orgId,
      start: input.start ?? 0,
      limit: input.limit ?? 20,
      sort: 'add_time DESC',
    }),
  );
  const pagination = answer.additional_data?.pagination;
  const nextStart = pagination?.more_items_in_collection && typeof pagination.next_start === 'number' ? pagination.next_start : null;
  return { results: (answer.data ?? []).map(shapeNote), nextStart };
}

// ---------------------------------------------------------------------------
// Writes

/** Said when a write went through but the answer could not be read. */
export const ANSWER_UNREADABLE =
  'The change was made in Pipedrive, but its answer could not be read. Do not repeat the change; read the record again later.';

/** The tool's input field and Pipedrive's field, per type: the only fields a write sends. */
export const WRITE_FIELDS: Readonly<Record<RecordType, ReadonlyArray<readonly [string, string]>>> = {
  deals: [
    ['title', 'title'],
    ['value', 'value'],
    ['currency', 'currency'],
    ['personId', 'person_id'],
    ['orgId', 'org_id'],
    ['pipelineId', 'pipeline_id'],
    ['stageId', 'stage_id'],
    ['ownerId', 'owner_id'],
    ['expectedCloseDate', 'expected_close_date'],
    ['probability', 'probability'],
    ['status', 'status'],
    ['lostReason', 'lost_reason'],
  ],
  persons: [
    ['name', 'name'],
    ['email', 'emails'],
    ['phone', 'phones'],
    ['orgId', 'org_id'],
    ['ownerId', 'owner_id'],
    ['jobTitle', 'job_title'],
  ],
  organizations: [
    ['name', 'name'],
    ['address', 'address'],
    ['ownerId', 'owner_id'],
  ],
  activities: [
    ['subject', 'subject'],
    ['type', 'type'],
    ['dueDate', 'due_date'],
    ['dueTime', 'due_time'],
    ['duration', 'duration'],
    ['dealId', 'deal_id'],
    ['personId', 'participants'],
    ['orgId', 'org_id'],
    ['ownerId', 'owner_id'],
    ['note', 'note'],
    ['done', 'done'],
  ],
};

/** A field value as Pipedrive takes it. null clears a field. */
function fieldValue(field: string, value: unknown): unknown {
  if (value === null) return field === 'emails' || field === 'phones' || field === 'participants' ? [] : null;
  switch (field) {
    case 'emails':
    case 'phones':
      return [{ value, primary: true, label: 'work' }];
    case 'address':
      return { value };
    case 'participants':
      return [{ person_id: value, primary: true }];
    case 'note':
      return noteHtml(String(value));
    default:
      return value;
  }
}

function body(type: RecordType, input: Json): { body: Json; given: string[] } {
  const out: Json = {};
  const given: string[] = [];
  for (const [field, upstream] of WRITE_FIELDS[type]) {
    if (input[field] === undefined) continue;
    out[upstream] = fieldValue(upstream, input[field]);
    given.push(field);
  }
  return { body: out, given };
}

/** The value a field had, as the tool takes it, so passing it back undoes the change. */
function previousValue(type: RecordType, upstream: string, before: Json): unknown {
  const value = before[upstream];
  if (upstream === 'emails' || upstream === 'phones') {
    const list = Array.isArray(value) ? (value as Array<{ value?: string; primary?: boolean }>) : [];
    return (list.find(entry => entry.primary) ?? list[0])?.value ?? null;
  }
  if (upstream === 'address') return (value as { value?: string } | null | undefined)?.value ?? null;
  if (upstream === 'participants') return type === 'activities' ? (before.person_id ?? null) : null;
  return value ?? null;
}

/** Create a deal, person, organization or activity (POST /api/v2/{type}); the answer is the new record. */
export async function createRecord(client: UpstreamClient, type: RecordType, input: Json): Promise<Json> {
  const { body: payload } = body(type, input);
  const raw = await client.post(recordPath(type), payload);
  // The record exists from here on: an answer that cannot be read must not look like a failure, or a retry makes a
  // duplicate.
  const created = v2One(SCHEMAS[type]).safeParse(nestedFailuresAsStatus(raw));
  if (!created.success) return { created: true, id: null, record: null, note: ANSWER_UNREADABLE };
  return { created: true, id: created.data.data.id, record: shape(type, created.data.data as Json) };
}

/**
 * Change fields of a record (PATCH /api/v2/{type}/{id}). The record is read
 * first; the answer holds the changed fields as they were, so the change can
 * be undone, and the record as it is now.
 */
export async function updateRecord(client: UpstreamClient, type: RecordType, recordId: number, input: Json): Promise<Json> {
  const { body: payload, given } = body(type, input);
  if (given.length === 0) throw new Error('Nothing to change: give at least one field.');
  const before = await readRecord(client, type, recordId);
  const previous: Json = {};
  for (const [field, upstream] of WRITE_FIELDS[type]) {
    if (input[field] === undefined) continue;
    previous[field] = previousValue(type, upstream, before);
  }
  const raw = await client.patch(recordPath(type, recordId), payload);
  const after = v2One(SCHEMAS[type]).safeParse(nestedFailuresAsStatus(raw));
  if (!after.success || after.data.data.id !== recordId) {
    return { updated: true, id: recordId, changed: given, before: previous, record: null, note: ANSWER_UNREADABLE };
  }
  return { updated: true, id: recordId, changed: given, before: previous, record: shape(type, after.data.data as Json) };
}

/** The field a note's target sets. */
const NOTE_TARGET: Readonly<Record<TargetKind, string>> = { deal: 'deal_id', person: 'person_id', organization: 'org_id' };

/** Add a note to a deal, person or organization (POST /api/v1/notes). The text is kept as escaped HTML. */
export async function addNote(client: UpstreamClient, input: { on: TargetKind; recordId: number; content: string }): Promise<Json> {
  const raw = await client.post(`${V1}/notes`, { content: noteHtml(input.content), [NOTE_TARGET[input.on]]: input.recordId });
  const created = v2One(note).safeParse(nestedFailuresAsStatus(raw));
  if (!created.success) return { created: true, noteId: null, note: ANSWER_UNREADABLE };
  return { created: true, noteId: created.data.data.id, on: input.on, recordId: input.recordId };
}

/** Change a note's text (PUT /api/v1/notes/{id}). The answer holds the text as it was. */
export async function updateNote(client: UpstreamClient, input: { noteId: number; content: string }): Promise<Json> {
  const path = `${V1}/notes/${encodePathParam(String(input.noteId), 'id')}`;
  const before = parse(v2One(note), await client.get(path));
  if (before.data.id !== input.noteId) throw new UnexpectedAnswerError();
  const raw = await client.put(path, { content: noteHtml(input.content) });
  const after = v2One(note).safeParse(nestedFailuresAsStatus(raw));
  const previous = { content: typeof before.data.content === 'string' ? noteText(before.data.content) : null };
  if (!after.success) return { updated: true, id: input.noteId, before: previous, record: null, note: ANSWER_UNREADABLE };
  return { updated: true, id: input.noteId, before: previous, record: shapeNote(after.data.data) };
}
