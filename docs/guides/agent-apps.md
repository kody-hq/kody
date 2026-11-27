---
id: agent_apps
title: Using apps as an agent
summary:
  How an agent finds and calls the package apps its person can run. List them
  with appList, call one with appFetch or kody app fetch, and act as the person
  with an optional profile label. Covers consent links, profiles, and using
  hosted URLs as app addresses.
category: platform
audience: agents
---

# Using apps as an agent

A package app is a small web app someone published on Kody. If your person can
open an app in a browser, you can call it for them. One path does this:
`appFetch` (MCP, `execute`, the Open API) and `kody app fetch` (CLI). It runs
the same access check as a browser visit, so there is nothing extra to set up.

## Find an app

Call `appList`. It returns every app you can run: apps in each org your person
belongs to, and apps another org shared with them.

```json
{ "owner": "acme" }
```

`owner` is optional. Each result has the address to call (`app`, such as
`@acme/board`), the owning org, the `package_id`, the hosted URL a person opens,
whether the app is public or private, and `shared: true` when it comes from an
org your person is not a member of. Long lists page with `next_cursor`.

From a terminal: `kody app list` follows all the result pages. Pass `--org acme`
to filter by the owning org, or `--json` for an object with one `apps` array.

Package search (`search` with `entity` omitted or a package name) also finds
apps, but `appList` is the answer to "which apps can I run right now".

## Call an app

```json
{
	"app": "@acme/board",
	"path": "/api/cards",
	"method": "POST",
	"headers": { "content-type": "application/json" },
	"body": "{\"title\":\"Ship it\"}"
}
```

`app` takes the `@org/app` address or the app's hosted URL. You can pass
`package_id` instead. The call returns `status`, `headers`, `body`, and
`truncated`.

From a terminal:

```sh
kody app fetch @acme/board /api/cards --method POST \
  --header "content-type: application/json" --body @card.json
kody app fetch @acme/board /export.csv --out export.csv
```

Things to know:

- **It is a real visit.** The app's handler runs with real side effects, the
  same as a person clicking in a browser. Pass `synthetic: true` (CLI:
  `--synthetic`) only for a smoke test; that sets the `Kody-Synthetic: true`
  header so an app can tell a test from a visit.
- **Bodies are capped.** Over MCP the response body stops at 102,400 bytes and
  `truncated` is `true`. The Open API takes `max_bytes` up to 10,485,760;
  `kody app fetch --out <file>` uses that to write up to 10 MB to a file.
- **Websockets are not supported.** Use plain HTTP routes.
- **Call it from your agent session.** `appFetch` works from MCP, `execute`, the
  Open API, and the CLI. Code running inside a package app or a job cannot call
  it.

## Who the app sees

The app sees your person: the same `user_id` it sees when they visit in a
browser. Data the app keeps per person is the same data either way.

When you act through a [profile](/docs/profiles), the app also sees the profile
as a label: `metaGetCurrentUser()` and the `X-Kody-Visitor` header carry
`profile: { id, name }`, and `profile` is `null` for a visit with no profile.
The visit counts for your person in the publisher's Visitors list, and its run
record carries the profile chain. The app's own permissions do not change: it
still runs as its publisher's choice of person, and it reaches a visitor's
credentials only through the needs the visitor allowed.

## Profiles

A profile reaches an app only when the profile was given Use on that app. Your
person's access is the outer limit, each parent profile narrows it, and the
token's scopes narrow it again. `appList` shows exactly the apps the profile can
run.

To give a profile an app, including one another org shared with your person,
grant it from the org the profile lives in:

```json
{
	"resource_type": "app",
	"resource_id": "<package_id from appList>",
	"subject_type": "profile",
	"subject_id": "prf_...",
	"preset": "use"
}
```

That is `accessGrant`. `profileCreate` and `profileHandoff` take the same grant
in `grants[]`. The person must be able to run the app themselves, and a
sub-profile can only get an app its parent holds. Remove the grant with
`accessRevoke`.

An app can ask a visitor for a credential (a visitor need). A profile uses that
credential only when the profile was also given Use on the credential itself.
The person's consent to the app does not widen what a profile can reach.

## When the app needs your person once

Some things only a person can approve, and an agent never approves them:

- **Run as me.** The first visit to an app shared from another org asks the
  person to confirm that the app's work runs for them and bills their own org.
- **A credential the app asks for.** The person chooses whether the app may use
  it.

When either is missing, the call fails with `app_consent_required` and a
`consent_url`. Give that link to your person. They open it once in a browser,
confirm, and then the same call works. Nothing is recorded until they do.

## Imports are not visits

`import ... from 'kody:@org/package/export'` reuses a package's code inside the
same org. It does not cross orgs and it is not a visit to an app. To use an app,
call `appFetch`. To reuse its code, import it.

## Pass hosted URLs as app addresses

An app's hosted URL (`https://<app>--<org>.kody.run/` or a custom domain) is for
people in a browser, where Kody signs them in. Pass that URL as an address to
`appFetch` or `kody app fetch` instead of sending your API token to the app
host. Before handing the request to app code,
[Kody strips inbound `Authorization`, `Proxy-Authorization`, and `X-Kody-*` headers and forwards only cookies scoped to that app](../../packages/worker/src/package-runtime/package-app-serve.ts).

## Related

- [Package apps](/docs/package-apps): building and publishing an app
- [Profiles](/docs/profiles): scoped identities for agents
- [Sharing a package](/docs/package-sharing): how an app gets shared
