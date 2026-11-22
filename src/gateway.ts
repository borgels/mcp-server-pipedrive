import { z } from 'zod/v4';
import { UNTRUSTED_CONTENT_NOTE } from './pipedrive/annotations.js';
import { DEFAULT_BASE_URL, PipedriveClient, isCompanyHost, refreshTokenSecret, type PipedriveClientOptions } from './pipedrive/client.js';
import {
  isToolDisabled,
  resolveInstancePolicy,
  runInCallScope,
  TOOL_PREFIX,
  type InstancePolicy,
} from './pipedrive/policy.js';
import { ConfigError } from './config-env.js';
import { failureFrom, failureMetadata, formatUnknownError, redactDeep, SecretRedactor, type FailureMetadata } from './errors.js';
import { fixedOutputs, withheldResult } from './fallbacks.js';
import { admitsKey, keyRefusedText, leaksSecret, sealedError } from './key-admission.js';
import {
  auditRejectedCall,
  changedInput,
  PIPEDRIVE_TOOLS,
  executeTool,
  findTool,
  logFieldValue,
  validateCall,
  validateStartupConfig,
  type PipedriveChangeAction,
  type PipedriveChangeRecord,
  type PipedriveChangeSpec,
  type CallContext,
  type ToolDefinition,
  type UpstreamOperation,
} from './tools/pipedrive.js';

/**
 * Embeddable entry point (package export `./gateway`): an embedding host,
 * such as an MCP gateway that does its own per-user authorization, lists
 * `tools` and invokes `callTool`. Tool definitions, input validation,
 * instance policy and audit are shared with the MCP server in
 * src/tools/pipedrive.ts.
 *
 * One instance per Pipedrive company and user (one API token). Several instances
 * can run in one process. Each instance uses only the token passed to
 * createPipedriveGateway (never PIPEDRIVE_API_TOKEN or PIPEDRIVE_BASE_URL from
 * the environment) and redacts errors with its own secrets only.
 *
 * Instance policy (writes, disabled tools, audit) comes from the host when it
 * passes `policy`: that instance then reads none of PIPEDRIVE_ENABLE_WRITES,
 * PIPEDRIVE_DISABLED_TOOLS or PIPEDRIVE_AUDIT_LOG,
 * so two tenants in one process can have different settings. Without
 * `policy` the instance uses the environment, as the MCP server does. Limits
 * (timeouts, retries) are still read from the environment and apply to every
 * instance.
 *
 * What no policy can turn on: a request outside the client's fixed list of
 * writes (src/pipedrive/client.ts, ALLOWED_WRITES): a new or changed deal,
 * person, organization or activity (API v2), and a new or changed note (API
 * v1). There is no DELETE, merge or bulk change, and nothing sends e-mail or
 * invitations or touches users, permissions, pipelines, stages, fields,
 * filters, products, files or webhooks.
 */

export type { AuditSink, InstancePolicy } from './pipedrive/policy.js';
export type {
  PipedriveChangeAction,
  PipedriveChangeRecord,
  PipedriveChangeSpec,
  PipedriveLogField,
  PipedriveLogFieldType,
} from './tools/pipedrive.js';

export type GatewayRiskLevel = 'read' | 'write' | 'destructive';
export type GatewayJsonValue = string | number | boolean | null | GatewayJsonValue[] | { [key: string]: GatewayJsonValue };
export type GatewayJsonObject = { [key: string]: GatewayJsonValue };

export interface GatewayToolDefinition {
  name: string;
  title: string;
  description: string;
  riskLevel: GatewayRiskLevel;
  enabledByDefault: boolean;
  inputSchema: GatewayJsonObject;
}

/**
 * Metadata about a failed call, on an error result whose cause is known: the HTTP status the upstream API answered
 * with, and the vendor's own request id when a response header gives one as a UUID or hex id. For a host that counts
 * failures without reading their text. Never the response body, the vendor's error code or message, or the input.
 */
export type GatewayFailure = FailureMetadata;

export interface GatewayToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: GatewayJsonValue;
  isError?: boolean;
  /** On an error result from the upstream API only: its HTTP status and request id (see GatewayFailure). */
  failure?: GatewayFailure;
}

export type GatewayCallContext = CallContext;

/** Deeply read-only JSON, as found in the frozen tool catalog. */
export type GatewayReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly GatewayReadonlyJsonValue[]
  | { readonly [key: string]: GatewayReadonlyJsonValue };

