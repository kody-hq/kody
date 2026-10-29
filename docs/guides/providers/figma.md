---
id: provider_figma
title: Connect Figma
summary:
  Verified walkthrough for connecting Figma to Kody (BYO OAuth or personal/plan
  access token), then using @kody/figma over Figma REST, not Figma's remote MCP.
category: provider
provider: Figma
lastVerified: 2026-10
---

# Connect Figma

Figma has no built-in Kody OAuth app. Connect with bring-your-own OAuth
(recommended) or a personal/plan access token, then call Figma through
[`@kody/figma`](https://kody.codes/@kody/figma) over the Figma REST API.

**Agents use Figma through Kody REST** (an OAuth integration or a PAT plus
`@kody/figma`). This is **not** Figma's allowlisted remote MCP. Do not connect
Figma's remote MCP for this path.

## What you get

Once connected, you can ask Kody things like:

- "Summarize the Checkout file and list its top-level pages."
- "List comments on this Figma design URL."
- "Render the empty-state frame as a PNG."

Exact capabilities depend on the OAuth scopes or token permissions you grant.

> [!WATCH] https://youtu.be/b_jLu3FYkTI Watch: Give your agent Figma access with
> Kody

## Before you start

- You need a Figma account and access to the
  [developer apps console](https://www.figma.com/developers/apps) (Lane A) or
  [personal/plan tokens](https://www.figma.com/developers/tokens) (Lane B).
- All REST calls go to `api.figma.com`. Approve that host when you save the
  integration or secret.
- Fork [`@kody/figma`](https://kody.codes/@kody/figma) after credentials exist;
  do not treat the live listing package storage as yours.

## Lane A: BYO OAuth (recommended)

1. Create an OAuth app at
   [www.figma.com/developers/apps](https://www.figma.com/developers/apps).
2. Set the redirect URI **exactly** to `https://kody.codes/connect/oauth` (a
   self-hosted deployment registers its own origin plus `/connect/oauth`).
3. Enable **exactly** these scopes on the Figma OAuth app: `current_user:read`,
   `file_content:read`, `file_metadata:read`, `file_comments:read`,
   `file_comments:write`, `file_versions:read`, `library_content:read`,
   `library_assets:read`, `folders:read`. Figma returns HTTP 400 Invalid scopes
   when authorize asks for a scope the app does not offer, a deprecated scope,
   or an enterprise-only extra.
4. Copy the client ID and client secret from the Figma app page.

### Connect to Kody

Open the prefilled connect URL while signed in to Kody:

```text
https://kody.codes/connect/oauth?provider=figma&authorizeUrl=https%3A%2F%2Fwww.figma.com%2Foauth&tokenUrl=https%3A%2F%2Fapi.figma.com%2Fv1%2Foauth%2Ftoken&apiBaseUrl=https%3A%2F%2Fapi.figma.com&scopes=current_user%3Aread%20file_content%3Aread%20file_metadata%3Aread%20file_comments%3Aread%20file_comments%3Awrite%20file_versions%3Aread%20library_content%3Aread%20library_assets%3Aread%20folders%3Aread&flow=confidential&pkce=true&allowedHosts=api.figma.com&dashboardUrl=https%3A%2F%2Fwww.figma.com%2Fdevelopers%2Fapps
```

For a team organization, add `&org=<team-slug>` so the app and connection are
saved there; without it they go to the personal organization (see
`guide:oauth`).

Decoded: authorize URL `https://www.figma.com/oauth`, token URL
`https://api.figma.com/v1/oauth/token`, `apiBaseUrl=https://api.figma.com`,
scopes space-separated as listed above, `flow=confidential`, `pkce=true`, and
`allowedHosts=api.figma.com`. Paste the client ID and client secret into the
setup form (never into chat), then authorize. Approve host `api.figma.com` if
the form still asks.

Reconnect later with `https://kody.codes/connect/oauth?provider=figma`.

To connect a second account, change `provider` (for example
`provider=figma-work`) and pass `integrationName: 'figma-work'` on package
calls.

See the [OAuth guide](../oauth.md) for query parameters, confidential exchange
plus PKCE, and reconnect behavior.

## Lane B: personal or plan access token

1. Create a personal access token from Figma **Settings → Security**, or a plan
   token at
   [www.figma.com/developers/tokens](https://www.figma.com/developers/tokens)
   ([PAT docs](https://developers.figma.com/docs/rest-api/personal-access-tokens/)).
2. Save it through the account secrets page. Never paste the token into chat:

```text
https://kody.codes/connect/secret-set?name=figmaPat&description=Figma%20personal%20or%20plan%20access%20token&allowedHosts=api.figma.com&scope=user
```

Approve `api.figma.com` on the same page after saving. The name `figmaPat` is
what `@kody/figma` reads by default.

For a second account or token, use a distinct secret name such as
`figmaPat-work` and pass `secretName: 'figmaPat-work'` (or `account: 'work'`).

## Use the `@kody/figma` package and verify

Credentials alone are not the finish. Fork
[`@kody/figma`](https://kody.codes/@kody/figma), a public community package from
the `@kody` org, so your automations call maintained helpers over Figma REST:

1. Search for `@kody/figma` (or open the listing) and `communityFork` it into
   your org (or click **Install**).
2. Check the fork's README **Required setup**: Lane A expects an OAuth
   integration named `figma`; Lane B expects secret `figmaPat`. Both need host
   `api.figma.com`.
3. Verify from `execute` (adjust the import to your fork):

```ts
import smokeTest from 'kody:@<your-username>/figma/smoke-test'

export default async function main() {
	return smokeTest()
}
```

A successful live response looks like `{ ok: true, live: true, … }` without
returning account PII. Without credentials, smoke-test still returns setup URLs
so the package stays forkable before anyone connects.

Optional OAuth-only probe with the raw runtime helper:

```ts
import { createAuthenticatedFetch } from 'kody:runtime'

export default async function main() {
	const figmaFetch = await createAuthenticatedFetch('figma')
	const response = await figmaFetch('https://api.figma.com/v1/me')
	if (!response.ok) {
		throw new Error(
			`Figma smoke test failed: ${response.status} ${await response.text()}`,
		)
	}
	const me = (await response.json()) as { id?: string; handle?: string }
	return { id: me.id, handle: me.handle }
}
```

## Scopes

| Scope                  | Needed for                              |
| ---------------------- | --------------------------------------- |
| `current_user:read`    | viewer / smoke-test                     |
| `file_content:read`    | file, nodes, images, image fills        |
| `file_metadata:read`   | file metadata                           |
| `file_comments:read`   | list comments                           |
| `file_comments:write`  | create / delete comments                |
| `file_versions:read`   | versioned reads via `./request`         |
| `library_content:read` | published components and styles         |
| `library_assets:read`  | library image assets via `./request`    |
| `folders:read`         | folder and file listing via `./request` |

Enable exactly those scopes on the Figma OAuth app when using Lane A. Narrower
grants work for a subset of helpers; insufficient-scope errors name the missing
scope and the next setup URL.

## Troubleshooting

- HTTP 400 Invalid scopes on authorize: the Figma OAuth app is missing a scope
  from the connect URL, still offers a deprecated scope, or the request includes
  an enterprise-only scope. Align the app and reconnect.
- `redirect_uri` mismatch: the registered redirect must be exactly
  `https://kody.codes/connect/oauth`.
- Host approval failures or blocked fetches: approve `api.figma.com` on the
  integration or `figmaPat` secret. REST is host-locked to that API host.
- `401` / `403` after a successful connect: reconnect
  (`/connect/oauth?provider=figma`) or rotate `figmaPat`; confirm the granted
  scopes cover the helper you called.
- Looking for Figma's remote MCP: that is a different path. This guide and
  `@kody/figma` use Kody REST only.

## Related

- [Integration bootstrap](../integration-bootstrap.md)
- [OAuth](../oauth.md)
- [`@kody/figma` listing](https://kody.codes/@kody/figma)
