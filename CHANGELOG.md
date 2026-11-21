# Changelog

## 0.1.1

- An organization's address is read with every documented field (street,
  number, floor, area, region, postal code, country and the formatted
  address), so a change answers with the whole old address.
- A test shows that the pipeline list follows its own cursor.

## 0.1.0

First version for Pipedrive CRM, from the MCP server template (0.1.1), with
the gateway in the same form as mcp-server-hubspot 0.2.0.

- Access with one personal API token of a Pipedrive user, sent in the
  `x-api-token` header, never in a URL, and only to `api.pipedrive.com` over
  https without following redirects. Never exchanged or renewed.
- Reads (API v2 where it exists): the connection (user id, company, currency,
  time zone), users, pipelines with their stages, search and list of deals,
  persons and organizations (a fixed list of fields each, no custom fields),
  get one deal, person or organization, activities, and notes (API v1) as
  plain text.
- Writes, off unless enabled, each undoable in Pipedrive: create and change a
  deal, person, organization or activity, move a deal to another stage, mark
  a deal won or lost, mark an activity done, add a note and change its text.
  Each update answers with the old values. No delete, merge, bulk change,
  e-mail, invitation, or change to users, permissions, pipelines, stages,
  fields, filters, products or webhooks: the client refuses every other write
  before it is sent, and read tools can only send GET.
- The gateway takes the token from the host, admits it, and exposes the
  catalog with `upstream`, `broad`, `requiresConfirmation` and `change`, and
  `resolvePipedriveChange` for a host that logs a change before it is sent:
  ids, keys, dates and flags only, never a title, an amount, a name or a text.
- `test/live.test.ts` and the CI job `live` run reads and changes against a
  real test company when the secret `PIPEDRIVE_TEST_API_TOKEN` is set, and
  pass with a notice when it is not.
