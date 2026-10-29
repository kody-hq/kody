---
id: provider_dropbox
title: Connect Dropbox
summary:
  Walkthrough for connecting Dropbox to Kody with your own Dropbox app: app
  console setup, the PKCE connect link with offline refresh tokens, the three
  Dropbox API hosts (api, content, notify), and a smoke test through
  @kentcdodds/dropbox.
category: provider
provider: Dropbox
lastVerified: 2026-10
---

# Connect Dropbox

Dropbox has no built-in Kody OAuth app. Create a Dropbox app in its developer
console, then connect it to Kody with the authorization code + PKCE flow. PKCE
is a public-client flow, so Kody never needs the app secret.

## What you get

Once connected, you can ask Kody things like:

- "Upload this report to my reports folder in Dropbox."
- "Find last month's invoices in my Dropbox and list them."
- "Make a share link for the onboarding deck."

## Before you start

- Dropbox apps are free. A new app is in development status, which is fine for
  your own account.
- Dropbox serves its API from three hosts, and a connection needs all three:
  - `api.dropboxapi.com` for RPC calls such as listing folders and metadata
  - `content.dropboxapi.com` for uploads and downloads
  - `notify.dropboxapi.com` for change longpolling
- A connection that only allows `api.dropboxapi.com` can list files but fails
  every upload and download. The connect link below includes all three hosts.

## Create the app

1. Open the [Dropbox App Console](https://www.dropbox.com/developers/apps) and
   click **Create app**.
2. Choose **Scoped access**, then **App folder** (Kody sees only
   `/Apps/<your app name>`) or **Full Dropbox**. Name the app.
3. On the **Settings** tab, add the redirect URI
   `https://kody.codes/connect/oauth` under **OAuth 2 → Redirect URIs**. A
   self-hosted deployment registers its own origin plus `/connect/oauth`.
   Matching is exact. Leave **Allow public clients (Implicit Grant & PKCE)** on.
4. On the **Permissions** tab, enable the scopes from the Scopes section and
   click **Submit**. Dropbox refuses an authorize request for a scope the app
   does not have.
5. Copy the **App key** from the **Settings** tab. It is the OAuth client ID.

## Connect to Kody

Open the prefilled connect link while signed in to Kody:

```text
https://kody.codes/connect/oauth?provider=dropbox&authorizeUrl=https%3A%2F%2Fwww.dropbox.com%2Foauth2%2Fauthorize&tokenUrl=https%3A%2F%2Fapi.dropboxapi.com%2Foauth2%2Ftoken&apiBaseUrl=https%3A%2F%2Fapi.dropboxapi.com&scopes=account_info.read%20files.metadata.read%20files.metadata.write%20files.content.read%20files.content.write%20sharing.read%20sharing.write&extraAuthorizeParams=%7B%22token_access_type%22%3A%22offline%22%7D&allowedHosts=api.dropboxapi.com%2Ccontent.dropboxapi.com%2Cnotify.dropboxapi.com&dashboardUrl=https%3A%2F%2Fwww.dropbox.com%2Fdevelopers%2Fapps
```

For a team organization, add `&org=<team-slug>` so the app and connection are
saved there; without it they go to the personal organization (see
`guide:oauth`).

Decoded: authorize URL `https://www.dropbox.com/oauth2/authorize`, token URL
`https://api.dropboxapi.com/oauth2/token`,
`apiBaseUrl=https://api.dropboxapi.com`, the scopes listed below
(space-separated), `extraAuthorizeParams={"token_access_type":"offline"}`, and
`allowedHosts=api.dropboxapi.com,content.dropboxapi.com,notify.dropboxapi.com`.
`flow=pkce` is Kody's default, so the link has no flow parameter. Paste the app
key into the setup form, then authorize.

`token_access_type=offline` makes Dropbox return a refresh token. Without it,
Dropbox issues a short-lived access token only, and the connection stops working
after about four hours.

Name the connection `dropbox`: that is the name
[`@kentcdodds/dropbox`](https://kody.codes/@kentcdodds/dropbox) reads. To
connect a second account, change `provider` (for example
`provider=dropbox-work`).

See the [OAuth guide](../oauth.md) for query parameters and reconnect behavior.

## Fix a connection missing a host

A Dropbox connection that only allows `api.dropboxapi.com` can list files but
fails every upload and download. Either:

- Open the connect link above again and reconnect. Kody keeps the connection's
  hosts and adds the ones in the link.
- Or open the connection on your **Credentials** page, choose **Edit hosts**,
  and add `content.dropboxapi.com` and `notify.dropboxapi.com`.

## Scopes

| Scope                  | Needed for                          |
| ---------------------- | ----------------------------------- |
| `account_info.read`    | account and space usage, smoke test |
| `files.metadata.read`  | list folders, search, metadata      |
| `files.metadata.write` | move, rename, delete                |
| `files.content.read`   | download                            |
| `files.content.write`  | upload, save from a URL             |
| `sharing.read`         | list shared links                   |
| `sharing.write`        | create shared links                 |

Request only what your workflows need. Enable each scope on the app's
**Permissions** tab first. After changing permissions, reconnect so the new
token carries them.

## Use the `@kentcdodds/dropbox` package and verify

Credentials alone are not the finish. Install or fork
[`@kentcdodds/dropbox`](https://kody.codes/@kentcdodds/dropbox), then verify
from `execute` (adjust the import to your fork):

```ts
import smokeTest from 'kody:@kentcdodds/dropbox/smoke-test'

export default async function main() {
	return smokeTest()
}
```

A successful response looks like `{ ok: true, … }` without account details.

Optional raw probe with the runtime helper, which exercises the content host:

```ts
import { createAuthenticatedFetch } from 'kody:runtime'

export default async function main() {
	const dropboxFetch = await createAuthenticatedFetch('dropbox')
	const response = await dropboxFetch(
		'https://content.dropboxapi.com/2/files/upload',
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/octet-stream',
				'Dropbox-API-Arg': JSON.stringify({
					path: '/kody-smoke-test.txt',
					mode: 'overwrite',
				}),
			},
			body: 'hello from Kody',
		},
	)
	if (!response.ok) {
		throw new Error(`Dropbox upload failed: ${response.status}`)
	}
	const file = (await response.json()) as { path_display?: string }
	return { uploaded: file.path_display }
}
```

## Troubleshooting

- `does not allow requests to host "content.dropboxapi.com"`: the connection is
  missing a Dropbox host. See Fix a connection missing a host.
- `redirect_uri` mismatch: the registered redirect must be exactly
  `https://kody.codes/connect/oauth`.
- Authorize fails with a scope error: enable that scope on the app's
  **Permissions** tab, or drop it from the link.
- `401` after a few hours: the connection has no refresh token. Reconnect with
  the link above, which asks for `token_access_type=offline`.
- `path/not_found` with an App folder app: paths are relative to
  `/Apps/<your app name>`, which Dropbox creates on the first write.

## Related

- [OAuth](../oauth.md)
- [Integration bootstrap](../integration-bootstrap.md)
- [`@kentcdodds/dropbox` listing](https://kody.codes/@kentcdodds/dropbox)
