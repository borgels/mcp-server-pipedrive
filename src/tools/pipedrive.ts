import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createHmac, createHash } from 'node:crypto';
import { z } from 'zod/v4';
import {
  READ_TOOL_ANNOTATIONS,
  UNTRUSTED_CONTENT_NOTE,
  UNTRUSTED_RESULT_NOTE,
  WRITE_TOOL_ANNOTATIONS,
} from '../pipedrive/annotations.js';
import { assertAuditLogWritable, auditTarget, newRequestId, writeAuditEvent } from '../pipedrive/audit.js';
import { readOnlyClient, type UpstreamClient } from '../pipedrive/client.js';
import { formatUnknownError, redactDeep, type SecretRedactor } from '../errors.js';
import { withheldResult } from '../fallbacks.js';
import { leaksSecret } from '../key-admission.js';
import {
  addNote,
  checkConnection,
  createRecord,
  CURSOR_PATTERN,
  DEAL_STATUSES,
  getRecord,
  listNotes,
  listPipelines,
  listRecords,
  listUsers,
  TARGET_KINDS,
  updateNote,
  updateRecord,
  V1,
  V2,
  WRITE_FIELDS,
  type RecordType,
} from '../pipedrive/resources.js';
import {
  checkInputPolicy,
  checkToolPolicy,
  currentInstancePolicy,
  isToolDisabled,
  redactInScope,
  runInCallScope,
  validatePolicyConfig,
} from '../pipedrive/policy.js';
import { INTERNAL_VALUE_PATTERN, isInternalValue, isIsoDate, isRecordId, TIME_OF_DAY_PATTERN } from '../pipedrive/values.js';

type ToolAnnotations = typeof READ_TOOL_ANNOTATIONS | typeof WRITE_TOOL_ANNOTATIONS;

/**
 * One upstream request a tool may make: `read` or `write`, the HTTP method
 * and the path template relative to the API base (`{name}` marks a
 * caller-supplied segment). Published in the gateway tool catalog so a host
 * can see what each tool touches; keep it in step with the handler.
 */
export interface UpstreamOperation {
  access: 'read' | 'write';
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  path: string;
}

/** A client that carries the redactor of its instance (PipedriveClient does). */
export interface RedactingClient extends UpstreamClient {
  readonly redactor: SecretRedactor;
}

/** What a write tool does. */
export type PipedriveChangeAction = 'create' | 'update';

/** The kind of record a write tool touches. */
export type PipedriveChangeRecord = 'deal' | 'person' | 'organization' | 'activity' | 'note';

/**
 * The type a logged value must have; anything else is left out of the values.
 *   id        a Pipedrive id (a positive integer), in clear
 *   date      a date YYYY-MM-DD, in clear
 *   count     the number of entries in a list, never the entries
 *   flag      true or false, in clear
 *   kind      an internal key (an activity type, a deal status, a record kind, a currency code), in clear
 *   fields    the names of the fields given, never their values
 * Names, e-mail addresses, phone numbers, amounts, texts and other values a person wrote are never log fields.
 */
export type PipedriveLogFieldType = 'id' | 'date' | 'count' | 'flag' | 'kind' | 'fields';

export interface PipedriveLogField {
  readonly name: string;
  readonly type: PipedriveLogFieldType;
}

/**
 * Write tools only: what the change does, for a host that logs a change
 * before it is sent. `logFields` are the input fields that identify it, each
 * with the one type its value must have.
 */
export interface PipedriveChangeSpec {
  readonly action: PipedriveChangeAction;
  readonly record: PipedriveChangeRecord;
  /** Always false: nothing here moves money. */
  readonly movesMoney: false;
  readonly logFields: readonly PipedriveLogField[];
}

/**
 * One definition per tool, shared by the MCP server and the gateway entry
 * point: same input schema, same handler, same policy and audit path.
 */
