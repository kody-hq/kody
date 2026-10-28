---
id: secret_providers
title: Custom secret providers
summary:
  Use credentials from an external vault in secret-aware fetch without the agent
  ever reading them.
category: platform
---

# Custom secret providers

A custom secret provider lets your agent use a password-manager item the same
way it uses a Kody secret: a placeholder in `fetch`, resolved at the network
boundary. The model never sees the value. User secrets use `{{secret:name}}`;
providers use `{{secret/<provider>:<ref>}}`.

Provider packages declare an id such as `1password`. Provider logic lives in a
saved package you bind; Kody core does not talk to the vault itself.

## Bind a provider

1. Save the vault door key as a Kody user secret. Paste it on
   `/connect/secret-set`, never into chat. URL shape:
   [Secret setup URL reference](./account-secret-setup.md).
2. Have a saved package that declares `kody.secretProvider.id` (for example
   `1password`) and exports `./secretProvider`.
3. Bind that package on `/@<slug>/-/secret-providers` (`secretProviderBind`):
   provider id, package, door-key secret name, and optional non-secret config.

Declaring metadata on a package does not bind it. Only the account owner can
bind or unbind. Unbind, and rebind to a different package, drop every grant for
that provider.

## Use a placeholder

In secret-aware `fetch`:

```
{{secret/1password:i/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/password}}
```

Item ids are a UUID (Service Account / web) or a 1Password Connect item id
(`^[a-z0-9]{26}$`). `op://Vault/<item-id>/password` is a writable synonym that
canonicalizes to the same grant key when the item segment is one of those ids.
Name-based vault paths are not interpreted in Kody core.

Documentation and status text that _shows_ the syntax may use a realistic
example ref (a concrete provider id and item UUID). The credential stamp counts
a vault token as a credential use only when it sits in a request or
credential-mapped site (fetch URL, header, query, path, body, signing key, SDK
option, or call argument). Placeholders only in display/help text — for example
`status()` `example` / `description` / `help` fields — do not block publish.
Angle-bracket markers (`{{secret/<provider>:<ref>}}`,
`{{secret/bwvault:i/<item-uuid>/<field>}}`) and the grammar metavariable token
`{{secret/provider:ref}}` remain inert everywhere the fetch gateway would fill
them (including message bodies / execute params). A complete token with a
concrete provider id and ref is still filled when it appears in a secret-aware
fetch (URL, header, or body).

The item's websites are the host allowlist. Empty websites refuse the fetch. The
request URL must be `https:`.

Ad hoc execute does not need a package grant. Saved packages need two things: a
`kody.credentials` slot that declares the provider (see the next section) and a
per-item grant.
`resourceLock({ kind: 'secret_provider', provider, ref, package_id })` returns
the Allow URL; grant and revoke on `/@<slug>/-/secret-providers`. A package runs
in the org that owns it, so a collaborator holding a grant uses that org's
binding and grants, not their own.

## Use a provider in a saved package

Declare the provider package in `kody.credentials` with
`kind: "secret-provider"`. `package` is the package.json name of the saved
provider package (the one that declares `kody.secretProvider.id` and exports
`./secretProvider`):

```json
{
	"name": "@you/deploy",
	"exports": { ".": "./src/index.ts" },
	"kody": {
		"description": "Deploy with a token kept in 1Password.",
		"credentials": {
			"vault": {
				"kind": "secret-provider",
				"package": "@you/onepassword-provider",
				"description": "Reads the deploy API token from the team vault."
			}
		}
	}
}
```

Then reference the vault item with the provider id that package declares,
written literally:

```ts
export default async function deploy() {
	return fetch('https://api.example.com/deploy', {
		method: 'POST',
		headers: {
			Authorization:
				'Bearer {{secret/1password:i/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/password}}',
		},
	})
}
```

The same shape works for any provider package (a Bitwarden provider package that
declares `bitwarden` fills `{{secret/bitwarden:...}}`).

- Publish looks up `package` in the publishing org, reads its
  `kody.secretProvider.id`, and seals the slot key into the credential stamp for
  placeholders with that id. The stamp seals the provider, not refs.
- At run time a vault use counts as declared only when the org's binding for
  that provider id is the declared package. If the org binds a different
  package, the fetch fails with `credential_need_undeclared`: bind the declared
  package, or republish with a slot that names the bound one.
- Each ref still needs its own grant for this package (above). Declaring the
  slot grants nothing, and a missing grant still blocks the fetch. The binding
  check, item websites as the host allowlist, `https:` only, and redaction all
  still apply, and the value never leaves the fetch gateway.
- A secret-provider slot is never filled by a saved credential: credential
  mappings, call maps, and `packageGet` needs skip it, and `credential("vault")`
  does not read it.

Publish fails with `unstampable_pattern` when the slot's package is missing,
unreadable, or declares no `kody.secretProvider.id`, and when a vault
placeholder in a request or credential-mapped site has a provider id that no
declared package serves or a computed provider id (for example
`{{secret/${provider}:...}}`). A slot keyed by the provider id with no `kind`
does not count.

Search does not crawl vaults. `secretProviderList` returns binding metadata
only.

## MCP

Search `secretProviderList` / `secretProviderBind` / `resourceLock` first; open
capability detail for the exact call shape.

## Where to go next

- [Secrets](./secrets.md) — the no-`secret_get` rule, placeholders, and host
  approval