/** One upstream request a tool may make (method and path template relative to the base URL). */
export type GatewayUpstreamOperation = Readonly<UpstreamOperation>;

/** A tool catalog entry: the gateway definition plus the upstream requests the tool may make. */
export interface GatewayToolCatalogEntry {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly riskLevel: GatewayRiskLevel;
  readonly enabledByDefault: boolean;
  readonly inputSchema: { readonly [key: string]: GatewayReadonlyJsonValue };
  readonly upstream: readonly GatewayUpstreamOperation[];
  /**
   * True when the tool can read more than its name says (anything in the
   * system, chosen by the input). A host that grants tools per role gives a
   * broad tool only to roles that may read everything. From the tool table
   * (`broad`), false unless a tool declares it.
   */
  readonly broad: boolean;
  /**
   * True for a tool a person should confirm outside the chat before it runs.
   * False for every tool here: none moves money.
   */
  readonly requiresConfirmation: boolean;
  /**
   * Write tools only: what the change does, for a host that logs a change
   * before it is sent. `logFields` are the input fields that identify it,
   * each with the one type its value must have (Pipedrive ids, internal keys, dates,
   * counts, flags, currency codes and the names of changed fields in clear;
   * never names, amounts or free text).
   * `resolvePipedriveChange` returns their values.
   */
  readonly change?: PipedriveChangeSpec;
}

/** OAuth access for one user: the app's credentials, the user's refresh token and the user's company address. */
export interface PipedriveGatewayOAuth {
  /** The app's client id from Pipedrive's Developer Hub. */
  clientId: string;
  /** The app's client secret. A secret. */
  clientSecret: string;
  /** The user's refresh token. A secret. */
  refreshToken: string;
  /** The user's company address, `api_domain` from the token answer: https://<company>.pipedrive.com. */
  apiDomain: string;
}

export interface PipedriveGatewayOptions
  extends Omit<PipedriveClientOptions, 'apiToken' | 'oauth' | 'credentialEnv' | 'allowLoopback' | 'tokenUrl' | 'now' | 'baseUrl'> {
  /** The personal API token of a Pipedrive user; a secret; never read from the environment. Give this or `oauth`. */
  apiToken?: string;
  /** OAuth access for one user through a registered app. Give this or `apiToken`. */
  oauth?: PipedriveGatewayOAuth;
  /** With an API token only: https://api.pipedrive.com, the default and the only address accepted. */
  baseUrl?: string;
  /**
   * Instance policy from the host. When given, the instance reads no policy
   * or audit variables from the environment (see InstancePolicy). A host
   * serving several tenants should always pass it.
   */
  policy?: InstancePolicy;
}

/**
 * JSON Schema for a gateway tool, derived from the tool's zod schema.
 * `format` is dropped: validators such as Ajv reject unknown formats in
 * strict mode unless format plugins are installed, and zod already checks
 * these values when the call runs.
 */
function toGatewayJsonSchema(tool: ToolDefinition): GatewayJsonObject {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.inputSchema, {
    io: 'input',
    override: ctx => {
      delete (ctx.jsonSchema as Record<string, unknown>).format;
    },
  }) as Record<string, unknown>;
  return schema as GatewayJsonObject;
}

function stripPrefix(name: string): string {
  return name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;
}