export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  /** MCP tool name (`pipedrive_*`). The gateway exposes it without the prefix. */
  name: string;
  title: string;
  description: string;
  inputShape: S;
  /** Strict object built from inputShape: unknown arguments are rejected. */
  inputSchema: z.ZodObject;
  annotations: ToolAnnotations;
  /** Whether the result carries upstream content (vs. server metadata). */
  returnsUpstreamContent: boolean;
  /** Short human-readable summary used by the gateway result text. */
  summary: string;
  /** Every upstream request the handler may make. */
  upstream: readonly UpstreamOperation[];
  /** True when the tool can read more than its name says. */
  broad?: boolean;
  /** Write tools: what the change does. */
  change?: PipedriveChangeSpec;
  /** True when a person should confirm each call outside the chat. Nothing here moves money, so none is. */
  requiresConfirmation?: boolean;
  /** Cross-field checks the schema shape cannot express. Returns a refusal or undefined. */
  check?: (input: Record<string, unknown>) => string | undefined;
  /**
   * Read-only tools (readOnlyHint) receive a client view that refuses
   * writes, so a mis-annotated tool cannot write.
   */
  handler: (client: UpstreamClient, input: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

function defineTool<S extends z.ZodRawShape>(definition: Omit<ToolDefinition<S>, 'inputSchema'>): ToolDefinition {
  const description = definition.returnsUpstreamContent
    ? `${definition.description} ${UNTRUSTED_CONTENT_NOTE}`
    : definition.description;
  return {
    ...definition,
    description,
    inputSchema: z.strictObject(definition.inputShape),
  } as unknown as ToolDefinition;
}

const change = (
  action: PipedriveChangeAction,
  record: PipedriveChangeRecord,
  logFields: Record<string, PipedriveLogFieldType>,
): PipedriveChangeSpec => ({
  action,
  record,
  movesMoney: false,
  logFields: Object.entries(logFields).map(([name, type]) => ({ name, type })),
});

// ---------------------------------------------------------------------------
// Schemas

const idSchema = (what: string) => z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe(what);
/** An id field a write may clear with null (e.g. a deal's person). */
const idOrNull = (what: string) => idSchema(what).nullable().optional();
const internalValue = (what: string) =>
  z.string().trim().regex(INTERNAL_VALUE_PATTERN, 'an internal key: letters, digits, _ and -').describe(what);
const dateSchema = z.string().trim().refine(isIsoDate, 'must be a date written YYYY-MM-DD');
const cursor = z
  .string()
  .trim()
  .regex(CURSOR_PATTERN, 'the value of next from the previous page')
  .optional()
  .describe('The value of next from the previous page.');
const limit = (max: number, fallback: number) =>
  z.number().int().min(1).max(max).optional().describe(`At most this many (default ${fallback}, at most ${max}).`);
const searchText = z
  .string()
  .trim()
  .min(2)
  .max(200)
  .describe('Search text, at least 2 characters. With it the answer is Pipedrive\'s best matches in short form.');
/** A text field: a string, or null to clear it. */
const textValue = (max: number) => z.union([z.string().trim().max(max), z.null()]).optional();
const currency = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, 'a currency code, e.g. DKK')
  .describe('Currency code, e.g. DKK (default: the company currency).');
const target = z.enum(TARGET_KINDS).describe('What it is on: deal, person or organization.');

const dealFields = {
  value: z.number().finite().min(0).max(1_000_000_000_000).nullable().optional().describe('The deal value, in its currency.'),
  currency: currency.optional(),
  personId: idOrNull('The contact person (from search_persons).'),
  orgId: idOrNull('The organization (from search_organizations).'),
  stageId: idSchema('The stage (from list_pipelines); it decides the pipeline.').optional(),
  ownerId: idSchema('The owner, a user (from list_users).').optional(),
  expectedCloseDate: dateSchema.nullable().optional().describe('Expected close date, YYYY-MM-DD.'),
  probability: z.number().min(0).max(100).nullable().optional().describe('Win probability in percent.'),
};

const personFields = {
  email: textValue(254).describe("E-mail address. On a change it replaces the person's e-mail addresses with this one."),
  phone: textValue(50).describe("Phone number. On a change it replaces the person's phone numbers with this one."),
  orgId: idOrNull('The organization the person works at (from search_organizations).'),
  ownerId: idSchema('The owner, a user (from list_users).').optional(),
  jobTitle: textValue(200),
};

const organizationFields = {
  address: textValue(500).describe('The full address as one line.'),
  ownerId: idSchema('The owner, a user (from list_users).').optional(),
};

const activityFields = {
  type: internalValue('The activity type key, e.g. call, meeting, task, deadline, email or lunch.').optional(),
  dueDate: dateSchema.nullable().optional().describe('Due date, YYYY-MM-DD.'),
  dueTime: z
    .string()
    .trim()
    .regex(TIME_OF_DAY_PATTERN, 'HH:MM')
    .nullable()
    .optional()
    .describe('Due time HH:MM in UTC (Pipedrive keeps activity times in UTC).'),
  duration: z.string().trim().regex(TIME_OF_DAY_PATTERN, 'HH:MM').nullable().optional().describe('Duration HH:MM.'),
  dealId: idOrNull('The deal it is about.'),
  personId: idOrNull('The person it is with (the primary participant).'),
  orgId: idOrNull('The organization it is about.'),
  ownerId: idSchema('Who does it, a user (from list_users).').optional(),
  note: textValue(10_000).describe('A note on the activity, kept as plain text.'),
};

