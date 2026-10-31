---
id: provider_notion
title: Connect Notion
summary:
  Verified walkthrough for connecting Notion to Kody: the personal internal
  connection token lane (fastest), the public connection OAuth lane, the
  page-picker access model (Notion has no OAuth scopes), prefilled connect
  links, and a users/me smoke test for both lanes.
category: provider
provider: Notion
lastVerified: 2026-08
---

# Connect Notion

Notion calls integrations "connections" and manages them in its Developer
portal. There are two lanes: an internal connection whose token you save as a
Kody secret (fastest), or a public connection connected through the hosted OAuth
flow (durable, works across workspaces).

## What you get

Once connected, you can ask Kody things like:

- "Add today's meeting notes to my Notes database."
- "Search my Notion for the onboarding checklist and summarize it."
- "Append this reading list to my Books page."

## Before you start

- Connections are free on every Notion plan.
- Access is granted per page: a connection only sees pages and databases that
  have been explicitly shared with it (Lane A) or picked during the consent
  screen (Lane B). Nothing is visible by default.
- The Developer portal lives at
  [app.notion.com/developers](https://app.notion.com/developers);
  [notion.so/profile/integrations](https://www.notion.so/profile/integrations)
  redirects there.

## Lane A: internal connection token (fastest)

1. Open the Developer portal at
   [app.notion.com/developers](https://app.notion.com/developers) and create a
   connection for your workspace (type: internal).
2. In the connection's tokens section, copy the secret — it starts with `ntn_`.
3. In Notion, open each page or database Kody should reach, open the page menu
   (`...`) -> **Connections**, and add your connection. Child pages inherit
   access.

### Save the token in Kody

Save it through the account secrets page — never paste the token into chat:

```text
https://kody.codes/connect/secret-set?name=notionToken&description=Notion%20internal%20connection%20token&allowedHosts=api.notion.com&scope=user
```

Approve the `api.notion.com` host on the same page after saving.

## Lane B: public connection (OAuth)

1. In the Developer portal, create a **public** connection. Choose the
   installation scope carefully — it cannot be changed after creation.
2. On the **Configuration** tab, set the redirect URI to
   `https://kody.codes/connect/oauth` (a self-hosted deployment registers its
   own origin plus `/connect/oauth`) and copy the client ID and client secret.

### Connect to Kody

```text
https://kody.codes/connect/oauth?provider=notion&authorizeUrl=https%3A%2F%2Fapi.notion.com%2Fv1%2Foauth%2Fauthorize&tokenUrl=https%3A%2F%2Fapi.notion.com%2Fv1%2Foauth%2Ftoken&flow=confidential&extraAuthorizeParams=%7B%22owner%22%3A%22user%22%7D
```

For a team organization, add `&org=<team-slug>` so the app and connection are
saved there; without it they go to the personal organization (see
`guide:oauth`).

Decoded: authorize URL `https://api.notion.com/v1/oauth/authorize`, token URL
`https://api.notion.com/v1/oauth/token`, `flow=confidential`, and
`extraAuthorizeParams={"owner":"user"}` (the page adds `response_type=code`
itself). No `tokenExchangeStyle` is needed: Kody defaults `api.notion.com` to
`basic-json` — HTTP Basic credentials with a JSON body — which is what Notion's
token endpoint expects. Paste the client ID and secret into the setup form, then
authorize and pick the pages Kody may access.

Since June 2026, each successful authorization mints a fresh access/refresh
token pair, and re-authorizing replaces the previous tokens. Kody stores the new
pair automatically on reconnect (`/connect/oauth?provider=notion`), which is
also how you change which pages are shared.

## Verify

Lane A (saved secret) — run in `execute` after the host is approved:

```ts
export default async function main() {
	const response = await fetch('https://api.notion.com/v1/users/me', {
		headers: {
			Authorization: 'Bearer {{secret:notionToken}}',
			'Notion-Version': '2026-03-11',
		},
	})
	if (!response.ok) {
		throw new Error(
			`Notion smoke test failed: ${response.status} ${await response.text()}`,
		)
	}
	const me = (await response.json()) as { name?: string; type: string }
	return { type: me.type, name: me.name }
}
```

Lane B (OAuth integration):

```ts
import { createAuthenticatedFetch } from 'kody:runtime'

export default async function main() {
	const notionFetch = await createAuthenticatedFetch('notion')
	const response = await notionFetch('https://api.notion.com/v1/users/me', {
		headers: { 'Notion-Version': '2026-03-11' },
	})
	if (!response.ok) {
		throw new Error(
			`Notion smoke test failed: ${response.status} ${await response.text()}`,
		)
	}
	const me = (await response.json()) as { name?: string; type: string }
	return { type: me.type, name: me.name }
}
```

Every Notion API request needs the `Notion-Version` header.

## Scopes and access

Notion has no OAuth scopes. What a connection can reach is decided by two
things:

- The pages granted: explicit **Connections** shares for Lane A, or the page
  picker on the consent screen for Lane B. Minimal tier: share one dedicated
  page or database. Fuller tier: share top-level pages so child pages inherit.
- The connection's capabilities, configured in the Developer portal: read
  content, update content, insert content, and user-information levels. A
  read-content-only connection cannot write, no matter which pages it sees.

To change page access on an OAuth connection, reconnect and pick again; for an
internal connection, edit the page's **Connections** menu.

## Troubleshooting

- `object_not_found` for a page you can open yourself: the page has not been
  shared with the connection. Add it via the page's **Connections** menu (Lane
  A) or reconnect and include it in the picker (Lane B).
- `401 unauthorized` on Lane B after re-authorizing elsewhere: each successful
  authorization replaces the token pair, so an older stored token stops working.
  Reconnect so Kody stores the current pair.
- `missing version` error: add the `Notion-Version` header to every request.
- Token exchange fails with `invalid_client`: Notion expects HTTP Basic
  credentials with a JSON body. Leave `tokenExchangeStyle` unset so the
  `api.notion.com` default (`basic-json`) applies.
- Installation scope wrong on a public connection: it cannot be edited after
  creation; create a new public connection instead.

## Use the `@kody/notion` package and verify (Lane B / OAuth)

Lane A stays on the raw `notionToken` fetch above. `@kody/notion`, a public
community package from the `@kody` org, is the Lane B finish after you fork it:
it uses the saved `notion` OAuth integration and does not read `notionToken`.

1. Search for `@kody/notion`. It wraps pages, databases, and a generic request
   escape hatch.
2. `communityFork` it into your org (or click **Install** on the listing).
3. Check the fork's README **Required setup**: it expects an OAuth integration
   named `notion` — the default name this guide's Lane B connect link uses, so
   no adaptation is needed.
4. Verify the fork against the OAuth integration from `execute`:

```ts
import smokeTest from 'kody:@<your-username>/notion/smoke-test'

export default async function main() {
	return smokeTest()
}
```

A successful response confirms OAuth access without returning workspace PII —
proving the fork, the tokens, and the page grants all line up. Remember the
package only sees pages you shared on Notion's consent screen.
