---
id: provider_salesforce
title: Connect Salesforce
summary:
  Verified connect walkthrough for Salesforce: bring-your-own Connected App
  or External Client App, the exact /connect/oauth callback, production vs
  sandbox login hosts, scopes, prefilled connect links, and a smoke test.
category: provider
provider: Salesforce
lastVerified: 2026-08
---

# Connect Salesforce

Every connection is bring-your-own: you create a Connected App or External
Client App in the org, register Kody's redirect URI, then finish OAuth on
`/connect/oauth`.

## What you get

Once connected, you can ask Kody things like:

- "Run this SOQL query and summarize the results."
- "Describe the Contact sObject and list its custom fields."
- "Show the Opportunity records that closed this month."

Exact access depends on the Connected App scopes and the Salesforce user's
permissions in that org.

## Before you start

- You need permission in the org to create a Connected App or External Client
  App (typically a system administrator).
- There is one OAuth app per Salesforce org you want to call. Production and
  sandbox are different login hosts and different connections.
- The helpers package is
  [@kody/salesforce](https://kody.codes/@kody/salesforce), a public community
  package from the `@kody` org. A saved integration is credentials only; fork
  that package and use your copy as the agent-facing surface.

See the [OAuth guide](../oauth.md) for query parameters, confidential exchange,
and reconnect behavior.

## Create a Connected App or External Client App

Salesforce Setup offers both **Connected Apps** and **External Client Apps**.
Either works. Enable OAuth and treat the consumer key / consumer secret as a
confidential web app.

1. In Salesforce Setup, open **App Manager** (Connected App) or **External
   Client App Manager** and create a new app with OAuth enabled.
2. Set the callback / redirect URI to exactly `https://kody.codes/connect/oauth`
   (a self-hosted deployment registers its own origin plus `/connect/oauth`).
   Matching is exact — a trailing slash or `heykody.dev` host fails.
3. Select OAuth scopes that include `api`, `refresh_token`, and
   `offline_access`. Add more only when a workflow needs them.
4. Copy the consumer key (client ID) and consumer secret (client secret). Paste
   those into Kody's `/connect/oauth` setup form, not into chat.

Production orgs authorize at `login.salesforce.com`. Sandboxes authorize at
`test.salesforce.com`. Using the wrong host looks like a broken client, not a
wrong org.

## Connect to Kody

Open this URL while signed in to Kody. It matches the `@kody/salesforce`
package's prefilled connect link, with the production callback and connect page
on `https://kody.codes/connect/oauth`:

```text
https://kody.codes/connect/oauth?provider=salesforce&authorizeUrl=https%3A%2F%2Flogin.salesforce.com%2Fservices%2Foauth2%2Fauthorize&tokenUrl=https%3A%2F%2Flogin.salesforce.com%2Fservices%2Foauth2%2Ftoken&apiBaseUrl=https%3A%2F%2Flogin.salesforce.com&scopes=api%20refresh_token%20offline_access&flow=confidential&allowedHosts=login.salesforce.com%2C*.salesforce.com%2C*.force.com%2C*.my.salesforce.com
```

For a team organization, add `&org=<team-slug>` so the app and connection are
saved there; without it they go to the personal organization (see
`guide:oauth`).

Decoded: authorize URL `https://login.salesforce.com/services/oauth2/authorize`,
token URL `https://login.salesforce.com/services/oauth2/token`, `apiBaseUrl`
`https://login.salesforce.com`, `flow=confidential`, scopes
`api refresh_token offline_access`, and `allowedHosts` covering the login host
plus `*.salesforce.com`, `*.force.com`, and `*.my.salesforce.com` so REST calls
can follow the org's instance URL.

For a sandbox, replace every `login.salesforce.com` with `test.salesforce.com`
in `authorizeUrl`, `tokenUrl`, `apiBaseUrl`, and `allowedHosts`. Use a distinct
`provider` name such as `salesforce-sandbox` so it does not overwrite the
production connection.

Paste the consumer key and secret into the setup form, then authorize as a user
who can see the data the workflow needs.

## More than one org

Each org is its own Kody integration. Give production, sandbox, and extra orgs
different `provider` values (`salesforce`, `salesforce-sandbox`,
`salesforce-eu`). The package helpers take `integrationName` so a call targets
that connection instead of the default `salesforce` name.

## Verify

After connecting, `communityFork` `@kody/salesforce` into your org and run the
fork's smoke test from `execute` (pass `integrationName` when the connection is
not named `salesforce`):

```ts
import smokeTest from 'kody:@<your-username>/salesforce/smoke-test'

export default async function main() {
	return smokeTest()
}
```

A successful response confirms OAuth without returning profile PII. Once that
passes, day-to-day calls go through package helpers such as `./query`,
`./describe-sobject`, `./request`, and `./triage-error`.

## Scopes

Space-delimited. The official connect link requests:

- `api` — REST and SOAP API access for the authorized user
- `refresh_token` and `offline_access` — a refresh token so Kody can keep
  calling after the access token expires

Widen only when a later workflow needs extra Salesforce OAuth scopes, then
reconnect with the new `scopes` value. Missing `refresh_token` /
`offline_access` is the usual reason a connection works once and then cannot
refresh.

## Troubleshooting

- Redirect URI mismatch: the Connected App / External Client App callback must
  be exactly `https://kody.codes/connect/oauth`. Do not register `heykody.dev` —
  production callback and connect URLs are on `kody.codes`.
- Sandbox authorize or token errors: the connect URL still points at
  `login.salesforce.com`. Rebuild it with `test.salesforce.com` and a distinct
  integration name.
- No refresh token after a successful connect: the app is missing
  `refresh_token` and `offline_access`, or the user previously authorized a
  narrower grant. Add the scopes, revoke the old grant in Salesforce if needed,
  and reconnect.
- API calls fail against `login.salesforce.com` or `test.salesforce.com` after
  connect: those are login hosts, not the org instance. Salesforce returns an
  instance URL (for example `*.my.salesforce.com`) from userinfo; the package
  follows that URL. Keep the wildcard hosts from the connect link so
  `createAuthenticatedFetch` can reach the instance.
- `invalid_client` / secret errors: confirm the consumer secret is current and
  that `flow=confidential` is set. Rotate the secret in Salesforce and reconnect
  if it was regenerated.

After you are connected, fork
[@kody/salesforce](https://kody.codes/@kody/salesforce) and use your copy for
identity, SOQL, sObject metadata, and confirmed record changes.
