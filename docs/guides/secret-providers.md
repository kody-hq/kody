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

Documentation and status text that _shows_ the syntax should use an inert form:
angle-bracket markers (`{{secret/<provider>:<ref>}}`,
`{{secret/bwvault:i/<item-uuid>/<field>}}`) or the grammar metavariable token
`{{secret/provider:ref}}`. Those are display text only: the fetch gateway leaves
them alone (including in message bodies / execute params), and the credential
stamp does not treat them as a credential use. A complete token with a concrete
provider id and ref is a live placeholder everywhere it appears in a
secret-aware fetch (URL, header, or body).

The item's websites are the host allowlist. Empty websites refuse the fetch. The
request URL must be `https:`.

Ad hoc execute does not need a package grant. Saved packages do:
`resourceLock({ kind: 'secret_provider', provider, ref, package_id })` returns
the Allow URL; grant and revoke on `/@<slug>/-/secret-providers`. A package runs
in the org that owns it, so a collaborator holding a grant uses that org's
binding and grants, not their own.

Search does not crawl vaults. `secretProviderList` returns binding metadata
only.

## MCP

Search `secretProviderList` / `secretProviderBind` / `resourceLock` first; open
capability detail for the exact call shape.

## Where to go next

- [Secrets](./secrets.md) — the no-`secret_get` rule, placeholders, and host
  approval