function toGatewayDefinition(tool: ToolDefinition): GatewayToolDefinition {
  return {
    name: stripPrefix(tool.name),
    title: tool.title,
    description: tool.description,
    riskLevel: tool.annotations.readOnlyHint ? 'read' : tool.annotations.destructiveHint ? 'destructive' : 'write',
    enabledByDefault: tool.annotations.readOnlyHint,
    inputSchema: toGatewayJsonSchema(tool),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

/** All tools, as gateway definitions (names without the prefix). */
export const pipedriveGatewayTools: GatewayToolDefinition[] = PIPEDRIVE_TOOLS.map(toGatewayDefinition);

/**
 * The tool catalog: every tool with its gateway definition and the upstream
 * requests it may make. Generated from the same tool table as the MCP server
 * and `pipedriveGatewayTools`, and deeply frozen. Hosts can use it to build
 * their own permission model without creating a gateway instance.
 */
export const pipedriveToolCatalog: readonly GatewayToolCatalogEntry[] = deepFreeze(
  PIPEDRIVE_TOOLS.map(tool => ({
    ...toGatewayDefinition(tool),
    upstream: tool.upstream.map(operation => ({ ...operation })),
    broad: tool.broad === true,
    requiresConfirmation: tool.requiresConfirmation === true,
    ...(tool.change
      ? { change: { ...tool.change, logFields: tool.change.logFields.map(field => ({ ...field })) } }
      : {}),
  })),
);

/** What a write tool call will change, resolved from its input before anything is sent. */
export interface PipedriveChange {
  readonly tool: string;
  readonly action: PipedriveChangeAction;
  readonly record: PipedriveChangeRecord;
  readonly movesMoney: false;
  readonly requiresConfirmation: boolean;
  /**
   * The values of the tool's `logFields` that are present and have their
   * field's type. A value of the wrong type is left out, so a name or a free
   * text can never reach the values.
   */
  readonly values: Readonly<Record<string, string | number | boolean>>;
}

export type PipedriveChangeResolution =
  | { readonly ok: true; readonly change: PipedriveChange }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolves what a write tool call will change, for a host that logs the
 * change before the call runs: the action, the record kind and the values of
 * the tool's `logFields`: Pipedrive ids, dates and keys in clear, never a
 * name or a comment. A field of type `pseudonym` would come back only as
 * HMAC-SHA-256 with `options.pseudonymKey` (else SHA-256). Refuses
 * read tools, unknown tools and invalid input, as callTool does.
 */
export function resolvePipedriveChange(
  toolName: string,
  input: GatewayJsonObject = {},
  options: { pseudonymKey?: string | Uint8Array; redactor?: SecretRedactor } = {},
): PipedriveChangeResolution {
  const name = typeof toolName === 'string' ? toolName.trim() : '';
  const tool = name ? findTool(`${TOOL_PREFIX}${stripPrefix(name)}`) : undefined;
  if (!tool) return { ok: false, reason: 'Unsupported Pipedrive gateway tool.' };
  if (!tool.change) return { ok: false, reason: `${stripPrefix(tool.name)} is not a write tool.` };
  const valid = validateCall(tool, input);
  if (!valid.ok) return { ok: false, reason: `Invalid input for ${stripPrefix(tool.name)}.` };
  const data = valid.data;
  const values: Record<string, string | number | boolean> = {};
  for (const field of tool.change.logFields) {
    const value = logFieldValue(
      field.type,
      field.type === 'fields' ? changedInput(tool.change.record, tool.change.action, data) : data[field.name],
      options.pseudonymKey,
    );
    if (value === undefined) continue;
    // A secret put in a field by mistake never reaches the host's log: with an instance's redactor, a value that
    // holds a piece of its token is left out.
    if (options.redactor && leaksSecret(String(value), options.redactor)) continue;
    values[field.name] = value;
  }
  return {
    ok: true,
    change: Object.freeze({
      tool: stripPrefix(tool.name),
      action: tool.change.action,
      record: tool.change.record,
      movesMoney: false as const,
      requiresConfirmation: tool.requiresConfirmation === true,
      values: Object.freeze(values),
    }),
  };
}

/** The admitted credential: an API token, or OAuth access with its secrets admitted one by one. */
type Admitted = { kind: 'token'; apiToken: string } | { kind: 'oauth'; oauth: PipedriveGatewayOAuth; secrets: string[] };

/**
 * Key admission (src/key-admission.ts): printable ASCII of 16 characters or more, sharing no piece with any text of
 * ours. Checked before anything is built from a secret; the refusal is a fixed text that holds no piece of it.
 */
function admitted(value: string): string {
  if (!admitsKey(value)) throw new ConfigError(keyRefusedText(value));
  return value;
}

function admittedCredential(options: PipedriveGatewayOptions): Admitted {
  const given = options as Partial<PipedriveGatewayOptions> | undefined;
  const token: unknown = given?.apiToken;
  const oauth: unknown = given?.oauth;
  if (token !== undefined && oauth !== undefined) {
    throw new ConfigError('createPipedriveGateway takes options.apiToken or options.oauth, not both.');
  }
  if (oauth !== undefined) {
    const o = (oauth ?? {}) as Partial<Record<keyof PipedriveGatewayOAuth, unknown>>;
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const clientId = text(o.clientId);
    const clientSecret = text(o.clientSecret);
    const refreshToken = text(o.refreshToken);
    const apiDomain = text(o.apiDomain);
    if (!clientId || !clientSecret || !refreshToken || !apiDomain) {
      throw new ConfigError('createPipedriveGateway requires oauth.clientId, oauth.clientSecret, oauth.refreshToken and oauth.apiDomain.');
    }
    if (!/^[\x21-\x7e]{1,200}$/.test(clientId)) throw new ConfigError('oauth.clientId is not a client id.');
    if (!isCompanyAddress(apiDomain)) throw new ConfigError('oauth.apiDomain must be the company address at Pipedrive (https://<company>.pipedrive.com).');
    const secret = admitted(clientSecret);
    const grant = admitted(refreshTokenSecret(refreshToken));
    if (grant === secret) throw new ConfigError(keyRefusedText(secret));
    return { kind: 'oauth', oauth: { clientId, clientSecret, refreshToken, apiDomain: apiDomain.replace(/\/+$/, '') }, secrets: [secret, grant] };
  }
  if (typeof token !== 'string' || token.trim() === '') {
    throw new ConfigError(
      'createPipedriveGateway requires options.apiToken or options.oauth. Embedded instances do not read credentials from the environment.',
    );
  }
  return { kind: 'token', apiToken: admitted(token.trim()) };
}

/** The given forms of the secrets, admitted or not, so every error can be masked against them. */
function givenSecrets(options: PipedriveGatewayOptions): string[] {
  const given = options as Partial<PipedriveGatewayOptions> | undefined;
  const o = (given?.oauth ?? {}) as Partial<Record<keyof PipedriveGatewayOAuth, unknown>>;
  const forms: string[] = [];
  for (const value of [given?.apiToken, o.clientSecret, o.refreshToken]) {
    if (typeof value !== 'string' || value === '') continue;
    forms.push(value, value.trim());
    if (value === o.refreshToken) forms.push(refreshTokenSecret(value.trim()));
  }
  return forms;
}

/**
 * Create one gateway instance for one Pipedrive user: with the user's API
 * token, or with OAuth access through a registered app (`oauth`). One of the
 * two is required and is the only credential the instance uses; a missing
 * value fails here.
 */
export function createPipedriveGateway(options: PipedriveGatewayOptions) {
  let firstSecret: string | undefined;
  // The host's pseudonym key, in every form it could be written, read before anything else can fail.
  const pseudonymForms = keyForms((options as Partial<PipedriveGatewayOptions> | undefined)?.policy?.pseudonymKey);
  const guard = new SecretRedactor();
  // What the host gave, admitted or not: every error is masked against it, the pseudonym key included.
  const secrets = [...givenSecrets(options), ...pseudonymForms];
  const refusal = () => keyRefusedText(firstSecret ?? '');
  try {
    // Every secret is known to the guard before any validation that can throw, and inside the try: whatever
    // happens while registering it leaves as the sealed error below.
    for (const form of secrets) guard.addSecret(form);
    // The pseudonym key is admitted like the secrets: as text, printable and sharing no piece with any text
    // of ours, so no fixed text (a fallback, an error, the tool list) can carry a piece of it; as bytes, every
    // form of it that is printable text (the bytes read as text, hex, base64) the same way.
    const pseudonymKey: unknown = (options as Partial<PipedriveGatewayOptions> | undefined)?.policy?.pseudonymKey;
    const refused =
      typeof pseudonymKey === 'string'
        ? !admitsKey(pseudonymKey)
        : pseudonymForms.some(form => /^[ -~]+$/.test(form) && !admitsKey(form));
    if (refused) throw new ConfigError(PSEUDONYM_KEY_REFUSED);
    // Admission of the credential, before a redactor is built from it.
    const credential = admittedCredential(options);
    const admittedSecrets = credential.kind === 'token' ? [credential.apiToken] : credential.secrets;
    firstSecret = admittedSecrets[0];
    for (const secret of admittedSecrets) guard.addSecret(secret);
    // The fixed outputs of the sink check (src/fallbacks.ts) must hold no piece of a key.
    if (leaksSecret(fixedOutputs(), guard)) {
      throw new ConfigError(refusal());
    }
    const gateway = buildGateway(options, credential);
    // The tool list leaves the gateway as it is: a key that shares a piece with it is refused.
    if (leaksSecret(gateway.tools, guard)) {
      throw new ConfigError(refusal());
    }
    return gateway;
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    // Redacted, then checked whole as the very last step: a message that still holds a piece of a key becomes the
    // fixed refusal.
    let message = guard.redact(raw);
    if (leaksSecret(message, guard)) message = refusal();
    // A fresh error in final form (src/key-admission.ts, sealedError): no cause, a stack without frames, and name,
    // message and stack masked against every key. Then the sink check on the finished object.
    const final = sealedError(error instanceof ConfigError ? new ConfigError(message) : new Error(message), ...secrets);
    if (leaksSecret(final, guard)) {
      throw sealedError(new ConfigError(refusal()), ...secrets);
    }
    throw final;
  }
}

const PSEUDONYM_KEY_REFUSED =
  'policy.pseudonymKey was refused: use at least 32 random printable characters (for example 32 random bytes as hex) or at least 32 random bytes.';

/** A key given as text or bytes, in every form it could be written: as given, or as the bytes read or encoded. */
function keyForms(key: unknown): string[] {
  if (typeof key === 'string') return key === '' ? [] : [...new Set([key, key.trim()])];
  if (key instanceof Uint8Array) {
    const bytes = Buffer.from(key);
    return [...new Set(['utf8', 'latin1', 'hex', 'base64', 'base64url'].map(form => bytes.toString(form as BufferEncoding)))];
  }
  return [];
}

/** Register a key given as text or bytes, in every form it could be written. */
function addKeyMaterial(redactor: SecretRedactor, key: string | Uint8Array): void {
  for (const form of keyForms(key)) redactor.addSecret(form);
}

function buildGateway(options: PipedriveGatewayOptions, credential: Admitted) {
  const { policy: hostPolicy, apiToken: _t, oauth: _o, ...clientOptions } = options;
  const policy =
    hostPolicy === undefined ? undefined : resolveInstancePolicy(hostPolicy, PIPEDRIVE_TOOLS.map(tool => tool.name));
  if (policy === undefined) {
    // In a scope of its own: a gateway created from inside another instance's call (its audit sink or its fetch)
    // validates against the environment, never against that instance's policy.
    runInCallScope({}, () => validateStartupConfig());
  }
  // Only Pipedrive's own addresses: with an API token https://api.pipedrive.com, with OAuth the user's company address
  // and oauth.pipedrive.com. Anything else is refused here, so no secret can be sent elsewhere, whatever the host passes.
  const {
    allowLoopback: _loopback,
    tokenUrl: _tokenUrl,
    now: _now,
    ...rest
  } = clientOptions as typeof clientOptions & { allowLoopback?: unknown; tokenUrl?: unknown; now?: unknown };
  if (rest.baseUrl !== undefined && (credential.kind === 'oauth' || !isPipedriveAddress(rest.baseUrl))) {
    throw new ConfigError(`createPipedriveGateway accepts only ${DEFAULT_BASE_URL} as baseUrl, and none with OAuth access.`);
  }
  const client =
    credential.kind === 'token'
      ? new PipedriveClient({ ...rest, apiToken: credential.apiToken, credentialEnv: {}, allowLoopback: false })
      : new PipedriveClient({
          ...rest,
          baseUrl: credential.oauth.apiDomain,
          oauth: { clientId: credential.oauth.clientId, clientSecret: credential.oauth.clientSecret, refreshToken: credential.oauth.refreshToken },
          credentialEnv: {},
          allowLoopback: false,
        });
  const redactor: SecretRedactor = client.redactor;
  // The host's pseudonym key is a secret like the access token: kept out of results, logs and errors.
  if (policy?.pseudonymKey !== undefined) addKeyMaterial(redactor, policy.pseudonymKey);
  // Every call in a scope of its own, with or without a host policy: a call made from inside another
  // instance's call (its audit sink or its fetch) never runs under that instance's policy, sink or redactor.
  const underPolicy = <T>(work: () => T): T => runInCallScope(policy ? { policy, redactor } : { redactor }, work);

  return {
    /**
     * resolvePipedriveChange bound to this instance: a value that holds a piece of
     * this instance's token is left out of the values.
     */
    resolveChange(toolName: string, input: GatewayJsonObject = {}, resolveOptions: { pseudonymKey?: string | Uint8Array } = {}) {
      return resolvePipedriveChange(toolName, input, { ...resolveOptions, redactor });
    },
    /** Tools enabled on this instance (the policy's or PIPEDRIVE_DISABLED_TOOLS' disabled tools are left out). */
    tools: underPolicy(() => pipedriveGatewayTools.filter(tool => !isToolDisabled(tool.name))),
    callTool(toolName: string, input: GatewayJsonObject = {}, context?: GatewayCallContext): Promise<GatewayToolResult> {
      // The whole result, text and data (keys included, numbers by their string form), with this instance's secrets
      // redacted: upstream data can echo the key, and so can an error. Redacted first, as data and depth-limited, and
      // only then copied as JSON, so no key is serialised and no deep value can exhaust the stack.
      return underPolicy(() =>
        runCall(toolName, input, context).then(
          // A second pass covers what the first one inserted (the depth placeholder). Then the sink check, as the very
          // last step: a result that holds a piece of the key anywhere, outer fields included, is withheld whole.
          result => {
            // The data also goes into the text, built from this final, redacted copy, so the sink check covers it.
            const final = withDataInText(
              withFailureInForm(
                JSON.parse(JSON.stringify(redactDeep(redactDeep(result, redactor), redactor))) as GatewayToolResult,
              ),
            );
            return leaksSecret(final, redactor) ? withheldResult() : final;
          },
        ),
      );
    },
  };

  async function runCall(
    toolName: string,
    input: GatewayJsonObject,
    context: GatewayCallContext | undefined,
  ): Promise<GatewayToolResult> {
    try {
      const name = typeof toolName === 'string' ? toolName.trim() : '';
      const tool = name ? findTool(`${TOOL_PREFIX}${stripPrefix(name)}`) : undefined;
      if (!tool) {
        // Redacted before it is cut short: a cut key would no longer match the redactor.
        await auditRejectedCall(String(toolName), input, 'unknown_tool', context);
        return errorResult('Unsupported Pipedrive gateway tool.');
      }

      const parsed = tool.inputSchema.safeParse(input ?? {});
      if (!parsed.success) {
        const reason = `Invalid input for ${name}: ${z.prettifyError(parsed.error)}`;
        await auditRejectedCall(tool.name, input, 'invalid_input', context);
        return errorResult(redactor.redact(reason));
      }

      const data = await executeTool(tool, client, parsed.data as Record<string, unknown>, context ?? undefined);
      const text = tool.returnsUpstreamContent ? `${tool.summary} ${UNTRUSTED_CONTENT_NOTE}` : tool.summary;
      return jsonResult(text, data);
    } catch (error) {
      return errorResult(formatUnknownError(error, redactor), failureMetadata(error));
    }
  }
}

/** Whether a base URL is Pipedrive's own address (https://api.pipedrive.com, a trailing slash allowed). */
/** A company address at Pipedrive, as `api_domain` gives it: https, a company host, nothing else. */
function isCompanyAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      isCompanyHost(url.hostname.toLowerCase()) &&
      url.port === '' &&
      (url.pathname === '/' || url.pathname === '') &&
      !url.username && !url.password && !value.includes('?') && !value.includes('#')
    );
  } catch {
    return false;
  }
}