const WRITE_NOTE = 'Off unless writes are enabled (PIPEDRIVE_ENABLE_WRITES, or the gateway host policy enableWrites).';

const anyField = (keys: readonly string[]) => (input: Record<string, unknown>) =>
  keys.some(key => input[key] !== undefined) ? undefined : 'Give at least one field to change.';

const fieldNames = (type: RecordType) => WRITE_FIELDS[type].map(([field]) => field);

/** Lost reason only with status lost. */
const lostReason = (input: Record<string, unknown>) =>
  input.lostReason !== undefined && input.lostReason !== null && input.status !== 'lost' ? 'Give lostReason only with status lost.' : undefined;

const atMostOneOwner = (input: Record<string, unknown>) =>
  [input.dealId, input.personId, input.orgId].filter(value => value !== undefined).length > 1
    ? 'Give at most one of dealId, personId and orgId.'
    : undefined;

const listCommon = {
  ownerId: idSchema('Only records owned by this user (from list_users).').optional(),
  updatedSince: dateSchema.optional().describe('Only records changed on or after this date (ignored with query).'),
  limit: limit(100, 20),
  cursor,
};

const searchNote = 'With query, a text search (best match first, short form; get_* has all fields) and only the filters said to work with it; without, a list with exact filters, the most recently changed first.';

