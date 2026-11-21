# mcp-server-pipedrive

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Pipedrive](https://www.pipedrive.com) CRM. It lets an MCP client (Claude or any other MCP-capable assistant) read deals, persons, organizations, activities, notes, pipelines and users in one Pipedrive company and, when enabled, create and change deals, persons, organizations, activities and notes, and move deals between stages.

> This is an independent, unofficial project. It is not developed, endorsed or supported by Pipedrive. It uses only Pipedrive's public API.

- Read-only by default; writes are opt-in per instance, and every write can be undone in Pipedrive (a new record, a changed field, a moved deal, an activity marked done). No delete, merge, bulk change, e-mail, invitation, or change to users, permissions, pipelines, stages, fields, filters, products or webhooks, whatever the configuration.
- One personal API token per server instance, sent only to `api.pipedrive.com` in the `x-api-token` header; the server does no per-user authorization itself (see [Security model](#security-model)).
- Two transports: stdio for local clients, stateless streamable HTTP for containers and gateways.
- Embeddable: the `./gateway` export exposes the same tools, validation, policy and audit to a host application.

## Tools

| Tool | Purpose |
|---|---|
| `pipedrive_check_connection` | Whether the token works: the user id, the company, its currency and time zone. |
| `pipedrive_list_users` | The company's users (owners of records): id, name, e-mail, active. |
| `pipedrive_list_pipelines` | The pipelines and their stages in order, with win probability. |
| `pipedrive_search_deals` | Deals by text, or listed by pipeline, stage, status, owner, person, organization or last change. |
| `pipedrive_get_deal` | One deal. |
| `pipedrive_search_persons` | Persons by text (name, e-mail, phone), or listed by organization, owner or last change. |
| `pipedrive_get_person` | One person with e-mail addresses and phone numbers. |
| `pipedrive_search_organizations` | Organizations by text (name, address), or listed by owner or last change. |
| `pipedrive_get_organization` | One organization with its address. |
| `pipedrive_list_activities` | Activities by deal, person, organization, owner, done or last change. |
| `pipedrive_list_notes` | Notes on a deal, person or organization, newest first, as plain text. |
| `pipedrive_create_deal` *(write)* | Create a deal, linked to a person and/or an organization. |
| `pipedrive_update_deal` *(write)* | Change a deal, or mark it won, lost or open again; the answer holds the old values. |
| `pipedrive_move_deal` *(write)* | Move a deal to another stage; the answer holds the stage it was in. |
| `pipedrive_create_person` *(write)* | Create a person, optionally at an organization. |
| `pipedrive_update_person` *(write)* | Change a person; the answer holds the old values. |
| `pipedrive_create_organization` *(write)* | Create an organization. |
| `pipedrive_update_organization` *(write)* | Change an organization; the answer holds the old values. |
| `pipedrive_create_activity` *(write)* | Create an activity (call, meeting, task ...) on a deal, person or organization; nothing is sent to anyone. |
| `pipedrive_update_activity` *(write)* | Mark an activity done, move or reassign it; the answer holds the old values. |
| `pipedrive_add_note` *(write)* | Add a note to a deal, person or organization. |
| `pipedrive_update_note` *(write)* | Replace a note's text; the answer holds the old text. |

Every read gives on a fixed list of fields per record type (custom fields are left out: their keys mean nothing without the company's field settings); the write tools set only the fields in their input schema. Deals, persons, organizations, activities, pipelines and stages use API v2; notes and users exist only in API v1.

## Access to Pipedrive

The server takes one **personal API token**: in Pipedrive, the user opens *Personal preferences > API* (or <https://app.pipedrive.com/settings/api>) and copies the token. It belongs to that user in that company and carries the user's permissions; there are no scopes to choose. It does not expire, but it stops working when the user generates a new one or leaves the company. A company admin can turn API access off for a permission set, and then the menu is missing.

The token goes in the `x-api-token` header, as Pipedrive's documentation asks, and only to `api.pipedrive.com` (Pipedrive finds the company from the token, so no company address is needed).

No OAuth app is used. Under Pipedrive's Developer Agreement, an app distributed commercially is a Marketplace app and needs Pipedrive's approval, even when unlisted; see [Sources](#sources).

## Quick start

Requires Node.js 22 or later and a Pipedrive API token (see [Access to Pipedrive](#access-to-pipedrive)). Every Pipedrive plan has the API, the 14-day trial too.

```bash
npx mcp-server-pipedrive
```

Or build from source:

```bash
git clone https://github.com/borgels/mcp-server-pipedrive.git
cd mcp-server-pipedrive
npm ci
npm run build
```

Claude Code:

```bash
claude mcp add pipedrive \
  --env PIPEDRIVE_API_TOKEN=<API token> \
  -- npx -y mcp-server-pipedrive
```

Claude Desktop (`claude_desktop_config.json`), or any client that launches stdio servers:

```json
{
  "mcpServers": {
    "pipedrive": {
      "command": "npx",
      "args": ["-y", "mcp-server-pipedrive"],
      "env": {
        "PIPEDRIVE_API_TOKEN": "<API token>"
      }
    }
  }
}
```

### Docker and HTTP

Images are published to `ghcr.io/borgels/mcp-server-pipedrive`: `latest` and the commit SHA from `main`, and `vX.Y.Z` for release tags. The container serves streamable HTTP at `/mcp` on port 3000, plus an unauthenticated `GET /healthz`.

```bash
TOKEN=$(openssl rand -hex 32); echo "$TOKEN"
docker run -d --name pipedrive-mcp -p 127.0.0.1:3000:3000 \
  -e PIPEDRIVE_API_TOKEN=<API token> \
  -e MCP_HTTP_TOKEN="$TOKEN" \
  ghcr.io/borgels/mcp-server-pipedrive:latest

claude mcp add --transport http pipedrive http://127.0.0.1:3000/mcp \
  --header "Authorization: Bearer $TOKEN"
```

To keep an audit log in the container, mount a writable directory and point `PIPEDRIVE_AUDIT_LOG` into it (e.g. `-v pipedrive-audit:/audit -e PIPEDRIVE_AUDIT_LOG=/audit/audit.jsonl`); the image runs as the `node` user and `/app` is not writable.

Clients send `Authorization: Bearer <MCP_HTTP_TOKEN>`. The server will not start on a non-loopback address without a token of at least 32 characters. It does not terminate TLS; run it behind a reverse proxy or gateway that does.

## Configuration

Configuration is read from the environment (see `.env.example`). Invalid numbers, booleans, URLs and unknown tool names stop the server at startup. Booleans accept `true`/`false`, `1`/`0`, `yes`/`no` and `on`/`off`.

### Upstream API

| Variable | Default | Description |
|---|---|---|
| `PIPEDRIVE_API_TOKEN` | – | **Required.** The personal API token of a Pipedrive user. |
| `PIPEDRIVE_BASE_URL` | `https://api.pipedrive.com` | Base URL of the API. Must be `https` (loopback `http` is allowed for local mocks). |
| `PIPEDRIVE_ALLOW_CUSTOM_BASE_URL` | `false` | Allow another address than Pipedrive's API host. |
| `PIPEDRIVE_TIMEOUT_MS` | `30000` | Timeout per request attempt. |
| `PIPEDRIVE_MAX_CONCURRENCY` | `4` | Maximum concurrent upstream requests. |
| `PIPEDRIVE_MAX_RESPONSE_BYTES` | `10485760` | Largest response body read (at most 100 MB). |

### Access control

| Variable | Default | Description |
|---|---|---|
| `PIPEDRIVE_ENABLE_WRITES` | `false` | Enable the write tools. |
| `PIPEDRIVE_DISABLED_TOOLS` | – | Comma-separated tool names to disable, with or without the `pipedrive_` prefix. |
| `PIPEDRIVE_AUDIT_LOG` | – | Path of a JSONL audit log: one record per tool call start, finish and error, with record ids, internal keys, dates and paging in clear text, no free text or search (not even hashed), duration, status and the caller passed by an embedding host. Write tools refuse to run if the log cannot be written. |

### HTTP transport

| Variable | Default | Description |
|---|---|---|
| `MCP_HTTP_TOKEN` | – | Bearer token, at least 32 printable ASCII characters (also on loopback). Required unless bound to loopback. |
| `MCP_HTTP_HOST` or `HOST` | `127.0.0.1` (`0.0.0.0` in the image) | Bind address; `MCP_HTTP_HOST` takes precedence. |
| `PORT` | `3000` | Listen port. |
| `MCP_ALLOWED_ORIGINS` | localhost origins | Comma-separated browser origins allowed to call the server. |
| `MCP_ALLOW_ANY_ORIGIN` | `false` | Allow any origin; requires a token. |
| `MCP_ALLOWED_HOSTS` | loopback names on a loopback bind | Comma-separated accepted `Host` header names. |
| `MCP_MAX_BODY_BYTES` | `10485760` | Maximum request body. |
| `MCP_AUTH_FAILURE_LIMIT`, `MCP_AUTH_FAILURE_WINDOW_MS` | `20`, `60000` | Failed-authentication limit per client address; `0` disables it. |
| `MCP_HTTP_ALLOW_UNAUTHENTICATED` | `false` | Permit a non-loopback bind without a token. Only for isolated networks. |

## Embedding (`./gateway`)

A host application can run the tools in-process instead of over MCP:

```ts
import { createPipedriveGateway, pipedriveToolCatalog } from 'mcp-server-pipedrive/gateway';

const gateway = createPipedriveGateway({
  apiToken: tenant.apiToken,
  policy: { enableWrites: true, disabledTools: [] },
});
const result = await gateway.callTool('search_deals', { status: 'won' }, { caller: 'user-1' });
```

- **Explicit credentials.** `apiToken` is required; a missing value throws when the gateway is created. It passes key admission. A gateway never reads `PIPEDRIVE_*` credentials or addresses from the environment, so one tenant cannot silently fall back to the process's credentials. The stdio and HTTP transports still read them from the environment.
- **Several tenants in one process.** Create one gateway per API token. Each instance redacts error text, tool results and audit records with its own key only; no secret is kept in a process-wide registry, and a dropped instance releases its key.
- **Instance policy from the host.** Pass `policy` to `createPipedriveGateway`: `enableWrites` (default false), `disabledTools` (must name known tools) and `audit`, a function that receives each audit record instead of `PIPEDRIVE_AUDIT_LOG` (without it the instance writes no audit; a write tool does not run if the sink throws on its start record). An instance with `policy` reads none of `PIPEDRIVE_ENABLE_WRITES`, `PIPEDRIVE_DISABLED_TOOLS`, `PIPEDRIVE_AUDIT_LOG` or `PIPEDRIVE_ALLOW_CUSTOM_BASE_URL`, so tenants in one process can have different settings. Without `policy` the instance uses the environment, like the MCP server. Each call runs in a scope of its own, so a call made from inside another instance's call never inherits its policy, sink or redactor, and every audit record is redacted as a whole with the instance's own key before the sink sees it. The limits (`PIPEDRIVE_TIMEOUT_MS`, ...) are still read from the environment and apply to every gateway in the process. Per-user and per-tenant authorization is the host's job.
- **Result format.** A successful `callTool` result has `structuredContent` and one text block: a short summary, a blank line, and the same data as compact JSON, as the MCP specification recommends (many clients read only the text). The JSON is built from the redacted result, so it holds exactly `structuredContent`. An error result has only its text.
- **Changes for a host log.** `resolvePipedriveChange(tool, input)` (and `gateway.resolveChange`) says what a write will change before it is sent: the action, the record and only Pipedrive ids, internal keys (record kind, activity type, deal status, currency code), dates, flags and the names of changed fields, never names, e-mail addresses, amounts or texts. No tool moves money, so `requiresConfirmation` is false for all.
- **Tool catalog.** `pipedriveToolCatalog` is a frozen list of every tool: `name` (without the `pipedrive_` prefix), `title`, `description`, `riskLevel` (`read`, `write` or `destructive`), `enabledByDefault`, `inputSchema` (JSON Schema), `broad` (true when a tool can read more than its name says, so a host gives it only to roles that may read everything) and `upstream`, the API requests the tool may make (`access`, `method` and path template). It is generated from the same tool table as the MCP server, so it cannot drift from the registered tools. `pipedriveGatewayTools` holds the same definitions without `upstream` and `broad`; `gateway.tools` lists those enabled on the instance.

## Threat model

What this server guarantees about the API key, and what it does not. It is
the yardstick for every change that touches errors, results or audit.

**Scope.** Guarantees (a), (b) and (c) apply to the embeddable gateway
(`./gateway`), the surface a multi-tenant host uses. The standalone MCP
server, configured from the environment for one key, keeps best-effort
redaction: its errors and audit records are redacted with its key, but it is
not held to these guarantees.

**Guaranteed:**

- **(a) The key never reaches anything persisted or shared:** audit sinks and
  the audit log file, logs, error texts, export hooks or files. Errors are
  our own texts; audit records and everything a gateway instance returns are
  redacted with the instance's own key before they leave it.
- **(b) No vendor-controlled free text in errors.** An error carries our own
  fixed text, the HTTP status, numbers we parse (Retry-After), and codes from
  a fixed list we wrote down; never a response body, a vendor message or
  code, a redirect's `Location`, a type or field name from the vendor, or
  the message of an error thrown while reading a response. A failure kept
  inside an otherwise returned result is the status or a fixed text as well.
  Errors never quote the key, the configured address or a refused configuration value (a timeout names its limit in milliseconds).
- **(c) Results go only to the tenant whose key it is.** One gateway
  instance per tenant; every call runs in a scope of its own; nothing about a
  tenant is kept in process-wide state. The MCP server serves one key.

**Not guaranteed (residual risk):** a vendor that deliberately echoes the
customer's own key back in data. Results are redacted on a best-effort
basis: the exact key, its URL- and JSON-encoded forms and any piece of it of
6 characters or more, in strings, object keys and the string form of
numbers and booleans, are replaced by `"‹redacted›"` before anything is
serialised. A key that comes back otherwise transformed (split into pieces
shorter than 6 characters, reversed, re-encoded, hashed) is not recognised.
Such data reaches only the tenant whose key it is, which already holds the
key. **What leaves a gateway holds no piece of the key.** This is checked at
the sink, not inferred from our texts: every output is checked in its final
form, and one that holds a piece of 6 characters of the key (or of one of
its encoded forms) is replaced by a fixed fallback. The outputs are the tool
list, every tool result as a whole (outer fields such as `isError`
included), audit records and stderr lines, and construction errors. A result becomes a fixed
"withheld" error, an audit record or line becomes a fixed one, and a
construction error becomes the fixed refusal. Every error a gateway throws is a fresh error in final form: no `cause`, a `stack` of only `name: message` (no frames, paths or function names), and name, message and stack masked against the secret. The fallbacks are a small,
closed set (`src/fallbacks.ts`), and a key that shares a piece with any of
them, or with the tool list, is refused when the gateway is created.

**Key admission.** Every key is a secret the vendor issues. A gateway
accepts only printable ASCII (0x21-0x7E) of at least 16 characters, checked
before anything is built from the key. As a cheap first filter it also
refuses a key that shares a piece of 6 characters with a string literal in
`src/` (`src/fixed-corpus.generated.ts`, kept up to date by a test). The
refusal is a fixed text that never repeats the key. The standalone MCP server applies the same redaction to errors
and audit records on a best-effort basis; its successful results are redacted
the same way and withheld whole when a piece of the key remains.

## Security model

- **One shared identity.** Every caller acts with the rights of the user whose API token is configured. Writes are limited to the eleven in the tool table.
- **Per-user authorization belongs in front of the server.** The server checks a single bearer token and does not know the end user. For multi-user use, run it behind an identity-aware gateway that decides which users may call which tools, holds the bearer token, and is the only network path to the server. Hosts can also embed the tools through the `./gateway` module export and pass the caller identity into the audit log.
- **Tool access is not data access.** A gateway controls who may call which tool; every permitted caller still sees everything the API key can see. To separate data, run several instances with different keys.
- **Writes are off by default.** Write tools are annotated as writes (not read-only), and not as destructive: each can be undone in Pipedrive. Clients can still ask for confirmation of every non-read-only tool. Read-only tools get a client that sends only GET. When `PIPEDRIVE_AUDIT_LOG` is set, a write tool does not run unless its start record is written; without it there is no audit record.
- **Upstream content is untrusted input.** Data returned by the API may be written by anyone with access to it. Tool results label it as data; clients that combine this server with other tools should treat it accordingly.
- **The API key stays on the API origin.** Redirects are never followed, the base URL must use `https`, and error messages and audit records are redacted (by each instance, with that instance's key) and size-capped. See the threat model above for what is and is not guaranteed.
- **The HTTP transport fails closed.** It refuses to start on a non-loopback address or with any origin allowed unless a token is set, compares tokens in constant time, throttles failed authentication per client address, checks `Origin` and `Host` (DNS rebinding), and caps request bodies.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Sources

Built from Pipedrive's public documentation (read 21.11.2026). The tests use answers shaped as documented; `test/live.test.ts` runs the tools against a real test company when `PIPEDRIVE_TEST_API_TOKEN` is set (in CI from the repository secret of that name; without it the job passes with a notice).

- API token, header and where to find it: <https://pipedrive.readme.io/docs/core-api-concepts-authentication>, <https://pipedrive.readme.io/docs/how-to-find-the-api-token>, <https://pipedrive.readme.io/docs/enabling-api-for-company-users>.
- API v2 and the migration from v1 (v1 deals, persons, organizations, activities, pipelines and stages are out of support from 01.08.2026): <https://pipedrive.readme.io/docs/pipedrive-api-v2-migration-guide>, <https://developers.pipedrive.com/changelog/post/deprecated-apiv1-endpoints-become-out-of-support>.
- Reference (deals, persons, organizations, activities, pipelines, stages, search, notes, users): <https://developers.pipedrive.com/docs/api/v1>.
- Paging and rate limits: <https://pipedrive.readme.io/docs/core-api-concepts-pagination>, <https://pipedrive.readme.io/docs/core-api-concepts-rate-limiting>.
- Private apps and the Developer Agreement (private apps for non-commercial use; commercial distribution is a Marketplace app subject to approval): <https://pipedrive.readme.io/docs/marketplace-registering-a-private-app>, <https://www.pipedrive.com/en/developer-agreement>.

## Development

```bash
npm run dev          # stdio transport
npm run dev:http     # HTTP transport on 127.0.0.1:3000
npm run typecheck
npm test
npm run build
```

Project layout:

| Path | Contents |
|---|---|
| `src/tools/pipedrive.ts` | Shared tool table (MCP and gateway), policy and audit wrapper. |
| `src/pipedrive/resources.ts` | The API calls and the schemas each answer is parsed with. |
| `src/pipedrive/` | Upstream client, API calls, policy, audit, tool annotations. |
| `src/transports/` | stdio and HTTP entry points; HTTP auth, origin and host checks. |
| `src/gateway.ts` | Embeddable entry point (`./gateway` export). |
| `src/config-env.ts` | Validated environment readers. |

## Releasing

1. Bump the version in `package.json`, `server.json` (`version` and the npm package `version`) and `src/version.ts`; tests and CI check that they agree. Update `CHANGELOG.md`. Merge.
2. Tag the merged commit and push the tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. `release.yml` tests, packs and publishes the tarball to npm through trusted publishing (no stored token; npm adds provenance when the repository is public), then publishes `server.json` to the MCP Registry. Versions already on npm or in the registry are skipped, so a failed run can be re-run. Pre-release tags (`vX.Y.Z-rc.1`) go to the npm dist-tag `next` and not to the registry. `publish.yml` pushes the `vX.Y.Z` image.

The first version of a new package is published by hand; see the header of `.github/workflows/release.yml` (and [docs/NEW-SERVER.md](docs/NEW-SERVER.md)).

## License

Apache-2.0
