---
id: connect_secret
title: Secret setup URL reference
summary:
  Hosted /connect/secret-set URL shape, query params, approval policy for API
  keys and PATs, and post-hoc package approval URLs including bulk approve.
category: platform
---

# Secret setup URL reference

Use the hosted **`/connect/secret-set`** page whenever the user needs to enter a
secret value such as an API key or personal access token. That page has one job:
set this secret. Secrets stay on the setup page; send the URL and wait until
they confirm save.

In-app "New secret" from `/@<slug>/-/secrets` opens `/@<slug>/-/secrets/new`
without query params. Prefill links that include `name` redirect to
`/connect/secret-set` so agent links do not land on the general secrets list.

If the secret will power a downstream package or package app, open
`search({ entity: "guide:integration_bootstrap" })` before building that
package. For the common non-OAuth path after bootstrap, open
`search({ entity: "guide:secret_backed_integration" })`. This guide covers the
secret-collection step only.

## When to use `/connect/secret-set`

Use it when:

- the user must provide a sensitive value
- a named secret needed for `fetch` placeholders or a named lookup (for example
  `secretJwtSign`) is missing
- the user needs to rotate a stored secret value

Send the `/connect/secret-set` URL and have them paste into **Secret value** on
that page.

## URL format

Provide the user a URL like:

`https://<your-kody-origin>/connect/secret-set?name=exampleApiKey&description=Example%20API%20key&expiresAt=2026-12-01T00:00:00.000Z&allowedHosts=api.example.com&scope=user&allowedPackages=pkg_123`

When `name` is present, the page focuses and scrolls to the secret value input
so the user can paste immediately.

## Query params

| Param             | Required | Description                                                                                                                                                                                                                                                           |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`            | yes      | Secret name (for example `exampleApiKey`).                                                                                                                                                                                                                            |
| `description`     | no       | Human-readable description shown in the UI.                                                                                                                                                                                                                           |
| `expiresAt`       | no       | Optional. Kody’s cutoff for sending the secret, separate from the provider token’s own expiration. UTC ISO (`2026-12-01T00:00:00.000Z`) or a `YYYY-MM-DD` date stored as midnight UTC. Prefills Expires. Leave omitted and Kody keeps the secret until it is deleted. |
| `allowedHosts`    | no       | Comma-separated hosts to review for approval.                                                                                                                                                                                                                         |
| `allowedPackages` | no       | Comma-separated saved package ids to review for approval.                                                                                                                                                                                                             |
| `scope`           | no       | `user` (default) or `package`.                                                                                                                                                                                                                                        |
| `packageId`       | no       | Required when `scope=package`. Use the saved package id that owns the secret.                                                                                                                                                                                         |

## Approval policy reminders

- A prefilled `allowedHosts` list is shown on the setup page. Saving writes that
  list with the secret.
- When the save URL omitted hosts, or a later call says a host is not approved,
  open **`/connect/secrets`** (`name` / `names` and `hosts`). Package grants use
  `/@<slug>/-/secrets/approve`.
- `hosts` must be hostname-shaped. Truncated or path-bearing values are rejected
  on that page and are not written to `allowedHosts`.

## Package approval URLs (after a package exists)

Package approval rules live in [Secrets](./secrets.md#two-approvals-both-yours)
(`guide:secrets`). `resourceLock({ kind: 'secret', name, package_id })` returns
the approval URL. Send the link and wait. For an unadopted community fork, adopt
it after reviewing the source or send the approval link.

- Single secret:
  `/@<slug>/-/secrets/user/{secretName}?package_id={savedPackageId}&package={kodyId}`
- Multiple secrets for one package (preferred):
  `/@<slug>/-/secrets/approve?package_id={savedPackageId}&package={kodyId}&names={secret1},{secret2}`

Prefer the bulk `/@<slug>/-/secrets/approve?...&names=...` URL whenever two or
more secrets still need package approval. The account UI shows every listed
secret and lets the user approve them in one click.

## Agent instructions

1. Generate the URL with the required `name` and any optional params.
   - When using `scope=package`, include the saved package id in `packageId`.
2. Ask the user to open the URL in their browser.
3. Wait until they confirm the secret is saved.
4. If the secret will back a package or package app, run the authenticated smoke
   test described in `guide: "integration_bootstrap"` before saving the
   downstream package.
5. For common non-OAuth integrations, continue with
   `guide: "secret_backed_integration"` after the secret exists.
6. Proceed using `{{secret:name}}` fetch placeholders or a named secret lookup
   such as `secretJwtSign`.
