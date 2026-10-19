# Inbound webhooks

Package-centered HTTP ingress that dispatches third-party POST payloads to a
bound saved-package export. End-user setup lives in
[`docs/use/webhooks.md`](../../use/webhooks.md).

## Why this exists

Many webhook providers cannot set custom Authorization headers. Webhook
endpoints are the external HTTP knock: credential-in-URL sibling of per-user
[email](../../use/email-primitives.md) inboxes, declared alongside other package
surfaces in `package.json#kody.webhooks` (same family as `kody.subscriptions`).
First-party trusted clients use the same path (URL secret, no Bearer). See
[0048](../decisions/0048-webhooks-replace-invocation-tokens.md).

## Manifest contract

Packages declare webhooks as an array under `kody.webhooks`. Each entry has a
slug `name`, an `export` that must exist in `package.json#exports` (one name ↔
one export; no `*`), optional `responseMode` (`ack` default / `sync`), optional
`inputMode` (`request` default / `params`), optional `rateLimitPerMinute`
(default 60, max 600), optional HMAC `verification` (algorithm / header /
encoding; optional `secretName` only for provider-issued secrets in the secret
store — omit `secretName` for package-owned HMAC minted onto the webhook URL
record), optional `challenge` for platform-handled ownership quizzes on the same
minted URL, and optional `replay` for timestamp windows and delivery-id dedupe.
Parsing and export existence checks live in `parseAuthoredPackageJson` /
`listPackageWebhooks` (`packages/worker/src/package-registry/`).

`challenge` is answered entirely by the ingress worker
(`packages/worker/src/webhooks/challenge.ts`). The only supported type is
`subscription-challenge` with knobs for method, where the token arrives, how the
subscriber proves itself, and how success is echoed. Do not add vendor-named
type ids ([0054](../decisions/0054-no-vendor-specific-platform-logic.md));
configure providers with documented presets under the generic type. Challenge
requests never call `invokePackageExport`, never write delivery/run history, and
never perform outbound fetch or MCP. They may resolve a named secret for HMAC or
verify-token compare. After the quiz succeeds, later provider POSTs still use
the normal URL-secret + optional HMAC path.

HMAC `verification` signs the raw body by default (`signedPayload` omitted or
`'body'`). Set `signedPayload` to `'timestamp.body'` when the provider HMAC
covers `` `${timestamp}.${rawBody}` `` (Stripe). Replay protection is
**opt-in**: body-only HMAC without `replay` does not bind a timestamp or
delivery id, so a captured signed payload can be replayed until the URL secret
is rotated.

`replay` fields:

- `timestampHeader` — header that carries the timestamp (required with
  `timestampFormat`)
- `timestampFormat` — `unix-seconds` | `unix-millis` | `iso-8601` |
  `stripe-signature` (`stripe-signature` reads `t=<unix>` from a Stripe-style
  header). Unknown formats fail publish-time validation.
- `toleranceSeconds` — optional; defaults to 300 when `timestampHeader` is set
- `deliveryIdHeader` — unique delivery id; dispatches use
  `sha256(userId + packageId + webhookName + deliveryId)` as the
  package-invocation idempotency key. The keyed ledger matches that key alone
  (`idempotencyParamsHash: 'ignore'`): retries change `receivedAt` (and often
  headers), and a later body for the same id is still that delivery. A different
  delivery id hashes to a different key, so it cannot reuse another event's
  acknowledgement.

`inputMode: "params"` is the first-party trusted-client contract. The bound
export's first argument is the parsed JSON object. When that object is the
invoke envelope (`params` plus optional `idempotencyKey`, `source`, and
`topic`), the platform unwraps `params`. `idempotencyKey` counts only as a
non-empty string, and `source` / `topic` only as a string or null. An
application payload that includes a nested `params` object next to other keys
(`route`, `dryRun`, or a reserved key with a non-metadata value) stays intact.
`Idempotency-Key` (or JSON `idempotencyKey` in params mode) maps to the same
package-invocation ledger with payload hashing (`include`): same key + same
first argument replays. On `sync`, mismatch and in-progress are **409**. `ack`
returns **202** after enqueue; the queue consumer applies the same ledger
asynchronously. Request-mode caller keys hash the JSON body so `receivedAt` does
not break retries. Delivery-id keys stay `ignore`. HMAC stays optional; the URL
secret is enough for a trusted client.

