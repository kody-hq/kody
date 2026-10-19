# Pattern: Cloudflare API v4 (`api.cloudflare.com`)

Use **secret-aware `fetch`** in **`execute`** or inside a saved package export
so Cloudflare API access can change without shipping Worker code.

You can keep this logic inline in `execute`, or place it in a package export and
import it from other packages with `kody:@...`.

## Auth and hosts

- Base URL: `https://api.cloudflare.com` (or your account’s documented API
  hostname).
- Send `Authorization: Bearer {{secret:yourSecretName}}` (or with `|scope=user`
  / `package` / `session` as needed).
- The user must approve **`api.cloudflare.com`** for that secret (host approval
  in the account UI). Saving a secret does not approve hosts automatically.

Unadopted community-forked packages also need package approval for user-scoped
secrets. Self-authored packages and adopted forks already have read/use access.
Package-scoped secrets are available only to their owning package.

## Paths

All API paths must be under **`/client/v4/`** (see
[Cloudflare API docs](https://developers.cloudflare.com/fundamentals/api/how-to/make-api-calls/)).

## Example module body

When this logic lives in a package export, mark the package metadata and search
description appropriately. When the code can mutate Cloudflare resources, treat
it as destructive in your surrounding workflow and review path.

```javascript
export default async () => {
	const path = '/client/v4/user/tokens/verify'
	const url = `https://api.cloudflare.com${path}`
	const res = await fetch(url, {
		headers: {
			Accept: 'application/json',
			Authorization: 'Bearer {{secret:cloudflareApiToken}}',
		},
	})
	const text = await res.text()
	let body = null
	if (text.trim()) {
		try {
			body = JSON.parse(text)
		} catch {
			throw new Error(`Cloudflare API returned non-JSON (${res.status})`)
		}
	}
	return { status: res.status, body }
}
```

For **POST / PUT / PATCH / DELETE**, set `Content-Type: application/json` and
`body: JSON.stringify(payload)`.

## Related

- Official Cloudflare docs:
  [developers.cloudflare.com](https://developers.cloudflare.com).
