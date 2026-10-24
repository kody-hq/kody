# Inbound webhooks

Kody inbound webhooks are **package-centered**: you declare them in
`package.json#kody.webhooks`, mint an opaque handle with `webhookUrlMint`, then
register the credential with `webhookUrlApply` (generic HTTPS, including the
GitHub Hooks API) or copy the URL yourself from the package's
[settings page](#manage-webhook-urls-in-package-settings). MCP and execute never
return the credential URL or `url_secret`. Each delivery invokes the bound
package export as its enabler.

Minting does not turn a webhook on. Mint and rotate return `approval_url` while
the endpoint has no enablement that is on or paused; a person opens it and
clicks Approve, which turns the webhook on for them and maps the credentials it
uses in the same step. Until then deliveries answer **409** `enablement_not_on`
with that link. An existing enablement is left alone; remint or rotate never
changes who the webhook runs as.

This is the HTTP sibling of [email primitives](./email-primitives.md). Webhooks
are the external HTTP knock: vendor providers (Sentry, GitHub, Stripe) and
first-party trusted clients (gateway proxies, CLIs) both POST to a minted URL.

There is no `*` / multi-export URL. One declared webhook name binds one export.

Treat every minted URL as a **credential**. Mint and rotate return an opaque
`handle` (and `url_host`), never the URL or `url_secret`. Register the URL with
`webhookUrlApply` so the credential stays inside Kody, or open the package's
[settings page](#manage-webhook-urls-in-package-settings) and copy it yourself
for providers without an apply adapter. MCP and execute never return the URL;
the owner does that from package settings.

## Declare a webhook in the package manifest

```json
{
	"name": "@you/sentry-bridge",
	"exports": {
		"./handle-sentry-webhook": "./src/handle-sentry-webhook.ts"
	},
	"kody": {
		"id": "sentry-bridge",
		"description": "Forward Sentry webhooks into automations",
		"webhooks": [
			{
				"name": "sentry",
				"export": "./handle-sentry-webhook",
				"responseMode": "ack",
				"verification": {
					"type": "hmac-sha256",
					"header": "sentry-hook-signature",
					"secretName": "sentryWebhookSecret",
					"encoding": "hex"
				}
			}
		]
	}
}
```

Rules:

- `name` is a slug unique within the package.
- `export` must reference a declared `package.json#exports` entry (validated at
  save/publish). One webhook name ↔ one export. There is no wildcard export.
- `responseMode` is `ack` (default) or `sync`.
- `inputMode` is `request` (default) or `params`. Vendor handlers stay on
  `request`. First-party trusted clients that send invoke-shaped JSON use
  `params` (see [Trusted clients](#trusted-clients)).
- `rateLimitPerMinute` is optional. Default **60**. Maximum **600** (gateway
  fan-in). A leaked URL is still bounded; there is no unlimited setting.
- `verification.type` is `hmac-sha256`, `hmac-sha1`, or `url-secret` for senders
  that cannot sign (see
  [Senders that cannot sign](#senders-that-cannot-sign-url-secret)). The
  remaining `verification` fields apply to the HMAC types only.
- `verification.secretName` is **optional**. Omit it for GitHub-style hooks
  where Kody mints package-owned HMAC onto the webhook URL record at
  `webhookUrlMint` (not listed in account secrets, no host Allow). Set it only
  for **provider-issued** signing secrets that must live in the secret store
  (for example Sentry or Stripe). Inbound signatures are checked against the
  named secret first, on the same URL; a signing secret Kody stored on the
  endpoint earlier (generated, or copied at mint) is still accepted as a
  fallback. Never put an inline secret value in the manifest.
- `verification.signedPayload` is `'body'` (default) or `'timestamp.body'`. Use
  `'timestamp.body'` when the provider HMAC covers
  `` `${timestamp}.${rawBody}` ``.
- `challenge` is optional. When set, the platform answers the provider's
  ownership quiz on the **same minted URL** (GET CRC / hub challenge, or Slack
  `url_verification` POST) without invoking your export. See
  [Subscription challenges](#subscription-challenges).
- `replay` is optional. Without it, body-only HMAC is **replayable**: anyone who
  observes one legitimate signed delivery can POST it again. Opt in per webhook
  with a timestamp window and/or a unique delivery id. Trusted clients send
  `Idempotency-Key` instead of `replay.deliveryIdHeader`.

Declaring a webhook does **not** open ingress by itself.

## Mint a handle

Use the MCP `webhooks` domain:

1. Save/publish the package with `kody.webhooks`.
2. For provider-issued HMAC only, store that secret with `secretSet` under
   `verification.secretName` (for example `sentryWebhookSecret`). GitHub-style
   hooks that use `{{webhookSecret}}` on apply should **omit**
   `verification.secretName` — Kody mints package-owned signing material when
   you mint the URL.
3. Call `webhookUrlMint` with the scoped package name (or `package_id` when the
   name is not known) and `webhookName`.
4. Call `webhookUrlApply` with the returned `handle` and a `type: "http"`
   destination. Kody POSTs/PUTs the minted URL into any HTTPS registration
   endpoint via `{{webhookUrl}}` substitution (for example GitHub's
   `POST /repos/{owner}/{repo}/hooks`). The owner can copy the URL from the
   package's [settings page](#manage-webhook-urls-in-package-settings)
   (`/@<username>/<packageKodyId>/settings#webhooks`) when that is simpler.

Other capabilities: `webhookList` (declarations — including `verification`,
`replay`, and `challenge` — joined with minted handle / approval state),
`webhookUrlRotate`, `webhookDeliveryList` (metadata only; bodies are never
stored), and `webhookSyntheticDispatch` (interactive-MCP smoke test for a minted
webhook — see [Synthetic smoke test](#synthetic-smoke-test)). The same delivery
history also appears under [Activity](./activity.md) (`/@<slug>/-/activity` and
the `runs` capabilities). List, mint, rotate, apply, and synthetic dispatch
never return the credential URL.

## Manage webhook URLs in package settings

Webhooks belong to the package that declares them, so the signed-in owner
manages their URLs on that package's settings page:
`/@<username>/<packageKodyId>/settings`, **Webhooks** section (for example
`/@kentcdodds/raycast/settings#webhooks`). The section lists every webhook the
package declares, joined with its minted state, one card per webhook:

- **Mint URL** issues the first credential for a declared webhook and shows the
  URL once so you can paste it into the provider.
- **Reveal URL** shows a minted URL again, with a copy button. Each reveal is
  written to the account audit log.
- **Rotate URL** replaces the secret. The previous URL stays active for **24
  hours**, or until the first accepted delivery arrives on the new URL. Rerun
  `webhookUrlApply` (same handle) or paste the new URL into the provider. The
  card shows “Previous URL active until …” during that overlap.
- **Turn off** is available from the package's Credentials page. The URL remains
  minted but answers 404. Turn it back on by Approving the same URL again; the
  HMAC secret stays the same.

Rotate changes the URL secret, not whether the webhook is on. A webhook with no
enablement has not been approved yet and answers 409 with its approval link; one
with only off enablements answers 404.

The URL is the human path. Agents get the handle and `url_host` through MCP and
either apply the handle (`type: "http"`) or ask the owner to copy the URL from
package settings. Mints that predate encrypted secret storage cannot be shown;
the card offers Rotate for those.

`/@<slug>/-/webhooks` (account rail → Webhooks) is a read-only index of every
webhook across your packages. Each row links to the owning package's Webhooks
section; nothing is minted or revealed from the index.

### Apply a handle to a destination

`webhookUrlApply` resolves the handle inside Kody and registers the URL through
an outbound HTTPS request (`type: "http"`). The model never sees the secret:
Kody injects the minted URL server-side via `{{webhookUrl}}` and returns only
`{ ok, url_host, http_status, remote_id, error }`. Remote bodies that echo the
hook URL are redacted.

Owner rationale: the signed-in owner can already reveal and paste the URL from
package settings. Opaque apply exists so agents can register that same
credential without pulling plaintext into model context — including at
caller-chosen HTTPS endpoints. Settings reveal/paste is owner consent. Silent
model-chosen apply to an arbitrary URL is not: prompt injection could POST the
long-lived credential to an attacker endpoint. Generic `http` therefore requires
an interactive hard confirm that surfaces the exact destination before the
outbound request runs.

Generic HTTPS (`type: "http"`) — Kody sends the request and substitutes
`{{webhookUrl}}` (and optional `{{webhookSecret}}`) into `url`, header values,
and/or `body` (form bodies are decoded/re-encoded). `{{webhookUrl}}` is
required. `{{webhookSecret}}` injects **package-owned HMAC signing material**
stored on the minted webhook URL record (not a user secrets-list entry, and not
host-gated). When a package declares `verification.secretName`, reminting (or
rotating) the URL copies that value onto the endpoint when the named secret
exists and the endpoint holds no signing secret yet — apply never does a live
`secretName` lookup for `{{webhookSecret}}` (so changing the name after
destination Allow cannot swap credentials). Destination `secretName` /
`integration` Bearer auth requires host approval / integration allowlists.
Destination URLs must be `https://`. Redirects are not followed. Auth is
optional via `secretName` or `integration` (Bearer), or a caller-supplied
`Authorization` header — not both. Destination `secretName` / `integration`
authorize the outbound request; they are not the webhook HMAC signing secret.
Owner destination approvals pin that auth to the **stable credential id** the
name resolves to (same idea as credential grants), plus the destination shape
(method, URL/host, headers, body). Rotating the credential's value keeps the
approval; deleting and recreating the same name requires a fresh Allow.

That path is **interactive MCP only** and reuses the same **account owner
approval flow** as secret host approval (`/connect/secrets`), secret package
grants, and locked-package publish approval: the capability returns an
`approval_url` to `/connect/webhook-apply` with the exact method, URL,
`{{webhookUrl}}` / `{{webhookSecret}}` injection sites, headers, body template,
and auth mode (including the credential id when `secretName` / `integration` is
set). The signed-in owner Allows on the website (writing a durable destination
grant); the agent then retries and the outbound request runs. Package runtimes
cannot use `http` apply. Agents never grant access and never see the webhook
credential.

```ts
await kody.webhooks.webhookUrlApply({
	handle,
	destination: {
		type: 'http',
		url: 'https://hooks.example/register',
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: '{"webhookUrl":"{{webhookUrl}}"}',
		secretName: 'hooksRegistrationToken',
	},
})
// If approval is required, send the owner approval_url (/connect/webhook-apply),
// wait for Allow, then retry the same call.
```

GitHub repository hooks use the same `http` path against the Hooks API
(`POST https://api.github.com/repos/{owner}/{repo}/hooks`). Put `{{webhookUrl}}`
in `config.url`, include `User-Agent: kody` (GitHub requires a User-Agent), send
the GitHub Accept / API-Version headers, and authorize with
`integration: 'github'` (or a host-approved token via `secretName`). Declare
HMAC `verification` **without** `secretName` so mint stores package-owned
signing material, and put `{{webhookSecret}}` in `config.secret`:

```ts
await kody.webhooks.webhookUrlApply({
	handle,
	destination: {
		type: 'http',
		url: 'https://api.github.com/repos/acme/api/hooks',
		method: 'POST',
		headers: {
			Accept: 'application/vnd.github+json',
			'Content-Type': 'application/json',
			'User-Agent': 'kody',
			'X-GitHub-Api-Version': '2022-11-28',
		},
		body: JSON.stringify({
			name: 'web',
			active: true,
			events: ['push', 'pull_request'],
			config: {
				url: '{{webhookUrl}}',
				content_type: 'json',
				insecure_ssl: '0',
				secret: '{{webhookSecret}}',
			},
		}),
		integration: 'github',
	},
})
```

`{{webhookSecret}}` injects package-owned HMAC from the webhook URL record (or a
value copied from `verification.secretName` at mint/rotate). If the placeholder
is present but verification is undeclared, or package-owned HMAC is missing,
apply fails with a clear error. Omit `{{webhookSecret}}` when the webhook has no
HMAC verification. GitHub-style hooks that declare `verification.secretName` can
drop that secrets-list entry after reminting (with the named secret present so
mint can copy it) or after reminting without `secretName`.

Prefer `http` for Workers and any provider API that accepts a callback URL
field. Providers that need an ownership quiz (X Activity CRC, WebSub / YouTube,
Meta, Slack URL verification) use a declared
[`challenge`](#subscription-challenges) on the webhook — you do not need a shim
Worker for those. Do not invent per-vendor apply adapters when a single HTTPS
registration request is enough. The owner can also reveal and paste the URL from
package settings.

## Ingress URL

`GET|POST https://<origin>/@<username>/webhooks/<packageKodyId>/<webhookName>/<urlSecret>`

- Unknown / unminted / disabled / renamed-away / wrong secret → **404** (no
  distinction).
- `GET` is allowed only when the webhook declares a GET-capable
  [`challenge`](#subscription-challenges); otherwise **405**.
- Payload > **1 MB** → **413**.
- Minted but not approved (or its enablement was turned off), or paused because
  its enabler lost access → **409**
  `{ "ok": false, "error": { "code": "enablement_not_on", "message", "details": { "approvalUrl" } } }`.
  The message says which, and includes the approval link.
- Rate limit per minted webhook → **429**. Default **60**/min; override with
  `rateLimitPerMinute` up to **600**.
- `ack`: **202** `{ "ok": true }` after Kody durably queues the delivery; the
  export runs in the background. Bodies use the same **1 MB** cap as sync;
  oversized queue messages spill to ephemeral storage until the consumer runs. A
  temporary queue failure returns **503** so the provider can retry without Kody
  claiming acceptance. Activity duration for ack deliveries measures queue
  consumer + export time (ingress receive time is kept as metadata). Failed
  deliveries keep diagnostic logs — including when the export never reached user
  code.
- `sync`: waits for the export JSON result (**502** on failure). The failure
  body is `{ "ok": false, "error": { "code", "message" } }` and never carries
  package internals. `code` is `invocation_failed` unless the fetch gateway
  refused the package's request because a credential placeholder was bound for a
  host the credential does not allow, went over plain HTTP, or sat in the URL
  host or user info: then it is `credential_placement_refused`. When the refusal
  concerns one named slot, `error.slot` carries that slot name (never a value);
  a Basic Auth pair or a vault reference omits it. Ack deliveries record the
  same code in Activity. The owner sees the full error in Activity.

Background delivery retries keep the same idempotency key, so a transient
platform persistence failure does not duplicate a completed export. Ack (queued)
deliveries run the export with a 5-minute budget on every plan. `sync`
deliveries keep the interactive ~90-second budget, and the HTTP response stops
waiting after 30 seconds. Exports that exceed their budget receive an explicit
timeout failure and should split or checkpoint their work, or hand long work to
a [workflow](./workflows.md).

## Subscription challenges

Some providers prove URL ownership with a fixed quiz before they send events:
HMAC a challenge token, echo a hub challenge, or return a JSON challenge field.
Kody answers those on the minted webhook URL **in the platform** — the bound
export never runs for the quiz, and challenge handling does not mutate account
state, call MCP, or fetch outbound.

Declare one `challenge` object next to (or instead of, when the provider has no
POST HMAC) `verification`. Use the generic `subscription-challenge` type with
knobs, or copy a documented preset below.

### Generic `subscription-challenge`

| Knob        | Role                                                                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `method`    | `GET` or `POST`                                                                                                                                                                          |
| `challenge` | Where the token arrives: `{ in: "query" \| "json", key }`                                                                                                                                |
| `when`      | Optional filters (`query` / `json`). GET mismatch → **400**; POST mismatch → not a quiz (delivery continues). **Required for POST** (`when.json`) so ordinary event bodies fall through. |
| `prove`     | `none`, `verify-token` (query secret match), `hmac` (CRC of token), or `request-hmac` (sign the request)                                                                                 |
| `respond`   | `text` echo, `json` echo under `key`, or `json-hmac` (CRC response)                                                                                                                      |

`prove.*.secretName` is the same named secret-store reference as
`verification.secretName` — never an inline value. Later provider POSTs still go
through normal URL-secret + optional HMAC verification; only verified deliveries
reach the export.

Platform schema stays vendor-agnostic
([0054](../contributing/decisions/0054-no-vendor-specific-platform-logic.md)):
configure providers with knobs or documented presets, not new `foo-hub` type
ids.

### Presets (copy into `challenge`)

**Hub echo as `text/plain` (Meta / Facebook / WhatsApp-style):**

```json
{
	"type": "subscription-challenge",
	"method": "GET",
	"challenge": { "in": "query", "key": "hub.challenge" },
	"when": { "query": { "hub.mode": "subscribe" } },
	"prove": {
		"kind": "verify-token",
		"in": "query",
		"key": "hub.verify_token",
		"secretName": "metaVerifyToken"
	},
	"respond": { "as": "text" }
}
```

**Hub echo as JSON `{ "hub.challenge" }` (Strava-style):**

```json
{
	"type": "subscription-challenge",
	"method": "GET",
	"challenge": { "in": "query", "key": "hub.challenge" },
	"when": { "query": { "hub.mode": "subscribe" } },
	"prove": {
		"kind": "verify-token",
		"in": "query",
		"key": "hub.verify_token",
		"secretName": "stravaVerifyToken"
	},
	"respond": { "as": "json", "key": "hub.challenge" }
}
```

Store the same `verify_token` value you pass when creating the Strava push
subscription. Mint the webhook, register the revealed URL as `callback_url`, and
pass that secret as `verify_token` on create.

**WebSub / YouTube hub (optional verify token; allows unsubscribe):**

```json
{
	"type": "subscription-challenge",
	"method": "GET",
	"challenge": { "in": "query", "key": "hub.challenge" },
	"when": { "query": { "hub.mode": ["subscribe", "unsubscribe"] } },
	"respond": { "as": "text" }
}
```

Add a `prove.verify-token` block with `secretName` when the hub sends
`hub.verify_token`.

**CRC of query token → JSON HMAC field (X Account Activity-style):**

```json
{
	"type": "subscription-challenge",
	"method": "GET",
	"challenge": { "in": "query", "key": "crc_token" },
	"prove": {
		"kind": "hmac",
		"secretName": "xConsumerSecret",
		"algorithm": "hmac-sha256",
		"encoding": "base64",
		"prefix": "sha256="
	},
	"respond": { "as": "json-hmac", "key": "response_token" }
}
```

**JSON body challenge + optional request signature (Slack Events-style):**

```json
{
	"type": "subscription-challenge",
	"method": "POST",
	"challenge": { "in": "json", "key": "challenge" },
	"when": { "json": { "type": "url_verification" } },
	"prove": {
		"kind": "request-hmac",
		"secretName": "slackSigningSecret",
		"algorithm": "hmac-sha256",
		"encoding": "hex",
		"prefix": "v0=",
		"timestampHeader": "x-slack-request-timestamp",
		"signatureHeader": "x-slack-signature",
		"signedPayload": "v0.timestamp.body"
	},
	"respond": { "as": "json", "key": "challenge" }
}
```

When `prove` is omitted, the platform echoes without a signature check. Event
POSTs still use the normal delivery path — declare a matching `verification`
block when those deliveries must also verify request signing.

### X Activity (CRC) example for `@kentcdodds/x`

```json
{
	"name": "activity-event",
	"export": "./activity-event",
	"challenge": {
		"type": "subscription-challenge",
		"method": "GET",
		"challenge": { "in": "query", "key": "crc_token" },
		"prove": {
			"kind": "hmac",
			"secretName": "xConsumerSecret",
			"algorithm": "hmac-sha256",
			"encoding": "base64",
			"prefix": "sha256="
		},
		"respond": { "as": "json-hmac", "key": "response_token" }
	},
	"verification": {
		"type": "hmac-sha256",
		"header": "X-Twitter-Webhooks-Signature",
		"secretName": "xConsumerSecret",
		"encoding": "base64",
		"prefix": "sha256="
	}
}
```

Store the X consumer secret with `secretSet` under `xConsumerSecret`, mint the
webhook, then register the revealed URL directly with X. CRC GETs never invoke
`./activity-event`; activity POSTs do, after HMAC verification.

## Payload shape seen by the package export

```ts
{
	webhook: {
		packageKodyId: string
		name: string
		receivedAt: string // ISO timestamp
	}
	request: {
		method: string
		contentType: string | null
		headers: Record<string, string> // safe allowlisted subset, lowercase keys
		body: string // raw text
		json: unknown | null
	}
}
```

Example export:

```js
export async function handleSentryWebhook(input) {
	const event = input.request.json
	// ... automate ...
	return { ok: true }
}
```

## Signature verification examples

### Signing presets

Every webhook should declare `verification`. Match your sender in the table,
then copy the JSON from its section. Omit `secretName` where the table says so:
mint then stores a package-owned signing secret on the URL record, and
`webhookUrlApply` can hand it to the sender as `{{webhookSecret}}`.

| Sender                               | `verification`                                                                                                            | Secret                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Stripe                               | `hmac-sha256`, header `Stripe-Signature`, `hex`, `signedPayload: "timestamp.body"`, plus `replay` (see [Stripe](#stripe)) | `secretName` (Stripe's signing secret)       |
| GitHub                               | `hmac-sha256`, header `x-hub-signature-256`, `hex`, prefix `sha256=`                                                      | Omit `secretName`; apply `{{webhookSecret}}` |
| Sentry Integration Platform webhook  | `hmac-sha256`, header `sentry-hook-signature`, `hex`                                                                      | `secretName` (Sentry's client secret)        |
| X Account Activity                   | `hmac-sha256`, header `X-Twitter-Webhooks-Signature`, `base64`, prefix `sha256=`                                          | `secretName` (consumer secret)               |
| Bitbucket Cloud                      | `hmac-sha256`, header `X-Hub-Signature`, `hex`, prefix `sha256=` (see [Bitbucket Cloud](#bitbucket-cloud))                | Omit `secretName`; apply `{{webhookSecret}}` |
| Your own caller (script, server, CI) | `hmac-sha256`, header `x-kody-signature`, `hex`, prefix `sha256=` (see [Your own caller](#your-own-caller))               | Omit `secretName`; apply `{{webhookSecret}}` |
| A sender that cannot sign            | `{ "type": "url-secret" }` (see [Senders that cannot sign](#senders-that-cannot-sign-url-secret))                         | The URL itself                               |

X Account Activity's `verification` block is on the
[CRC example](#x-activity-crc-example-for-kentcdodds-x), next to its challenge.

Kody cannot verify these senders yet. Declare `url-secret` for them (Discord
also needs a relay):

- **Discord interactions (Ed25519).** Discord signs with an Ed25519 key pair
  (`X-Signature-Ed25519` over `X-Signature-Timestamp` + body), and
  `verification` supports only HMAC. Discord also checks that an interactions
  endpoint rejects bad signatures, so point Discord at a bot or gateway that
  verifies them and forwards to the webhook, rather than at the minted URL.
- **Slack Events.** Slack signs `v0:{timestamp}:{body}`; delivery verification
  supports only `body` and `timestamp.body`.
- **Telegram.** Bots send a static `X-Telegram-Bot-Api-Secret-Token` header, not
  an HMAC.
- **Gmail Pub/Sub push** (OIDC JWT), **Microsoft Graph** (`clientState`),
  **Azure DevOps service hooks** (basic auth), and **PostHog** (Standard
  Webhooks; not yet verifiable).

### Sentry Integration Platform webhook

Integration Platform webhooks sign the raw body with the integration client
secret and send it in `sentry-hook-signature`. Project Service Hooks differ:
they use the hook secret from registration, so this block does not verify them.

```json
{
	"type": "hmac-sha256",
	"header": "sentry-hook-signature",
	"secretName": "sentryWebhookSecret",
	"encoding": "hex"
}
```

### GitHub

Omit `secretName` so `webhookUrlMint` stores package-owned HMAC on the URL
record (not in account secrets). Use `{{webhookSecret}}` on apply:

```json
{
	"type": "hmac-sha256",
	"header": "x-hub-signature-256",
	"encoding": "hex",
	"prefix": "sha256="
}
```

GitHub HMAC covers the raw body only. Add `replay.deliveryIdHeader` so a
replayed `X-GitHub-Delivery` is acknowledged without running the export again:

```json
{
	"name": "github",
	"export": "./handle-github-webhook",
	"verification": {
		"type": "hmac-sha256",
		"header": "x-hub-signature-256",
		"encoding": "hex",
		"prefix": "sha256="
	},
	"replay": {
		"deliveryIdHeader": "X-GitHub-Delivery"
	}
}
```

### Stripe

Stripe signs `` `${t}.${rawBody}` `` and sends both the unix timestamp and HMAC
in `Stripe-Signature`. Declare `signedPayload: "timestamp.body"` and a timestamp
window:

```json
{
	"name": "stripe",
	"export": "./handle-stripe-webhook",
	"verification": {
		"type": "hmac-sha256",
		"header": "Stripe-Signature",
		"secretName": "stripeWebhookSecret",
		"encoding": "hex",
		"signedPayload": "timestamp.body"
	},
	"replay": {
		"timestampHeader": "Stripe-Signature",
		"timestampFormat": "stripe-signature",
		"toleranceSeconds": 300
	}
}
```

`stripe-signature` reads `t=<unix>` from the header. Deliveries whose timestamp
is missing, unparseable, or older than `toleranceSeconds` (default 300) are
rejected with the same generic 401 as a bad HMAC.

### Bitbucket Cloud

Omit `secretName` so `webhookUrlMint` stores package-owned HMAC on the URL
record (not in account secrets). Bitbucket Cloud sends
`X-Hub-Signature: sha256=<hex HMAC-SHA256 of the raw body>`. Put
`{{webhookSecret}}` in the webhook secret when you register the URL:

```json
{
	"type": "hmac-sha256",
	"header": "X-Hub-Signature",
	"encoding": "hex",
	"prefix": "sha256="
}
```

### Your own caller

Omit `secretName`. A caller you control signs each request with
`x-kody-signature: sha256=<lowercase hex HMAC-SHA256 of the raw request body>`,
keyed by the secret `webhookUrlApply` delivered as `{{webhookSecret}}`:

```json
{
	"type": "hmac-sha256",
	"header": "x-kody-signature",
	"encoding": "hex",
	"prefix": "sha256="
}
```

Kody package code cannot compute that signature (packages never see secret
plaintext), so package-to-webhook calls use `url-secret`.

### Senders that cannot sign: `url-secret`

Declare `url-secret` when the sender has no way to sign requests, or signs in a
way Kody cannot verify yet (Telegram, Microsoft Graph, Azure DevOps, PostHog, a
cron service; see [Signing presets](#signing-presets)). The URL secret is then
the only credential and signature headers are ignored: a POST to the minted URL
runs the export once it passes any declared `replay` checks (a matching
`challenge` POST is answered without running it). This is a supported, permanent
verification type:

```json
{
	"name": "events",
	"export": "./handle-events",
	"verification": { "type": "url-secret" }
}
```

A webhook that declares an HMAC type never falls back to the URL secret: a
request without a valid signature is refused with 401, even on the right URL.
Prefer an HMAC type whenever the sender can sign.

A webhook that omits `verification` is treated as `url-secret`, and publish
accepts it. Declare a type so the manifest says how the webhook authenticates:
`url-secret` when the sender cannot sign, an HMAC type when it can.

Either way, the webhook runs as its enabler, the person who turned it on; with
no `on` enablement the delivery answers 409 `enablement_not_on`.

## Synthetic smoke test

After mint, smoke-test the bound export from **interactive MCP** with
`webhookSyntheticDispatch` instead of POSTing a real provider delivery to
yourself. Search the `webhooks` domain, then call:

```json
{
	"kodyId": "@you/sentry-bridge",
	"webhookName": "sentry",
	"request": {
		"json": { "action": "created" }
	}
}
```

For `inputMode: "params"` webhooks, pass `params` (the first-arg object) instead
of `request`. The platform skips the public URL and HMAC path, marks the
Activity webhook run `synthetic: true`, and counts the invoke against automation
usage like a normal delivery. **Side effects are real.** The capability is
owner-only and unavailable from package jobs, subscriptions, webhooks, or other
package runtimes. It never returns `url` / `url_secret`.

Do not confuse platform synthetic dispatch with a package-local `dryRun` field
on trusted-client POSTs — those are unrelated contracts. Sibling fields such as
`route` and `dryRun` on `params`-mode fixtures are preserved for the export; the
platform only sets top-level `synthetic: true`.

## Trusted clients

A first-party caller (Discord gateway proxy, YouTube WebSub worker, Raycast
extension, social-launch client) mints a webhook URL and POSTs JSON. No
`Authorization: Bearer`. One webhook per export they actually call.

```json
{
	"name": "message-created",
	"export": "./dispatch-message-created",
	"responseMode": "sync",
	"inputMode": "params",
	"rateLimitPerMinute": 600,
	"verification": { "type": "url-secret" }
}
```

Use `sync` when the caller needs the export JSON (or a **409** idempotency
conflict). Use `ack` when the caller only needs acceptance; the queue consumer
applies the same idempotency ledger.

`inputMode: "params"` passes a JSON object as the export's **first argument**.
If the body is the invoke envelope (`{ "params": { … } }` with optional
`idempotencyKey`, `source`, and `topic`), the platform unwraps `params`.
`idempotencyKey` counts only as a non-empty string, and `source` / `topic` only
as a string or null. A top-level JSON object that is not that envelope is the
first argument as-is, so sibling fields such as `route` and `dryRun` stay
visible even when a nested `params` object is present. Arrays and non-objects
are **400** `invalid_params`. Default `inputMode: "request"` passes
`{ webhook, request }` as the export's first argument.

Send **`Idempotency-Key`** (standard header). In `params` mode, JSON
`idempotencyKey` is accepted when the header is absent. Same key + same payload
replays the stored result. On `sync`, a different payload is **409**
`idempotency_mismatch` and an in-progress key is **409**
`invocation_in_progress`. `ack` still returns **202** after enqueue; the
consumer records the ledger outcome. This works without HMAC: the URL secret is
the credential.

Caller keys use the same package-invocation idempotency ledger as
`replay.deliveryIdHeader`. Delivery-id keys still match by id alone (vendor
retries change `receivedAt`). Caller keys hash the payload: in `params` mode
that is the export first argument; in `request` mode it is the JSON body so
`receivedAt` does not break retries.

Do not declare a `*` webhook. A client that calls several exports gets one
webhook declaration per export.

## Lifecycle

Republishing a package that removes or renames a webhook deactivates that
ingress (unknown name → 404). Turn a webhook off with `enablementDisable`
without deleting the mint; the URL answers 404 before rate limiting and without
recording a delivery. Turn it back on by Approving that same URL again; the HMAC
secret is unchanged. Rotate the URL secret with `webhookUrlRotate` when a
credential may have leaked, then call `webhookUrlApply` again with the same
handle so providers get the new URL. The
[settings card](#manage-webhook-urls-in-package-settings) describes the 24-hour
/ first-accepted-delivery overlap. Changing `verification.secretName` or
rotating the secret value it names keeps the previous signing key valid for the
same 24-hour window (a delivery that verifies under the new key retires it
early). A webhook that declares HMAC still never falls back to the URL secret.
Rotate does not change whether the webhook is on.

## Related

- Packages: [Packages](./packages.md)
- Architecture: [Inbound webhooks](../contributing/architecture/webhooks.md)
- Secrets: [Secrets and host approval](./secrets-and-values.md)
