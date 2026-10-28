---
id: provider_origin
title: Connect Origin
summary:
  Verified walkthrough for connecting Cursor Origin to Kody: Origin Apps with
  Ed25519 signing keys, installation access tokens, the community helpers
  package, and a rate-limit smoke test. Cloud Agents API keys are not Origin
  credentials.
category: provider
provider: Origin
lastVerified: 2026-08
---

# Connect Origin

Origin is Cursor's code forge. Its public REST API lives at
`https://api.cursor.com/v1/origin` and authenticates with **Origin App JWTs**
and short-lived **installation access tokens** (`oit_…`), not with Cloud Agents
API keys.

A saved Cursor dashboard key (`crsr_…` / `cursorApiKey`) can call Cloud Agents
and `/v1/me`. Origin rejects that same Bearer token. Use an Origin App.

## What you get

Once connected, you can ask Kody things like:

- "List the Origin repos this app installation can see."
- "Show open pull requests on acme/api."
- "What is left on this installation's Origin rate-limit budget?"

GitHub-mirrored-in repos stay outside installations. Native Origin repos and
repos Origin mirrors _out_ to GitHub are in scope.

## Before you start

- Origin is in early beta on paid Cursor plans. The Origin API is Alpha and can
  change; read [the Origin API docs](https://cursor.com/docs/api/origin) when
  updating an integration.
- You need permission to create an Origin App and install it into a codebase at
  [cursor.com/codebase](https://cursor.com/codebase).
- Installation tokens last at most 15 minutes. Kody mints them just in time from
  a stored Ed25519 private key. Do not save an `oit_…` token as the durable
  secret.
- `secretJwtSign` signs the app JWT host-side (`algorithm: "EdDSA"`). The
  private key never enters execute or package code.

## Lane A: Origin App (durable)

1. Open
   [cursor.com/codebase/settings/apps](https://cursor.com/codebase/settings/apps)
   and create an Origin App. Copy the app id (`app_01…`).
2. Generate an Ed25519 key pair locally. Register **only the public key** on the
   app. Keep the PKCS#8 private key out of chat and out of git:

   ```text
   openssl genpkey -algorithm ED25519 -out origin-app-private.pem
   openssl pkey -in origin-app-private.pem -pubout -out origin-app-public.pem
   ```

3. Install the app into your codebase. Request only the scopes the task needs.
   `repository:metadata:read` is granted automatically. Typical read-only
   reporting uses `repository:contents:read` and
   `repository:pull_requests:read`; include `repository:checks:read` when
   reading check suites or runs. The install URL shape is documented on the
   Origin API page; the workspace admin picks the owner and repos.
4. After install, store the installation id (`i_01…`) from the installation
   receipt `sub` claim, or list installations later with an app JWT.

### Save the private key in Kody

Save the PKCS#8 PEM through the account secrets page — never paste it into chat:

```text
https://kody.codes/connect/secret-set?name=originAppPrivateKey&description=Origin%20App%20Ed25519%20PKCS%238%20private%20key&allowedHosts=api.cursor.com&scope=user
```

Approve `api.cursor.com` on that page. The name `originAppPrivateKey` is what
`@kentcdodds/origin` reads by default.

### Save the readable ids

App id and installation id are not secrets. Put them in a memory
(`metaMemoryVerify`, then `metaMemoryUpsert`) so later agents can recall them.
Inside a saved package, `packageStorage()` holds that package's own knobs — do
not call it from bare `execute`.

- `originAppId` — the `app_01…` id (JWT `iss` and `kid`)
- `originInstallationId` — the `i_01…` id used to mint installation tokens

Set `originInstallationId` explicitly. Do not select an installation implicitly
when more than one installation is available.

## Smoke test

After the secret exists, run this in `execute` with params
`{ "appId": "app_01…" }`. It signs an app JWT and reads the zero-cost rate-limit
endpoint:

```ts
import { kody } from 'kody:runtime'

export default async function main(params: { appId?: string } = {}) {
	const appId = params.appId
	if (!appId) {
		throw new Error('Pass appId in execute params.')
	}
	const now = Math.floor(Date.now() / 1000)
	const { jwt } = await kody.secretJwtSign({
		private_key_secret_name: 'originAppPrivateKey',
		algorithm: 'EdDSA',
		header: { kid: appId },
		send_to_host: 'api.cursor.com',
		claims: {
			iss: appId,
			aud: 'origin-apps',
			iat: now,
			exp: now + 300,
		},
	})
	const rateLimit = await fetch('https://api.cursor.com/v1/origin/rate_limit', {
		headers: { Authorization: `Bearer ${jwt}` },
	})
	if (!rateLimit.ok) {
		throw new Error(`Origin rate_limit failed: ${String(rateLimit.status)}`)
	}
	const body = (await rateLimit.json()) as {
		resources?: { core?: { limit?: number; remaining?: number } }
	}
	return {
		ok: true,
		limit: body.resources?.core?.limit ?? null,
		remaining: body.resources?.core?.remaining ?? null,
	}
}
```

A `401` that says the request is missing a Bearer token usually means Origin did
not accept the credential kind — confirm you are signing with the Origin App
private key, not `cursorApiKey`.

After the smoke test passes, prefer a community helpers package
(`communitySearch` for `origin`) over raw `secretJwtSign` + `fetch` in later
work. Integrations are auth; the package is how agents should call Origin.

## Helpers package

The Origin helpers package (community-search `origin`) wraps:

- just-in-time app JWT + installation token minting
- `GET /v1/origin/rate_limit` (smoke test)
- installation and installation-repo listing
- repo and pull-request reads
- `originRequest` for unwrapped Origin paths

Fork or install that listing after the smoke test. Do not treat Origin as a
second backer for Kody repos — Artifacts stays the durable home for Kody package
source.

## Lane B: one-off CLI user token (not durable)

After `origin auth login`, `origin api` sends a user Bearer token. That token is
fine for a short local experiment. Installation tokens and CLI sessions expire;
do not save them as `originAppPrivateKey`. Prefer Lane A for anything Kody
should keep calling.

## Related

- [Origin API](https://cursor.com/docs/api/origin)
- [Secret-backed integration recipe](../secret-backed-integration.md)
- [Account secret setup](../account-secret-setup.md)
- [Secrets and host approval](../../use/secrets-and-values.md)
