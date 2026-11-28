---
id: agent_apps
title: Using apps as an agent
summary:
  How an agent finds, calls, and opens the package apps its person can run. List
  them with appList, call one with appFetch or kody app fetch, and open one in
  the agent's own browser with appOpenLink or kody app open-link. Covers acting
  as the person with an optional profile label, consent links, profiles, and
  using hosted URLs as app addresses.
category: platform
audience: agents
---

# Using apps as an agent

Use `appList` to find a hosted package app, `appFetch` or `kody app fetch` to
call it as your person, and `appOpenLink` or `kody app open-link` to
[open it in your own browser](#open-an-app-in-your-browser). The
[shared visit permission check](../../packages/worker/src/app-visit/authorize.node.test.ts)
requires `app:execute` on the app in its owning org and accounts for the
credential you call with.

## Find an app

Call `appList` to find apps you have Use access to in member orgs or shared from
another org. In a terminal, use `kody app list`.

```json
{ "owner": "acme" }
```

Use the returned `app` address (such as `@acme/board`) for your next call. For
another page, pass `next_cursor` as `cursor`. The CLI follows all pages
automatically: pass `--org acme` to filter or `--json` for one `apps` array. See
the [listing reference](../use/app-fetch.md#list-apps) for limits and result
fields.

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
`package_id` instead. See the [call reference](../use/app-fetch.md#call-shape)
for response encoding, body limits, and supported methods.

From a terminal:

```sh
kody app fetch @acme/board /api/cards --method POST \
  --header "content-type: application/json" --body @card.json
kody app fetch @acme/board /export.csv --out export.csv
```

**Calls can have real side effects**, even when marked as a
[synthetic smoke test](../use/app-fetch.md#synthetic-smoke-tests). Use plain
HTTP routes from an interactive session; the
[`appFetch` caller check](../../packages/worker/src/mcp/capabilities/packages/app-fetch.node.test.ts)
rejects package app and background job callers.

## Open an app in your browser

When you need the app's pages in a real browser (to look at the UI, click
through a flow, or take a screenshot), call `appOpenLink` and open the `url` it
returns in your browser. Nobody has to sign in to Kody in that browser first.

```json
{ "app": "@acme/board", "path": "/cards" }
```

From a terminal, `kody app open-link @acme/board /cards` prints only the link.

Treat the link like a password: do not paste it into chat, logs, or a pull
request. Use one link per browser visit, not one per page. See the
[open-link reference](../use/app-fetch.md#open-link) for expiry and visit
access, or
[When the app needs your person once](#when-the-app-needs-your-person-once) if
you get `app_consent_required`.

Keep using `appFetch` for programmatic calls: it returns the status, headers,
and body directly and needs no browser. Never send your API token to the app's
host to sign in; [it is stripped](#pass-hosted-urls-as-app-addresses).

## Who the app sees

The app sees your person: the same `user_id` it sees when they visit in a
browser. Data the app keeps per person is the same data either way.

When you act through a [profile](/docs/profiles), the app also sees the profile
as a label: `metaGetCurrentUser()` and the `X-Kody-Visitor` header carry
`profile: { id, name }`, and `profile` is `null` for a visit with no profile.
This is the same for `appFetch` and for a browser opened with `appOpenLink`. The
visit counts for your person in the publisher's Visitors list,
[which names the profile that visited for them](../../packages/worker/src/usage/credit-attribution.node.test.ts),
and its run record carries the profile chain. The app's own permissions do not
change: it still runs as its publisher's choice of person. A
[visitor-need lookup](../../packages/worker/src/package-runtime/package-app-authority.ts)
requires the visitor's live grant for that app and need.

## Profiles

The [app access check](../../packages/worker/src/app-visit/authorize.ts) uses
the person's access, each layer of the profile chain, and any token scopes
together. `appList` applies the same permission when filtering results.

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
in `grants[]`. An
[app grant to a profile](../../packages/worker/src/app-visit/authorize.node.test.ts)
requires the person's own access and, for a sub-profile, its parent's access.
Remove the grant with `accessRevoke`.

A visitor-need credential still needs
[Use at every layer of the acting profile chain](../../packages/worker/src/credentials/personal-credential-profile.node.test.ts),
even when the person has allowed the need.

## When the app needs your person once

When
[`appFetch` reports `app_consent_required`](../../packages/worker/src/mcp/capabilities/packages/app-fetch.node.test.ts)
(or
[`appOpenLink` does](../../packages/worker/src/mcp/capabilities/packages/app-open-link.node.test.ts)),
give its `consent_url` to your person. An outside visitor may need to confirm
**Run as me**, or the app may need approval for a required visitor credential.
The call reports the missing approval instead of recording it. Retry after the
person confirms in the browser. See the
[consent reference](../use/app-fetch.md#consent) for error details.

## Imports are not visits

`import ... from 'kody:@org/package/export'` reuses code
[within the caller's org](../../packages/worker/src/package-runtime/package-import-resolution.node.test.ts);
it is not an app visit. To use an app, call `appFetch` or open it with
`appOpenLink`.

## Pass hosted URLs as app addresses

An app's hosted URL (`https://<app>--<org>.kody.run/` or a custom domain) is for
a browser. A person's browser is signed in by Kody; yours is signed in by an
[`appOpenLink` link](#open-an-app-in-your-browser). Pass that URL as an address
to `appFetch`, `appOpenLink`, or their CLI commands instead of sending your API
token to the app host. Before handing the request to app code,
[Kody strips inbound `Authorization`, `Proxy-Authorization`, and `X-Kody-*` headers and forwards only cookies scoped to that app](../../packages/worker/src/package-runtime/package-app-serve.ts).

## Related

- [Package apps](/docs/package-apps): building and publishing an app
- [Profiles](/docs/profiles): scoped identities for agents
- [Sharing a package](/docs/package-sharing): how an app gets shared