`rateLimitPerMinute` overrides the default 60/min ceiling per minted endpoint.
600/min is the documented maximum for gateway fan-in. The limiter still bounds a
leaked URL.

Declaring a webhook does **not** open ingress. A minted URL secret in D1 does.

## Ingress path

Route: `GET|POST /@:username/webhooks/:packageKodyId/:webhookName/:urlSecret`

1. Worker `fetch` in `packages/worker/src/index.ts` matches the path early. The
   path is also registered in `routes.ts` / `router.ts` (POST action), and
   `/@*/webhooks/*` is in `run_worker_first` for all Wrangler environments. GET
   challenges are handled by the early Worker path (not the Remix POST action).
2. Resolve username → user; resolve `packageKodyId` to a saved package owned by
   that user; load minted row keyed by `(user_id, package_id, webhook_name)`.
3. Unminted, disabled, missing declaration (after republish rename/remove), or
   URL-secret mismatch → **404** (indistinguishable). URL-secret mismatches do
   **not** record delivery history (avoids log-flush DoS and rate-limit side
   channels).
4. Constant-time compare the URL secret against `url_secret_hash` (SHA-256) and,
   during rotate overlap, the previous hash. The previous URL stays active for
   24 hours or until the first POST on the new URL that is accepted for dispatch
   (ack enqueue or sync invoke), whichever comes first. HMAC, rate limit,
   payload, declaration rejects, and challenge quizzes do not retire the
   previous URL. An expired previous hash is treated as unknown. Signing-secret
   rotation (`verification.secretName` rename or a value change for that name)
   keeps the previous signing material for the same 24h window
   (`previous_hmac_secret_*`); a delivery that verifies under the current key
   retires it early.
5. After a matching URL secret, enforce per-webhook rate limit (declared
   `rateLimitPerMinute` when the name is still live, otherwise the default 60,
   max 600) → **429** (no delivery history on the limited path). Missing
   declaration after republish rename/remove still **404**s and records a
   rejected delivery, but only after that limit.
6. When `challenge` is declared and the request matches that quiz (GET for CRC /
   hub types; Slack `url_verification` POST), answer via
   `handleWebhookSubscriptionChallenge` and return — no package invoke, no
   delivery row. Non-matching POSTs continue. GET without a matching challenge
   declaration → **405**.
7. Payload cap 1 MB → **413**. When verification is `{ type: 'url-secret' }` (or
   omitted, which is permanently treated the same), the URL secret is the
   credential and signature headers are ignored. A declared HMAC type never
   falls back to the URL secret. For HMAC, try `verification.secretName` in the
   secret store first (user/package scope via package storage context), then the
   previous signing secret during its 24h grace window, then the package-owned
   HMAC on `webhook_endpoints.hmac_secret_encrypted`. Missing secret or HMAC
   mismatch → **401**, with a clear delivery-log error for missing secrets. When
   `replay.timestampHeader` is declared, a missing, unparseable, or stale
   timestamp is rejected with the same generic **401** before dispatch (and
   before any run record that implies acceptance). When
   `replay.deliveryIdHeader` is declared, a missing id is rejected the same way;
   present ids become the invocation idempotency key.
8. Dispatch via `invokePackageExport` with a synthetic internal token scoped to
   the owning user / package / export, `source: 'webhook'`.
9. `ack`: await enqueue to `kody-webhook-dispatch`, then return **202**. The
   queue consumer owns the full invocation and its terminal writes, so work is
   not tied to the post-response `waitUntil` window. A failed enqueue returns
   **503** so the provider can retry. Queue messages omit reconstructed
   `params.request.json` (the consumer parses `body`) and spill `body` to
   `BUNDLE_ARTIFACTS_KV` under
   `webhook-dispatch-payload:v1:{userId}:{deliveryId}` when the serialized
   message would exceed a conservative 120 KB ceiling beneath Cloudflare Queues'
   128 KB limit. `sync`: await (30s) and return export JSON, **502** on failure.