export const PIPEDRIVE_TOOLS: ToolDefinition[] = [
  defineTool({
    name: 'pipedrive_check_connection',
    title: 'Check Pipedrive connection',
    description: 'Check that the API token works: the user id it belongs to, the company, its default currency and time zone.',
    inputShape: {},
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Checked the connection.',
    upstream: [{ access: 'read', method: 'GET', path: `${V1}/users/me` }],
    handler: async client => checkConnection(client),
  }),
  defineTool({
    name: 'pipedrive_list_users',
    title: 'List users (Pipedrive)',
    description: 'The users of the company: id, name, e-mail and whether active. Records name their owner by user id (owner_id).',
    inputShape: { activeOnly: z.boolean().optional().describe('Only active users (default true).') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed users.',
    upstream: [{ access: 'read', method: 'GET', path: `${V1}/users` }],
    handler: async (client, input) => listUsers(client, input),
  }),
  defineTool({
    name: 'pipedrive_list_pipelines',
    title: 'List pipelines (Pipedrive)',
    description: 'The pipelines and their stages in order: id, name and win probability. Deals name their pipeline and stage by these ids.',
    inputShape: {},
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed pipelines.',
    upstream: [
      { access: 'read', method: 'GET', path: `${V2}/pipelines` },
      { access: 'read', method: 'GET', path: `${V2}/stages` },
    ],
    handler: async client => listPipelines(client),
  }),

  // -------------------------------------------------------------------------
  // Deals, persons, organizations

  defineTool({
    name: 'pipedrive_search_deals',
    title: 'Search deals (Pipedrive)',
    description: `Deals: title, value, currency, status (open, won, lost), pipeline, stage, owner, person, organization and expected close date. ${searchNote} Filters with query: personId, orgId, status.`,
    inputShape: {
      query: searchText.optional(),
      status: z.enum(DEAL_STATUSES).optional().describe('Only open, won or lost deals.'),
      pipelineId: idSchema('Only this pipeline (ignored with query).').optional(),
      stageId: idSchema('Only this stage (ignored with query).').optional(),
      personId: idSchema('Only deals with this person.').optional(),
      orgId: idSchema('Only deals with this organization.').optional(),
      ...listCommon,
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Searched deals.',
    upstream: [
      { access: 'read', method: 'GET', path: `${V2}/deals` },
      { access: 'read', method: 'GET', path: `${V2}/deals/search` },
    ],
    handler: async (client, input) => listRecords(client, 'deals', input),
  }),
  defineTool({
    name: 'pipedrive_get_deal',
    title: 'Get deal (Pipedrive)',
    description: 'One deal with its fields.',
    inputShape: { dealId: idSchema('The deal (from search_deals).') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched deal.',
    upstream: [{ access: 'read', method: 'GET', path: `${V2}/deals/{dealId}` }],
    handler: async (client, input) => getRecord(client, 'deals', input.dealId),
  }),
  defineTool({
    name: 'pipedrive_search_persons',
    title: 'Search persons (Pipedrive)',
    description: `Persons (contacts): name, e-mail addresses, phone numbers, organization, job title and owner. ${searchNote} The search looks in name, e-mail and phone; filter with query: orgId.`,
    inputShape: {
      query: searchText.optional(),
      orgId: idSchema('Only persons at this organization.').optional(),
      ...listCommon,
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Searched persons.',
    upstream: [
      { access: 'read', method: 'GET', path: `${V2}/persons` },
      { access: 'read', method: 'GET', path: `${V2}/persons/search` },
    ],
    handler: async (client, input) => listRecords(client, 'persons', input),
  }),
  defineTool({
    name: 'pipedrive_get_person',
    title: 'Get person (Pipedrive)',
    description: 'One person with its fields.',
    inputShape: { personId: idSchema('The person (from search_persons).') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched person.',
    upstream: [{ access: 'read', method: 'GET', path: `${V2}/persons/{personId}` }],
    handler: async (client, input) => getRecord(client, 'persons', input.personId),
  }),
  defineTool({
    name: 'pipedrive_search_organizations',
    title: 'Search organizations (Pipedrive)',
    description: `Organizations (companies): name, address and owner. ${searchNote} The search looks in name and address.`,
    inputShape: { query: searchText.optional(), ...listCommon },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Searched organizations.',
    upstream: [
      { access: 'read', method: 'GET', path: `${V2}/organizations` },
      { access: 'read', method: 'GET', path: `${V2}/organizations/search` },
    ],
    handler: async (client, input) => listRecords(client, 'organizations', input),
  }),
  defineTool({
    name: 'pipedrive_get_organization',
    title: 'Get organization (Pipedrive)',
    description: 'One organization with its fields.',
    inputShape: { orgId: idSchema('The organization (from search_organizations).') },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Fetched organization.',
    upstream: [{ access: 'read', method: 'GET', path: `${V2}/organizations/{orgId}` }],
    handler: async (client, input) => getRecord(client, 'organizations', input.orgId),
  }),

  // -------------------------------------------------------------------------
  // Activities and notes

  defineTool({
    name: 'pipedrive_list_activities',
    title: 'List activities (Pipedrive)',
    description:
      'Activities (calls, meetings, tasks and other to-dos), the most recently changed first: subject, type, done, due date and time (UTC), duration, owner, deal, person, organization and note. Filter by owner, deal, person, organization, done or last change.',
    inputShape: {
      dealId: idSchema('Only activities on this deal.').optional(),
      personId: idSchema('Only activities with this person.').optional(),
      orgId: idSchema('Only activities on this organization.').optional(),
      done: z.boolean().optional().describe('true: only done; false: only not done.'),
      ownerId: idSchema('Only activities of this user (from list_users).').optional(),
      updatedSince: dateSchema.optional().describe('Only activities changed on or after this date.'),
      limit: limit(100, 20),
      cursor,
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed activities.',
    upstream: [{ access: 'read', method: 'GET', path: `${V2}/activities` }],
    handler: async (client, input) => listRecords(client, 'activities', input),
  }),
  defineTool({
    name: 'pipedrive_list_notes',
    title: 'List notes (Pipedrive)',
    description:
      'Notes, newest first, on a deal, person or organization (or across the company without one): text, author (user_id) and time. nextStart gives the next page (as start).',
    inputShape: {
      dealId: idSchema('Only notes on this deal.').optional(),
      personId: idSchema('Only notes on this person.').optional(),
      orgId: idSchema('Only notes on this organization.').optional(),
      limit: limit(100, 20),
      start: z.number().int().min(0).max(1_000_000).optional().describe('The value of nextStart from the previous page.'),
    },
    annotations: READ_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Listed notes.',
    upstream: [{ access: 'read', method: 'GET', path: `${V1}/notes` }],
    check: atMostOneOwner,
    handler: async (client, input) => listNotes(client, input),
  }),

  // -------------------------------------------------------------------------
  // Writes. Each can be undone in Pipedrive: a new record can be deleted there by a user, and a change can be changed
  // back (the update tools answer with the fields as they were). No tool deletes, merges, changes many records at once,
  // sends e-mail, or changes users, permissions, pipelines, stages, fields or settings.

  defineTool({
    name: 'pipedrive_create_deal',
    title: 'Create deal (Pipedrive)',
    description: `Create a deal, linked to a person and/or an organization. Without a stage Pipedrive puts it in the first stage of the default pipeline. ${WRITE_NOTE}`,
    inputShape: {
      title: z.string().trim().min(1).max(255).describe('The deal title.'),
      ...dealFields,
      pipelineId: idSchema('The pipeline (from list_pipelines), when no stage is given.').optional(),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Created deal.',
    upstream: [{ access: 'write', method: 'POST', path: `${V2}/deals` }],
    change: change('create', 'deal', {
      personId: 'id',
      orgId: 'id',
      pipelineId: 'id',
      stageId: 'id',
      ownerId: 'id',
      currency: 'kind',
      expectedCloseDate: 'date',
    }),
    handler: async (client, input) => createRecord(client, 'deals', input),
  }),
  defineTool({
    name: 'pipedrive_update_deal',
    title: 'Update deal (Pipedrive)',
    description: `Change fields of a deal: title, value, person, organization, owner, expected close date, probability, or mark it won or lost (status; open reopens it). Fields not given stay as they are. The answer holds the fields as they were, so the change can be undone. ${WRITE_NOTE}`,
    inputShape: {
      dealId: idSchema('The deal (from search_deals).'),
      title: z.string().trim().min(1).max(255).optional().describe('New title.'),
      ...dealFields,
      status: z.enum(DEAL_STATUSES).optional().describe('won or lost closes the deal; open reopens it.'),
      lostReason: textValue(500).describe('Why the deal was lost (with status lost).'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Updated deal.',
    upstream: [
      { access: 'read', method: 'GET', path: `${V2}/deals/{dealId}` },
      { access: 'write', method: 'PATCH', path: `${V2}/deals/{dealId}` },
    ],
    change: change('update', 'deal', {
      dealId: 'id',
      stageId: 'id',
      status: 'kind',
      ownerId: 'id',
      expectedCloseDate: 'date',
      changed: 'fields',
    }),
    check: input => lostReason(input) ?? anyField(fieldNames('deals'))(input),
    handler: async (client, input) => updateRecord(client, 'deals', input.dealId, input),
  }),
  defineTool({
    name: 'pipedrive_move_deal',
    title: 'Move deal to a stage (Pipedrive)',
    description: `Move a deal to another stage of its pipeline, or to a stage of another pipeline (the stage decides the pipeline). The answer holds the stage it was in, so the move can be undone. ${WRITE_NOTE}`,
    inputShape: {
      dealId: idSchema('The deal (from search_deals).'),
      stageId: idSchema('The stage to move it to (from list_pipelines).'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Moved deal.',
    upstream: [
      { access: 'read', method: 'GET', path: `${V2}/deals/{dealId}` },
      { access: 'write', method: 'PATCH', path: `${V2}/deals/{dealId}` },
    ],
    change: change('update', 'deal', { dealId: 'id', stageId: 'id' }),
    handler: async (client, input) => updateRecord(client, 'deals', input.dealId, { stageId: input.stageId }),
  }),
  defineTool({
    name: 'pipedrive_create_person',
    title: 'Create person (Pipedrive)',
    description: `Create a person (a contact), optionally at an organization. Search with search_persons first, so the person is not created twice. ${WRITE_NOTE}`,
    inputShape: { name: z.string().trim().min(1).max(255).describe('The full name.'), ...personFields },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Created person.',
    upstream: [{ access: 'write', method: 'POST', path: `${V2}/persons` }],
    change: change('create', 'person', { orgId: 'id', ownerId: 'id', given: 'fields' }),
    handler: async (client, input) => createRecord(client, 'persons', input),
  }),
  defineTool({
    name: 'pipedrive_update_person',
    title: 'Update person (Pipedrive)',
    description: `Change fields of a person; fields not given stay as they are (null clears a field). A new e-mail or phone replaces all the person's e-mail addresses or phone numbers with that one. The answer holds the fields as they were, every address and number included, so they can be restored. ${WRITE_NOTE}`,
    inputShape: {
      personId: idSchema('The person (from search_persons).'),
      name: z.string().trim().min(1).max(255).optional().describe('New name.'),
      ...personFields,
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Updated person.',
    upstream: [
      { access: 'read', method: 'GET', path: `${V2}/persons/{personId}` },
      { access: 'write', method: 'PATCH', path: `${V2}/persons/{personId}` },
    ],
    change: change('update', 'person', { personId: 'id', orgId: 'id', ownerId: 'id', changed: 'fields' }),
    check: anyField(fieldNames('persons')),
    handler: async (client, input) => updateRecord(client, 'persons', input.personId, input),
  }),
  defineTool({
    name: 'pipedrive_create_organization',
    title: 'Create organization (Pipedrive)',
    description: `Create an organization (a company). Search with search_organizations first, so it is not created twice. ${WRITE_NOTE}`,
    inputShape: { name: z.string().trim().min(1).max(255).describe('The organization name.'), ...organizationFields },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Created organization.',
    upstream: [{ access: 'write', method: 'POST', path: `${V2}/organizations` }],
    change: change('create', 'organization', { ownerId: 'id', given: 'fields' }),
    handler: async (client, input) => createRecord(client, 'organizations', input),
  }),
  defineTool({
    name: 'pipedrive_update_organization',
    title: 'Update organization (Pipedrive)',
    description: `Change fields of an organization; fields not given stay as they are (null clears the address). The answer holds the fields as they were. ${WRITE_NOTE}`,
    inputShape: {
      orgId: idSchema('The organization (from search_organizations).'),
      name: z.string().trim().min(1).max(255).optional().describe('New name.'),
      ...organizationFields,
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Updated organization.',
    upstream: [
      { access: 'read', method: 'GET', path: `${V2}/organizations/{orgId}` },
      { access: 'write', method: 'PATCH', path: `${V2}/organizations/{orgId}` },
    ],
    change: change('update', 'organization', { orgId: 'id', ownerId: 'id', changed: 'fields' }),
    check: anyField(fieldNames('organizations')),
    handler: async (client, input) => updateRecord(client, 'organizations', input.orgId, input),
  }),
  defineTool({
    name: 'pipedrive_create_activity',
    title: 'Create activity (Pipedrive)',
    description: `Create an activity (a call, meeting, task or other to-do) with a due date, optionally on a deal, person or organization and assigned to a user. Nothing is sent to anyone: no invitation, no e-mail. It can be created as done to log something that took place. ${WRITE_NOTE}`,
    inputShape: {
      subject: z.string().trim().min(1).max(255).describe('What is to be done, or what took place.'),
      ...activityFields,
      done: z.boolean().optional().describe('true to log an activity that already took place (default false).'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Created activity.',
    upstream: [{ access: 'write', method: 'POST', path: `${V2}/activities` }],
    change: change('create', 'activity', {
      type: 'kind',
      dueDate: 'date',
      dealId: 'id',
      personId: 'id',
      orgId: 'id',
      ownerId: 'id',
      done: 'flag',
    }),
    handler: async (client, input) => createRecord(client, 'activities', input),
  }),
  defineTool({
    name: 'pipedrive_update_activity',
    title: 'Update activity (Pipedrive)',
    description: `Change an activity: mark it done (done true) or not done, move its due date or time, reassign it, or change its subject or note. Fields not given stay as they are. The answer holds the fields as they were, so the change can be undone. ${WRITE_NOTE}`,
    inputShape: {
      activityId: idSchema('The activity (from list_activities).'),
      subject: z.string().trim().min(1).max(255).optional().describe('New subject.'),
      ...activityFields,
      done: z.boolean().optional().describe('true marks it done; false marks it not done.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Updated activity.',
    upstream: [
      { access: 'read', method: 'GET', path: `${V2}/activities/{activityId}` },
      { access: 'write', method: 'PATCH', path: `${V2}/activities/{activityId}` },
    ],
    change: change('update', 'activity', { activityId: 'id', type: 'kind', dueDate: 'date', ownerId: 'id', done: 'flag', changed: 'fields' }),
    check: anyField(fieldNames('activities')),
    handler: async (client, input) => updateRecord(client, 'activities', input.activityId, input),
  }),
  defineTool({
    name: 'pipedrive_add_note',
    title: 'Add note (Pipedrive)',
    description: `Add a note to a deal, person or organization. The text is kept as plain text. ${WRITE_NOTE}`,
    inputShape: {
      on: target,
      recordId: idSchema('The deal, person or organization.'),
      content: z.string().trim().min(1).max(50_000).describe('The note text.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: false,
    summary: 'Added note.',
    upstream: [{ access: 'write', method: 'POST', path: `${V1}/notes` }],
    change: change('create', 'note', { on: 'kind', recordId: 'id' }),
    handler: async (client, input) => addNote(client, input),
  }),
  defineTool({
    name: 'pipedrive_update_note',
    title: 'Update note (Pipedrive)',
    description: `Replace the text of a note. The answer holds the text as it was, so the change can be undone. ${WRITE_NOTE}`,
    inputShape: {
      noteId: idSchema('The note (from list_notes).'),
      content: z.string().trim().min(1).max(50_000).describe('The new note text.'),
    },
    annotations: WRITE_TOOL_ANNOTATIONS,
    returnsUpstreamContent: true,
    summary: 'Updated note.',
    upstream: [
      { access: 'read', method: 'GET', path: `${V1}/notes/{noteId}` },
      { access: 'write', method: 'PUT', path: `${V1}/notes/{noteId}` },
    ],
    change: change('update', 'note', { noteId: 'id' }),
    handler: async (client, input) => updateNote(client, input),
  }),
];

/**
 * Validate a write call's input exactly as executeTool does before it sends
 * anything: the strict schema, then the tool's own cross-field check. Used
 * by the change resolution, so a call it accepts is one that would run.
 */
export function validateCall(tool: ToolDefinition, input: unknown): { ok: true; data: Record<string, unknown> } | { ok: false } {
  const parsed = tool.inputSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false };
  const data = parsed.data as Record<string, unknown>;
  return tool.check?.(data) ? { ok: false } : { ok: true, data };
}

export function findTool(name: string): ToolDefinition | undefined {
  return PIPEDRIVE_TOOLS.find(tool => tool.name === name);
}

/** The pseudonym of a value: HMAC-SHA-256 with the host's key, else SHA-256; 16 hex characters with a prefix. */
export function pseudonym(value: string, key?: string | Uint8Array): string {
  if (key !== undefined && key.length > 0) {
    return `hmac:${createHmac('sha256', key).update(value).digest('hex').slice(0, 16)}`;
  }
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

/** The input field that names the record an update tool changes; never one of its changed fields. */
export const TARGET_FIELD: Readonly<Record<PipedriveChangeRecord, string>> = {
  deal: 'dealId',
  person: 'personId',
  organization: 'orgId',
  activity: 'activityId',
  note: 'noteId',
};

/** The input without the field that names the record changed, for a `fields` log value. */
export function changedInput(record: PipedriveChangeRecord, action: PipedriveChangeAction, input: Record<string, unknown>): Record<string, unknown> {
  if (action !== 'update') return input;
  const { [TARGET_FIELD[record]]: _target, ...rest } = input;
  return rest;
}

/** The names of the fields the write tools can set: the only names a `fields` log value can hold. */
const WRITE_FIELD_KEYS: ReadonlySet<string> = new Set([
  ...Object.values(WRITE_FIELDS).flatMap(entries => entries.map(([field]) => field)),
  'pipelineId',
]);

/**
 * The value of one log field when it has exactly the field's type; otherwise
 * undefined. Never a name, an amount or a text.
 */
export function logFieldValue(
  type: PipedriveLogFieldType,
  value: unknown,
  _pseudonymKey?: string | Uint8Array,
): string | number | boolean | undefined {
  switch (type) {
    case 'id':
      return isRecordId(value) ? value : undefined;
    case 'date':
      return isIsoDate(value) ? value : undefined;
    case 'count':
      return Array.isArray(value) ? value.length : undefined;
    case 'flag':
      return typeof value === 'boolean' ? value : undefined;
    case 'kind':
      return isInternalValue(value) ? value : undefined;
    case 'fields': {
      // The whole validated input: the names of the fields given, never their values.
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const names = Object.keys(value)
        .filter(key => WRITE_FIELD_KEYS.has(key) && (value as Record<string, unknown>)[key] !== undefined)
        .sort();
      return names.length > 0 ? names.join(',') : undefined;
    }
    default:
      return undefined;
  }
}

/** Validate the tool policy environment. Cheap; runs for every server instance. */
export function validateToolConfig(): void {
  validatePolicyConfig(PIPEDRIVE_TOOLS.map(tool => tool.name));
}

/**
 * Startup checks for entry points (transports, gateway): tool policy plus a
 * writable audit log. The audit check is not repeated per HTTP request, so
 * read tools keep working if the log becomes unwritable later; write tools
 * then fail closed when their start record cannot be written.
 */
export function validateStartupConfig(): void {
  validateToolConfig();
  assertAuditLogWritable();
}

/** Tools enabled on this instance (PIPEDRIVE_DISABLED_TOOLS removes them entirely). */
export function enabledTools(): ToolDefinition[] {
  return PIPEDRIVE_TOOLS.filter(tool => !isToolDisabled(tool.name));
}

export function registerTools(server: McpServer, client: RedactingClient): void {
  validateToolConfig();
  for (const tool of enabledTools()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (input: Record<string, unknown>) => {
        let result: { content: Array<{ type: 'text'; text: string }>; isError?: true };
        try {
          // In a scope with this server's redactor, like a gateway call: audit records and context are redacted.
          const data = await runInCallScope({ redactor: client.redactor }, () => executeTool(tool, client, input));
          // Pipedrive data can echo a token, in values or in object keys: redacted as data before it is serialised (a
          // serialised token is escaped and no longer matches), as on the gateway.
          result = mcpToolResult(tool, redactDeep(redactDeep(data, client.redactor), client.redactor));
        } catch (error) {
          // Central redaction with this instance's secrets: no error text reaches the client unredacted.
          result = { isError: true, content: [{ type: 'text' as const, text: formatUnknownError(error, client.redactor) }] };
        }
        // The same last check as the gateway: a result that still holds a piece of the token is withheld whole.
        return leaksSecret(result, client.redactor) ? withheldResult() : result;
      },
    );
  }
}

/** Optional call context supplied by an embedding host. */
export interface CallContext {
  /** Caller identity, recorded in audit events. */
  caller?: string;
  /** Request id to reuse in audit events, for correlation with the host's own log. */
  requestId?: string;
}

function contextString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  // Redacted before it is cut short: a cut key would no longer match the redactor.
  const trimmed = redactInScope(value).trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/**
 * The audit's view of a call context. Nothing the host sends is kept in
 * clear: a request id may be any text (a name, a phone number, an address),
 * so the audit keeps its pseudonym, which still ties the lines of one call
 * together for the host that knows the key; without a request id the audit
 * makes one. The caller becomes a pseudonym the same way. Both are keyed
 * with the host's policy.pseudonymKey when given.
 */
export function normaliseCallContext(context: unknown): { requestId: string; caller?: string } {
  const value = (context && typeof context === 'object' ? context : {}) as Record<string, unknown>;
  const key = currentInstancePolicy()?.pseudonymKey;
  const given = typeof value.requestId === 'string' && value.requestId.length > 0 ? value.requestId.slice(0, 1000) : undefined;
  const requestId = given === undefined ? newRequestId() : pseudonym(given, key);
  const caller = contextString(value.caller, 320);
  return {
    requestId,
    ...(caller === undefined ? {} : { caller: pseudonym(caller, key) }),
  };
}

/**
 * Run one validated tool call through the instance policy and the audit
 * log. Used by both the MCP server and the gateway entry point.
 */
export async function executeTool(
  tool: ToolDefinition,
  client: RedactingClient,
  input: Record<string, unknown>,
  context?: CallContext,
): Promise<unknown> {
  const { requestId, caller } = normaliseCallContext(context);
  const target = auditTarget(input);
  const { redactor } = client;

  const policy = checkToolPolicy(tool.name, tool.annotations.readOnlyHint);
  const inputPolicy = policy.allowed ? checkInputPolicy(tool.name, input) : policy;
  const refusal = inputPolicy.allowed ? tool.check?.(input) : undefined;
  if (!inputPolicy.allowed || refusal) {
    const reason = inputPolicy.allowed ? (refusal as string) : inputPolicy.reason;
    await writeAuditEvent({ requestId, tool: tool.name, caller, action: 'policy_denied', target, reason }, { redactor });
    throw new Error(reason);
  }

  // Write tools fail closed: no write runs without its start record.
  await writeAuditEvent(
    { requestId, tool: tool.name, caller, action: 'start', target, reason: policy.reason },
    { required: !tool.annotations.readOnlyHint, redactor },
  );
  const startedAt = performance.now();

  try {
    const handlerClient = tool.annotations.readOnlyHint ? readOnlyClient(client, tool.name) : client;
    const result = await tool.handler(handlerClient, input as never);
    await writeAuditEvent({
      requestId,
      tool: tool.name,
      caller,
      action: 'finish',
      target,
      status: 'ok',
      durationMs: Math.round(performance.now() - startedAt),
    }, { redactor });
    return result;
  } catch (error) {
    await writeAuditEvent({
      requestId,
      tool: tool.name,
      caller,
      action: 'error',
      target,
      status: 'error',
      durationMs: Math.round(performance.now() - startedAt),
      error,
    }, { redactor });
    throw error;
  }
}

/** Why a call was rejected before it ran: a fixed code, never text from the caller. */
export type RejectionCode = 'unknown_tool' | 'invalid_input';

/**
 * Audit a call rejected before execution (unknown tool or invalid input).
 * The record holds only what we wrote: a known tool name (an unknown one is
 * recorded as `unknown` with a pseudonym of what was given), the argument
 * names that the tool's schema knows, the number of other arguments, and a
 * fixed code. A caller can put a name or a text anywhere, so nothing it
 * chose is logged in clear.
 */
export async function auditRejectedCall(
  toolName: string,
  input: unknown,
  code: RejectionCode,
  context?: unknown,
): Promise<void> {
  const { requestId, caller } = normaliseCallContext(context);
  const tool = typeof toolName === 'string' ? findTool(toolName) : undefined;
  const known = new Set(tool ? Object.keys(tool.inputShape) : []);
  const keys = input && typeof input === 'object' && !Array.isArray(input) ? Object.keys(input) : [];
  const fields = keys.filter(key => known.has(key)).sort();
  await writeAuditEvent({
    requestId,
    tool: tool ? tool.name : 'unknown',
    caller,
    action: 'rejected',
    target: {
      ...(tool ? {} : { toolPseudonym: pseudonym(String(toolName).slice(0, 200)) }),
      fields,
      otherFields: keys.length - fields.length,
    },
    reason: code,
  });
}

/** Compact JSON (no pretty-printing): indentation only costs tokens. */
export function compactJson(data: unknown): string {
  return JSON.stringify(data ?? null);
}

function mcpToolResult(tool: ToolDefinition, data: unknown) {
  const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: compactJson(data) }];
  if (tool.returnsUpstreamContent) {
    content.push({ type: 'text', text: UNTRUSTED_RESULT_NOTE });
  }
  return { content };
}
