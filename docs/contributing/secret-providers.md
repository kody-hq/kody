# External secret providers

Kody resolves password-manager credentials the same way it resolves user
secrets: placeholders at the secret-aware `fetch` boundary, never a
`secret_get`. Provider logic lives in saved packages. Kody core stays
provider-agnostic.

## Grammar

`{{secret/<provider>:<ref>}}` splits on the **first** `:` after `secret/`. The
`ref` is opaque to core. Angle-bracket markers such as `<provider>`,
`<item-id>`, or `<field>`, and the grammar metavariable form
`{{secret/provider:ref}}`, make a token inert documentation (never filled,
including in ordinary message bodies). The publish stamp also ignores vault
tokens that appear only in display/help text (for example `status()` example
fields), even with a concrete provider id and ref. A token in a fetch/request or
credential-mapped site stamps only when the package declares a described
`kind: "secret-provider"` slot whose `package` (looked up in the publishing org)
declares the token's literal provider id as `kody.secretProvider.id`; that slot
key is sealed into the stamp. At run time a provider use is declared only when
the org's binding for the id names the declared package (an older slot keyed by
the provider id still counts).

- `{{secret/1password:i/<item-id>/password}}` — canonical form (`<item-id>` is a
  UUID or a 1Password Connect 26-char id `^[a-z0-9]{26}$`)
- `{{secret/1password:op://Vault/Item/password}}` — writable synonym only
- `{{secret:name}}` — user-secret placeholders (separate grammar)

## Canonicalization

Grants and the short TTL cache key on the canonical ref `i/<item-id>/<field>`.

Core has a small helper that maps `op://<vault>/<item-id>/<field>` when the item
segment is already a UUID or Connect item id. Name-based
`op://Vault/Item/password` is not interpreted in core. The bound provider
package's sealed `./secretProvider` export can canonicalize that synonym
(`action: "canonicalize"`) and return `{ canonicalRef }` without a secret value.

Grant approval through
`resourceLock({ kind: 'secret_provider', provider, ref, package_id })` requires
a locally canonicalizable ref so lock/search never call the vault.

## Binding

A saved package may declare it can serve a provider id:

```json
{
	"kody": {
		"secretProvider": { "id": "1password" }
	},
	"exports": {
		"./secretProvider": "./secret-provider.ts"
	}
}
```

Declaring metadata does **not** bind the provider. The account owner pins one
saved package identity to that provider id on `/@<slug>/-/secret-providers` (or
`secretProviderBind`), plus the **Kody user secret** that holds the door key and
optional non-secret config (for example a Connect base URL).

## Sealed resolve

The platform invokes `./secretProvider` only from the fetch boundary, with
`action: "resolve" | "canonicalize"`. The resolve result is
`{ value, hosts: string[] }`. Ordinary `execute` and `kody:@` imports of
`./secretProvider` are rejected so `value` is never an RPC or import result.

Timeout budget: **8s** for resolve, **5s** for canonicalize. Empty `hosts`
denies every use. Host match normalizes to hostname, so
`https://app.example.com/login` allows `app.example.com` only. A request that
carries a provider secret must use an `https:` URL. Items with no usable
websites fail closed.

## Grants

- Ad hoc execute may use provider placeholders without a package grant (same
  spirit as unlocked user secrets).
- Saved packages need a `kind: "secret-provider"` slot for the provider (see
  [Use a provider in a saved package](../guides/secret-providers.md#use-a-provider-in-a-saved-package))
  and an explicit `(provider, canonicalRef) → package` grant. `resourceLock`
  returns the approval URL; only the owner can grant or revoke on
  `/@<slug>/-/secret-providers`. Unbind, and rebind to a different provider
  package, drop every grant for that provider.
- A package runs in the org that owns it, so a collaborator holding a grant uses
  that org's binding and grants, not their own.

Ungranted package use fails **before** the value-returning provider call.

## Cache and failures

Resolved values cache for **30 seconds**, keyed by
`(account, provider, canonicalRef)`. Bind, unbind, and rebind invalidate that
account+provider slice. Deduplicate refs in one request. Fail closed on a
missing door-key secret, provider error, missing field, empty hosts, host
mismatch, non-HTTPS request URL, broken ref, or missing grant. Errors name the
next action and never include values.

Ordinary `search` does not call the provider or crawl a vault.

## Implementing a provider package

1. Declare `kody.secretProvider.id`.
2. Export `./secretProvider`.
3. Accept
   `{ action, ref, canonicalRef, doorSecretName, doorSecretValue, config }`.
4. For `canonicalize`, return `{ canonicalRef }` only.
5. For `resolve`, return `{ value, hosts }` where `hosts` are item websites.
6. Do not log `doorSecretValue` or `value`.

Adding another vendor is a new package plus an account binding, not a Kody core
fork.

See [Secrets](../guides/secrets.md),
[Custom secret providers](../guides/secret-providers.md), and
[Secrets and host approval](../use/secrets-and-values.md).