10. Authenticated deliveries (and post-auth rejects such as HMAC / size /
    missing declaration) record a `webhook` surface run record (no payload
    body). See [Run records](./run-records.md). URL-secret mismatches, pre-auth
    rate limits, and subscription challenges still write no delivery history.
    Ack delivery `startedAt` is the queue-consumer dispatch start (not ingress
    `receivedAt`); ingress time is retained under metadata `receivedAt` so
    Activity duration measures export/dispatch work, not provider→queue lag.
    Failed ack deliveries attach diagnostic logs and the underlying invocation
    error code (`metadata.invocationErrorCode`). Pre-execution claim releases
    finish the companion `export` run as an error with logs instead of deleting
    it, so a failed delivery is never a silent `log_count: 0` with no export
    row.

Ack messages carry the accepted delivery id, idempotency key, scoped endpoint
identity, export name, and already-authenticated payload (inline `body`, or a
user-scoped KV key when the body was spilled). Queue retries reuse that exact
idempotency key. Request-mode caller `Idempotency-Key` messages set
`callerIdempotency` so the consumer hashes the JSON body (same as sync).
Unique-key ack claims omit that flag and hash the `{ webhook, request }`
envelope. Transient ledger lookup/terminal-persistence failures,
still-in-progress replays, and other pre-execution infrastructure codes
(`idempotency_conflict_unresolved`, `artifact_preparation_failed`, … — see
`readPreExecutionPackageInvocationInfrastructureCode`) are retried. On the last
consumer attempt (`max_retries`, currently 10) those retries record
`invocation_retry_exhausted` (with diagnostic logs) and ack instead of falling
through to the dead-letter queue. Terminal package errors are recorded with logs
and acknowledged. A missing spilled body is a terminal failure
(`ack_queue_payload_missing`). The consumer runs the export with
`backgroundExecutorTimeoutMs` (5 minutes), so genuinely longer package work ends
as an explicit timeout rather than an unknown interrupted outcome. Sync
deliveries keep the 90s interactive budget behind the 30s
`webhookSyncInvocationTimeoutMs` race. `webhook` run records use a 10-minute
stale-`running` TTL so a full-length ack run is not reconciled early.

The Queue consumer batch size is one. Processing is sequential and one export
can consume the full sandbox budget, so larger batches could exceed the Queue
consumer's 15-minute wall-clock limit before later messages are acknowledged.

## Isolation

- Every D1 row carries `user_id`. Capabilities always bind
  `requireMcpUser(...).userId`.
- Ingress may look up by username + package name leaf + webhook name, then
  immediately re-scopes by the owning user.
- Account deletion/export include `webhook_endpoints` (minted URL state).
  Delivery history lives in run records and is covered with the rest of `RunLog`
  export/deletion. Export redacts `url_secret_hash`, `url_secret_encrypted`,
  `hmac_secret_encrypted`, `hmac_verification_secret_encrypted`,
  `previous_url_secret_hash`, and `previous_hmac_secret_encrypted`.
- Plaintext URL secrets and verification secrets are never logged. URL secrets
  are hashed for ingress and stored encrypted for `webhookUrlApply` and the
  owner reveal in package settings. MCP mint, rotate, list, apply, and synthetic
  dispatch never return the credential URL. Verification secrets stay in the
  secrets primitive; previous signing snapshots are platform ciphertext only.

