---
id: shared_packages
title: Shared packages for many accounts
summary:
  Build one package that many callers import, each with its own account of the
  same provider. Declare the need once, let each caller map it on its own
  package, pick per run, open several accounts with multiple, or pass a client
  in.
category: platform
---

# Shared packages for many accounts

A shared package wraps one provider (for example a payments or email API) and is
imported by several caller packages. Each caller brings its own account. You
write the shared package once; each caller chooses which credential fills it.

## Declare the need on the shared package

List the need in the shared package's `kody.credentials` and open it with
`credential(key)`:

```json
{
	"name": "@you/payments",
	"exports": { "./locations": "./src/locations.ts" },
	"kody": {
		"credentials": {
			"payments": {
				"provider": "square",
				"description": "Read locations in the caller's account"
			}
		}
	}
}
```

```ts
import { credential } from 'kody:runtime'

export async function listLocations() {
	const client = await credential('payments')
	const res = await client.fetch('/v2/locations')
	return await res.json()
}
```

A caller that imports `@you/payments` inherits the `payments` need. Its package
page lists it with `from` naming the shared package.

## Map the need on each caller

Mappings live on the package you run (the entry package), including needs it
inherits. When the shared package calls `credential('payments')` in a caller's
run, it uses the caller's mapping.

- Set an org default (shared by the org) or a personal default (yours only) on
  the caller's **Credentials** tab, or have an agent propose one with
  `credentialMappingPropose`.
- Each caller maps its own account. Two callers of the same shared package can
  use two different accounts with no change to the shared package.

## Scheduled and trigger runs

A schedule or other trigger of the caller uses that trigger's mapping on the
caller's package, then the caller's defaults. Map the need per trigger when one
schedule should use a different account. See [Triggers](./triggers.md).

## Pick per run

Pass a `credentials` map on `execute` (for `code` or `invoke`), or
`--credential` on the CLI, to choose for one run:

```bash
npx @kodycodes/cli execute --invoke kody:@you/checkout/run \
  --credential payments=store-east
```

The map is checked before code runs, and a pick chooses only among credentials
you can already Use.

## Several accounts in one run

Declare the need with `multiple: true` and open every pick with
`credentials(key)`. Tell the clients apart by `name` (each client also has
`scope`, `kind`, and `hosts`):

```json
{
	"payments": {
		"provider": "square",
		"multiple": true,
		"description": "Stores to read"
	}
}
```

```ts
import { credentials } from 'kody:runtime'

export async function listAllLocations() {
	const results = []
	for (const client of await credentials('payments')) {
		const res = await client.fetch('/v2/locations')
		results.push({
			name: client.name,
			scope: client.scope,
			locations: await res.json(),
		})
	}
	return results
}
```

The caller maps up to 16 credentials for the need, or picks them per run with a
list in the `credentials` map (`{ payments: ['store-east', 'store-west'] }`).

## Pass a client in

The caller can open the client itself and hand it to the shared package. The
exported function uses exactly the client it was given, so it reads no mapping.
A shared package that only takes clients this way can leave the need out of its
own `kody.credentials`; the caller declares it instead:

```ts
// In the caller, which declares the need:
import { credential } from 'kody:runtime'
import { listLocationsWith } from 'kody:@you/payments/locations'

export default async function run() {
	return await listLocationsWith(await credential('payments'))
}
```

```ts
// In the shared package's src/locations.ts:
export async function listLocationsWith(client: { fetch: typeof fetch }) {
	const res = await client.fetch('/v2/locations')
	return await res.json()
}
```

A client works only in the run that opened it.

## Name secrets in the manifest

A newly published package may use only the credentials its `kody.credentials`
closure declares. A secret name built at runtime from an account string (one
secret per customer, for example) is not supported: any name the manifest does
not list is refused with `credential_need_undeclared`. Declare one need and let
each caller map it, open several with `multiple: true`, or pass a client in, as
above.

## Related

- [Credentials](./credentials.md): needs, mappings, picks, and errors.
- [Package authoring](./package-authoring.md): manifest shape and publishing.