function isPipedriveAddress(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname.toLowerCase() === 'api.pipedrive.com' &&
      url.port === '' &&
      (url.pathname === '/' || url.pathname === '') &&
      !url.username && !url.password && !value.includes('?') && !value.includes('#')
    );
  } catch {
    return false;
  }
}

/** One gateway instance, as returned by createPipedriveGateway. */
export type PipedriveGateway = ReturnType<typeof createPipedriveGateway>;

/** The data as it came; callTool redacts it and only then copies it as JSON. */
function jsonResult(text: string, structuredContent: unknown): GatewayToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: (structuredContent ?? null) as GatewayJsonValue,
  };
}

/**
 * The redacted data, also as compact JSON in the text block after the summary, as the MCP spec asks of a tool
 * that returns structured content: many clients read only the text. Built from the final, redacted copy, so the
 * text holds exactly `structuredContent` and nothing more. Error results have no data and are left as they are.
 */
function withDataInText(result: GatewayToolResult): GatewayToolResult {
  if (result.isError || result.structuredContent === undefined) return result;
  const [first, ...rest] = result.content;
  const summary = first?.text ?? '';
  return {
    ...result,
    content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(result.structuredContent)}` }, ...rest],
  };
}

function errorResult(text: string, failure?: GatewayFailure): GatewayToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text }],
    ...(failure ? { failure } : {}),
  };
}

/**
 * The failure metadata as it must be after redaction: on an error result only, a status of 100-599 and a request id
 * still in the form of one (redaction can have changed it). Anything else is dropped, never passed on.
 */
function withFailureInForm(result: GatewayToolResult): GatewayToolResult {
  const { failure, ...rest } = result;
  if (!result.isError || failure === undefined || failure === null || typeof failure !== 'object') return rest;
  const checked = failureFrom(failure.httpStatus, failure.requestId);
  return checked === undefined ? rest : { ...rest, failure: checked };
}