`webhookSyntheticDispatch` is the interactive-MCP smoke test for one minted
webhook. It skips the public URL and HMAC path, invokes the bound export with a
caller fixture, marks the Activity webhook run `synthetic: true`, and counts
against automation usage like a normal delivery. Side effects are real.
Owner-only; unavailable from package jobs, subscriptions, webhooks, or other
package runtimes. End-user call shape:
[`docs/use/webhooks.md`](../../use/webhooks.md#synthetic-smoke-test).

## Owner UI

Webhooks belong to the package that declares them, so the owner surface is the
**Webhooks** section of package settings (`/@:username/:kodyId/settings`,
`packages/worker/start/pages/package-webhook-settings.tsx` with one
`package-webhook-card.tsx` per declared webhook). Reads and mutations are Start
server functions in `packages/worker/start/server/package-webhooks.ts`
(`loadPackageWebhooks`, `mintPackageWebhook`, `rotatePackageWebhook`,
`revealPackageWebhook`, `enablePackageWebhook`, `disablePackageWebhook`) that
call `packages/worker/src/app/handlers/package-webhooks.ts`. The handler is
owner-only: the signed-in user must be `:username` and own `:kodyId`, otherwise
it answers 404 without naming the package or its webhooks. The load returns
`listWebhooksForUser` filtered to the package and joined with `urlRecoverable`
and `previousUrlActiveUntil`, never the URL. `mint`, `rotate`, and `reveal`
return the refreshed list plus a `revealed` entry built by
`revealWebhookUrlForWebsite` (decrypt `url_secret_encrypted`, rebuild the
ingress path from the request origin); `enable` / `disable` return the list
only. Every intent writes an `account` audit event (`webhook_url_mint`,
`webhook_url_rotate`, `webhook_url_reveal`, `webhook_enable`,
`webhook_disable`). `mint` refuses an already-minted webhook so a stray click
cannot rotate a provider's URL; `reveal` refuses mints without
`url_secret_encrypted` and points at Rotate. The client keeps revealed URLs in
memory only and drops them on Hide or when the settings page changes package.

`/@<slug>/-/webhooks` (`packages/worker/start/pages/account-webhooks.tsx`,
`packages/worker/start/server/account-collections.ts`) is a thin cross-package
index. Its native read lists every declared webhook (never a URL) and each row
deep-links to `/@:username/:kodyId/settings#webhook-<name>`. The account index
has no mutating intents.

`revealWebhookUrlForWebsite` is website-only: no MCP capability, execute
binding, or apply result may return the credential URL.

## Storage

Minted endpoint state lives in the D1 `webhook_endpoints` table defined by
`packages/worker/migrations/0001-squashed-init.sql`, with `url_secret_encrypted`
added in `0057-webhook-url-secret-encrypted.sql`, rotate-overlap columns in
`0062-webhook-url-rotation-grace.sql`, and package-owned `hmac_secret_encrypted`
in `0072-webhook-hmac-secret-encrypted.sql`. Rotate copies the outgoing hash to
`previous_url_secret_hash` with `previous_url_secret_expires_at` 24 hours out.
The previous ciphertext is not stored: reveal and apply always rebuild the
current URL. Package-owned HMAC is preserved across URL rotate (independent of
the path secret). `webhookUrlMint` / `webhookUrlRotate` return an opaque
`handle` (`whh_<id>`) and `url_host`. `webhookUrlApply` resolves the handle
inside Kody and registers the URL through an outbound HTTPS request
(`type: "http"` with server-side `{{webhookUrl}}` substitution, and optional
`{{webhookSecret}}` from package-owned HMAC on the endpoint — copied from
`verification.secretName` at mint/rotate when present). HMAC injection is not a
user-secrets host Allow (unlike destination Bearer `secretName`). Apply is
interactive-only and reuses the account owner approval flow (same family as
`/connect/secrets` host approval, secret package grants, and locked-package
publish approval): deny with `approval_url` to `/connect/webhook-apply`, owner
Allow writes a durable destination fingerprint grant, then retry. Silent
model-chosen apply is rejected. GitHub repository hooks use the same `http` path
against `https://api.github.com/repos/{owner}/{repo}/hooks` with
`{{webhookSecret}}` in `config.secret` when HMAC is declared (prefer omitting
`verification.secretName` so mint stores package-owned HMAC). The credential and
signing secret are injected server-side and never returned to the model.
Delivery history is in the per-user `RunLog` Durable Object (`webhook` surface),
not in D1. See [Data storage](./data-storage.md) and
[Run records](./run-records.md).
