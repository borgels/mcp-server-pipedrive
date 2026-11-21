# Changelog

## 0.4.0

- Gateway error results carry failure metadata: when the upstream API
  answered with an HTTP error or a redirect (never followed), the result has
  `failure: { httpStatus, requestId? }`, so a host can count failures by
  status without reading their text. `requestId` is the vendor's own id from
  a response header (`REQUEST_ID_HEADERS`), kept only when it is a hex id of
  8 to 64 characters (one run of hex digits, or groups of four or more joined
  by single hyphens, as in a UUID) and does not hold the shape of a personal
  number. It is checked again after redaction, so an id that shared a piece
  with the key is dropped. Never the body, the vendor's error code or
  message. The same form as mcp-server-hubspot 0.3.0.

## 0.3.1

- Licensor and copyright holder corrected to Borgels Services ApS in `LICENSE`,
  `NOTICE` and `CONTRIBUTING.md`. The license is unchanged (FSL-1.1-ALv2).

## 0.3.0

- License changed from Apache-2.0 to the Functional Source License, Version 1.1,
  ALv2 Future License (FSL-1.1-ALv2). You may read, run, modify and use the code
  internally and contribute changes; offering it as a competing commercial
  product or service is not allowed. Each version becomes Apache-2.0 two years
  after its release. Versions released before 0.3.0 remain under Apache-2.0
  (see `NOTICE`).

## 0.2.0

- The gateway can use OAuth access for one user through an app registered in
  Pipedrive's Developer Hub, instead of an API token: `oauth` with the app's
  client id and secret, the user's refresh token and the user's company
  address (`api_domain`). The client renews the access token at
  `oauth.pipedrive.com/oauth/token` with HTTP Basic auth, keeps it for its
  lifetime (60 minutes), renews once and sends again on a 401, and sends it as
  a Bearer token only to `https://<company>.pipedrive.com`. A refused renewal
  is a 401 in the server's own words. A refresh token of the form
  `<id>:<id>:<secret>` has only its last part treated as secret, so the ids in
  ordinary answers are not withheld.
- The standalone server still takes an API token from the environment.

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
